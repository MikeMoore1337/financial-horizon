"""Opt-in email registration with verified address, secure sessions, Turnstile and quotas.

All routes disabled unless all external SMTP + Turnstile settings are configured.
No OAuth and no financial database access.
"""
from __future__ import annotations

import logging
from typing import Callable
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from urllib.parse import urlsplit
from pydantic import BaseModel, Field

from . import SESSION_COOKIE
from .config import Settings
from .security import normalize_email, valid_password, limit_key
from .store import AuthStore, Throttled, AuthFailure
from .turnstile import validate_token
from .mailer import Mailer

logger=logging.getLogger("fh.email_auth")
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


class EmailChangeRequest(BaseModel):
    email: str=Field(min_length=5,max_length=254)
    password: str=Field(min_length=1,max_length=128)
    challenge: str=Field(min_length=1,max_length=2048)


def create_app(
    config: Settings|None=None,
    store: AuthStore|None=None,
    captcha: Callable[[str,str,str,str],bool]|None=None,
    mailer: Mailer|None=None,
    oauth_config=None,
    oauth_store=None,
    oauth_exchanger=None,
) -> FastAPI:
    config=config or Settings.from_env()
    app=FastAPI(title="Financial Horizon Email Auth", docs_url=None, redoc_url=None,
                openapi_url=None)
    app.add_middleware(TrustedHostMiddleware,allowed_hosts=[urlsplit(config.public_origin).hostname]+(["testserver"] if config.test_mode else []))
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

    def throttle(request:Request,action:str,email:str|None=None,*,only_email:bool=False):
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        addr=request.client.host if request.client else "unknown"
        # Trust only ASGI peer IP; forwarding headers are not user-controlled identities.
        policy={
            "register":((6,3600),(2,86400)),
            "resend":((6,3600),(3,86400)),
            "reset":((6,3600),(3,86400)),
            "login":((30,3600),(10,3600)),
            "verify":((30,3600),None),
            "confirm":((20,3600),None),
            "logout":((60,3600),None),
            "logout-others":((10,3600),None),
            "change-email":((5,3600),(2,86400)),
            "change-confirm":((15,3600),None),
            "rotate":((6,3600),None)
        }
        ip_policy,email_policy=policy[action]
        # Global quota must be consumed first, so distributed abusive IPs cannot
        # grow an unbounded number of individual counter rows.
        parts=[] if only_email else [
            (limit_key(config.rate_secret,action+"-global","all"),300,3600),
            (limit_key(config.rate_secret,action+"-ip",addr),*ip_policy)
        ]
        if only_email and (not email or not email_policy):
            raise RuntimeError("Email quota policy not configured")
        if email and email_policy:
            parts.append((limit_key(config.rate_secret,action+"-email",email),*email_policy))
        try:
            for key,limit,seconds in parts:store.limit(key,limit,seconds)
        except Throttled:
            raise HTTPException(status_code=429,detail="Слишком много попыток. Попробуйте позже.")

    def challenge(token:str,action:str):
        if not config.enabled:raise RuntimeError("Email registration not configured")
        if not captcha(config.turnstile_secret,token,config.public_origin,action):
            raise HTTPException(status_code=400,detail="Не удалось подтвердить защитную проверку")

    def cookie(response:Response,session:str):
        response.set_cookie(
            key=SESSION_COOKIE,value=session,path="/api/auth",max_age=7*86400,
            secure=not config.test_mode,httponly=True,samesite="lax"
        )

    def deliver(email:str,purpose:str,raw:str):
        # Stay below the external free relay's daily send allowance even under
        # distributed CAPTCHA abuse. No user identifiers enter the global key.
        try:
            if store is None:raise RuntimeError("Email AuthStore was not initialized")
            store.reserve_transactional_email(max_per_24h=80)
            result=mailer.send(email,purpose,raw)
            if result is False:raise RuntimeError("delivery failed")
        except Throttled:
            logger.warning("transactional_email_daily_budget_exceeded purpose=%s",purpose)
        except Exception:
            # Generic response prevents account probing through SMTP failures.
            # Resend endpoints allow recovery without exposing token to caller.
            logger.warning("transactional_email_delivery_failed purpose=%s",purpose)

    @app.get("/api/auth/email/config")
    def public_config():
        return {
            "enabled":config.enabled,
            "sitekey":config.turnstile_sitekey if config.enabled else "",
            "email_only":True,
            "capabilities":{"email_change":config.enabled,"rotate_session":config.enabled,"revoke_other_sessions":config.enabled}
        }

    @app.post("/api/auth/email/register",status_code=202)
    def register(request:Request,payload:EmailRequest,background:BackgroundTasks):
        require_enabled();guard_origin(request)
        try:
            email=normalize_email(payload.email)
        except ValueError as exc:
            raise HTTPException(status_code=422,detail=str(exc)) from None
        throttle(request,"register");challenge(payload.challenge,"register");throttle(request,"register",email,only_email=True)
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
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
        throttle(request,"resend");challenge(payload.challenge,"resend");throttle(request,"resend",email,only_email=True)
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        raw=store.email_action(email,"verify")
        if raw:background.add_task(deliver,email,"verify",raw)
        return {"message":GENERIC_MESSAGE}

    @app.post("/api/auth/email/verify")
    def verify(request:Request,payload:VerifyRequest,response:Response):
        require_enabled();guard_origin(request);throttle(request,"verify")
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        try:session=store.confirm_email(payload.token,payload.password)
        except (AuthFailure,ValueError):raise HTTPException(status_code=400,detail="Ссылка недействительна или пароль не подходит") from None
        # Revoke the prior cookie before replacing it with a new identity.
        prior=request.cookies.get(SESSION_COOKIE)
        if prior and prior!=session:store.logout(prior)
        cookie(response,session)
        return {"authenticated":True}

    @app.post("/api/auth/email/login")
    def login(request:Request,payload:LoginRequest,response:Response):
        require_enabled();guard_origin(request)
        try:email=normalize_email(payload.email)
        except ValueError:raise HTTPException(status_code=401,detail="Неверный email или пароль") from None
        throttle(request,"login",email)
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        peer=request.client.host if request.client else "unknown"
        pair=limit_key(config.rate_secret,"login-backoff",peer+"\x00"+email)
        retry=store.login_retry_after(pair)
        if retry:
            raise HTTPException(status_code=429,detail="Слишком много попыток. Попробуйте позже.",
                                headers={"Retry-After":str(retry)})
        try:
            session=store.login(email,payload.password)
        except AuthFailure:
            store.note_login_failure(pair)
            raise HTTPException(status_code=401,detail="Неверный email или пароль") from None
        store.clear_login_backoff(pair)
        # Revoke the prior cookie before replacing it with a new identity.
        prior=request.cookies.get(SESSION_COOKIE)
        if prior and prior!=session:store.logout(prior)
        cookie(response,session)
        return {"authenticated":True}

    @app.post("/api/auth/email/reset/request",status_code=202)
    def request_reset(request:Request,payload:EmailRequest,background:BackgroundTasks):
        require_enabled();guard_origin(request)
        try:email=normalize_email(payload.email)
        except ValueError:raise HTTPException(status_code=422,detail="Некорректный email") from None
        throttle(request,"reset");challenge(payload.challenge,"reset");throttle(request,"reset",email,only_email=True)
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        raw=store.email_action(email,"reset")
        if raw:background.add_task(deliver,email,"reset",raw)
        return {"message":GENERIC_MESSAGE}

    @app.post("/api/auth/email/reset/confirm")
    def confirm_reset(request:Request,payload:PasswordChange):
        require_enabled();guard_origin(request);throttle(request,"confirm")
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        try:
            store.reset_password(payload.token,payload.password)
        except (AuthFailure,ValueError):
            raise HTTPException(status_code=400,detail="Ссылка недействительна или пароль не подходит") from None
        return {"message":"Пароль обновлён. Войдите с новым паролем."}

    @app.post("/api/auth/email/change/request",status_code=202)
    def request_change(request:Request,payload:EmailChangeRequest,background:BackgroundTasks):
        require_enabled();guard_origin(request)
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        current=store.current(request.cookies.get(SESSION_COOKIE))
        if not current:
            raise HTTPException(status_code=401,detail="Войдите в аккаунт")
        try:
            email=normalize_email(payload.email)
        except ValueError:
            raise HTTPException(status_code=422,detail="Некорректный email") from None
        throttle(request,"change-email")
        challenge(payload.challenge,"change-email")
        # Quota is bound to the existing principal, NOT the requested new address.
        throttle(request,"change-email",current["email"],only_email=True)
        try:
            token=store.request_email_change(request.cookies.get(SESSION_COOKIE),email,payload.password)
        except AuthFailure:
            raise HTTPException(status_code=401,detail="Неверный пароль или сеанс истёк") from None
        if token:
            background.add_task(deliver,email,"email-change",token)
        return {"message":GENERIC_MESSAGE}

    @app.post("/api/auth/email/change/confirm")
    def confirm_change(request:Request,payload:TokenRequest,response:Response,background:BackgroundTasks):
        require_enabled();guard_origin(request);throttle(request,"change-confirm")
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        try:
            session,old_email=store.confirm_email_change(request.cookies.get(SESSION_COOKIE),payload.token)
        except AuthFailure:
            raise HTTPException(status_code=400,detail="Ссылка недействительна или требуется вход в аккаунт") from None
        cookie(response,session)
        background.add_task(deliver,old_email,"email-changed","")
        return {"ok":True,"authenticated":True}

    @app.post("/api/auth/email/session/rotate")
    def rotate(request:Request,response:Response):
        require_enabled();guard_origin(request);throttle(request,"rotate")
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        try:
            session=store.rotate_session(request.cookies.get(SESSION_COOKIE))
        except AuthFailure:
            raise HTTPException(status_code=401,detail="Войдите в аккаунт") from None
        cookie(response,session)
        return {"ok":True,"authenticated":True}

    @app.get("/api/auth/email/me")
    def current(request:Request):
        if not config.enabled:return {"authenticated":False}
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        user=store.current(request.cookies.get(SESSION_COOKIE))
        return {"authenticated":bool(user),"user":user if user else None}

    @app.post("/api/auth/email/logout-others")
    def logout_others(request:Request):
        require_enabled();guard_origin(request);throttle(request,"logout-others")
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        if not store.revoke_other_sessions(request.cookies.get(SESSION_COOKIE)):
            raise HTTPException(status_code=401,detail="Требуется вход в аккаунт")
        return {"ok":True}

    @app.post("/api/auth/email/logout")
    def logout(request:Request,response:Response):
        require_enabled();guard_origin(request);throttle(request,"logout")
        if store is None:raise RuntimeError("Email AuthStore was not initialized")
        store.logout(request.cookies.get(SESSION_COOKIE))
        response.delete_cookie(SESSION_COOKIE,path="/api/auth",
                               secure=not config.test_mode,httponly=True,samesite="lax")
        return {"ok":True}

    # The email application remains the only session and user authority.
    # No OAuth database migration occurs during normal startup.
    from fh_auth.config import Config as OAuthConfig
    from fh_auth.app import make_oauth_router
    from fh_auth.store import OAuthStore
    oauth_config = oauth_config or OAuthConfig.from_env()
    if oauth_config.enabled:
        if not config.enabled:
            raise ValueError("OAuth requires the existing email auth service")
        if (oauth_config.database_path.resolve(strict=False) !=
                config.database_path.resolve(strict=False) or
                oauth_config.public_url != config.public_origin):
            raise ValueError("OAuth and email auth must use one origin and SQLite database")
        oauth_store = oauth_store or OAuthStore(config.database_path)
    app.include_router(make_oauth_router(oauth_config, oauth_store, oauth_exchanger))
    return app


app=create_app()
