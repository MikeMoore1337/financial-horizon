"""OAuth routes mounted on the existing email-auth FastAPI application.

No standalone OAuth session, cookie or user database. OAuth remains disabled
unless the feature gate and each provider's explicit gate are configured.
"""
from __future__ import annotations

import hmac
import json
import logging
import re
import secrets
from hashlib import sha256
from typing import Awaitable, Callable
from urllib.parse import parse_qsl

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, StrictBool

from fh_email_auth import SESSION_COOKIE
from fh_email_auth.store import AuthFailure, Throttled
from .config import Config
from .providers import OAuthProvider
from .exchange import exchange_provider
from .store import OAuthStore

_MARKER = "fh_oauth_marker"
_STATE_RE = re.compile(r"^[A-Za-z0-9._~-]{32,256}$")
_VK_DEVICE_RE = re.compile(r"^[A-Za-z0-9._~-]{6,256}$")
_logger = logging.getLogger("fh.oauth")


class LinkIntent(BaseModel):
    confirm: StrictBool


def _random() -> str:
    return secrets.token_urlsafe(40)


async def _params(request: Request) -> dict[str, str]:
    pairs = list(request.query_params.multi_items())
    if request.method == "POST":
        ctype = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if ctype != "application/x-www-form-urlencoded":
            raise HTTPException(400, "Неверный формат ответа провайдера")
        body = await request.body()
        if len(body) > 8192:
            raise HTTPException(413, "Слишком большой ответ провайдера")
        try:
            pairs += parse_qsl(body.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError:
            raise HTTPException(400, "Неверный ответ провайдера") from None
    params = {}
    for key, value in pairs:
        if (not key.isascii() or len(key) > 48 or len(value) > 4096 or
                key in params):
            raise HTTPException(400, "Неверные параметры авторизации")
        params[key] = value
    if "payload" in params:
        raw = params.pop("payload")
        try:
            decoded = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "Неверный ответ VK ID") from None
        if not isinstance(decoded, dict):
            raise HTTPException(400, "Неверный ответ VK ID")
        for key, value in decoded.items():
            if not isinstance(key, str) or not key.isascii() or len(key) > 48:
                raise HTTPException(400, "Неверный ответ VK ID")
            if value is None:
                continue
            if not isinstance(value, (str, int)) or isinstance(value, bool):
                raise HTTPException(400, "Неверный ответ VK ID")
            value = str(value)
            if len(value) > 4096 or (key in params and params[key] != value):
                raise HTTPException(400, "Конфликт параметров VK ID")
            params[key] = value
    return params


