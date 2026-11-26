"""#35 server-side budget candidate, deliberately not mounted in HTTP.

Called inside the existing profile-row lock, RLS transaction, revision and
SHA-256 receipt protocol. The UI must reconcile legacy category names with
the profile-owned catalogue before enabling this transport. No ledger write.
"""
from datetime import date
import re
from typing import Any, Mapping
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from .db import finance_transaction
from .ledger_service import (
    MAX_MINOR, FinanceCommandError, FinanceResult, VerifiedFinanceScope,
    _integer, _opaque_etag, _reject, _require_revision, _shape, _uuid,
)

BUDGET_ACTIONS = frozenset({
    "budget.create", "budget.amend", "budget.archive", "budget.category.assign",
    "budget.category.create", "budget.category.rename", "budget.category.archive",
})

# Fixed identifiers only; never accept a table name from an HTTP body.
_TABLES = {
    "budget_category": "budget_categories",
    "budget_rule": "budget_rules",
    "budget_assignment": "budget_assignments",
}


def _conflict(message: str = "Бюджетная запись недоступна") -> FinanceCommandError:
    return FinanceCommandError("semantic_conflict", message, 409)


def _month(value: object) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", value):
        raise _reject("Неверный месяц бюджета")
    try:
        return date.fromisoformat(value + "-01")
    except ValueError:
        raise _reject("Неверный месяц бюджета") from None


def _month_index(value: date) -> int:
    return value.year * 12 + value.month - 1


def _bounds(rule: Mapping[str, Any]) -> tuple[int, int]:
    start = _month_index(rule["from_month"])
    end = start + 1 if rule["recurrence"] == "once" else 120_000
    for key in ("ends_before_month", "archived_from_month"):
        if rule[key] is not None:
            end = min(end, _month_index(rule[key]))
    return start, end


