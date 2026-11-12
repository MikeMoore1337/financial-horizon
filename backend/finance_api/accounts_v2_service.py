"""Strict unmounted account v2 -> authoritative SQL service bridge (#33/#67).

This is NOT an HTTP router. The accepted finance v1 API and production feature
gate remain unchanged. Only use after a trusted FH session has supplied scope.
"""
from __future__ import annotations

from uuid import uuid5

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
    """Validate the exact scoped v2 candidate before a single SQL transaction.

    Unlike the internal compatibility mode, this entrypoint NEVER enables
    unapproved reserve/loan mutation internals. It supports only the
    strictly validated account and linked-payment v2 proposal. The core enforces the same whitelist even
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

    # A public candidate MUST NOT accept client claims that an obligation
    # or loan has been paid. Mint stable transaction/fact IDs using the
    # authenticated profile and original mutation UUID, preserving the same
    # SQL request fingerprint on every identical network retry.
    if validated["action"] in ("settlement.payment.record", "loan.payment.record"):
        seed = f'financial-horizon:payment:v2:{validated["action"]}:{validated["client_mutation_id"]}'
        validated = {
            **validated,
            "payload": {
                **validated["payload"],
                "fact_id": str(uuid5(scope.profile_id, seed + ":fact")),
                "transaction_id": str(uuid5(scope.profile_id, seed + ":transaction")),
            },
        }

    return submit_account_command(
        engine, scope=scope, command=validated, if_match=if_match,
        idempotency_key=idempotency_key, allow_internal=False,
        allow_account_v2=True,
    )
