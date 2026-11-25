"""Strict unmounted HTTP envelope for explicit personal legacy source import (#69).

Only route mounting in an operator-approved private personal deployment can
expose these endpoints. The browser must independently verify its encrypted
backup, compare active IndexedDB and request explicit consent. No auto-upload.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import Request

from backend.finance_db.import_manifest_candidate import _safe_manifest
from backend.finance_db.ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, _opaque_etag,
)

_MAX_MANIFEST_BYTES = 2_000_000
_MAX_COMMIT_BYTES = 10_000_000
_MAX_RESTORE_BYTES = 2048


def _invalid() -> None:
    raise FinanceCommandError(
        "invalid_command", "Некорректный запрос переноса финансов", 422,
    )


def _unique_pairs(items: list[tuple[str, object]]) -> dict[str, object]:
    value = {}
    for name, item in items:
        if name in value or name in ("__proto__", "constructor", "prototype"):
            raise ValueError("Duplicate or unsafe JSON keys")
        value[name] = item
    return value


def _non_finite(_: str) -> None:
    raise ValueError("Non-finite JSON number")


async def parse_personal_import_envelope(
    request: Request, *, action: str,
) -> dict[str, Any]:
    expected = {
        "manifest": {"manifest"},
        "commit": {"manifest", "source_canonical_json"},
        "restore": {"batch_id", "source_sha256", "confirm_restore"},
    }.get(action)
    if expected is None:
        raise ValueError("Unknown import action")

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        _invalid()
    maximum = (
        _MAX_MANIFEST_BYTES if action == "manifest"
        else _MAX_COMMIT_BYTES if action == "commit"
        else _MAX_RESTORE_BYTES
    )
    length = request.headers.get("content-length")
    if length is not None and (
        not length.isascii() or not length.isdecimal() or len(length) > 12
        or int(length) > maximum
    ):
        raise FinanceCommandError("invalid_command", "Превышен размер импорта", 413)
    raw = bytearray()
    try:
        async for chunk in request.stream():
            if len(raw) + len(chunk) > maximum:
                raise FinanceCommandError("invalid_command", "Превышен размер импорта", 413)
            raw.extend(chunk)
        obj = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_pairs, parse_constant=_non_finite,
        )
        if type(obj) is not dict or set(obj) != expected:
            _invalid()
        if action == "commit" and type(obj["source_canonical_json"]) is not str:
            _invalid()
        if action == "restore":
            if obj["confirm_restore"] is not True:
                _invalid()
            if type(obj["batch_id"]) is not str or type(obj["source_sha256"]) is not str:
                _invalid()
        return obj
    except FinanceCommandError:
        raise
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _invalid()


def require_manifest_if_match(
    request: Request, *, scope: VerifiedFinanceScope, manifest: object,
) -> None:
    validated = _safe_manifest(manifest)
    expected = _opaque_etag(scope.profile_id, validated.expected_server_revision)
    if request.headers.get("if-match", "") != expected:
        raise FinanceCommandError(
            "stale_revision", "Необходимо перечитать финансовый профиль", 412,
        )
