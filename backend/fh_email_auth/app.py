"""Opt-in email registration with verified address, secure sessions, Turnstile and quotas.

All routes disabled unless all external SMTP + Turnstile settings are configured.
No OAuth and no financial database access.
"""
from __future__ import annotations

import logging
from typing import Callable
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import Settings
from .security import normalize_email, valid_password, limit_key
from .store import AuthStore, Throttled, AuthFailure
from .turnstile import validate_token
from .mailer import Mailer

logger=logging.getLogger("fh.email_auth")
SESSION_COOKIE="fh_email_session"
GENERIC_MESSAGE="Если адрес допускает действие, письмо с инструкцией будет отправлено."


class EmailRequest(BaseModel):
    email: str=Field(min_length=5,max_length=254)
    challenge: str=Field(min_length=1,max_length=2048)


class VerifyRequest(BaseModel):
    token: str=Field(min_length=32,max_length=256,pattern=r"^[A-Za-z0-9_-]+$")
    password: str=Field(min_length=12,max_length=128)


class LoginRequest(BaseModel):
    email: str=Field(min_length=5,max_length=254)
    password: str=Field(min_length=1,max_length=128)


class TokenRequest(BaseModel):
    token: str=Field(min_length=32,max_length=256,pattern=r"^[A-Za-z0-9_-]+$")


class PasswordChange(TokenRequest):
    password: str=Field(min_length=12,max_length=128)