def make_oauth_router(
    config: Config,
    store: OAuthStore | None,
    exchanger: Callable[..., Awaitable[str]] | None = None
) -> APIRouter:
    router = APIRouter()
    providers = {
        p: OAuthProvider(p, *config.credentials[p]) for p in config.active_providers()
    }
    exchanger = exchanger or exchange_provider

    def require_provider(provider: str):
        if not config.enabled or provider not in providers or store is None:
            raise HTTPException(404, "Этот способ входа недоступен")
        return providers[provider]

    def throttle(request: Request, action: str):
        peer = request.client.host if request.client else "unknown"
        for name, value, cap, window in (
            ("global", "all", 200, 3600),
            ("peer", peer, 8 if action == "start" else 20, 900),
        ):
            digest = hmac.new(config.session_secret.encode("utf-8"),
                              f"oauth:{action}:{name}:{value}".encode("utf-8"),
                              sha256).hexdigest()
            try:
                store.limit(digest, cap, window)
            except Throttled:
                raise HTTPException(429, "Слишком много попыток входа") from None

    def require_origin(request: Request):
        if request.headers.get("origin") != config.public_url:
            raise HTTPException(403, "Недопустимый источник запроса")
        site = request.headers.get("sec-fetch-site")
        if site and site not in ("same-origin", "none"):
            raise HTTPException(403, "Запрос с другого сайта")

    def begin(provider: str, request: Request, *, intent: str):
        client = require_provider(provider)
        throttle(request, "start")
        session = request.cookies.get(SESSION_COOKIE)
        current = store.current(session)
        if intent == "login" and current:
            raise HTTPException(409, "Для смены аккаунта сначала выйдите")
        if intent == "link" and not current:
            raise HTTPException(401, "Сначала войдите в аккаунт")
        state, marker, verifier, nonce = _random(), _random(), secrets.token_urlsafe(48), _random()
        target = client.authorize(base=config.public_url, state=state,
                                  verifier=verifier, nonce=nonce)
        store.begin(provider=provider, state=state, browser_marker=marker,
                    verifier=verifier, nonce=nonce,
                    redirect_uri=client.redirect_uri(config.public_url),
                    intent=intent,
                    target_user_id=current["id"] if intent == "link" else None,
                    session=session if intent == "link" else None)
        response = RedirectResponse(target, status_code=303)
        response.set_cookie(_MARKER, marker, path="/api/auth/oauth",
                            secure=not config.test_mode, httponly=True,
                            samesite="lax", max_age=600)
        return response

    @router.get("/api/auth/providers")
    def advertised():
        return {"enabled":config.enabled, "providers":list(providers)}

    @router.get("/api/auth/oauth/{provider}/start")
    def start(provider: str, request: Request):
        return begin(provider, request, intent="login")

    @router.post("/api/auth/oauth/{provider}/link/start")
    def link_start(provider: str, request: Request, payload: LinkIntent):
        require_origin(request)
        if payload.confirm is not True:
            raise HTTPException(400, "Требуется подтверждение привязки")
        return begin(provider, request, intent="link")

    async def complete(provider: str, request: Request):
        client = require_provider(provider)
        throttle(request, "callback")
        params = await _params(request)
        state = params.get("state")
        if not state or not _STATE_RE.fullmatch(state):
            raise HTTPException(400, "Недействительный запрос авторизации")
        claim = store.claim(provider=provider, state=state, marker=request.cookies.get(_MARKER))
        if not claim:
            raise HTTPException(400, "Срок запроса авторизации истёк")
        response = None
        try:
            if params.get("error"):
                response = RedirectResponse("/account.html?oauth=denied", status_code=303)
            else:
                if provider == "vk" and not _VK_DEVICE_RE.fullmatch(params.get("device_id", "")):
                    raise ValueError("VK callback requires valid device_id")
                subject = await exchanger(
                    client, claim, params.get("code", ""),
                    device_id=params.get("device_id"), state=state
                )
                if claim.intent == "link":
                    new_cookie = store.complete_link(
                        claim, subject, request.cookies.get(SESSION_COOKIE)
                    )
                    destination = "/account.html?oauth=linked"
                else:
                    if store.current(request.cookies.get(SESSION_COOKIE)):
                        raise AuthFailure()
                    _uid, new_cookie = store.complete_login(provider, subject)
                    previous = request.cookies.get(SESSION_COOKIE)
                    if previous:
                        store.logout(previous)
                    destination = "/?auth=success"
                response = RedirectResponse(destination, status_code=303)
                response.set_cookie(SESSION_COOKIE, new_cookie, path="/api/auth",
                                    secure=not config.test_mode, httponly=True,
                                    samesite="lax", max_age=7 * 86400)
        except Exception:
            # No raw code, id_token, provider response, email or subject in logs.
            _logger.warning("oauth_callback_failed provider=%s", provider)
            response = RedirectResponse("/account.html?oauth=failed", status_code=303)
        finally:
            store.finish(state)
        response.delete_cookie(_MARKER, path="/api/auth/oauth",
                               secure=not config.test_mode, httponly=True,
                               samesite="lax")
        return response

    @router.get("/api/auth/oauth/{provider}/callback")
    async def callback_get(provider: str, request: Request):
        return await complete(provider, request)

    @router.post("/api/auth/oauth/{provider}/callback")
    async def callback_post(provider: str, request: Request):
        return await complete(provider, request)

    return router
