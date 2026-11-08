"""Feature-off FastAPI finance routes with current FH session and strict Origin guard.

The existing email login cookie is Path=/api/auth; a protected same-origin
bootstrap POST verifies it and creates a separate /api/finance/v1 scoped
HttpOnly cookie backed by the SAME AuthStore session (including revocation).
No local encryption passphrase or identity/profiles are accepted from JSON.
"""
from __future__ import annotations

import json
import logging
from typing import Callable
from uuid import UUID

from fastapi import APIRouter, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from .ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, derive_verified_scope,
    ensure_verified_profile, submit_account_command,
)
from .snapshot import get_finance_snapshot, get_finance_delta

log = logging.getLogger("fh.finance_api")
AUTH_COOKIE = "fh_email_session"
FINANCE_COOKIE = "fh_finance_session"
FINANCE_COOKIE_PATH = "/api/finance/v1"
BODY_LIMIT = 32_768


def _guard_origin(request: Request, origin: str) -> None:
    if request.headers.get("origin") != origin:
        raise HTTPException(status_code=403, detail="Недопустимый источник запроса")
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="Запрос с другого сайта")


def _finance_response(result) -> JSONResponse:
    return JSONResponse(
        result.body,
        status_code=result.status,
        headers={"ETag": result.etag, "Cache-Control": "private, no-store",
                 "Vary": "Cookie", "X-Content-Type-Options": "nosniff"},
    )


def _finance_error(error: FinanceCommandError) -> JSONResponse:
    body = {"code": error.code, "message": error.message}
    if error.server_revision is not None:
        body["server_revision"] = error.server_revision
    return JSONResponse(body, status_code=error.status,
                        headers={"Cache-Control": "private, no-store", "Vary": "Cookie"})