def create_app(
    config: Settings|None=None,
    store: AuthStore|None=None,
    captcha: Callable[[str,str,str,str],bool]|None=None,
    mailer: Mailer|None=None
) -> FastAPI:
    config=config or Settings.from_env()
    app=FastAPI(title="Financial Horizon Email Auth", docs_url=None, redoc_url=None,
                openapi_url=None)
    if config.enabled:
        store=store or AuthStore(config.database_path)
    captcha=captcha or validate_token
    mailer=mailer or Mailer(config)

    @app.middleware("http")
    async def safe_headers(request:Request,call_next):
        if request.url.path.startswith("/api/auth/email") and request.method in ("POST","PUT","PATCH"):
            length=request.headers.get("content-length")
            if length and (not length.isdecimal() or int(length)>4096):
                return JSONResponse({"detail":"Слишком большой запрос"},status_code=413)
            if len(await request.body())>4096:
                return JSONResponse({"detail":"Слишком большой запрос"},status_code=413)
        response=await call_next(request)
        response.headers["Cache-Control"]="no-store"
        response.headers["Referrer-Policy"]="no-referrer"
        response.headers["X-Content-Type-Options"]="nosniff"
        return response

    def require_enabled():
        if not config.enabled:
            raise HTTPException(status_code=404,detail="Регистрация отключена")

    def guard_origin(request:Request):
        if request.headers.get("origin")!=config.public_origin:
            raise HTTPException(status_code=403,detail="Недопустимый источник запроса")
        site=request.headers.get("sec-fetch-site")
        if site and site not in ("same-origin","none"):
            raise HTTPException(status_code=403,detail="Запрос с другого сайта")

    def throttle(request:Request,action:str,email:str|None=None):
        assert store is not None
        addr=request.client.host if request.client else "unknown"
        # Trust only ASGI peer IP; forwarding headers are not user-controlled identities.
        policy={
            "register":((6,3600),(2,86400)),
            "resend":((6,3600),(3,86400)),
            "reset":((6,3600),(3,86400)),
            "login":((30,3600),(10,3600)),
            "verify":((30,3600),None),
            "confirm":((20,3600),None),
            "logout":((60,3600),None)
        }
        ip_policy,email_policy=policy[action]
        # Global quota must be consumed first, so distributed abusive IPs cannot
        # grow an unbounded number of individual counter rows.
        parts=[
            (limit_key(config.rate_secret,action+"-global","all"),300,3600),
            (limit_key(config.rate_secret,action+"-ip",addr),*ip_policy)
        ]
        if email and email_policy:
            parts.append((limit_key(config.rate_secret,action+"-email",email),*email_policy))
        try:
            for key,limit,seconds in parts:store.limit(key,limit,seconds)
        except Throttled:
            raise HTTPException(status_code=429,detail="Слишком много попыток. Попробуйте позже.")

    def challenge(token:str,action:str):
        assert config.enabled
        if not captcha(config.turnstile_secret,token,config.public_origin,action):
            raise HTTPException(status_code=400,detail="Не удалось подтвердить защитную проверку")

    def cookie(response:Response,session:str):
        response.set_cookie(
            key=SESSION_COOKIE,value=session,path="/api/auth",max_age=7*86400,
            secure=not config.test_mode,httponly=True,samesite="strict"
        )

    def deliver(email:str,purpose:str,raw:str):
        try:
            result=mailer.send(email,purpose,raw)
            if result is False:raise RuntimeError("delivery failed")
        except Exception:
            # Generic response prevents account probing through SMTP failures.
            # Resend endpoints allow recovery without exposing token to caller.
            logger.warning("transactional_email_delivery_failed purpose=%s",purpose)

    @app.get("/api/auth/email/config")
    def public_config():
        return {
            "enabled":config.enabled,
            "sitekey":config.turnstile_sitekey if config.enabled else "",
            "email_only":True
        }

    @app.post("/api/auth/email/register",status_code=202)
    def register(request:Request,payload:EmailRequest,background:BackgroundTasks):
        require_enabled();guard_origin(request)
        try:
            email=normalize_email(payload.email)
        except ValueError as exc:
            raise HTTPException(status_code=422,detail=str(exc)) from None
        throttle(request,"register",email);challenge(payload.challenge,"register")
        assert store is not None
        try:
            raw=store.create_account(email)
        except ValueError as exc:
            raise HTTPException(status_code=422,detail=str(exc)) from None
        if raw:background.add_task(deliver,email,"verify",raw)
        return {"message":GENERIC_MESSAGE}

    @app.post("/api/auth/email/resend",status_code=202)
    def resend(request:Request,payload:EmailRequest,background:BackgroundTasks):
        require_enabled();guard_origin(request)
        try:email=normalize_email(payload.email)
        except ValueError:raise HTTPException(status_code=422,detail="Некорректный email") from None
        throttle(request,"resend",email);challenge(payload.challenge,"resend")
        assert store is not None
        raw=store.email_action(email,"verify")
        if raw:background.add_task(deliver,email,"verify",raw)
        return {"message":GENERIC_MESSAGE}

    @app.post("/api/auth/email/verify")
    def verify(request:Request,payload:VerifyRequest,response:Response):
        require_enabled();guard_origin(request);throttle(request,"verify")
        assert store is not None
        try:session=store.confirm_email(payload.token,payload.password)
        except (AuthFailure,ValueError):raise HTTPException(status_code=400,detail="Ссылка недействительна или пароль не подходит") from None
        cookie(response,session)
        return {"authenticated":True}

    @app.post("/api/auth/email/login")
    def login(request:Request,payload:LoginRequest,response:Response):
        require_enabled();guard_origin(request)
        try:email=normalize_email(payload.email)
        except ValueError:raise HTTPException(status_code=401,detail="Неверный email или пароль") from None
        throttle(request,"login",email)
        assert store is not None
        try:session=store.login(email,payload.password)
        except AuthFailure:raise HTTPException(status_code=401,detail="Неверный email или пароль") from None
        cookie(response,session)
        return {"authenticated":True}

    @app.post("/api/auth/email/reset/request",status_code=202)
    def request_reset(request:Request,payload:EmailRequest,background:BackgroundTasks):
        require_enabled();guard_origin(request)
        try:email=normalize_email(payload.email)
        except ValueError:raise HTTPException(status_code=422,detail="Некорректный email") from None
        throttle(request,"reset",email);challenge(payload.challenge,"reset")
        assert store is not None
        raw=store.email_action(email,"reset")
        if raw:background.add_task(deliver,email,"reset",raw)
        return {"message":GENERIC_MESSAGE}

    @app.post("/api/auth/email/reset/confirm")
    def confirm_reset(request:Request,payload:PasswordChange):
        require_enabled();guard_origin(request);throttle(request,"confirm")
        assert store is not None
        try:
            store.reset_password(payload.token,payload.password)
        except (AuthFailure,ValueError):
            raise HTTPException(status_code=400,detail="Ссылка недействительна или пароль не подходит") from None
        return {"message":"Пароль обновлён. Войдите с новым паролем."}

    @app.get("/api/auth/email/me")
    def current(request:Request):
        if not config.enabled:return {"authenticated":False}
        assert store is not None
        user=store.current(request.cookies.get(SESSION_COOKIE))
        return {"authenticated":bool(user),"user":user if user else None}

    @app.post("/api/auth/email/logout")
    def logout(request:Request,response:Response):
        require_enabled();guard_origin(request);throttle(request,"logout")
        assert store is not None
        store.logout(request.cookies.get(SESSION_COOKIE))
        response.delete_cookie(SESSION_COOKIE,path="/api/auth",
                               secure=not config.test_mode,httponly=True,samesite="strict")
        return {"ok":True}

    return app


app=create_app()
