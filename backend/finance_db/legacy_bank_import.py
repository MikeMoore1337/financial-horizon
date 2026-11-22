"""Validate the original local bank journal for a lossless personal import."""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
from uuid import UUID, uuid5

from sqlalchemy import text

from .bank_import_candidate import _day, _hash, _preflight_row, _uuid
from .ledger_service import FinanceCommandError, _account_sync_entity, _post

_MAX_MINOR = 1_000_000_000_000
_MAX_SAFE = (1 << 53) - 1


def _invalid() -> None:
    raise FinanceCommandError("invalid_command", "Повреждена исходная банковская история", 422)


def _shape(value: object, fields: set[str]) -> dict:
    if type(value) is not dict or set(value) != fields:
        _invalid()
    return value


def _integer(value: object, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _invalid()
    return value


def validate_legacy_bank_ledger(value: object, source_revision: int) -> dict:
    """Validate identities, source revisions and active balances before any SQL write."""
    _integer(source_revision, 0, _MAX_SAFE)
    ledger = _shape(value, {"version", "accounts", "operations", "batches"})
    if type(ledger["version"]) is not int or ledger["version"] != 1:
        _invalid()
    accounts, operations, batches = ledger["accounts"], ledger["operations"], ledger["batches"]
    if (type(accounts) is not list or len(accounts) > 100 or
        type(operations) is not list or len(operations) > 5000 or
        type(batches) is not list or len(batches) > 5000):
        _invalid()
    balances = {}
    for raw in accounts:
        account = _shape(raw, {"id", "name", "currency", "openingMinor"})
        ident, title = account["id"], account["name"]
        _uuid(ident)
        if (ident in balances or type(title) is not str or not title.strip() or
            len(title) > 160 or account["currency"] != "RUB"):
            _invalid()
        balances[ident] = _integer(account["openingMinor"], -_MAX_MINOR, _MAX_MINOR)
    batch_by_key = {}
    for raw in batches:
        batch = _shape(raw, {"batchKey", "fileDigest", "operationCount",
                             "committedStateRevision", "cancelledStateRevision"})
        key = _hash(batch["batchKey"])
        _hash(batch["fileDigest"])
        committed = _integer(batch["committedStateRevision"], 1, source_revision)
        _integer(batch["operationCount"], 1, 1000)
        if batch["cancelledStateRevision"] is not None:
            _integer(batch["cancelledStateRevision"], committed + 1, source_revision)
        if key in batch_by_key:
            _invalid()
        batch_by_key[key] = batch
    counts = {key: 0 for key in batch_by_key}
    source_keys, external_keys = set(), set()
    operation_fields = {"sourceKey", "fingerprint", "externalId", "date", "amountCents",
                        "kind", "description", "accountId", "targetAccountId", "category", "batchKey"}
    for raw in operations:
        row = _shape(raw, operation_fields)
        key, batch_key = _hash(row["sourceKey"]), _hash(row["batchKey"])
        _hash(row["fingerprint"])
        if key in source_keys or batch_key not in batch_by_key:
            _invalid()
        source_keys.add(key)
        account, target = row["accountId"], row["targetAccountId"]
        _uuid(account)
        if account not in balances:
            _invalid()
        if target is not None:
            _uuid(target)
        if (row["kind"] not in ("income", "expense", "transfer") or
            (row["kind"] == "transfer") != (target is not None) or
            (target is not None and (target not in balances or target == account))):
            _invalid()
        _day(row["date"])
        amount = _integer(row["amountCents"], 1, _MAX_MINOR)
        if type(row["description"]) is not str or len(row["description"]) > 500:
            _invalid()
        category, external = row["category"], row["externalId"]
        if category is not None and (type(category) is not str or len(category) > 160):
            _invalid()
        if external is not None:
            if type(external) is not str or not 1 <= len(external) <= 150:
                _invalid()
            identity = (account, external)
            if identity in external_keys:
                _invalid()
            external_keys.add(identity)
        counts[batch_key] += 1
        if batch_by_key[batch_key]["cancelledStateRevision"] is None:
            balances[account] += amount if row["kind"] == "income" else -amount
            if target is not None:
                balances[target] += amount
            if abs(balances[account]) > _MAX_SAFE or (target is not None and abs(balances[target]) > _MAX_SAFE):
                _invalid()
    if any(counts[key] != batch["operationCount"] for key, batch in batch_by_key.items()):
        _invalid()
    return {"accounts": accounts, "operations": operations, "batches": batches, "balances": balances}


def _conflict() -> None:
    raise FinanceCommandError("semantic_conflict", "Банковая история изменилась или требует сверки", 409)


def apply_legacy_bank_ledger(session, scope, request, ledger: dict, revision: int) -> dict:
    """Apply the explicitly mapped local journal inside the caller's locked transaction."""
    if request.schema_version != 3:
        _invalid()
    account_choices = {x.source_id: x for x in request.bank_accounts}
    operation_choices = {x.source_key: x for x in request.bank_operations}
    if (set(account_choices) != {x["id"] for x in ledger["accounts"]} or
        set(operation_choices) != {x["sourceKey"] for x in ledger["operations"]}):
        _invalid()
    profile, digest = scope.profile_id, bytes.fromhex(request.source_sha256)
    previous = session.execute(text("""
        SELECT DISTINCT m.record_type,m.source_record_id,m.target_id
        FROM import_record_map m JOIN import_batches b
          ON b.profile_id=m.profile_id AND b.source_sha256=m.source_sha256
        WHERE m.profile_id=:p AND b.status='committed'
          AND m.record_type IN ('bankAccounts','bankOperations')
    """), {"p":profile}).mappings().all()
    old = {}
    for row in previous:
        old.setdefault((row["record_type"],row["source_record_id"]),set()).add(row["target_id"])

    def save_mapping(kind, source_id, target, decision):
        prior = old.get((kind,source_id),set())
        if prior and (decision != "link" or prior != {target}):
            _conflict()
        session.execute(text("""
            INSERT INTO import_record_map
              (profile_id,source_sha256,record_type,source_record_id,target_id)
            VALUES (:p,:sha,:kind,:source,:target)
        """), {"p":profile,"sha":digest,"kind":kind,"source":source_id,"target":target})

    targets = {}
    for account in ledger["accounts"]:
        choice = account_choices[account["id"]]
        target = (UUID(choice.target_id) if choice.decision == "link" else
                  uuid5(profile,"legacy-bank-account:v3:"+request.source_scope+":"+account["id"]))
        if target in targets.values():
            _conflict()
        existing = session.execute(text("""
            SELECT name,kind,currency,opening_minor,archived_at FROM accounts
            WHERE profile_id=:p AND id=:id
        """), {"p":profile,"id":target}).mappings().one_or_none()
        if choice.decision == "link":
            if (existing is None or existing["archived_at"] is not None or
                existing["currency"].strip() != "RUB" or
                existing["name"] != account["name"] or
                int(existing["opening_minor"]) != account["openingMinor"]):
                _conflict()
        else:
            if existing is not None:
                _conflict()
            session.execute(text("""
                INSERT INTO accounts (profile_id,id,name,kind,currency,opening_minor)
                VALUES (:p,:id,:name,:kind,'RUB',:opening)
            """), {"p":profile,"id":target,"name":account["name"],
                   "kind":choice.account_kind,"opening":account["openingMinor"]})
        save_mapping("bankAccounts",account["id"],target,choice.decision)
        targets[account["id"]] = target

    batches = {x["batchKey"]:x for x in ledger["batches"]}
    additions, operation_targets = {}, {}
    linked = 0
    for source in ledger["operations"]:
        choice = operation_choices[source["sourceKey"]]
        account, target = targets[source["accountId"]], targets.get(source["targetAccountId"])
        cancelled = batches[source["batchKey"]]["cancelledStateRevision"] is not None
        if choice.decision == "link":
            transaction_id = UUID(choice.target_id)
            row = session.execute(text("""
                SELECT r.*,b.status,t.kind AS actual_kind,t.occurred_on AS actual_day,
                  t.note AS actual_note,t.reversed_transaction_id AS actual_reversed_id,
                  EXISTS(SELECT 1 FROM ledger_transactions v WHERE v.profile_id=r.profile_id
                         AND v.reversed_transaction_id=r.transaction_id) AS reversed
                FROM bank_import_rows r JOIN bank_import_batches b
                  ON b.profile_id=r.profile_id AND b.id=r.batch_id
                JOIN ledger_transactions t ON t.profile_id=r.profile_id AND t.id=r.transaction_id
                WHERE r.profile_id=:p AND r.transaction_id=:id
            """), {"p":profile,"id":transaction_id}).mappings().one_or_none()
            if (row is None or (row["source_key"].strip() != source["sourceKey"] and
                (source["externalId"] is None or row["external_id"] != source["externalId"])) or
                row["fingerprint"].strip() != source["fingerprint"] or
                row["external_id"] != source["externalId"] or row["account_id"] != account or
                row["target_account_id"] != target or row["kind"] != source["kind"] or
                row["occurred_on"] != _day(source["date"]) or int(row["amount_minor"]) != source["amountCents"] or
                row["description"] != source["description"] or row["category"] != source["category"] or
                row["actual_kind"] != source["kind"] or row["actual_day"] != _day(source["date"]) or
                row["actual_note"] != source["description"] or row["actual_reversed_id"] is not None or
                bool(row["reversed"]) != cancelled or (row["status"] == "cancelled" and not row["reversed"])):
                _conflict()
            postings = session.execute(text("""
                SELECT account_id,signed_minor FROM ledger_postings
                WHERE profile_id=:p AND transaction_id=:id ORDER BY account_id
            """), {"p":profile,"id":transaction_id}).all()
            expected = [(account,source["amountCents"] if source["kind"] == "income" else -source["amountCents"])]
            if target is not None:
                expected.append((target,source["amountCents"]))
            if sorted((x.account_id,int(x.signed_minor)) for x in postings) != sorted(expected):
                _conflict()
            if cancelled:
                reversals = session.execute(text("""
                    SELECT id,kind FROM ledger_transactions
                    WHERE profile_id=:p AND reversed_transaction_id=:id
                """), {"p":profile,"id":transaction_id}).mappings().all()
                if len(reversals) != 1 or reversals[0]["kind"] != "reversal":
                    _conflict()
                inverse = session.execute(text("""
                    SELECT account_id,signed_minor FROM ledger_postings
                    WHERE profile_id=:p AND transaction_id=:id ORDER BY account_id
                """), {"p":profile,"id":reversals[0]["id"]}).all()
                if sorted((x.account_id,int(x.signed_minor)) for x in inverse) != sorted((a,-n) for a,n in expected):
                    _conflict()
            linked += 1
        else:
            if source["kind"] == "transfer" and choice.reviewed_transaction_ids:
                _invalid()
            if source["kind"] in ("income", "expense"):
                ambiguous = session.execute(text("""
                    SELECT EXISTS(
                      SELECT 1 FROM settlements s JOIN obligations o
                        ON o.profile_id=s.profile_id AND o.id=s.obligation_id
                      WHERE s.profile_id=:p AND s.voided_at IS NULL AND o.direction=:kind
                        AND s.paid_on=:day AND s.amount_minor=:amount
                    ) OR EXISTS(
                      SELECT 1 FROM loan_payments l WHERE l.profile_id=:p AND l.voided_at IS NULL
                        AND :kind='expense' AND l.paid_on=:day AND l.amount_minor=:amount
                    )
                """), {"p":profile,"day":_day(source["date"]),"amount":source["amountCents"],
                       "kind":source["kind"]}).scalar_one()
                if ambiguous:
                    _conflict()
            bank_key = sha256(("legacy-bank-v3:"+request.source_sha256+":"+source["batchKey"]).encode()).hexdigest()
            batch_id = uuid5(profile,"bank-import:v1:"+bank_key)
            transaction_id = uuid5(batch_id,source["sourceKey"])
            op = {"source_key":source["sourceKey"],"external_id":source["externalId"],
                  "account_id":account,"target_account_id":target,"occurred_on":_day(source["date"]),
                  "amount_minor":source["amountCents"],"kind":source["kind"],
                  "reviewed_transaction_ids":{UUID(x) for x in choice.reviewed_transaction_ids}}
            _preflight_row(session,scope,op)
            additions.setdefault(source["batchKey"],[]).append((source,op,transaction_id,bank_key,batch_id))
        save_mapping("bankOperations",source["sourceKey"],transaction_id,choice.decision)
        operation_targets[source["sourceKey"]] = str(transaction_id)

    cancelled_new = any(batches[key]["cancelledStateRevision"] is not None for key in additions)
    if revision + 1 + int(cancelled_new) > _MAX_SAFE:
        _invalid()
    next_revision = revision + 1
    postings_count = 0
    for original_key, items in additions.items():
        batch = batches[original_key]
        cancelled = batch["cancelledStateRevision"] is not None
        bank_key, batch_id = items[0][3:5]
        payload = json.dumps([x[0] for x in items],ensure_ascii=False,sort_keys=True,separators=(",",":"))
        session.execute(text("""
            INSERT INTO bank_import_batches
              (profile_id,id,batch_key,file_digest,payload_sha256,status,committed_revision,cancelled_revision,operation_count)
            VALUES (:p,:id,:key,:file,:sha,:status,:revision,:cancelled,:count)
        """), {"p":profile,"id":batch_id,"key":bank_key,"file":batch["fileDigest"],
               "sha":sha256(payload.encode()).digest(),"status":"cancelled" if cancelled else "committed",
               "revision":next_revision,"cancelled":next_revision+1 if cancelled else None,"count":len(items)})
        for source,op,transaction_id,_,_ in items:
            amount, account, target = op["amount_minor"],op["account_id"],op["target_account_id"]
            postings = [(account,amount if op["kind"] == "income" else -amount)]
            if target is not None:
                postings.append((target,amount))
            _post(session,profile,transaction_id,op["kind"],scope.user_id,op["occurred_on"],postings,
                  note=source["description"])
            session.execute(text("""
                INSERT INTO bank_import_rows
                 (profile_id,batch_id,source_key,fingerprint,external_id,account_id,target_account_id,
                  transaction_id,kind,occurred_on,amount_minor,description,category)
                VALUES (:p,:batch,:key,:fingerprint,:external,:account,:target,:tx,:kind,:day,:amount,:note,:category)
            """), {"p":profile,"batch":batch_id,"key":source["sourceKey"],"fingerprint":source["fingerprint"],
                   "external":source["externalId"],"account":account,"target":target,"tx":transaction_id,
                   "kind":source["kind"],"day":op["occurred_on"],"amount":amount,
                   "note":source["description"],"category":source["category"]})
            postings_count += len(postings)
            if cancelled:
                _post(session,profile,uuid5(batch_id,"undo:"+str(transaction_id)),"reversal",scope.user_id,
                      datetime.now(timezone.utc).date(),[(a,-n) for a,n in postings],reversed_id=transaction_id,
                      note="Отменено до переноса; исходная дата отмены неизвестна")
                postings_count += len(postings)
    for target in targets.values():
        entity = _account_sync_entity(session,profile,target)
        if not 1 <= entity["entity_revision"] <= _MAX_SAFE:
            _invalid()
    return {"revision":next_revision+int(cancelled_new),"cash_postings_created":postings_count,
            "bank_accounts_created":sum(x.decision == "add" for x in account_choices.values()),
            "bank_accounts_linked":sum(x.decision == "link" for x in account_choices.values()),
            "bank_operations_created":sum(len(x) for x in additions.values()),"bank_operations_linked":linked,
            "bank_account_targets":{source_id:str(target) for source_id,target in targets.items()},
            "bank_operation_targets":operation_targets}
