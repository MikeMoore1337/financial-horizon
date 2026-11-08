"""Read-only, scoped, complete finance snapshots and revision-aligned deltas (#67).

Never query an authenticated profile without its verified user and RLS context.
All mutation paths must serialize through the same finance_profiles FOR UPDATE
lock; readers use FOR SHARE to prevent partial multi-statement snapshots.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
import json
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from .db import finance_transaction
from .ledger_service import (
    FinanceCommandError, FinanceResult, VerifiedFinanceScope, _opaque_etag,
    _safe_balance,
)

_MAX_PER_ENTITY = 5_000
_ENTITY_FIELDS = {
    "obligations": ("obligation", (
        "title", "direction", "amount_minor", "starts_on", "timezone",
        "recurrence_unit", "recurrence_every", "category", "deleted_at",
    )),
    "loans": ("loan", (
        "title", "opening_minor", "payment_minor", "apr_basis_points",
        "term_months", "due_day", "as_of_date", "calculation_version",
        "imported_schedule", "deleted_at",
    )),
    "reserves": ("reserve", (
        "title", "target_minor", "target_on", "archived_at",
    )),
    "ledger_transactions": ("transaction", (
        "kind", "occurred_on", "note", "posted_at", "reversed_transaction_id",
    )),
    "settlements": ("settlement", (
        "obligation_id", "occurrence_on", "paid_on", "amount_minor", "voided_at",
    )),
    "loan_payments": ("loan_payment", (
        "loan_id", "paid_on", "amount_minor", "strategy", "voided_at",
    )),
}


def _as_json(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return _safe_balance(value)
    if isinstance(value, dict):
        return {str(key): _as_json(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_as_json(item) for item in value]
    return value


def _locked_profile(session: Session, scope: VerifiedFinanceScope):
    profile = session.execute(text("""
        SELECT id,revision,currency,min_available_revision FROM finance_profiles
        WHERE id=:p FOR SHARE
    """), {"p": scope.profile_id}).mappings().one_or_none()
    if not profile:
        raise FinanceCommandError("forbidden", "Нет доступа к финансовому профилю", 403)
    return profile


def get_finance_snapshot(engine: Engine, *, scope: VerifiedFinanceScope) -> FinanceResult:
    """All published finance entities and posted account entries, from one SQL snapshot."""
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        profile = _locked_profile(session, scope)
        revision = int(profile["revision"])

        # A single grouped query yields exact, all-time balance including archived accounts.
        accounts = session.execute(text("""
            SELECT a.id,a.entity_revision,a.name,a.kind,a.currency,a.opening_minor,a.archived_at,
                   a.opening_minor+COALESCE(SUM(p.signed_minor),0) AS balance_minor
            FROM accounts a LEFT JOIN ledger_postings p
                 ON p.profile_id=a.profile_id AND p.account_id=a.id
            WHERE a.profile_id=:pid
            GROUP BY a.id,a.profile_id,a.entity_revision,a.name,a.kind,a.currency,
                     a.opening_minor,a.archived_at
            ORDER BY a.id LIMIT :n
        """), {"pid": scope.profile_id, "n": _MAX_PER_ENTITY + 1}).mappings().all()
        if len(accounts) > _MAX_PER_ENTITY:
            raise FinanceCommandError("service_unavailable", "Слишком большой финансовый снимок", 503)
        reserves = session.execute(text("""
            SELECT account_id,COALESCE(SUM(delta_minor),0) AS amount
              FROM reserve_allocations WHERE profile_id=:pid GROUP BY account_id
        """), {"pid": scope.profile_id}).mappings().all()
        by_account = {r["account_id"]: _safe_balance(r["amount"]) for r in reserves}
        entities: list[dict[str, Any]] = []
        for a in accounts:
            balance = _safe_balance(a["balance_minor"])
            reserved = by_account.get(a["id"], 0)
            if abs(balance - reserved) > 2**53 - 1:
                raise FinanceCommandError("invalid_command", "Доступный остаток переполнен", 422)
            entities.append({
                "id": str(a["id"]), "entity_revision": int(a["entity_revision"]),
                "kind": "account",
                "data": {
                    "name": a["name"], "type": a["kind"], "currency": a["currency"].strip(),
                    "opening_minor": int(a["opening_minor"]), "balance_minor": balance,
                    "reserved_minor": reserved, "available_minor": balance - reserved,
                    "archived_at": _as_json(a["archived_at"]),
                },
            })

        for table, (kind, fields) in _ENTITY_FIELDS.items():
            # The table/columns come exclusively from the hard-coded whitelist above.
            rows = session.execute(text(
                f"SELECT id,entity_revision,{','.join(fields)} "
                f"FROM {table} WHERE profile_id=:p ORDER BY id LIMIT :n"
            ), {"p": scope.profile_id, "n": _MAX_PER_ENTITY + 1}).mappings().all()
            if len(rows) > _MAX_PER_ENTITY:
                raise FinanceCommandError("service_unavailable", "Слишком большой финансовый снимок", 503)
            for row in rows:
                entities.append({
                    "id": str(row["id"]), "entity_revision": int(row["entity_revision"]),
                    "kind": kind,
                    "data": {name: _as_json(row[name]) for name in fields},
                })

        # Attach full, signed postings and payment links to each immutable transaction.
        transactions = {entity["id"]: entity for entity in entities
                        if entity["kind"] == "transaction"}
        postings = session.execute(text("""
            SELECT transaction_id,account_id,signed_minor FROM ledger_postings
            WHERE profile_id=:p ORDER BY transaction_id,account_id
            LIMIT :n
        """), {"p": scope.profile_id, "n": 2 * _MAX_PER_ENTITY + 1}).mappings().all()
        if len(postings) > 2 * _MAX_PER_ENTITY:
            raise FinanceCommandError("service_unavailable", "Слишком много проводок", 503)
        for p in postings:
            tx = transactions.get(str(p["transaction_id"]))
            if tx is None:
                raise FinanceCommandError("service_unavailable", "Неполный журнал транзакций", 503)
            tx["data"].setdefault("postings", []).append({
                "account_id": str(p["account_id"]), "signed_minor": int(p["signed_minor"]),
            })
        links = session.execute(text("""
            SELECT transaction_id,settlement_id,loan_payment_id FROM ledger_payment_links
            WHERE profile_id=:p ORDER BY transaction_id LIMIT :n
        """), {"p": scope.profile_id, "n": _MAX_PER_ENTITY + 1}).mappings().all()
        if len(links) > _MAX_PER_ENTITY:
            raise FinanceCommandError("service_unavailable", "Слишком много связей платежей", 503)
        for link in links:
            tx = transactions.get(str(link["transaction_id"]))
            if tx is None:
                raise FinanceCommandError("service_unavailable", "Повреждена связь платежа", 503)
            tx["data"]["payment_link"] = {
                "settlement_id": _as_json(link["settlement_id"]),
                "loan_payment_id": _as_json(link["loan_payment_id"]),
            }

        return FinanceResult(200, {
            "schema_version": 1,
            "profile_id": str(scope.profile_id),
            "revision": revision,
            "currency": profile["currency"].strip(),
            "entities": entities,
            "server_at": datetime.now(timezone.utc).isoformat(),
        }, _opaque_etag(scope.profile_id, revision))


def get_finance_delta(
    engine: Engine, *, scope: VerifiedFinanceScope, since_revision: int,
    page_revisions: int = 100,
) -> FinanceResult:
    """Page at revision boundaries, never drop or split multi-row revisions."""
    if type(since_revision) is not int or since_revision < 0:
        raise FinanceCommandError("invalid_command", "Неверная исходная ревизия", 422)
    if type(page_revisions) is not int or not 1 <= page_revisions <= 200:
        raise FinanceCommandError("invalid_command", "Неверный размер страницы", 422)
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        profile = _locked_profile(session, scope)
        current = int(profile["revision"])
        minimum = int(profile["min_available_revision"])
        if since_revision < minimum:
            raise FinanceCommandError("snapshot_required", "Необходим новый снимок", 409, current)
        if since_revision > current:
            raise FinanceCommandError("invalid_command", "Ревизия опережает сервер", 422)
        revs = session.execute(text("""
            SELECT DISTINCT revision FROM change_log
            WHERE profile_id=:p AND revision>:since
            ORDER BY revision LIMIT :n
        """), {"p": scope.profile_id, "since": since_revision,
               "n": page_revisions + 1}).scalars().all()
        selected = revs[:page_revisions]
        has_more = len(revs) > page_revisions
        upper = int(selected[-1]) if selected else since_revision
        rows = session.execute(text("""
            SELECT revision,ordinal,kind,entity_id,payload
            FROM change_log WHERE profile_id=:p AND revision>:low AND revision<=:high
            ORDER BY revision,ordinal
        """), {"p": scope.profile_id, "low": since_revision,
               "high": upper}).mappings().all()
        changes = []
        for item in rows:
            payload = dict(item["payload"])
            changes.append({
                "revision": int(item["revision"]),
                "ordinal": int(item["ordinal"]),
                "kind": item["kind"],
                "entity_id": str(item["entity_id"]),
                "entity_revision": int(payload.pop("entity_revision", 1)),
                "payload": _as_json(payload),
            })
        return FinanceResult(200, {
            "schema_version": 1, "from_revision": since_revision,
            "to_revision": current, "next_since_revision": upper,
            "has_more": has_more, "changes": changes,
        }, _opaque_etag(scope.profile_id, current))
