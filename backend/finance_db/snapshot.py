"""Read-only, scoped, complete finance snapshots and revision-aligned deltas (#67).

Never query an authenticated profile without its verified user and RLS context.
All mutation paths must serialize through the same finance_profiles FOR UPDATE
lock; readers use FOR SHARE to prevent partial multi-statement snapshots.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
import re
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from .db import finance_transaction
from .ledger_service import (
    FinanceCommandError, FinanceResult, VerifiedFinanceScope, _opaque_etag,
    _safe_balance, _reserve_pairs,
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
        "title", "target_minor", "target_on", "archived_at", "allocated_minor",
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


# Hard-coded SQL projection for each audited table; no dynamic SQL identifiers.
_ENTITY_QUERIES = {
    "obligations": text(
        "SELECT id,entity_revision,title,direction,amount_minor,starts_on,timezone,"
        "recurrence_unit,recurrence_every,category,deleted_at "
        "FROM obligations WHERE profile_id=:p AND id>:after ORDER BY id LIMIT :n"
    ),
    "loans": text(
        "SELECT id,entity_revision,title,opening_minor,payment_minor,apr_basis_points,"
        "term_months,due_day,as_of_date,calculation_version,imported_schedule,deleted_at "
        "FROM loans WHERE profile_id=:p AND id>:after ORDER BY id LIMIT :n"
    ),
    "reserves": text(
        "SELECT r.id,r.entity_revision,r.title,r.target_minor,r.target_on,r.archived_at, "
        "COALESCE((SELECT SUM(a.delta_minor) FROM reserve_allocations a "
        "WHERE a.profile_id=r.profile_id AND a.reserve_id=r.id),0) AS allocated_minor "
        "FROM reserves r WHERE r.profile_id=:p AND r.id>:after ORDER BY r.id LIMIT :n"
    ),
    "ledger_transactions": text(
        "SELECT id,entity_revision,kind,occurred_on,note,posted_at,reversed_transaction_id "
        "FROM ledger_transactions WHERE profile_id=:p AND id>:after ORDER BY id LIMIT :n"
    ),
    "settlements": text(
        "SELECT id,entity_revision,obligation_id,occurrence_on,paid_on,amount_minor,voided_at "
        "FROM settlements WHERE profile_id=:p AND id>:after ORDER BY id LIMIT :n"
    ),
    "loan_payments": text(
        "SELECT id,entity_revision,loan_id,paid_on,amount_minor,strategy,voided_at "
        "FROM loan_payments WHERE profile_id=:p AND id>:after ORDER BY id LIMIT :n"
    ),
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


_PAGE_MAX = 5_000
_CURSOR_RE = re.compile(
    r"^(0|[1-9][0-9]{0,18}):(account|obligation|loan|reserve|transaction|settlement|loan_payment):"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
)
_KIND_ORDER = ("account",) + tuple(value[0] for value in _ENTITY_FIELDS.values())


def _page_cursor(cursor: str | None, current_revision: int) -> tuple[str | None, UUID]:
    if cursor is None:
        return None, UUID(int=0)
    match = _CURSOR_RE.fullmatch(cursor) if isinstance(cursor, str) and len(cursor) <= 150 else None
    if not match:
        raise FinanceCommandError("invalid_command", "Неверный курсор финансового снимка", 422)
    revision = int(match[1])
    if revision != current_revision:
        raise FinanceCommandError("stale_revision", "Снимок изменён при загрузке страниц", 412, current_revision)
    return match[2], UUID(match[3])


def get_finance_snapshot(
    engine: Engine, *, scope: VerifiedFinanceScope, cursor: str | None = None,
    limit_entities: int = 1_000,
) -> FinanceResult:
    """Stable kind+UUID keyset pages pinned to the full finance revision.

    A subsequent page is refused if concurrent edits advanced profile revision.
    Return 206 (not 200) for partial responses so old clients cannot silently
    treat the first page as a complete financial snapshot. The optional cursor
    is a protocol extension gated on #65/#68 acceptance, NOT a live v1 release.
    """
    if type(limit_entities) is not int or not 1 <= limit_entities <= _PAGE_MAX:
        raise FinanceCommandError("invalid_command", "Неверный размер страницы снимка", 422)
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        profile = _locked_profile(session, scope)
        revision = int(profile["revision"])
        after_kind, after_id = _page_cursor(cursor, revision)
        first_kind = _KIND_ORDER.index(after_kind) if after_kind else 0
        entities: list[dict[str, Any]] = []
        last_kind: str | None = None
        last_id: str | None = None
        full_page = False

        def collect(kind: str, rows, convert):
            nonlocal last_kind, last_id, full_page
            remaining = limit_entities - len(entities)
            extra = len(rows) > remaining
            for row in rows[:remaining]:
                item = convert(row)
                entities.append(item)
                last_kind, last_id = kind, item["id"]
            if extra or len(entities) == limit_entities:
                full_page = True

        if first_kind == 0:
            after = after_id if after_kind == "account" else UUID(int=0)
            account_rows = session.execute(text("""
                SELECT a.id,a.entity_revision,a.name,a.kind,a.currency,a.opening_minor,a.archived_at,
                       a.opening_minor+COALESCE(SUM(p.signed_minor),0) AS balance_minor
                FROM accounts a LEFT JOIN ledger_postings p
                    ON p.profile_id=a.profile_id AND p.account_id=a.id
                WHERE a.profile_id=:pid AND a.id>:after
                GROUP BY a.id,a.profile_id,a.entity_revision,a.name,a.kind,a.currency,
                         a.opening_minor,a.archived_at
                ORDER BY a.id LIMIT :n
            """), {"pid": scope.profile_id, "after": after,
                   "n": limit_entities + 1}).mappings().all()
            ids = [a["id"] for a in account_rows[:limit_entities]]
            reserved = session.execute(text("""
                SELECT account_id,COALESCE(SUM(delta_minor),0) AS amount
                FROM reserve_allocations WHERE profile_id=:p
                    AND account_id=ANY(:ids)
                GROUP BY account_id
            """), {"p": scope.profile_id, "ids": ids}).mappings().all() if ids else []
            by_account = {r["account_id"]: _safe_balance(r["amount"]) for r in reserved}

            def account_entity(row):
                balance = _safe_balance(row["balance_minor"])
                reserve = by_account.get(row["id"], 0)
                available = _safe_balance(balance - reserve)
                return {
                    "id": str(row["id"]), "entity_revision": int(row["entity_revision"]),
                    "kind": "account",
                    "data": {
                        "name": row["name"], "type": row["kind"],
                        "currency": row["currency"].strip(),
                        "opening_minor": int(row["opening_minor"]),
                        "balance_minor": balance,
                        "reserved_minor": reserve, "available_minor": available,
                        "archived_at": _as_json(row["archived_at"]),
                    },
                }

            collect("account", account_rows, account_entity)

        if not full_page:
            for index, (table, (kind, fields)) in enumerate(_ENTITY_FIELDS.items(), start=1):
                if index < first_kind:
                    continue
                after = after_id if after_kind == kind else UUID(int=0)
                remaining = limit_entities - len(entities)
                rows = session.execute(_ENTITY_QUERIES[table], {
                    "p": scope.profile_id, "after": after, "n": remaining + 1,
                }).mappings().all()
                collect(kind, rows, lambda row, k=kind, cols=fields: {
                    "id": str(row["id"]),
                    "entity_revision": int(row["entity_revision"]),
                    "kind": k,
                    "data": {field: _as_json(row[field]) for field in cols},
                })
                if full_page:
                    break

        # Reserve totals alone are not enough to reconstruct which account
        # can safely release which earmarked funds after a 410 re-snapshot.
        reserves = {
            UUID(item["id"]): item
            for item in entities if item["kind"] == "reserve"
        }
        allocations = _reserve_pairs(session, scope.profile_id, list(reserves))
        for reserve_id, item in reserves.items():
            pairs = allocations[reserve_id]
            if sum(pair["allocated_minor"] for pair in pairs) != item["data"]["allocated_minor"]:
                raise FinanceCommandError(
                    "service_unavailable", "Неполное распределение резерва", 503
                )
            item["data"]["allocations_by_account"] = pairs

        # Only fetch postings and links for the transactions in this page,
        # not every historical transaction. This remains bounded at page_size*2.
        transactions = {
            entity["id"]: entity for entity in entities if entity["kind"] == "transaction"
        }
        transaction_ids = [UUID(txid) for txid in transactions]
        if transaction_ids:
            postings = session.execute(text("""
                SELECT transaction_id,account_id,signed_minor FROM ledger_postings
                WHERE profile_id=:p AND transaction_id=ANY(:ids)
                ORDER BY transaction_id,account_id
            """), {"p": scope.profile_id, "ids": transaction_ids}).mappings().all()
            for posting in postings:
                tx = transactions.get(str(posting["transaction_id"]))
                if tx is None:
                    raise FinanceCommandError("service_unavailable", "Неполный журнал транзакций", 503)
                tx["data"].setdefault("postings", []).append({
                    "account_id": str(posting["account_id"]),
                    "signed_minor": int(posting["signed_minor"]),
                })
            links = session.execute(text("""
                SELECT transaction_id,settlement_id,loan_payment_id FROM ledger_payment_links
                WHERE profile_id=:p AND transaction_id=ANY(:ids)
                ORDER BY transaction_id
            """), {"p": scope.profile_id, "ids": transaction_ids}).mappings().all()
            for link in links:
                tx = transactions.get(str(link["transaction_id"]))
                if tx is None:
                    raise FinanceCommandError("service_unavailable", "Повреждена связь платежа", 503)
                tx["data"]["payment_link"] = {
                    "settlement_id": _as_json(link["settlement_id"]),
                    "loan_payment_id": _as_json(link["loan_payment_id"]),
                }

        body = {
            "schema_version": 1, "profile_id": str(scope.profile_id),
            "revision": revision, "currency": profile["currency"].strip(),
            "entities": entities, "server_at": datetime.now(timezone.utc).isoformat(),
        }
        if full_page and last_kind is not None and last_id is not None:
            body["next_cursor"] = f"{revision}:{last_kind}:{last_id}"
        return FinanceResult(206 if "next_cursor" in body else 200,
                             body, _opaque_etag(scope.profile_id, revision))

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
            raise FinanceCommandError("snapshot_required", "Необходим новый снимок", 410, current)
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
        if (any(int(rev) != since_revision + index
                for index, rev in enumerate(selected, start=1))
            or (not selected and since_revision < current)):
            # Never advance the offline cursor over a missing committed revision.
            raise FinanceCommandError("service_unavailable", "Журнал содержит пропуск", 503)
        rows = session.execute(text("""
            SELECT revision,ordinal,schema_version,kind,entity_id,payload
            FROM change_log WHERE profile_id=:p AND revision>:low AND revision<=:high
            ORDER BY revision,ordinal
        """), {"p": scope.profile_id, "low": since_revision,
               "high": upper}).mappings().all()
        if len(rows) > 2_000:
            raise FinanceCommandError("service_unavailable", "Страница журнала превышает лимит", 503)
        changes = []
        next_ordinal = {int(rev): 0 for rev in selected}
        for item in rows:
            rev = int(item["revision"])
            ordinal = int(item["ordinal"])
            payload = item["payload"]
            if (rev not in next_ordinal or ordinal != next_ordinal[rev]
                or item["schema_version"] != 1
                or item["kind"] not in ("upsert", "tombstone", "ledger_posted")
                or not isinstance(item["entity_id"], UUID)
                or not isinstance(payload, dict)):
                raise FinanceCommandError("service_unavailable", "Журнал изменений повреждён", 503)
            next_ordinal[rev] += 1
            payload = dict(payload)
            entity_revision = payload.pop("_entity_revision", None)
            if type(entity_revision) is not int or not 1 <= entity_revision <= 2**53 - 1:
                raise FinanceCommandError("service_unavailable", "Ревизия события отсутствует", 503)
            changes.append({
                "revision": rev,
                "ordinal": ordinal,
                "kind": item["kind"],
                "entity_id": str(item["entity_id"]),
                "entity_revision": entity_revision,
                "payload": _as_json(payload),
            })
        if any(count == 0 for count in next_ordinal.values()):
            raise FinanceCommandError("service_unavailable", "Неполный журнал изменений", 503)
        return FinanceResult(200, {
            "schema_version": 1, "from_revision": since_revision,
            "to_revision": current, "next_since_revision": upper,
            "has_more": has_more, "changes": changes,
        }, _opaque_etag(scope.profile_id, current))
