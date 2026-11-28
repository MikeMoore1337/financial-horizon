"""Authoritative goal append service, called only under the existing profile lock.

Uses existing _post, finance revision, RLS, command receipts and change_log.
The browser never supplies a posted/reversal transaction identity.
"""
from datetime import datetime, timezone
import json
from typing import Any, Mapping
from uuid import UUID, uuid5

from sqlalchemy import text
from sqlalchemy.orm import Session

from .goal_journal import (
    MAX_EVENTS, MAX_GOALS, MAX_JOURNAL_BYTES, MAX_PROFILE_JOURNAL_BYTES,
    day, replay, validate_event,
)
from .ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, _account, _account_sync_entity,
    _post, _reject, _require_revision, _shape, _transaction_sync_entity, _uuid,
)

GOAL_ACTIONS = frozenset(("goal.append",))


def conflict(message: str = "Цель или счёт недоступны") -> FinanceCommandError:
    return FinanceCommandError("semantic_conflict", message, 409)


def validate_goal_payload(command: Mapping[str, Any]) -> None:
    p = _shape(command["payload"], {"goal_id", "account_id", "event", "counterparty_account_id"},
               {"goal_id", "account_id", "event"})
    target, account = _uuid(p["goal_id"]), _uuid(p["account_id"])
    if target == account:
        raise _reject("Идентификатор цели совпадает со счётом")
    event = validate_event(p["event"], public=True)
    if event["id"] != command["client_mutation_id"]:
        raise _reject("Идентификатор события должен совпадать с командой")
    is_transfer = (event.get("funding") == "account-transfer" or event.get("usage") == "account-transfer")
    if is_transfer != ("counterparty_account_id" in p):
        raise _reject("Укажите второй собственный счёт только для перевода")
    if is_transfer and _uuid(p["counterparty_account_id"]) == account:
        raise _reject("Перевод между одинаковыми счетами запрещён")


