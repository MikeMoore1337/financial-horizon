"""#69: strictly opt-in, all-or-nothing import of legacy finance history.

Requires an existing staged source manifest, a verified FH owner scope and
separately saved/revalidated encrypted browser backup. NO public HTTP route.
All imported original fields (including unsupported audit/QR metadata) are
also retained byte-for-byte as the canonical source archive for recovery.
The old IndexedDB and external encrypted backup are NEVER modified.

Legacy historical payments have NO funding account: import as unlinked facts,
never fabricate bank balances or ledger postings.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
import re
from uuid import UUID, uuid5

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .db import finance_transaction
from .import_manifest_candidate import (
    _safe_manifest, _KIND, import_batch_id, require_safe_import_target,
)
from .ledger_service import FinanceCommandError, VerifiedFinanceScope

_MAX_BYTES = 8_000_000
_MAX_MINOR = 1_000_000_000_000
_MAX_RECORDS = 10_000
_ID_MAX = 128
_MONTH = re.compile(r"^\d{4}-(?:0[1-9]|1[0-2])$")
_BAD_KEYS = frozenset(("__proto__", "prototype", "constructor"))


def _invalid() -> None:
    raise FinanceCommandError("invalid_command", "Повреждён источник финансов", 422)


def _conflict() -> None:
    raise FinanceCommandError("semantic_conflict", "Импорт несовместим с серверным состоянием", 409)


def _pairs(entries):
    result = {}
    for key, value in entries:
        if key in result or key in _BAD_KEYS:
            raise ValueError("Duplicate or unsafe JSON key")
        result[key] = value
    return result


def _constant(_):
    raise ValueError("Nonfinite number")


def _json(raw: object) -> tuple[dict, bytes]:
    if type(raw) is not str:
        _invalid()
    encoded = raw.encode("utf-8")
    if not (2 <= len(encoded) <= _MAX_BYTES):
        _invalid()
    try:
        source = json.loads(
            raw, object_pairs_hook=_pairs, parse_constant=_constant,
            parse_float=Decimal,
        )
        if type(source) is not dict:
            _invalid()
        # Bound recursion before working with caller-owned nested metadata.
        work = [(source, 0)]
        while work:
            item, depth = work.pop()
            if depth > 32:
                _invalid()
            if type(item) is dict:
                if len(item) > 400:
                    _invalid()
                work.extend((value, depth + 1) for value in item.values())
            elif type(item) is list:
                if len(item) > 100_000:
                    _invalid()
                work.extend((value, depth + 1) for value in item)
            elif item is not None and type(item) not in (str, int, bool, Decimal):
                _invalid()
        return source, encoded
    except (ValueError, TypeError, UnicodeError, RecursionError, InvalidOperation):
        _invalid()


def _record_id(value: object) -> str:
    if (type(value) is not str or not 1 <= len(value) <= _ID_MAX
        or value != value.strip() or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)):
        _invalid()
    return value


def _name(value: object) -> str:
    if type(value) is not str or not 1 <= len(value) <= 160 or not value.strip():
        _invalid()
    return value


def _minor(value: object, *, positive: bool = False) -> int:
    if type(value) is not int or not (1 if positive else 0) <= value <= _MAX_MINOR:
        _invalid()
    return value


def _int(value: object, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _invalid()
    return value


def _day(value: object) -> str:
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        _invalid()
    try:
        if date.fromisoformat(value).isoformat() != value:
            _invalid()
    except ValueError:
        _invalid()
    return value


def _timestamp(value: object) -> datetime | None:
    if value is None:
        return None
    if type(value) is not str or len(value) > 40 or "T" not in value:
        _invalid()
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _invalid()
    if result.tzinfo is None or result.utcoffset() is None:
        _invalid()
    return result


def _money_rate(value: object) -> int:
    # Legacy APR is a percent (e.g. 12.50%). SQL stores basis points.
    # Reject rather than round a rate that cannot be preserved exactly.
    if type(value) not in (int, Decimal):
        _invalid()
    try:
        basis = Decimal(value) * 100
    except (InvalidOperation, TypeError):
        _invalid()
    if basis != basis.to_integral_value():
        _invalid()
    return _int(int(basis), 0, 100_000)


def _snapshot_rows(snapshot: dict, source_revision: int) -> dict[str, list[dict]]:
    version = snapshot.get("version")
    if type(version) is not int or version not in (1, 2):
        _invalid()
    if version == 1:
        if source_revision != 0 or "revision" in snapshot:
            _invalid()
    elif _int(snapshot.get("revision"), 0, 2**53-1) != source_revision:
        _invalid()
    settings = snapshot.get("settings")
    if type(settings) is not dict or settings.get("currency") != "RUB":
        _invalid()
    if type(snapshot.get("categories")) is not list or type(snapshot.get("audit")) is not list:
        _invalid()

    rows: dict[str, list[dict]] = {}
    total = 0
    for kind in _KIND:
        items = snapshot.get(kind)
        if type(items) is not list:
            _invalid()
        seen: set[str] = set()
        for item in items:
            if type(item) is not dict:
                _invalid()
            ident = _record_id(item.get("id"))
            if ident in seen:
                _invalid()
            seen.add(ident)
        total += len(items)
        rows[kind] = items
    if total > _MAX_RECORDS:
        _invalid()
    return rows


def _build_sql_rows(source: dict[str, list[dict]], targets: dict[tuple[str, str], UUID],
                    scope: VerifiedFinanceScope) -> dict[str, list[dict]]:
    p = scope.profile_id
    converted: dict[str, list[dict]] = {k: [] for k in _KIND}
    for record in source["entries"]:
        ident = _record_id(record["id"])
        kind = record.get("kind")
        repeat = record.get("recurrence")
        if kind not in ("income", "expense") or repeat not in ("once", "monthly", "yearly"):
            _invalid()
        category = record.get("category")
        if category is not None and (type(category) is not str or len(category) > 100):
            _invalid()
        converted["entries"].append({
            "p": p, "id": targets["entries", ident],
            "title": _name(record.get("title")), "direction": kind,
            "amount": _minor(record.get("amountCents")), "starts": _day(record.get("date")),
            "recurrence": {"once":"none", "monthly":"month", "yearly":"year"}[repeat],
            "category": category, "deleted": _timestamp(record.get("deletedAt")),
        })

    for record in source["loans"]:
        ident = _record_id(record["id"])
        rows = record.get("schedule")
        if rows is not None:
            if type(rows) is not list or len(rows) > 5000:
                _invalid()
            for row in rows:
                if type(row) is not dict:
                    _invalid()
                _day(row.get("date"))
                for k in ("amountCents", "balanceCents", "interestCents", "principalCents"):
                    value = row.get(k)
                    if value is not None:
                        _minor(value)
            # The lossless canonical snapshot remains authoritative for every
            # original field; this projection is only the UI calculation input.
            schedule = json.dumps(rows, ensure_ascii=False, separators=(",", ":"),
                                  default=lambda x: float(x) if type(x) is Decimal else _invalid())
        else:
            schedule = None
        converted["loans"].append({
            "p": p, "id": targets["loans", ident],
            "title": _name(record.get("title")),
            "opening": _minor(record.get("openingCents")),
            "payment": _minor(record.get("paymentCents")),
            "apr": _money_rate(record.get("apr")),
            "term": _int(record.get("termMonths"), 1, 1200),
            "due": _int(record.get("dueDay"), 1, 31),
            "asof": _day(record.get("asOfDate")),
            "schedule": schedule,
            "deleted": _timestamp(record.get("deletedAt")),
        })

    for record in source["settlements"]:
        ident = _record_id(record["id"])
        related = ("entries", _record_id(record.get("entryId")))
        if related not in targets:
            _invalid()
        month = record.get("occurrence")
        if type(month) is not str or not _MONTH.fullmatch(month):
            _invalid()
        converted["settlements"].append({
            "p": p, "id": targets["settlements", ident],
            "entry": targets[related], "occurrence": month + "-01",
            "paid": _day(record.get("date")),
            "amount": _minor(record.get("amountCents"), positive=True),
            "voided": _timestamp(record.get("voidedAt")),
        })

    for record in source["loanPayments"]:
        ident = _record_id(record["id"])
        related = ("loans", _record_id(record.get("loanId")))
        if related not in targets or record.get("strategy") not in ("term", "amount"):
            _invalid()
        converted["loanPayments"].append({
            "p": p, "id": targets["loanPayments", ident],
            "loan": targets[related], "paid": _day(record.get("date")),
            "amount": _minor(record.get("amountCents"), positive=True),
            "strategy": record["strategy"],
            "voided": _timestamp(record.get("voidedAt")),
        })
    return converted


_SQL = {
    "entries": text("""
        INSERT INTO obligations
          (profile_id,id,title,direction,amount_minor,starts_on,recurrence_unit,
           category,deleted_at)
        VALUES (:p,:id,:title,:direction,:amount,:starts,:recurrence,
                :category,:deleted)
    """),
    "loans": text("""
        INSERT INTO loans
          (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
           term_months,due_day,as_of_date,imported_schedule,deleted_at)
        VALUES (:p,:id,:title,:opening,:payment,:apr,:term,:due,:asof,
                CAST(:schedule AS jsonb),:deleted)
    """),
    "settlements": text("""
        INSERT INTO settlements
          (profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor,voided_at)
        VALUES (:p,:id,:entry,:occurrence,:paid,:amount,:voided)
    """),
    "loanPayments": text("""
        INSERT INTO loan_payments
          (profile_id,id,loan_id,paid_on,amount_minor,strategy,voided_at)
        VALUES (:p,:id,:loan,:paid,:amount,:strategy,:voided)
    """),
}


def commit_verified_legacy_import_candidate(
    engine: Engine, *, scope: VerifiedFinanceScope, manifest: object,
    source_canonical_json: str,
    fail_after_sql_kind: str | None = None,
) -> dict[str, object]:
    """Commit a staged import exactly once, within one scoped SQL transaction.

    The optional fault injector is test-only and MUST NOT be routed from HTTP.
    The stage check and matching SHA never replace the client's actual
    encrypted backup restore check and explicit consent.
    """
    request = _safe_manifest(manifest)
    if (request.source_scope.startswith("account:") and
        request.source_scope != "account:" + scope.user_id):
        raise FinanceCommandError("forbidden", "Неверный источник аккаунта", 403)
    if fail_after_sql_kind is not None and fail_after_sql_kind not in _KIND:
        raise ValueError("Unknown synthetic fault stage")

    source, encoded = _json(source_canonical_json)
    if sha256(encoded).hexdigest() != request.source_sha256:
        _invalid()
    rows = _snapshot_rows(source, request.source_revision)
    inventory = sorted((kind, _record_id(item["id"]))
                       for kind in _KIND for item in rows[kind])
    expected = sorted((item.record_type, item.source_record_id) for item in request.rows)
    if inventory != expected:
        _invalid()

    batch_id = import_batch_id(scope, request)
    digest = bytes.fromhex(request.source_sha256)
    receipt_id = uuid5(batch_id, "financial-horizon:verified-import-commit:v1")
    counts = {kind: len(rows[kind]) for kind in _KIND}

    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        profile = session.execute(text("""
            SELECT revision FROM finance_profiles WHERE id=:p FOR UPDATE
        """), {"p": scope.profile_id}).mappings().one_or_none()
        if profile is None:
            raise FinanceCommandError("forbidden", "Финансовый профиль недоступен", 403)
        batch = session.execute(text("""
            SELECT status,source_sha256,base_revision,source_canonical_json
              FROM import_batches WHERE profile_id=:p AND id=:id FOR UPDATE
        """), {"p": scope.profile_id, "id": batch_id}).mappings().one_or_none()
        if batch is None or bytes(batch["source_sha256"]) != digest or (
            int(batch["base_revision"]) != request.expected_server_revision
        ):
            _conflict()
        if batch["status"] == "committed":
            archived = batch["source_canonical_json"]
            if archived is None or bytes(archived) != encoded:
                _conflict()
            receipt = session.execute(text("""
                SELECT committed_revision FROM command_receipts
                WHERE profile_id=:p AND client_mutation_id=:mid
                  AND request_sha256=:sha
            """), {"p": scope.profile_id, "mid": receipt_id,
                   "sha": sha256(encoded).digest()}).scalar_one_or_none()
            if receipt is None:
                _conflict()
            return {
                "status": "COMMITTED", "replayed": True, "revision": int(receipt),
                "batch_id": str(batch_id), "source_sha256": request.source_sha256,
                "record_count": len(inventory), "counts": counts,
                "source_original_preserved": True, "cash_postings_created": 0,
            }
        if batch["status"] != "staged":
            _conflict()
        if int(profile["revision"]) != request.expected_server_revision:
            raise FinanceCommandError("stale_revision",
                                      "Профиль изменился после подготовки", 412,
                                      int(profile["revision"]))
        # Recheck exact same server account UUID, zero cash and no postings
        # under the profile lock immediately before any import SQL writes.
        require_safe_import_target(session, scope.profile_id, request)

        mapped = session.execute(text("""
            SELECT record_type,source_record_id,target_id FROM import_record_map
            WHERE profile_id=:p AND source_sha256=:sha
        """), {"p": scope.profile_id, "sha": digest}).mappings().all()
        targets = {(row["record_type"], row["source_record_id"]): row["target_id"]
                   for row in mapped}
        if set(targets) != set(inventory):
            _conflict()
        for kind, source_id in inventory:
            if targets[kind, source_id] != uuid5(
                scope.profile_id, "financial-horizon:legacy-record:v1:" +
                request.source_sha256 + ":" + kind + ":" + source_id,
            ):
                _conflict()
        values = _build_sql_rows(rows, targets, scope)
        # Every table write, receipt, source archive and revision belongs to
        # this *single* PostgreSQL transaction. Errors roll back ALL of it.
        for kind in _KIND:
            if values[kind]:
                session.execute(_SQL[kind], values[kind])
            if fail_after_sql_kind == kind:
                raise RuntimeError("SYNTHETIC_IMPORT_TRANSACTION_FAILURE")

        revision = int(profile["revision"]) + 1
        response = {
            "status": "COMMITTED", "replayed": False,
            "revision": revision, "batch_id": str(batch_id),
            "source_sha256": request.source_sha256,
            "record_count": len(inventory), "counts": counts,
            "source_original_preserved": True, "cash_postings_created": 0,
        }
        session.execute(text("""
            UPDATE import_batches
            SET status='committed',committed_at=now(),source_canonical_json=:bytes
            WHERE profile_id=:p AND id=:id AND status='staged'
        """), {"p": scope.profile_id, "id": batch_id, "bytes": encoded})
        session.execute(text("""
            UPDATE finance_profiles
            SET revision=:r,min_available_revision=:r,updated_at=now()
            WHERE id=:p
        """), {"p": scope.profile_id, "r": revision})
        session.execute(text("""
            INSERT INTO command_receipts
              (profile_id,client_mutation_id,request_sha256,status_code,
               committed_revision,response_body)
            VALUES (:p,:mid,:sha,201,:r,CAST(:body AS jsonb))
        """), {"p": scope.profile_id, "mid": receipt_id,
               "sha": sha256(encoded).digest(), "r": revision,
               "body": json.dumps(response, separators=(",", ":"))})
        # A full server snapshot is mandatory after the bulk import.
        # All existing incremental cursors now fail closed with 410.
        session.execute(text("""
            INSERT INTO change_log
              (profile_id,revision,ordinal,schema_version,kind,entity_id,payload)
            VALUES (:p,:r,0,1,'import_requires_snapshot',NULL,CAST(:body AS jsonb))
        """), {"p": scope.profile_id, "r": revision,
               "body": json.dumps({"batch_id": str(batch_id),
                                   "record_count": len(inventory)},
                                  separators=(",", ":"))})
        return response


def restore_original_legacy_source_candidate(
    engine: Engine, *, scope: VerifiedFinanceScope, batch_id: str,
    source_sha256: str,
) -> str:
    """Recover the *exact* original canonical JSON bytes for a verified owner.

    Internal-only; no HTTP handler, no logs, no deletion, no automatic cutover.
    Independent external encrypted backup remains required for disaster recovery.
    """
    try:
        ident = UUID(batch_id)
    except (ValueError, TypeError, AttributeError):
        _invalid()
    if type(source_sha256) is not str or not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
        _invalid()
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        archived = session.execute(text("""
            SELECT source_canonical_json FROM import_batches
            WHERE profile_id=:p AND id=:id AND status='committed'
              AND source_sha256=:sha
        """), {"p": scope.profile_id, "id": ident,
               "sha": bytes.fromhex(source_sha256)}).scalar_one_or_none()
        if archived is None:
            raise FinanceCommandError("not_found", "Копия импорта не найдена", 404)
        encoded = bytes(archived)
        if sha256(encoded).hexdigest() != source_sha256:
            raise FinanceCommandError("unavailable",
                                      "Не удалось подтвердить исходную копию", 503)
        original = encoded.decode("utf-8")
        _json(original)  # verify the restored data is still valid JSON
        return original
