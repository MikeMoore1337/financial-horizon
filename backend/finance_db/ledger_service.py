"""Transactional account-ledger command core for #67 (feature OFF).

Do NOT mount directly on production or accept scope IDs from HTTP.
A trusted auth adapter must resolve the FH email session before invoking this.
Only the approved v1 planning/transfer/reverse commands may be exposed as v1 routes;
the other actions below are internal v2 candidates for review.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha256
import json
import re
from typing import Any, Mapping
from uuid import UUID, uuid4, uuid5
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from .db import finance_transaction

MAX_MINOR = 1_000_000_000_000
MAX_COMMAND_BYTES = 32_768
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_STRONG_ETAG_RE = re.compile(r'^"[^"\r\n]{1,254}"$')
_TYPES = frozenset(("bank", "card", "cash", "savings", "other"))
_INTERNAL_ACTIONS = frozenset((
    "obligation.create", "account.create", "account.update", "account.archive", "account.unarchive",
    "transaction.record", "account.transfer", "transaction.reverse",
    "settlement.payment.record", "loan.payment.record",
    "settlement.payment.void", "loan.payment.void", "reserve.allocate",
))
_PUBLIC_V1_ACTIONS = frozenset(("obligation.create", "account.transfer", "reserve.allocate", "transaction.reverse"))
# The proposed v2 transport has a deliberately narrower whitelist than internal
# commands. No v2 HTTP route is mounted, and the default callable remains v1.
_PUBLIC_V2_ACCOUNT_ACTIONS = frozenset((
    "account.create", "account.update", "account.archive", "account.unarchive",
    "transaction.record", "settlement.payment.record", "loan.payment.record",
    "settlement.payment.void", "loan.payment.void",
))


class FinanceCommandError(ValueError):
    """A typed, non-sensitive error with public HTTP status and code."""

    def __init__(self, code: str, message: str, status: int,
                 server_revision: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.server_revision = server_revision


@dataclass(frozen=True, slots=True)
class VerifiedFinanceScope:
    """Populated only from authenticated backend state, not caller JSON."""
    user_id: str
    profile_id: UUID


@dataclass(frozen=True, slots=True)
class FinanceResult:
    status: int
    body: dict[str, Any]
    etag: str


def _reject(msg: str = "Некорректная финансовая команда") -> FinanceCommandError:
    return FinanceCommandError("invalid_command", msg, 422)


def _uuid(value: object) -> UUID:
    if not isinstance(value, str) or not _UUID_RE.fullmatch(value):
        raise _reject("Ожидался канонический UUID")
    return UUID(value)


def _integer(value: object, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise _reject("Сумма или ревизия вне допустимого диапазона")
    return value


def _date(value: object) -> date:
    if not isinstance(value, str) or len(value) != 10:
        raise _reject("Неверная календарная дата")
    try:
        d = date.fromisoformat(value)
        if d.isoformat() != value:
            raise ValueError()
        return d
    except ValueError:
        raise _reject("Неверная календарная дата") from None


def _shape(value: object, fields: set[str], required: set[str]) -> Mapping[str, Any]:
    if not isinstance(value, dict) or (set(value) - fields) or not required.issubset(value):
        raise _reject("Недопустимая структура финансовой команды")
    return value


def _expect_versions(value: object) -> dict[str, int]:
    if not isinstance(value, dict) or len(value) > 100:
        raise _reject("Недопустимые ревизии зависимых сущностей")
    versions: dict[str, int] = {}
    for key, v in value.items():
        versions[str(_uuid(key))] = _integer(v, 1, (1 << 63) - 1)
    return versions


def _require_revision(versions: Mapping[str, int], entity_id: UUID, actual: int) -> None:
    if versions.get(str(entity_id)) != actual:
        raise FinanceCommandError(
            "semantic_conflict", "Запись изменилась на другом устройстве", 409
        )


def _opaque_etag(profile_id: UUID, revision: int) -> str:
    # Stable, strong version tag. It is not an authentication token.
    digest = sha256(profile_id.bytes + revision.to_bytes(8, "big")).hexdigest()[:16]
    return f'"fh.1.{revision}.{digest}"'


def _safe_balance(amount: object) -> int:
    # PostgreSQL SUM(bigint) returns NUMERIC. Never serialize money as float or
    # more than JavaScript's safe integer boundary into the public API.
    if amount is None:
        raise FinanceCommandError("invalid_command", "Нет расчётного остатка", 422)
    value = int(amount)
    if value != amount or not -(2**53 - 1) <= value <= (2**53 - 1):
        raise FinanceCommandError("invalid_command", "Остаток вне допустимого диапазона", 422)
    return value


def derive_verified_scope(verified_user_id: str, server_namespace: UUID) -> VerifiedFinanceScope:
    """Stable opaque profile UUID derived ONLY after session verification."""
    if (not isinstance(verified_user_id, str)
        or not re.fullmatch(r"[0-9a-f]{32}", verified_user_id)):
        raise ValueError("A verified FH auth session is required")
    if not isinstance(server_namespace, UUID):
        raise ValueError("Server profile namespace must be configured")
    return VerifiedFinanceScope(
        verified_user_id,
        uuid5(server_namespace, "financial-horizon:finance-profile:v1:" + verified_user_id),
    )


def ensure_verified_profile(
    engine: Engine, *, verified_user_id: str, server_namespace: UUID,
) -> VerifiedFinanceScope:
    """Create one stable finance profile on first login, with no privileged role.

    The namespace MUST be a stable server-side deployment setting, backed up
    alongside recovery materials. Not a user-entered UUID or secret token.
    Only call after actual AuthStore.current() authenticated this principal.
    """
    scope = derive_verified_scope(verified_user_id, server_namespace)
    profile_id = scope.profile_id
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        # RLS FOR ALL, including INSERT and ON CONFLICT, still applies.
        # The exact same principal gets the same UUID on concurrent logins.
        session.execute(text("""
            INSERT INTO finance_profiles (id,owner_user_id,currency)
            VALUES (:id,:user,'RUB') ON CONFLICT (id) DO NOTHING
        """), {"id": profile_id, "user": verified_user_id})
        owner = session.execute(text("""
            SELECT owner_user_id FROM finance_profiles WHERE id=:id
        """), {"id": profile_id}).scalar_one_or_none()
        if owner != verified_user_id:
            raise FinanceCommandError("forbidden", "Нет доступа к финансовому профилю", 403)
    return scope


def _validated(command: object, if_match: str, idem_key: str,
               *, allow_internal: bool, allow_account_v2: bool = False,
               ) -> tuple[Mapping[str, Any], UUID, int, dict[str, int], bytes]:
    body = _shape(command, {
        "schema_version", "client_mutation_id", "base_revision", "action",
        "expected_entity_revisions", "payload",
    }, {
        "schema_version", "client_mutation_id", "base_revision", "action",
        "expected_entity_revisions", "payload",
    })
    if type(body["schema_version"]) is not int:
        raise _reject("Неподдерживаемая версия схемы")
    version = body["schema_version"]
    if version == 1 and not allow_account_v2:
        actions = _INTERNAL_ACTIONS if allow_internal else _PUBLIC_V1_ACTIONS
    elif version == 2 and allow_account_v2 and not allow_internal:
        actions = _PUBLIC_V2_ACCOUNT_ACTIONS
    else:
        raise _reject("Неподдерживаемая версия схемы")
    action = body["action"]
    if not isinstance(action, str) or action not in actions:
        raise _reject("Команда недоступна в этой версии API")
    mutation_id = _uuid(body["client_mutation_id"])
    if _uuid(idem_key) != mutation_id:
        raise _reject("Idempotency-Key не совпадает с идентификатором команды")
    if not isinstance(if_match, str) or not _STRONG_ETAG_RE.fullmatch(if_match):
        raise FinanceCommandError("precondition_required", "Требуется сильный If-Match", 428)
    revision = _integer(body["base_revision"], 0, (1 << 63) - 1)
    versions = _expect_versions(body["expected_entity_revisions"])
    if not isinstance(body["payload"], dict):
        raise _reject("Некорректные данные команды")
    try:
        serialized = json.dumps({"request": body, "if_match": if_match},
                                ensure_ascii=False, sort_keys=True,
                                separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, OverflowError):
        raise _reject("Некорректные данные команды") from None
    if len(serialized) > MAX_COMMAND_BYTES:
        raise _reject("Слишком большой финансовый запрос")
    return body, mutation_id, revision, versions, sha256(serialized).digest()


def _profile_lock(session: Session, profile_id: UUID) -> int:
    row = session.execute(text(
        "SELECT revision FROM finance_profiles WHERE id=:id FOR UPDATE"
    ), {"id": profile_id}).mappings().one_or_none()
    if row is None:
        raise FinanceCommandError("forbidden", "Нет доступа к финансовому профилю", 403)
    return int(row["revision"])


def _account(session: Session, profile_id: UUID, account_id: UUID, versions: Mapping[str, int],
             *, archived: bool = False) -> Mapping[str, Any]:
    row = session.execute(text("""
        SELECT id,entity_revision,archived_at FROM accounts
        WHERE profile_id=:p AND id=:id FOR UPDATE
    """), {"p": profile_id, "id": account_id}).mappings().one_or_none()
    if not row or (not archived and row["archived_at"] is not None):
        raise FinanceCommandError("semantic_conflict", "Счёт недоступен", 409)
    _require_revision(versions, account_id, row["entity_revision"])
    return row


def _change(revision: int, kind: str, target: UUID, entity_revision: int,
            payload: dict[str, Any]) -> dict[str, Any]:
    return {"revision": revision, "ordinal": 0, "kind": kind,
            "entity_id": str(target), "entity_revision": entity_revision,
            "payload": payload}


def _post(session: Session, p: UUID, txid: UUID, kind: str, actor: str,
          occurred_on: date, postings: list[tuple[UUID, int]],
          *, reversed_id: UUID | None = None, note: str | None = None) -> None:
    session.execute(text("""
        INSERT INTO ledger_transactions
        (profile_id,id,kind,occurred_on,actor_user_id,reversed_transaction_id,note)
        VALUES (:p,:t,:kind,:d,:actor,:r,:note)
    """), {"p": p, "t": txid, "kind": kind, "d": occurred_on,
           "actor": actor, "r": reversed_id, "note": note})
    for acc, amount in postings:
        session.execute(text("""
            INSERT INTO ledger_postings (profile_id,transaction_id,account_id,signed_minor)
            VALUES (:p,:t,:a,:v)
        """), {"p": p, "t": txid, "a": acc, "v": amount})
        session.execute(text("""
            UPDATE accounts SET entity_revision=entity_revision+1, updated_at=now()
            WHERE profile_id=:p AND id=:a
        """), {"p": p, "a": acc})
        if amount < 0:
            # Earmarked cash is not available for an ordinary debit. Check
            # after inserting the actual posting, but BEFORE COMMIT. The
            # caller's profile FOR UPDATE lock serializes all competing
            # reserve allocations/transfers. A rejection rolls back both
            # ledger rows and the idempotency receipt.
            result = session.execute(text("""
                SELECT a.opening_minor + COALESCE((
                    SELECT SUM(t.signed_minor) FROM ledger_postings t
                    WHERE t.profile_id=a.profile_id AND t.account_id=a.id
                ),0) AS balance_minor,
                COALESCE((
                    SELECT SUM(r.delta_minor) FROM reserve_allocations r
                    WHERE r.profile_id=a.profile_id AND r.account_id=a.id
                ),0) AS reserved_minor
                FROM accounts a WHERE a.profile_id=:p AND a.id=:a
            """), {"p": p, "a": acc}).mappings().one()
            reserved = _safe_balance(result["reserved_minor"])
            if reserved < 0:
                raise FinanceCommandError(
                    "service_unavailable", "Повреждён остаток резерва", 503
                )
            # Preserve existing permitted-overdraft behavior for accounts
            # without reservations; only protect funds explicitly earmarked.
            if reserved > 0 and _safe_balance(result["balance_minor"]) < reserved:
                raise FinanceCommandError(
                    "semantic_conflict", "Средства уже зарезервированы", 409
                )


def _account_sync_entity(session: Session, profile_id: UUID, account_id: UUID) -> dict[str, Any]:
    """Full account entity at the *committed revision*, including both balances."""
    row = session.execute(text("""
        SELECT a.id,a.entity_revision,a.name,a.kind,a.currency,a.opening_minor,a.archived_at,
          a.opening_minor + COALESCE((
            SELECT SUM(p.signed_minor) FROM ledger_postings p
            WHERE p.profile_id=a.profile_id AND p.account_id=a.id
          ), 0) AS balance_minor,
          COALESCE((
            SELECT SUM(r.delta_minor) FROM reserve_allocations r
            WHERE r.profile_id=a.profile_id AND r.account_id=a.id
          ), 0) AS reserved_minor
        FROM accounts a WHERE a.profile_id=:p AND a.id=:id
    """), {"p": profile_id, "id": account_id}).mappings().one()
    balance = _safe_balance(row["balance_minor"])
    reserved = _safe_balance(row["reserved_minor"])
    available = _safe_balance(balance - reserved)
    return {
        "id": str(row["id"]), "entity_revision": int(row["entity_revision"]),
        "kind": "account",
        "data": {
            "name": row["name"], "type": row["kind"],
            "currency": row["currency"].strip(),
            "opening_minor": int(row["opening_minor"]),
            "balance_minor": balance, "reserved_minor": reserved,
            "available_minor": available,
            "archived_at": row["archived_at"].isoformat() if row["archived_at"] else None,
        },
    }


_MAX_RESERVE_PAIRS_PER_PAGE = 10_000


def _reserve_pairs(
    session: Session, profile_id: UUID, reserve_ids: list[UUID],
) -> dict[UUID, list[dict[str, Any]]]:
    """Full nonzero allocation by (reserve, account), sorted and RLS-scoped.

    Never silently truncate: a profile requiring more than this bound needs an
    explicitly paged protocol extension before production activation.
    """
    breakdown: dict[UUID, list[dict[str, Any]]] = {key: [] for key in reserve_ids}
    if not reserve_ids:
        return breakdown
    rows = session.execute(text("""
        SELECT reserve_id,account_id,SUM(delta_minor) AS amount
        FROM reserve_allocations
        WHERE profile_id=:p AND reserve_id=ANY(:ids)
        GROUP BY reserve_id,account_id
        HAVING SUM(delta_minor)<>0
        ORDER BY reserve_id,account_id
        LIMIT :limit
    """), {
        "p": profile_id, "ids": reserve_ids,
        "limit": _MAX_RESERVE_PAIRS_PER_PAGE + 1,
    }).mappings().all()
    if len(rows) > _MAX_RESERVE_PAIRS_PER_PAGE:
        raise FinanceCommandError(
            "service_unavailable", "Требуется постраничная загрузка резервов", 503
        )
    for row in rows:
        amount = _safe_balance(row["amount"])
        if amount <= 0 or row["reserve_id"] not in breakdown:
            raise FinanceCommandError(
                "service_unavailable", "Неполное распределение резерва", 503
            )
        breakdown[row["reserve_id"]].append({
            "account_id": str(row["account_id"]), "allocated_minor": amount,
        })
    return breakdown


def _reserve_sync_entity(session: Session, profile_id: UUID, reserve_id: UUID) -> dict[str, Any]:
    """Full server-owned reserve image including the committed allocation total."""
    row = session.execute(text("""
        SELECT r.id,r.entity_revision,r.title,r.target_minor,r.target_on,r.archived_at,
          COALESCE((SELECT SUM(a.delta_minor) FROM reserve_allocations a
            WHERE a.profile_id=r.profile_id AND a.reserve_id=r.id),0) AS allocated_minor
        FROM reserves r WHERE r.profile_id=:p AND r.id=:id
    """), {"p": profile_id, "id": reserve_id}).mappings().one()
    return {
        "id": str(row["id"]), "entity_revision": int(row["entity_revision"]),
        "kind": "reserve",
        "data": {
            "title": row["title"], "target_minor": int(row["target_minor"]),
            "target_on": row["target_on"].isoformat() if row["target_on"] else None,
            "archived_at": row["archived_at"].isoformat() if row["archived_at"] else None,
            "allocated_minor": _safe_balance(row["allocated_minor"]),
            "allocations_by_account": _reserve_pairs(
                session, profile_id, [reserve_id]
            )[reserve_id],
        },
    }


def _transaction_sync_entity(session: Session, profile_id: UUID, txid: UUID) -> dict[str, Any]:
    """Immutable transaction with exact historical date and complete signed effects."""
    row = session.execute(text("""
        SELECT id,kind,occurred_on,note,posted_at,reversed_transaction_id,entity_revision
        FROM ledger_transactions WHERE profile_id=:p AND id=:id
    """), {"p": profile_id, "id": txid}).mappings().one()
    postings = session.execute(text("""
        SELECT account_id,signed_minor FROM ledger_postings
        WHERE profile_id=:p AND transaction_id=:id ORDER BY account_id
    """), {"p": profile_id, "id": txid}).mappings().all()
    data = {
        "kind": row["kind"], "occurred_on": row["occurred_on"].isoformat(),
        "note": row["note"], "posted_at": row["posted_at"].isoformat(),
        "reversed_transaction_id": (
            str(row["reversed_transaction_id"]) if row["reversed_transaction_id"] else None
        ),
        "postings": [
            {"account_id": str(item["account_id"]), "signed_minor": int(item["signed_minor"])}
            for item in postings
        ],
    }
    link = session.execute(text("""
        SELECT settlement_id,loan_payment_id FROM ledger_payment_links
        WHERE profile_id=:p AND transaction_id=:id
    """), {"p": profile_id, "id": txid}).mappings().one_or_none()
    if link:
        data["payment_link"] = {
            "settlement_id": str(link["settlement_id"]) if link["settlement_id"] else None,
            "loan_payment_id": str(link["loan_payment_id"]) if link["loan_payment_id"] else None,
        }
    return {
        "id": str(row["id"]), "entity_revision": int(row["entity_revision"]),
        "kind": "transaction", "data": data,
    }


def _payment_fact_sync_entity(
    session: Session, profile_id: UUID, fact_id: UUID, *, settlement: bool,
) -> dict[str, Any]:
    """Complete fact image matching the authoritative /state and /changes schema."""
    if settlement:
        row = session.execute(text("""
            SELECT id,entity_revision,obligation_id,occurrence_on,paid_on,
                   amount_minor,voided_at FROM settlements
            WHERE profile_id=:p AND id=:fact
        """), {"p": profile_id, "fact": fact_id}).mappings().one()
        data = {
            "obligation_id": str(row["obligation_id"]),
            "occurrence_on": row["occurrence_on"].isoformat(),
            "paid_on": row["paid_on"].isoformat(),
            "amount_minor": int(row["amount_minor"]),
            "voided_at": row["voided_at"].isoformat() if row["voided_at"] else None,
        }
        kind = "settlement"
    else:
        row = session.execute(text("""
            SELECT id,entity_revision,loan_id,paid_on,amount_minor,
                   strategy,voided_at FROM loan_payments
            WHERE profile_id=:p AND id=:fact
        """), {"p": profile_id, "fact": fact_id}).mappings().one()
        data = {
            "loan_id": str(row["loan_id"]),
            "paid_on": row["paid_on"].isoformat(),
            "amount_minor": int(row["amount_minor"]),
            "strategy": row["strategy"],
            "voided_at": row["voided_at"].isoformat() if row["voided_at"] else None,
        }
        kind = "loan_payment"
    return {
        "id": str(row["id"]), "entity_revision": int(row["entity_revision"]),
        "kind": kind, "data": data,
    }


def _apply(session: Session, scope: VerifiedFinanceScope, cmd: Mapping[str, Any],
           versions: Mapping[str, int], new_revision: int) -> dict[str, Any]:
    p = scope.profile_id
    payload = cmd["payload"]
    action = cmd["action"]
    target: UUID
    affected_revision: int
    change_kind = "upsert"
    change_payload: dict[str, Any] = {}
    extra_changes: list[tuple[str, UUID, int, dict[str, Any]]] = []

    if action == "obligation.create":
        required = {
            "title", "direction", "amount_minor", "starts_on",
            "timezone", "recurrence_unit", "recurrence_every",
        }
        _shape(payload, required, required)
        if versions:
            raise _reject("Создание обязательства не имеет предыдущих ревизий сущностей")
        title = payload["title"]
        if not isinstance(title, str) or not title.strip() or len(title) > 160:
            raise _reject("Некорректное название обязательства")
        direction = payload["direction"]
        if not isinstance(direction, str) or direction not in ("income", "expense"):
            raise _reject("Недопустимое направление обязательства")
        amount = _integer(payload["amount_minor"], 0, MAX_MINOR)
        starts = _date(payload["starts_on"])
        tz = payload["timezone"]
        if not isinstance(tz, str) or not 1 <= len(tz) <= 64:
            raise _reject("Недопустимый часовой пояс")
        try:
            ZoneInfo(tz)
        except (ValueError, KeyError, ZoneInfoNotFoundError):
            raise _reject("Недопустимый часовой пояс") from None
        recurrence = payload["recurrence_unit"]
        if not isinstance(recurrence, str) or recurrence not in ("none", "month", "year"):
            raise _reject("Недопустимая периодичность")
        every = _integer(payload["recurrence_every"], 1, 120)
        target = uuid4()  # Server-generated entity ID retained in the stored receipt.
        session.execute(text("""
            INSERT INTO obligations
              (profile_id,id,title,direction,amount_minor,starts_on,
               timezone,recurrence_unit,recurrence_every)
            VALUES (:p,:id,:title,:direction,:amount,:starts,:tz,:recurrence,:every)
        """), {
            "p": p, "id": target, "title": title.strip(),
            "direction": direction, "amount": amount, "starts": starts,
            "tz": tz, "recurrence": recurrence, "every": every,
        })
        affected_revision = 1
        change_payload = {
            "entity": {
                "id": str(target), "kind": "obligation", "entity_revision": 1,
                "data": {
                    "title": title.strip(), "direction": direction,
                    "amount_minor": amount, "starts_on": starts.isoformat(),
                    "timezone": tz, "recurrence_unit": recurrence,
                    "recurrence_every": every, "category": None,
                    "deleted_at": None,
                },
            },
        }
    elif action == "account.create":
        _shape(payload, {"id", "name", "kind", "currency", "opening_minor"},
               {"id", "name", "kind", "currency", "opening_minor"})
        target = _uuid(payload["id"])
        name = payload["name"]
        if not isinstance(name, str) or not name.strip() or len(name) > 160:
            raise _reject("Некорректное название счёта")
        if not isinstance(payload["kind"], str) or payload["kind"] not in _TYPES or payload["currency"] != "RUB":
            raise _reject("Недоступный тип или валюта счёта")
        opening = _integer(payload["opening_minor"], -MAX_MINOR, MAX_MINOR)
        session.execute(text("""
            INSERT INTO accounts (profile_id,id,name,kind,currency,opening_minor)
            VALUES (:p,:id,:name,:kind,'RUB',:opening)
        """), {"p": p, "id": target, "name": name.strip(),
               "kind": payload["kind"], "opening": opening})
        affected_revision = 1
        change_payload = {"kind": "account", "name": name.strip(), "type": payload["kind"],
                          "currency": "RUB", "opening_minor": opening}
    elif action in ("account.update", "account.archive", "account.unarchive"):
        expected = {"account_id"} | ({"name", "kind"} if action == "account.update" else set())
        _shape(payload, expected, expected)
        target = _uuid(payload["account_id"])
        # Archive is a read-only state for account metadata until explicitly restored.
        # Keep archive/unarchive transitions revision-checked and accessible.
        entity = _account(session, p, target, versions,
                          archived=action != "account.update")
        if action == "account.update":
            name = payload["name"]
            if (not isinstance(name, str) or not name.strip() or len(name) > 160
                or not isinstance(payload["kind"], str) or payload["kind"] not in _TYPES):
                raise _reject("Некорректные параметры счёта")
            session.execute(text("""
                UPDATE accounts SET name=:name,kind=:kind,
                  entity_revision=entity_revision+1,updated_at=now()
                WHERE profile_id=:p AND id=:id
            """), {"p": p, "id": target, "name": name.strip(), "kind": payload["kind"]})
            change_payload = {"name": name.strip(), "type": payload["kind"]}
        else:
            if (entity["archived_at"] is not None) == (action == "account.archive"):
                raise FinanceCommandError("semantic_conflict", "Счёт уже в указанном состоянии", 409)
            session.execute(text("""
                UPDATE accounts SET archived_at=:time,
                    entity_revision=entity_revision+1,updated_at=now()
                WHERE profile_id=:p AND id=:id
            """), {"p": p, "id": target,
                   "time": datetime.now(timezone.utc) if action == "account.archive" else None})
            change_payload = {"archived": action == "account.archive"}
        affected_revision = int(entity["entity_revision"]) + 1
    elif action == "transaction.record":
        _shape(payload, {"id", "account_id", "kind", "signed_minor", "occurred_on", "note"},
               {"id", "account_id", "kind", "signed_minor", "occurred_on"})
        target = _uuid(payload["id"])
        acc = _uuid(payload["account_id"])
        kind = payload["kind"]
        amount = _integer(payload["signed_minor"], -MAX_MINOR, MAX_MINOR)
        if kind not in ("income", "expense", "adjustment") or amount == 0:
            raise _reject("Некорректная финансовая операция")
        if (kind == "income" and amount < 0) or (kind == "expense" and amount > 0):
            raise _reject("Несогласованный знак дохода или расхода")
        _account(session, p, acc, versions)
        note = payload.get("note")
        if note is not None and (not isinstance(note, str) or len(note) > 500):
            raise _reject("Некорректное примечание")
        _post(session, p, target, kind, scope.user_id,
              _date(payload["occurred_on"]), [(acc, amount)], note=note)
        affected_revision = 1
        change_kind = "ledger_posted"
        change_payload = {"account_id": str(acc), "signed_minor": amount,
                          "transaction_kind": kind}
    elif action in ("settlement.payment.record", "loan.payment.record"):
        is_settlement = action == "settlement.payment.record"
        required = ({
            "transaction_id", "fact_id", "account_id", "amount_minor",
            "paid_on", "obligation_id", "occurrence_on",
        } if is_settlement else {
            "transaction_id", "fact_id", "account_id", "amount_minor",
            "paid_on", "loan_id", "strategy",
        })
        _shape(payload, required, required)
        target = _uuid(payload["transaction_id"])
        fact_id = _uuid(payload["fact_id"])
        acc = _uuid(payload["account_id"])
        amount = _integer(payload["amount_minor"], 1, MAX_MINOR)
        paid_on = _date(payload["paid_on"])
        _account(session, p, acc, versions)
        fact_source = _uuid(payload["obligation_id"] if is_settlement else payload["loan_id"])
        if is_settlement:
            source = session.execute(text("""
                SELECT direction,entity_revision,deleted_at FROM obligations
                WHERE profile_id=:p AND id=:id FOR UPDATE
            """), {"p": p, "id": fact_source}).mappings().one_or_none()
            if not source or source["deleted_at"] is not None:
                raise FinanceCommandError("semantic_conflict",
                                          "Обязательство недоступно", 409)
            _require_revision(versions, fact_source, source["entity_revision"])
            occurrence = _date(payload["occurrence_on"])
            if source["direction"] not in ("income", "expense"):
                raise _reject("Неизвестное направление обязательства")
            signed = amount if source["direction"] == "income" else -amount
            session.execute(text("""
                INSERT INTO settlements
                  (profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor)
                VALUES (:p,:id,:source,:occurrence,:date,:amount)
            """), {
                "p": p, "id": fact_id, "source": fact_source,
                "occurrence": occurrence, "date": paid_on, "amount": amount,
            })
            link_field = "settlement_id"
            fact_kind = "settlement"
            fact_payload = {
                "kind": fact_kind, "obligation_id": str(fact_source),
                "occurrence_on": occurrence.isoformat(),
                "paid_on": paid_on.isoformat(), "amount_minor": amount,
                "direction": source["direction"], "voided_at": None,
                "entity": {
                    "id": str(fact_id), "entity_revision": 1, "kind": "settlement",
                    "data": {
                        "obligation_id": str(fact_source),
                        "occurrence_on": occurrence.isoformat(),
                        "paid_on": paid_on.isoformat(), "amount_minor": amount,
                        "voided_at": None,
                    },
                },
            }
        else:
            source = session.execute(text("""
                SELECT entity_revision,deleted_at FROM loans
                WHERE profile_id=:p AND id=:id FOR UPDATE
            """), {"p": p, "id": fact_source}).mappings().one_or_none()
            if not source or source["deleted_at"] is not None:
                raise FinanceCommandError("semantic_conflict",
                                          "Кредит недоступен", 409)
            _require_revision(versions, fact_source, source["entity_revision"])
            strategy = payload["strategy"]
            if not isinstance(strategy, str) or strategy not in ("term", "amount"):
                raise _reject("Неверная стратегия кредитного платежа")
            signed = -amount
            session.execute(text("""
                INSERT INTO loan_payments
                  (profile_id,id,loan_id,paid_on,amount_minor,strategy)
                VALUES (:p,:id,:source,:date,:amount,:strategy)
            """), {
                "p": p, "id": fact_id, "source": fact_source,
                "date": paid_on, "amount": amount, "strategy": strategy,
            })
            link_field = "loan_payment_id"
            fact_kind = "loan_payment"
            fact_payload = {
                "kind": fact_kind, "loan_id": str(fact_source),
                "paid_on": paid_on.isoformat(),
                "amount_minor": amount, "strategy": strategy,
                "voided_at": None,
                "entity": {
                    "id": str(fact_id), "entity_revision": 1, "kind": "loan_payment",
                    "data": {
                        "loan_id": str(fact_source), "paid_on": paid_on.isoformat(),
                        "amount_minor": amount, "strategy": strategy, "voided_at": None,
                    },
                },
            }
        _post(session, p, target, "payment", scope.user_id, paid_on,
              [(acc, signed)])
        # Both fact types have their own profile-scoped unique constraints;
        # SQL deferred triggers validate the payment sign and exact amount.
        if link_field == "settlement_id":
            session.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,settlement_id)
                VALUES (:p,:tx,:fact)
            """), {"p": p, "tx": target, "fact": fact_id})
        else:
            session.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,loan_payment_id)
                VALUES (:p,:tx,:fact)
            """), {"p": p, "tx": target, "fact": fact_id})
        affected_revision = 1
        change_kind = "ledger_posted"
        change_payload = {
            "transaction_kind": "payment",
            "account_id": str(acc), "signed_minor": signed,
            link_field: str(fact_id),
        }
        extra_changes.append(("upsert", fact_id, 1, fact_payload))
    elif action in ("settlement.payment.void", "loan.payment.void"):
        # A payment fact and its cash movement cannot be cancelled in separate
        # commits. The new Alembic 0002 deferred SQL triggers reject either
        # half of a compensation, even if a trusted caller bypasses this code.
        is_settlement = action == "settlement.payment.void"
        _shape(payload, {"transaction_id", "fact_id", "account_id", "reason"},
               {"transaction_id", "fact_id", "account_id", "reason"})
        original_id = _uuid(payload["transaction_id"])
        fact_id = _uuid(payload["fact_id"])
        acc_id = _uuid(payload["account_id"])
        reason = payload["reason"]
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
            raise _reject("Укажите причину отмены оплаты")

        # Profile row FOR UPDATE in submit_account_command serializes all
        # competing commands. Every ID below is additionally profile-scoped.
        link = session.execute(text("""
            SELECT link.settlement_id,link.loan_payment_id,
                   tx.kind,tx.entity_revision
            FROM ledger_payment_links link
            JOIN ledger_transactions tx
              ON tx.profile_id=link.profile_id AND tx.id=link.transaction_id
            WHERE link.profile_id=:p AND link.transaction_id=:tx
        """), {"p": p, "tx": original_id}).mappings().one_or_none()
        if (link is None or link["kind"] != "payment"
            or (link["settlement_id"] if is_settlement else link["loan_payment_id"]) != fact_id
            or (link["loan_payment_id"] if is_settlement else link["settlement_id"]) is not None):
            raise FinanceCommandError("semantic_conflict", "Связанная оплата недоступна", 409)
        _require_revision(versions, original_id, link["entity_revision"])
        already = session.execute(text("""
            SELECT 1 FROM ledger_transactions
            WHERE profile_id=:p AND reversed_transaction_id=:tx
        """), {"p": p, "tx": original_id}).first()
        if already:
            raise FinanceCommandError("semantic_conflict", "Оплата уже отменена", 409)

        # Use two static SQL statements. Never build table names even from an
        # internal enum: this boundary must remain auditable by AppSec tools.
        if is_settlement:
            fact = session.execute(text("""
                SELECT entity_revision,voided_at FROM settlements
                WHERE profile_id=:p AND id=:fact FOR UPDATE
            """), {"p": p, "fact": fact_id}).mappings().one_or_none()
        else:
            fact = session.execute(text("""
                SELECT entity_revision,voided_at FROM loan_payments
                WHERE profile_id=:p AND id=:fact FOR UPDATE
            """), {"p": p, "fact": fact_id}).mappings().one_or_none()
        if fact is None or fact["voided_at"] is not None:
            raise FinanceCommandError("semantic_conflict", "Факт оплаты уже аннулирован", 409)
        _require_revision(versions, fact_id, fact["entity_revision"])
        account = _account(session, p, acc_id, versions, archived=True)
        original_posting = session.execute(text("""
            SELECT account_id,signed_minor FROM ledger_postings
            WHERE profile_id=:p AND transaction_id=:tx
        """), {"p": p, "tx": original_id}).mappings().all()
        if (len(original_posting) != 1
            or original_posting[0]["account_id"] != account["id"]):
            raise FinanceCommandError("semantic_conflict",
                                      "Счёт исходной оплаты не совпадает", 409)
        original_minor = _safe_balance(original_posting[0]["signed_minor"])
        if original_minor == 0 or abs(original_minor) > MAX_MINOR:
            raise FinanceCommandError("semantic_conflict", "Повреждённая оплата", 409)

        target = uuid4()
        # Guarded SQL columns allow only a one-time void of this fact.
        if is_settlement:
            session.execute(text("""
                UPDATE settlements SET voided_at=now(),
                  entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:fact
            """), {"p": p, "fact": fact_id})
        else:
            session.execute(text("""
                UPDATE loan_payments SET voided_at=now(),
                  entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:fact
            """), {"p": p, "fact": fact_id})
        _post(session, p, target, "reversal", scope.user_id,
              datetime.now(timezone.utc).date(), [(acc_id, -original_minor)],
              reversed_id=original_id, note=reason.strip())
        affected_revision = 1
        change_kind = "ledger_posted"
        change_payload = {
            "transaction_kind": "reversal", "reversed_transaction_id": str(original_id),
            "account_id": str(acc_id),
        }
        next_fact_revision = int(fact["entity_revision"]) + 1
        extra_changes.append((
            "upsert", fact_id, next_fact_revision,
            {"entity": _payment_fact_sync_entity(
                session, p, fact_id, settlement=is_settlement,
            )},
        ))
    elif action == "reserve.allocate":
        required = {"reserve_id", "account_id", "delta_minor"}
        _shape(payload, required, required)
        target = _uuid(payload["reserve_id"])
        account_id = _uuid(payload["account_id"])
        delta = _integer(payload["delta_minor"], -MAX_MINOR, MAX_MINOR)
        if delta == 0:
            raise _reject("Нулевое изменение резерва запрещено")
        account = _account(session, p, account_id, versions)
        reserve = session.execute(text("""
            SELECT entity_revision,target_minor,archived_at FROM reserves
            WHERE profile_id=:p AND id=:id FOR UPDATE
        """), {"p": p, "id": target}).mappings().one_or_none()
        if reserve is None or reserve["archived_at"] is not None:
            raise FinanceCommandError("semantic_conflict", "Резерв недоступен", 409)
        _require_revision(versions, target, reserve["entity_revision"])
        pair = _safe_balance(session.execute(text("""
            SELECT COALESCE(SUM(delta_minor),0) FROM reserve_allocations
            WHERE profile_id=:p AND reserve_id=:reserve AND account_id=:account
        """), {"p": p, "reserve": target, "account": account_id}).scalar_one())
        reserve_total = _safe_balance(session.execute(text("""
            SELECT COALESCE(SUM(delta_minor),0) FROM reserve_allocations
            WHERE profile_id=:p AND reserve_id=:reserve
        """), {"p": p, "reserve": target}).scalar_one())
        account_reserved = _safe_balance(session.execute(text("""
            SELECT COALESCE(SUM(delta_minor),0) FROM reserve_allocations
            WHERE profile_id=:p AND account_id=:account
        """), {"p": p, "account": account_id}).scalar_one())
        account_balance = _safe_balance(session.execute(text("""
            SELECT a.opening_minor + COALESCE((
                SELECT SUM(t.signed_minor) FROM ledger_postings t
                WHERE t.profile_id=a.profile_id AND t.account_id=a.id
            ),0) FROM accounts a WHERE a.profile_id=:p AND a.id=:account
        """), {"p": p, "account": account_id}).scalar_one())
        if pair < 0 or reserve_total < 0 or account_reserved < 0:
            raise FinanceCommandError("service_unavailable", "Некорректный остаток резерва", 503)
        if pair + delta < 0:
            raise FinanceCommandError("semantic_conflict", "Недостаточно средств в указанном резерве", 409)
        if delta > 0 and (
            reserve_total + delta > int(reserve["target_minor"])
            or account_reserved + delta > account_balance
        ):
            raise FinanceCommandError("semantic_conflict", "Недостаточно доступных средств или превышена цель", 409)
        allocation_id = uuid4()
        session.execute(text("""
            INSERT INTO reserve_allocations(profile_id,id,reserve_id,account_id,delta_minor)
            VALUES (:p,:id,:reserve,:account,:delta)
        """), {
            "p": p, "id": allocation_id, "reserve": target,
            "account": account_id, "delta": delta,
        })
        session.execute(text("""
            UPDATE reserves SET entity_revision=entity_revision+1, updated_at=now()
            WHERE profile_id=:p AND id=:id
        """), {"p": p, "id": target})
        session.execute(text("""
            UPDATE accounts SET entity_revision=entity_revision+1, updated_at=now()
            WHERE profile_id=:p AND id=:id
        """), {"p": p, "id": account_id})
        affected_revision = int(reserve["entity_revision"]) + 1
        change_payload = {
            "allocation_id": str(allocation_id),
            "account_id": str(account_id), "delta_minor": delta,
            "entity": _reserve_sync_entity(session, p, target),
        }
        extra_changes.append((
            "upsert", account_id, int(account["entity_revision"]) + 1,
            {"entity": _account_sync_entity(session, p, account_id)},
        ))
    elif action == "account.transfer":
        _shape(payload, {"from_account_id", "to_account_id", "amount_minor", "occurred_on"},
               {"from_account_id", "to_account_id", "amount_minor", "occurred_on"})
        from_acc, to_acc = _uuid(payload["from_account_id"]), _uuid(payload["to_account_id"])
        if from_acc == to_acc:
            raise _reject("Перевод между одинаковыми счетами запрещён")
        amount = _integer(payload["amount_minor"], 1, MAX_MINOR)
        # Lock in stable order even with multiple concurrent transfers.
        for acc in sorted((from_acc, to_acc)):
            _account(session, p, acc, versions)
        target = uuid4()  # Server-minted transaction identity, not client controlled.
        _post(session, p, target, "transfer", scope.user_id,
              _date(payload["occurred_on"]), [(from_acc, -amount), (to_acc, amount)])
        affected_revision = 1
        change_kind = "ledger_posted"
        change_payload = {"from_account_id": str(from_acc), "to_account_id": str(to_acc),
                          "amount_minor": amount, "transaction_kind": "transfer"}
    elif action == "transaction.reverse":
        _shape(payload, {"transaction_id", "reason"}, {"transaction_id", "reason"})
        original_id = _uuid(payload["transaction_id"])
        reason = payload["reason"]
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
            raise _reject("Укажите причину отмены")
        original = session.execute(text("""
            SELECT id,kind,entity_revision FROM ledger_transactions
            WHERE profile_id=:p AND id=:id
        """), {"p": p, "id": original_id}).mappings().one_or_none()
        if original is None or original["kind"] in ("reversal", "payment"):
            raise FinanceCommandError("semantic_conflict",
                                      "Исходная операция недоступна для отдельной отмены", 409)
        _require_revision(versions, original_id, original["entity_revision"])
        already = session.execute(text("""
            SELECT id FROM ledger_transactions
            WHERE profile_id=:p AND reversed_transaction_id=:old
        """), {"p": p, "old": original_id}).first()
        if already:
            raise FinanceCommandError("semantic_conflict", "Операция уже отменена", 409)
        rows = session.execute(text("""
            SELECT account_id,signed_minor FROM ledger_postings
            WHERE profile_id=:p AND transaction_id=:old ORDER BY account_id
        """), {"p": p, "old": original_id}).all()
        if len(rows) not in (1, 2):
            raise FinanceCommandError("semantic_conflict", "Повреждён исходный журнал", 409)
        for row in rows:
            _account(session, p, row.account_id, versions, archived=True)
        target = uuid4()
        _post(session, p, target, "reversal", scope.user_id,
              datetime.now(timezone.utc).date(),
              [(row.account_id, -row.signed_minor) for row in rows],
              reversed_id=original_id, note=reason.strip())
        affected_revision = 1
        change_kind = "ledger_posted"
        change_payload = {"reversed_transaction_id": str(original_id),
                          "transaction_kind": "reversal"}
    else:
        raise _reject("Неизвестная финансовая команда")

    # Clients must be able to reconstruct /state from /changes without
    # inferring dates, posting signs, balances or account entity revisions.
    # Embed complete entity images in the *same* revision and receipt; never
    # advance the cursor based on incomplete financial postings.
    if change_kind == "ledger_posted":
        entity = _transaction_sync_entity(session, p, target)
        account_ids = sorted({
            UUID(item["account_id"]) for item in entity["data"]["postings"]
        })
        change_payload = {
            **change_payload,
            "entity": entity,
            "accounts": [_account_sync_entity(session, p, acc) for acc in account_ids],
        }
    elif action.startswith("account."):
        change_payload = {
            **change_payload,
            "entity": _account_sync_entity(session, p, target),
        }

    session.execute(text("""
        UPDATE finance_profiles SET revision=:r,updated_at=now() WHERE id=:p
    """), {"r": new_revision, "p": p})
    # A single profile revision may contain multiple logically coupled changes
    # (payment fact + signed ledger transaction). Never paginate half a revision.
    changes = [(change_kind, target, affected_revision, change_payload), *extra_changes]
    for ordinal, (kind, entity_id, entity_revision, event_payload) in enumerate(changes):
        audit_payload = {**event_payload, "_entity_revision": entity_revision}
        session.execute(text("""
            INSERT INTO change_log
              (profile_id,revision,ordinal,schema_version,kind,entity_id,payload)
            VALUES (:p,:r,:ordinal,1,:kind,:id,CAST(:payload AS jsonb))
        """), {
            "p": p, "r": new_revision, "ordinal": ordinal,
            "kind": kind, "id": entity_id,
            "payload": json.dumps(audit_payload, ensure_ascii=False),
        })
    return [
        {**_change(new_revision, kind, entity_id, entity_revision, event_payload),
         "ordinal": ordinal}
        for ordinal, (kind, entity_id, entity_revision, event_payload) in enumerate(changes)
    ]


def submit_account_command(
    engine: Engine, *, scope: VerifiedFinanceScope, command: object,
    if_match: str, idempotency_key: str, allow_internal: bool = False,
    allow_account_v2: bool = False,
) -> FinanceResult:
    """One RLS-protected SQL COMMIT for a validated finance command and its receipt.

    'allow_internal' is only for trusted existing v1 internal consumers.
    'allow_account_v2' is only for the validated, unmounted v2 account
    proposal, and never accepts other internal actions.
    Neither option may be set from an untrusted client request.
    """
    if allow_internal and allow_account_v2:
        raise ValueError("Internal and proposed public v2 modes are mutually exclusive")
    body, mutation_id, base_revision, versions, request_hash = _validated(
        command, if_match, idempotency_key, allow_internal=allow_internal,
        allow_account_v2=allow_account_v2,
    )
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        # A single profile row lock serializes writes across all devices.
        revision = _profile_lock(session, scope.profile_id)
        # Dedupe BEFORE checking stale ETag / entity versions.
        existing = session.execute(text("""
            SELECT request_sha256,status_code,committed_revision,response_body
            FROM command_receipts WHERE profile_id=:p AND client_mutation_id=:id
        """), {"p": scope.profile_id, "id": mutation_id}).mappings().one_or_none()
        if existing is not None:
            if bytes(existing["request_sha256"]) != request_hash:
                raise FinanceCommandError("idempotency_key_reuse",
                                          "Другая команда с этим идентификатором уже существует", 409)
            replay = dict(existing["response_body"])
            replay["replayed"] = True
            return FinanceResult(200, replay,
                                 _opaque_etag(scope.profile_id, existing["committed_revision"]))
        if if_match != _opaque_etag(scope.profile_id, revision):
            raise FinanceCommandError("stale_revision", "Снимок устарел", 412, revision)
        if base_revision != revision:
            raise FinanceCommandError("semantic_conflict",
                                      "Профиль изменился на другом устройстве", 409, revision)
        new_revision = revision + 1
        changes = _apply(session, scope, body, versions, new_revision)
        ack = {"schema_version": body["schema_version"], "client_mutation_id": str(mutation_id),
               "revision": new_revision, "replayed": False, "changes": changes}
        session.execute(text("""
            INSERT INTO command_receipts
            (profile_id,client_mutation_id,request_sha256,status_code,committed_revision,response_body)
            VALUES (:p,:id,:hash,201,:revision,CAST(:reply AS jsonb))
        """), {"p": scope.profile_id, "id": mutation_id, "hash": request_hash,
               "revision": new_revision, "reply": json.dumps(ack, ensure_ascii=False)})
        return FinanceResult(201, ack, _opaque_etag(scope.profile_id, new_revision))


def get_account_snapshot(engine: Engine, *, scope: VerifiedFinanceScope) -> FinanceResult:
    """Consistent authorised read; never caches financial state outside PostgreSQL."""
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        row = session.execute(text("""
            SELECT revision,currency FROM finance_profiles WHERE id=:p
        """), {"p": scope.profile_id}).mappings().one_or_none()
        if row is None:
            raise FinanceCommandError("forbidden", "Нет доступа к финансовому профилю", 403)
        accounts = session.execute(text("""
            SELECT a.id,a.name,a.kind,a.currency,a.opening_minor,a.entity_revision,
                   a.archived_at,
                   a.opening_minor + COALESCE(sum(j.signed_minor),0) AS balance_minor
            FROM accounts a LEFT JOIN ledger_postings j
              ON j.profile_id=a.profile_id AND j.account_id=a.id
            WHERE a.profile_id=:p
            GROUP BY a.id,a.profile_id,a.name,a.kind,a.currency,a.opening_minor,
                     a.entity_revision,a.archived_at
            ORDER BY a.id
        """), {"p": scope.profile_id}).mappings().all()
        entities = [{
            "id": str(a["id"]), "entity_revision": a["entity_revision"],
            "kind": "account",
            "data": {"name": a["name"], "type": a["kind"], "currency": a["currency"].strip(),
                     "opening_minor": int(a["opening_minor"]), "balance_minor": _safe_balance(a["balance_minor"]),
                     "archived_at": a["archived_at"].isoformat() if a["archived_at"] else None},
        } for a in accounts]
        revision = int(row["revision"])
        body = {"schema_version": 1, "profile_id": str(scope.profile_id),
                "revision": revision, "currency": row["currency"].strip(),
                "entities": entities,
                "server_at": datetime.now(timezone.utc).isoformat()}
        return FinanceResult(200, body, _opaque_etag(scope.profile_id, revision))