def _json_size(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _event_rows(session: Session, profile: UUID, target: UUID):
    return session.execute(text("""
        SELECT event,delta_minor,ledger_transaction_id FROM goal_events
        WHERE profile_id=:p AND goal_id=:id ORDER BY ordinal
    """), {"p": profile, "id": target}).mappings().all()


def _new_id(session: Session, profile: UUID, target: UUID) -> None:
    # The encrypted snapshot map uses one ID across entity kinds.
    if session.execute(text("""
        SELECT 1 FROM (
          SELECT id FROM accounts WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM obligations WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM loans WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM reserves WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM ledger_transactions WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM settlements WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM loan_payments WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM budget_categories WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM budget_rules WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM budget_assignments WHERE profile_id=:p AND id=:id
          UNION ALL SELECT id FROM financial_goals WHERE profile_id=:p AND id=:id
        ) AS existing LIMIT 1
    """), {"p": profile, "id": target}).first():
        raise conflict("Идентификатор уже используется")


def goal_entity(session: Session, profile: UUID, target: UUID) -> dict[str, Any]:
    row = session.execute(text("""
        SELECT account_id,entity_revision FROM financial_goals WHERE profile_id=:p AND id=:id
    """), {"p": profile, "id": target}).mappings().one()
    events = _event_rows(session, profile, target)
    return {"id": str(target), "kind": "goal", "entity_revision": int(row["entity_revision"]),
            "data": {"account_id": str(row["account_id"]), "event_log": [e["event"] for e in events],
                     "saved_minor": sum(int(e["delta_minor"]) for e in events)}}


def apply_goal_candidate(session: Session, scope: VerifiedFinanceScope, command: Mapping[str, Any],
                         versions: Mapping[str, int]):
    validate_goal_payload(command)
    p = scope.profile_id
    payload = command["payload"]
    target, account = _uuid(payload["goal_id"]), _uuid(payload["account_id"])
    event = dict(payload["event"])
    kind, on = event["type"], day(event["on"])
    if on > datetime.now(timezone.utc).date():
        raise _reject("Фактическое событие цели не может быть в будущем")
    row = session.execute(text("""
        SELECT account_id,entity_revision FROM financial_goals
        WHERE profile_id=:p AND id=:id FOR UPDATE
    """), {"p": p, "id": target}).mappings().one_or_none()
    if kind == "create":
        if row is not None:
            raise conflict("Цель уже существует")
        _new_id(session, p, target)
        if session.execute(text("SELECT count(*) FROM financial_goals WHERE profile_id=:p"),
                           {"p": p}).scalar_one() >= MAX_GOALS:
            raise conflict("Достигнут предел целей")
        old, before, revision = [], 0, 1
    else:
        if row is None or row["account_id"] != account:
            raise conflict()
        _require_revision(versions, target, int(row["entity_revision"]))
        stored = _event_rows(session, p, target)
        old = [e["event"] for e in stored]
        if len(old) != row["entity_revision"]:
            raise FinanceCommandError("service_unavailable", "Неполная история цели", 503)
        before = replay(old)["saved_minor"]
        if before != sum(int(e["delta_minor"]) for e in stored):
            raise FinanceCommandError("service_unavailable", "История накоплений не сходится", 503)
        revision = int(row["entity_revision"]) + 1
    if revision > 1000:  # Existing encrypted receipt validator bounds each array.
        raise conflict("Достигнут предел истории цели")

    # Derive all actual postings from the command intent and existing immutable
    # journal. No separate API call can create an expense/transfer for this event.
    postings: list[tuple[UUID, int]] = []
    tx_kind: str | None = None
    original: UUID | None = None
    if kind in ("contribution", "use"):
        mode = event.get("funding", event.get("usage"))
        amount = event["amountCents"]
        if mode == "account-transfer":
            other = _uuid(payload["counterparty_account_id"])
            signed = amount if kind == "contribution" else -amount
            postings = [(account, signed), (other, -signed)]
            tx_kind = "transfer"
        elif mode == "expense":
            postings = [(account, -amount)]
            tx_kind = "expense"
    elif kind == "void":
        previous = next((e for e in old if e["id"] == event["eventId"]), None)
        if previous is None:
            raise conflict("Исходное событие недоступно")
        if "ledgerMovementId" in previous:
            original = _uuid(previous["ledgerMovementId"])
            movement = session.execute(text("""
                SELECT kind,occurred_on FROM ledger_transactions WHERE profile_id=:p AND id=:t
            """), {"p": p, "t": original}).mappings().one_or_none()
            if (movement is None or movement["kind"] not in ("transfer", "expense")
                    or movement["occurred_on"] != day(previous["on"])):
                raise conflict("Исходная проводка недоступна")
            if session.execute(text("""
                SELECT 1 FROM ledger_transactions WHERE profile_id=:p AND reversed_transaction_id=:t
            """), {"p": p, "t": original}).first():
                raise conflict("Проводка уже отменена")
            rows = session.execute(text("""
                SELECT account_id,signed_minor FROM ledger_postings
                WHERE profile_id=:p AND transaction_id=:t ORDER BY account_id
            """), {"p": p, "t": original}).all()
            expected = previous["amountCents"] if previous["type"] == "contribution" else -previous["amountCents"]
            if (len(rows) not in (1, 2) or
                    not any(a == account and int(amount) == expected for a, amount in rows)):
                raise conflict("Проводка не совпадает с историей цели")
            postings = [(a, -int(amount)) for a, amount in rows]
            tx_kind = "reversal"

    tx_id = None
    if tx_kind:
        tx_id = uuid5(p, "fh37:goal:" + command["client_mutation_id"])
        _new_id(session, p, tx_id)
        event["ledgerReversalId" if kind == "void" else "ledgerMovementId"] = str(tx_id)
    # Reuse the exact TS event representation, with server-minted references.
    after = replay([*old, event])["saved_minor"]
    delta = after - before
    if _json_size([*old, event]) > MAX_JOURNAL_BYTES:
        raise conflict("История цели достигла предела")
    total = session.execute(text("""
        SELECT count(*) AS count,COALESCE(SUM(octet_length(event::text)),0) AS size
        FROM goal_events WHERE profile_id=:p
    """), {"p": p}).mappings().one()
    if total["count"] >= MAX_EVENTS or int(total["size"]) + _json_size(event) + 128 > MAX_PROFILE_JOURNAL_BYTES:
        raise conflict("История целей достигла предела")

    touched = {account, *(a for a, _ in postings)}
    required = {str(a) for a in touched}
    if kind != "create":
        required.add(str(target))
    if set(versions) != required:
        raise _reject("Требуются точные ревизии цели и связанных счетов")
    for aid in sorted(touched):
        _account(session, p, aid, versions,
                 archived=(kind == "void" or (not postings and delta <= 0 and kind != "create")))

    # Check aggregate final cash including the pending postings, before writing
    # either journal. Negative unreserved balance remains legal as before.
    cash_delta = dict(postings)
    for aid in touched:
        view = _account_sync_entity(session, p, aid)["data"]
        reserved = view["reserved_minor"] + (delta if aid == account else 0)
        balance = view["balance_minor"] + cash_delta.get(aid, 0)
        if reserved < 0 or (reserved > 0 and balance < reserved):
            raise conflict("Недостаточно свободных средств для цели")
    if kind == "create":
        session.execute(text("""
            INSERT INTO financial_goals(profile_id,id,account_id) VALUES (:p,:id,:a)
        """), {"p": p, "id": target, "a": account})
    else:
        session.execute(text("""
            UPDATE financial_goals SET entity_revision=:r WHERE profile_id=:p AND id=:id
        """), {"p": p, "id": target, "r": revision})

    # Insert allocation before a linked expense/transfer debit; the deferred FK
    # and constraints prove the whole transaction or roll it back.
    session.execute(text("""
        INSERT INTO goal_events(profile_id,id,goal_id,ordinal,event,delta_minor,ledger_transaction_id)
        VALUES (:p,:id,:g,:r,CAST(:event AS jsonb),:delta,:t)
    """), {"p": p, "id": _uuid(event["id"]), "g": target, "r": revision,
           "event": json.dumps(event, ensure_ascii=False), "delta": delta, "t": tx_id})
    changes = []
    if tx_id is not None:
        _post(session, p, tx_id, tx_kind, scope.user_id, on, postings,
              reversed_id=original, note=event.get("reason") if kind == "void" else None)
        changes.append(("ledger_posted", tx_id, 1, {
            "entity": _transaction_sync_entity(session, p, tx_id),
            "accounts": [_account_sync_entity(session, p, a) for a in sorted(touched)],
        }))
    elif delta:
        session.execute(text("""
            UPDATE accounts SET entity_revision=entity_revision+1,updated_at=now()
            WHERE profile_id=:p AND id=:a
        """), {"p": p, "a": account})
        entity = _account_sync_entity(session, p, account)
        changes.append(("upsert", account, entity["entity_revision"], {"entity": entity}))
    return [("upsert", target, revision, {"entity": goal_entity(session, p, target)}), *changes]