def _name(value: object) -> str:
    if (not isinstance(value, str) or not 1 <= len(value) <= 40
            or value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise _reject("Некорректное название категории")
    return value


def _row(session: Session, p: UUID, kind: str, target: UUID):
    # Kind is selected by the internal dispatcher, never by the client.
    return session.execute(text(
        "SELECT * FROM " + _TABLES[kind] + " WHERE profile_id=:p AND id=:id"
    ), {"p": p, "id": target}).mappings().one_or_none()


def _existing(session: Session, p: UUID, kind: str, target: UUID):
    row = _row(session, p, kind, target)
    if row is None:
        raise _conflict()
    return row


def _new(session: Session, p: UUID, kind: str, target: UUID) -> None:
    if _row(session, p, kind, target) is not None:
        raise _conflict("Идентификатор уже используется")


def _versions(versions: Mapping[str, int], target: UUID | None = None,
              current: int | None = None) -> None:
    if target is None:
        if versions:
            raise _reject("Создание не имеет предыдущей ревизии")
    else:
        if set(versions) != {str(target)}:
            raise _reject("Требуется ревизия изменяемой сущности")
        _require_revision(versions, target, current)


def _category(session: Session, p: UUID, value: object) -> UUID | None:
    if value is None:
        return None
    target = _uuid(value)
    row = _existing(session, p, "budget_category", target)
    if row["archived"]:
        raise _conflict("Категория архивирована")
    return target


def _check_name(session: Session, p: UUID, name: str, target: UUID) -> None:
    if session.execute(text("""
        SELECT 1 FROM budget_categories
        WHERE profile_id=:p AND lower(name)=lower(:name) AND id<>:id
    """), {"p": p, "name": name, "id": target}).first():
        raise _conflict("Такая категория уже существует")


def _check_overlap(session: Session, p: UUID, rule: Mapping[str, Any]) -> None:
    start, end = _bounds(rule)
    if start >= end:
        return
    rows = session.execute(text("""
        SELECT id,recurrence,from_month,ends_before_month,archived_from_month
        FROM budget_rules WHERE profile_id=:p
          AND category_id IS NOT DISTINCT FROM :category_id AND id<>:id
    """), {"p": p, "category_id": rule["category_id"], "id": rule["id"]}).mappings()
    for other in rows:
        left, right = _bounds(other)
        if max(left, start) < min(right, end):
            raise _conflict("Лимиты пересекаются")


def _entity(kind: str, row: Mapping[str, Any]) -> dict[str, Any]:
    data = {}
    for key, value in row.items():
        if key in ("id", "profile_id", "entity_revision"):
            continue
        if isinstance(value, UUID):
            value = str(value)
        elif isinstance(value, date):
            value = value.isoformat()[:7]
        data[key] = value
    return {"id": str(row["id"]), "kind": kind,
            "entity_revision": row["entity_revision"], "data": data}


def _change(session: Session, p: UUID, kind: str, target: UUID, **extra):
    entity = _entity(kind, _existing(session, p, kind, target))
    return ("upsert", target, entity["entity_revision"], {"entity": entity, **extra})


def _insert_rule(session: Session, p: UUID, rule: Mapping[str, Any]) -> None:
    _new(session, p, "budget_rule", rule["id"])
    _check_overlap(session, p, rule)
    session.execute(text("""
        INSERT INTO budget_rules
          (profile_id,id,category_id,limit_minor,recurrence,from_month,ends_before_month,archived_from_month)
        VALUES (:p,:id,:category_id,:limit_minor,:recurrence,:from_month,:ends_before_month,:archived_from_month)
    """), {"p": p, **rule})


def apply_budget_candidate(session: Session, scope: VerifiedFinanceScope,
                           cmd: Mapping[str, Any], versions: Mapping[str, int]):
    """Return complete upsert images to the shared atomic change-log writer."""
    p, action, payload = scope.profile_id, cmd["action"], cmd["payload"]
    if action == "budget.category.create":
        _shape(payload, {"id", "name"}, {"id", "name"})
        _versions(versions)
        target, name = _uuid(payload["id"]), _name(payload["name"])
        _new(session, p, "budget_category", target)
        _check_name(session, p, name, target)
        session.execute(text("""
            INSERT INTO budget_categories (profile_id,id,name) VALUES (:p,:id,:name)
        """), {"p": p, "id": target, "name": name})
        return [_change(session, p, "budget_category", target)]

    if action in ("budget.category.rename", "budget.category.archive"):
        keys = {"id", "name"} if action.endswith("rename") else {"id"}
        _shape(payload, keys, keys)
        target = _uuid(payload["id"])
        row = _existing(session, p, "budget_category", target)
        _versions(versions, target, row["entity_revision"])
        if row["archived"]:
            raise _conflict("Категория архивирована")
        if action.endswith("rename"):
            name = _name(payload["name"])
            _check_name(session, p, name, target)
            session.execute(text("""
                UPDATE budget_categories SET name=:name,entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:id
            """), {"p": p, "id": target, "name": name})
        else:
            session.execute(text("""
                UPDATE budget_categories SET archived=true,entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:id
            """), {"p": p, "id": target})
        return [_change(session, p, "budget_category", target)]

    if action == "budget.create":
        keys = {"id", "category_id", "limit_minor", "recurrence", "from_month"}
        _shape(payload, keys | {"ends_before_month"}, keys)
        _versions(versions)
        recurrence = payload["recurrence"]
        if recurrence not in ("monthly", "once"):
            raise _reject("Неверная периодичность бюджета")
        start = _month(payload["from_month"])
        end = _month(payload["ends_before_month"]) if payload.get("ends_before_month") is not None else None
        if end is not None and end <= start:
            raise _reject("Неверная граница бюджета")
        target = _uuid(payload["id"])
        rule = {"id": target, "category_id": _category(session, p, payload["category_id"]),
                "limit_minor": _integer(payload["limit_minor"], 0, MAX_MINOR),
                "recurrence": recurrence, "from_month": start,
                "ends_before_month": end, "archived_from_month": None}
        _insert_rule(session, p, rule)
        return [_change(session, p, "budget_rule", target)]

    if action in ("budget.amend", "budget.archive"):
        keys = ({"rule_id", "effective_from_month", "replacement_id", "limit_minor"}
                if action.endswith("amend") else {"rule_id", "archived_from_month"})
        _shape(payload, keys, keys)
        target = _uuid(payload["rule_id"])
        row = _existing(session, p, "budget_rule", target)
        _versions(versions, target, row["entity_revision"])
        month = _month(payload["effective_from_month"] if action.endswith("amend")
                       else payload["archived_from_month"])
        left, right = _bounds(row)
        if not left <= _month_index(month) < right:
            raise _conflict("Лимит не действует в выбранном месяце")
        if action.endswith("archive"):
            if row["archived_from_month"] is not None:
                raise _conflict("Лимит уже архивирован")
            session.execute(text("""
                UPDATE budget_rules SET archived_from_month=:month,entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:id
            """), {"p": p, "id": target, "month": month})
            return [_change(session, p, "budget_rule", target)]
        replacement = _uuid(payload["replacement_id"])
        amount = _integer(payload["limit_minor"], 0, MAX_MINOR)
        if month == row["from_month"]:
            if replacement != target:
                raise _reject("Изменение с начала сохраняет идентификатор")
            session.execute(text("""
                UPDATE budget_rules SET limit_minor=:amount,entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:id
            """), {"p": p, "id": target, "amount": amount})
            return [_change(session, p, "budget_rule", target)]
        _new(session, p, "budget_rule", replacement)
        session.execute(text("""
            UPDATE budget_rules SET ends_before_month=:month,entity_revision=entity_revision+1
            WHERE profile_id=:p AND id=:id
        """), {"p": p, "id": target, "month": month})
        rule = {k: row[k] for k in ("category_id", "recurrence", "ends_before_month", "archived_from_month")}
        rule.update(id=replacement, from_month=month, limit_minor=amount)
        _insert_rule(session, p, rule)
        return [_change(session, p, "budget_rule", target),
                _change(session, p, "budget_rule", replacement)]

    if action == "budget.category.assign":
        keys = {"transaction_id", "category_id"}
        _shape(payload, keys, keys)
        target = _uuid(payload["transaction_id"])
        tx = session.execute(text("""
            SELECT t.kind,t.entity_revision,
              (SELECT count(*) FROM ledger_postings x
                WHERE x.profile_id=t.profile_id AND x.transaction_id=t.id) AS posting_count,
              (SELECT sum(x.signed_minor) FROM ledger_postings x
                WHERE x.profile_id=t.profile_id AND x.transaction_id=t.id) AS amount,
              EXISTS (SELECT 1 FROM ledger_transactions r
                WHERE r.profile_id=t.profile_id AND r.reversed_transaction_id=t.id) AS reversed,
              EXISTS (SELECT 1 FROM ledger_payment_links l
                WHERE l.profile_id=t.profile_id AND l.transaction_id=t.id) AS linked
            FROM ledger_transactions t WHERE t.profile_id=:p AND t.id=:id
        """), {"p": p, "id": target}).mappings().one_or_none()
        if (tx is None or tx["reversed"] or tx["posting_count"] != 1
                or tx["amount"] is None or tx["amount"] >= 0
                or not (tx["kind"] == "expense" or tx["kind"] == "payment" and tx["linked"])):
            raise _conflict("Операция не является подтверждённым расходом")
        _versions(versions, target, tx["entity_revision"])
        category = _category(session, p, payload["category_id"])
        before = _row(session, p, "budget_assignment", target)
        session.execute(text("""
            INSERT INTO budget_assignments (profile_id,id,category_id)
            VALUES (:p,:id,:category)
            ON CONFLICT (profile_id,id) DO UPDATE SET
                category_id=EXCLUDED.category_id,
                entity_revision=budget_assignments.entity_revision+1
        """), {"p": p, "id": target, "category": category})
        previous = before["category_id"] if before else None
        return [_change(session, p, "budget_assignment", target,
                        previous_category_id=str(previous) if previous else None)]

    raise _reject("Неизвестная бюджетная команда")


def get_budget_candidate_snapshot(engine: Engine, *, scope: VerifiedFinanceScope) -> FinanceResult:
    """Private read model until integrated client sync supports all three kinds."""
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        revision = session.execute(text("""
            SELECT revision FROM finance_profiles WHERE id=:p FOR SHARE
        """), {"p": scope.profile_id}).scalar_one_or_none()
        if revision is None:
            raise FinanceCommandError("forbidden", "Нет доступа к финансовому профилю", 403)
        entities = []
        for kind, table in _TABLES.items():
            rows = session.execute(text(
                "SELECT * FROM " + table + " WHERE profile_id=:p ORDER BY id LIMIT 5001"
            ), {"p": scope.profile_id}).mappings().all()
            if len(rows) > 5000:
                raise FinanceCommandError("service_unavailable", "Бюджетный снимок превышает лимит", 503)
            entities.extend(_entity(kind, row) for row in rows)
        return FinanceResult(200, {"schema_version": 2, "profile_id": str(scope.profile_id),
                                   "revision": revision, "entities": entities},
                             _opaque_etag(scope.profile_id, revision))
