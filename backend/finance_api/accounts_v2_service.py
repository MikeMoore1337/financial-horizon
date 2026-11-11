"""Strict unmounted account v2 -> authoritative SQL service bridge (#33/#67).

This is NOT an HTTP router. The accepted finance v1 API and production feature
gate remain unchanged. Only use after a trusted FH session has supplied scope.
"""
from __future__ import annotations

from sqlalchemy.engine import Engine

from backend.finance_db.ledger_service import (
    FinanceCommandError,
    FinanceResult,
    VerifiedFinanceScope,
    submit_account_command,
)

from .contracts_v2_candidate import validate_v2_account_candidate


def submit_account_v2_candidate(
    engine: Engine, *, scope: VerifiedFinanceScope, command: object,
    if_match: str, idempotency_key: str,
) -> FinanceResult:
    """Validate the exact narrow v2 candidate before a single SQL transaction.

    Unlike the internal compatibility mode, this entrypoint NEVER enables
    payment/reserve/loan commands. The core enforces the same whitelist even
    if a later caller erroneously bypasses this transport validator.
    """
    try:
        validated = validate_v2_account_candidate(
            command, if_match=if_match, idempotency_key=idempotency_key,
        )
    except (ValueError, TypeError, OverflowError, RecursionError):
        # Never echo sensitive financial input or raw validator diagnostics.
        raise FinanceCommandError(
            "invalid_command", "Некорректная финансовая команда", 422,
        ) from None

    return submit_account_command(
        engine, scope=scope, command=validated, if_match=if_match,
        idempotency_key=idempotency_key, allow_internal=False,
        allow_account_v2=True,
    )
