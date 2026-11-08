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
from backend.finance_api.contracts import parse_v1_command

from .ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, derive_verified_scope,
    ensure_verified_profile, submit_account_command,
)
from .snapshot import get_finance_snapshot, get_finance_delta

log = logging.getLogger("fh.finance_api")
AUTH_COOKIE = "fh_email_session"
FINANCE_COOKIE = "fh_finance_session"
FINANCE_COOKIE_PATH = "/api/finance/v1"


def _guard_origin(request: Request, origin: str) -> None:
    if request.headers.get("origin") != origin:
        raise HTTPException(status_code=403, detail="Недопустимый источник запроса")
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="Запрос с другого сайта")


def _finance_response(result) -> JSONResponse:
    # Enforce transport quota for all snapshots, deltas and command receipts.
    if len(json.dumps(result.body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 2_000_000:
        raise FinanceCommandError("service_unavailable", "Ответ превышает лимит", 503)
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


def _query_integer(request: Request, key: str, default: int | None,
                   minimum: int, maximum: int) -> int:
    values = request.query_params.getlist(key)
    if len(values) > 1 or (not values and default is None):
        raise FinanceCommandError("invalid_command", "Неверные параметры запроса", 422)
    if not values:
        return default
    raw = values[0]
    if len(raw) > 20 or not raw.isascii() or not raw.isdecimal():
        raise FinanceCommandError("invalid_command", "Неверные параметры запроса", 422)
    value = int(raw)
    if value < minimum or value > maximum:
        raise FinanceCommandError("invalid_command", "Параметр вне допустимых границ", 422)
    return value


def mount_finance_routes(
    app: FastAPI, *, engine: Engine, namespace: UUID, public_origin: str,
    auth_resolver: Callable[[str | None], dict | None],
    secure_cookie: bool, rate_limiter: Callable[[Request, str], None] | None = None,
) -> None:
    """Explicit application wiring only; create_app() default does not call it.

    auth_resolver MUST be FH AuthStore.current, never a header/body resolver.
    namespace is stable, server-owned and included in recoverable configuration.
    """
    if (engine is None or engine.dialect.name != "postgresql"
        or not isinstance(namespace, UUID) or not public_origin):
        raise ValueError("Finance routes require validated PostgreSQL and server namespace")

    def require_user(request: Request, *, finance_cookie: bool) -> str:
        cookie = request.cookies.get(FINANCE_COOKIE if finance_cookie else AUTH_COOKIE)
        try:
            user = auth_resolver(cookie)
        except Exception as exc:
            log.error("finance_session_resolution_failed category=%s", type(exc).__name__)
            raise HTTPException(status_code=503, detail="Сессия временно недоступна") from None
        if not user or not isinstance(user.get("id"), str):
            raise HTTPException(status_code=401, detail="Войдите в аккаунт")
        return user["id"]

    def scope(request: Request) -> VerifiedFinanceScope:
        return derive_verified_scope(require_user(request, finance_cookie=True), namespace)

    def rate(request: Request, action: str) -> None:
        if rate_limiter is None:
            # A public finance service must have a shared, cross-worker limiter.
            raise HTTPException(status_code=503, detail="Финансовый сервис недоступен")
        try:
            rate_limiter(request, action)
        except HTTPException:
            # Preserve existing 429 quota rejection; never mask it as 503.
            raise
        except Exception as exc:
            # SQLite failures are not successful authentication or an open quota.
            # Never print the database exception text or SQL parameter values.
            log.error("finance_rate_store_failed category=%s", type(exc).__name__)
            raise HTTPException(status_code=503, detail="Финансовый сервис недоступен") from None

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
    def state(request: Request):
        rate(request, "finance-read")
        verified = scope(request)
        try:
            if not set(request.query_params).issubset({"cursor", "limit_entities"}):
                raise FinanceCommandError("invalid_command", "Недопустимый параметр снимка", 422)
            cursor_values = request.query_params.getlist("cursor")
            if len(cursor_values) > 1:
                raise FinanceCommandError("invalid_command", "Дублирован курсор", 422)
            cursor = cursor_values[0] if cursor_values else None
            limit = _query_integer(request, "limit_entities", 1000, 1, 5000)
            return _finance_response(get_finance_snapshot(
                engine, scope=verified, cursor=cursor, limit_entities=limit
            ))
        except FinanceCommandError as exc:
            return _finance_error(exc)
        except SQLAlchemyError:
            log.error("finance_state_read_failed")
            return _finance_error(FinanceCommandError(
                "service_unavailable", "Финансовый сервис недоступен", 503
            ))

    @router.get("/changes")
    def changes(request: Request):
        rate(request, "finance-read")
        verified = scope(request)
        try:
            if not set(request.query_params).issubset({"since_revision", "limit_revisions"}):
                raise FinanceCommandError("invalid_command", "Недопустимый параметр журнала", 422)
            since = _query_integer(request, "since_revision", None, 0, (1 << 53) - 1)
            limit = _query_integer(request, "limit_revisions", 50, 1, 100)
            return _finance_response(get_finance_delta(
                engine, scope=verified, since_revision=since, page_revisions=limit,
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
        verified = await run_in_threadpool(scope, request)
        try:
            body = await parse_v1_command(request)
        except FinanceCommandError as exc:
            return _finance_error(exc)
        # The request body may be delayed by network streaming. Revalidate the
        # real SQLite AuthStore session after parsing, in the SAME worker as
        # the SQL command. A logout/revocation during streaming must block the
        # write instead of using the initial (now stale) scope.
        def submit_with_fresh_session():
            current = scope(request)
            if current != verified:
                raise HTTPException(status_code=401, detail="Сеанс изменился")
            return submit_account_command(
                engine, scope=current, command=body,
                if_match=request.headers.get("if-match", ""),
                idempotency_key=request.headers.get("idempotency-key", ""),
                allow_internal=False,  # Never enable unpublished internal CRUD.
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