def mount_finance_routes(
    app: FastAPI, *, engine: Engine, namespace: UUID, public_origin: str,
    auth_resolver: Callable[[str | None], dict | None],
    secure_cookie: bool, rate_limiter: Callable[[Request, str], None] | None = None,
) -> None:
    """Explicit application wiring only; create_app() default does not call it.

    auth_resolver MUST be FH AuthStore.current, never a header/body resolver.
    namespace is stable, server-owned and included in recoverable configuration.
    """
    if engine is None or not isinstance(namespace, UUID) or not public_origin:
        raise ValueError("Finance routes require validated PostgreSQL and server namespace")

    def require_user(request: Request, *, finance_cookie: bool) -> str:
        cookie = request.cookies.get(FINANCE_COOKIE if finance_cookie else AUTH_COOKIE)
        user = auth_resolver(cookie)
        if not user or not isinstance(user.get("id"), str):
            raise HTTPException(status_code=401, detail="Войдите в аккаунт")
        return user["id"]

    def scope(request: Request) -> VerifiedFinanceScope:
        return derive_verified_scope(require_user(request, finance_cookie=True), namespace)

    def rate(request: Request, action: str) -> None:
        if rate_limiter is not None:
            rate_limiter(request, action)

    @app.post("/api/auth/email/finance/session", include_in_schema=False)
    def begin_finance_session(request: Request, response: Response):
        _guard_origin(request, public_origin)
        rate(request, "finance-session")
        raw_token = request.cookies.get(AUTH_COOKIE)
        user_id = require_user(request, finance_cookie=False)
        try:
            verified = ensure_verified_profile(
                engine, verified_user_id=user_id, server_namespace=namespace
            )
        except SQLAlchemyError:
            log.error("finance_session_provision_failed")
            raise HTTPException(status_code=503, detail="Финансовый сервис недоступен") from None
        response.set_cookie(
            FINANCE_COOKIE, raw_token,
            path=FINANCE_COOKIE_PATH, max_age=7 * 86400,
            secure=secure_cookie, httponly=True, samesite="strict",
        )
        response.headers["Cache-Control"] = "private, no-store"
        return {"ok": True, "profile_id": str(verified.profile_id)}

    router = APIRouter(prefix="/api/finance/v1", include_in_schema=False)

    @router.get("/state")
    def state(request: Request, cursor: str | None = None, limit_entities: int = 1_000):
        rate(request, "finance-read")
        verified = scope(request)
        try:
            return _finance_response(get_finance_snapshot(
                engine, scope=verified, cursor=cursor, limit_entities=limit_entities,
            ))
        except FinanceCommandError as exc:
            return _finance_error(exc)
        except SQLAlchemyError:
            log.error("finance_state_read_failed")
            return _finance_error(FinanceCommandError(
                "service_unavailable", "Финансовый сервис недоступен", 503
            ))

    @router.get("/changes")
    def changes(request: Request, since_revision: int, limit_revisions: int = 50):
        rate(request, "finance-read")
        verified = scope(request)
        if not (1 <= limit_revisions <= 100):
            return _finance_error(FinanceCommandError(
                "invalid_command", "Неверный размер страницы", 422
            ))
        try:
            return _finance_response(get_finance_delta(
                engine, scope=verified, since_revision=since_revision,
                page_revisions=limit_revisions,
            ))
        except FinanceCommandError as exc:
            return _finance_error(exc)
        except SQLAlchemyError:
            log.error("finance_delta_read_failed")
            return _finance_error(FinanceCommandError(
                "service_unavailable", "Финансовый сервис недоступен", 503
            ))

    @router.post("/commands")
    async def commands(request: Request):
        _guard_origin(request, public_origin)
        # Do not run SQLite rate limits or blocking PostgreSQL row locks in
        # the ASGI event loop; unrelated sessions must remain responsive.
        await run_in_threadpool(rate, request, "finance-write")
        # AuthStore.current reads SQLite synchronously, too. Keep that IO off
        # the ASGI event loop together with the PostgreSQL command execution.
        verified = await run_in_threadpool(scope, request)
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _finance_error(FinanceCommandError(
                "invalid_command", "Требуется application/json", 422
            ))
        length = request.headers.get("content-length")
        if length and (not length.isdecimal() or int(length) > BODY_LIMIT):
            return _finance_error(FinanceCommandError(
                "invalid_command", "Слишком большой запрос", 413
            ))
        # Chunked uploads may omit Content-Length. Never materialize the
        # unbounded request body before enforcing the same 32 KiB quota.
        raw = bytearray()
        async for chunk in request.stream():
            if len(chunk) + len(raw) > BODY_LIMIT:
                return _finance_error(FinanceCommandError(
                    "invalid_command", "Слишком большой запрос", 413
                ))
            raw.extend(chunk)
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return _finance_error(FinanceCommandError(
                "invalid_command", "Некорректный JSON", 422
            ))
        # Body streaming can take arbitrarily long, while a different browser
        # revokes the current SQLite session. Re-check after the complete body
        # is received, inside the SAME worker just before the PostgreSQL call.
        # Fail closed on a changed principal; the first lookup is NOT a durable
        # authorization decision for a delayed write.
        def submit_with_fresh_session():
            fresh = scope(request)
            if fresh != verified:
                raise HTTPException(status_code=401, detail="Сеанс изменился")
            return submit_account_command(
                engine, scope=fresh, command=body,
                if_match=request.headers.get("if-match", ""),
                idempotency_key=request.headers.get("idempotency-key", ""),
                allow_internal=False,  # Never expose internal CRUD through v1.
            )

        try:
            result = await run_in_threadpool(submit_with_fresh_session)
            return _finance_response(result)
        except FinanceCommandError as exc:
            return _finance_error(exc)
        except SQLAlchemyError:
            # The transaction context rolls back. Do not log SQL params,
            # raw financial amounts, private identifiers or session cookies.
            log.error("finance_command_db_failed")
            return _finance_error(FinanceCommandError(
                "service_unavailable", "Операция не подтверждена сервером", 503
            ))

    app.include_router(router)
