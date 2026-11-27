"""Unpublished strictly-normalized bank import wire envelope (#38).

Browser sends only confirmed normalized rows, never CSV or XLSX file contents.
Limits and duplicate-key rejection apply before the finance DB transaction.
"""
from __future__ import annotations

import json

from fastapi import Request

from backend.finance_db.ledger_service import FinanceCommandError

_MAX_BODY = 2_000_000


def _duplicate_object(pairs: list[tuple[str,object]]) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate JSON property")
        out[key] = value
    return out


def _reject_constant(_: str):
    raise ValueError("non-finite number")


async def parse_bank_import_body(request: Request) -> dict:
    ct = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if ct != "application/json":
        raise FinanceCommandError("invalid_command", "Ожидается JSON", 415)
    declared = request.headers.get("content-length")
    if declared is not None and (
        not declared.isdecimal() or int(declared) > _MAX_BODY
    ):
        raise FinanceCommandError("invalid_command", "Слишком большой запрос", 413)
    size = 0
    chunks = []
    async for chunk in request.stream():
        size += len(chunk)
        if size > _MAX_BODY:
            raise FinanceCommandError("invalid_command", "Слишком большой запрос", 413)
        chunks.append(chunk)
    try:
        parsed = json.loads(
            b"".join(chunks).decode("utf-8", errors="strict"),
            object_pairs_hook=_duplicate_object, parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, ValueError, TypeError, RecursionError):
        raise FinanceCommandError("invalid_command", "Некорректный JSON", 422) from None
    if type(parsed) is not dict:
        raise FinanceCommandError("invalid_command", "Неверное содержимое запроса", 422)
    return parsed
