"""Unpublished #38 bank statement POST/undo core; uses real RLS PostgreSQL.

All-or-nothing SQL transactions with account/profile CAS, server-side replay,
payment matching and append-only reversal. Not exposed through HTTP until
owner-approved UI, full integration and independent security review.
"""
from __future__ import annotations

from datetime import date
from hashlib import sha256
import json
import re
from uuid import UUID, uuid5

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .db import finance_transaction
from .ledger_service import (
    FinanceCommandError, FinanceResult, VerifiedFinanceScope,
    _opaque_etag, _post, _profile_lock,
)

_HEX = re.compile(r"^[0-9a-f]{64}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_DAY = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_MAX_MINOR = 1_000_000_000_000
_MAX_REVISION = (1 << 53) - 1
_MAX_ROWS = 1000


def _invalid() -> None:
    raise FinanceCommandError("invalid_command", "Некорректная партия банковского импорта", 422)


def _conflict() -> None:
    raise FinanceCommandError("semantic_conflict", "Требуется повторная сверка банковского импорта", 409)


def _uuid(value: object) -> UUID:
    if type(value) is not str or _UUID.fullmatch(value) is None:
        _invalid()
    return UUID(value)


def _hash(value: object) -> str:
    if type(value) is not str or _HEX.fullmatch(value) is None:
        _invalid()
    return value


def _revision(value: object) -> int:
    if type(value) is not int or not 0 <= value <= _MAX_REVISION:
        _invalid()
    return value


def _keys(value: object, required: set[str]) -> dict:
    if type(value) is not dict or set(value) != required:
        _invalid()
    return value


def _day(value: object) -> date:
    if type(value) is not str or _DAY.fullmatch(value) is None:
        _invalid()
    try:
        result = date.fromisoformat(value)
    except ValueError:
        _invalid()
    if not 1900 <= result.year <= 2200:
        _invalid()
    return result


def _validate_operation(raw: object) -> dict:
    op = _keys(raw, {
        "source_key","fingerprint","external_id","account_id","target_account_id",
        "occurred_on","amount_minor","kind","description","category","currency",
        "reviewed_transaction_ids",
    })
    _hash(op["source_key"])
    _hash(op["fingerprint"])
    op["account_id"] = _uuid(op["account_id"])
    target = op["target_account_id"]
    op["target_account_id"] = _uuid(target) if target is not None else None
    op["occurred_on"] = _day(op["occurred_on"])
    if op["kind"] not in ("income","expense","transfer") or op["currency"] != "RUB":
        _invalid()
    if type(op["amount_minor"]) is not int or not 1 <= op["amount_minor"] <= _MAX_MINOR:
        _invalid()
    if (op["kind"] == "transfer") != (op["target_account_id"] is not None):
        _invalid()
    if op["target_account_id"] == op["account_id"]:
        _invalid()
    if type(op["description"]) is not str or len(op["description"]) > 500:
        _invalid()
    if op["category"] is not None and (
        type(op["category"]) is not str or not 1 <= len(op["category"]) <= 160
    ):
        _invalid()
    if op["external_id"] is not None and (
        type(op["external_id"]) is not str or not 1 <= len(op["external_id"]) <= 150
    ):
        _invalid()
    reviewed = op["reviewed_transaction_ids"]
    if type(reviewed) is not list or len(reviewed) > 32:
        _invalid()
    ids = [_uuid(item) for item in reviewed]
    if len(ids) != len(set(ids)):
        _invalid()
    op["reviewed_transaction_ids"] = set(ids)
    return op


def _validate_commit(request: object) -> tuple[dict,list[dict],dict[UUID,int],bytes]:
    body = _keys(request, {
        "schema_version","client_mutation_id","base_revision","batch_key",
        "file_digest","expected_account_revisions","operations",
    })
    if type(body["schema_version"]) is not int or body["schema_version"] != 1:
        _invalid()
    _uuid(body["client_mutation_id"])
    _hash(body["batch_key"])
    _hash(body["file_digest"])
    _revision(body["base_revision"])
    raw_versions = body["expected_account_revisions"]
    if type(raw_versions) is not dict or len(raw_versions) > 2000:
        _invalid()
    versions: dict[UUID,int] = {}
    for key, version in raw_versions.items():
        ident = _uuid(key)
        if ident in versions or type(version) is not int or not 1 <= version <= _MAX_REVISION:
            _invalid()
        versions[ident] = version
    raw_ops = body["operations"]
    if type(raw_ops) is not list or not 1 <= len(raw_ops) <= _MAX_ROWS:
        _invalid()
    operations = [_validate_operation(dict(op) if type(op) is dict else op)
                  for op in raw_ops]
    source_keys = [op["source_key"] for op in operations]
    if len(set(source_keys)) != len(source_keys):
        _invalid()
    external = [(op["account_id"],op["external_id"]) for op in operations
                if op["external_id"] is not None]
    if len(external) != len(set(external)):
        _invalid()
    accounts = {op["account_id"] for op in operations}
    accounts.update(op["target_account_id"] for op in operations
                    if op["target_account_id"] is not None)
    if set(versions) != accounts:
        _invalid()
    # Commit intent is independent of client mutation UUID and optimistic revision.
    canonical = [{
        **{key: (str(value) if isinstance(value, (UUID,date)) else value)
           for key,value in op.items() if key != "reviewed_transaction_ids"},
        "reviewed_transaction_ids": sorted(map(str,op["reviewed_transaction_ids"])),
    } for op in sorted(operations,key=lambda x:x["source_key"])]
    payload_hash = sha256(json.dumps(canonical,ensure_ascii=False,sort_keys=True,
                                    separators=(",",":")).encode("utf-8")).digest()
    return body, operations, versions, payload_hash


def _receipt_hash(request: dict, action: str) -> bytes:
    return sha256((action+":"+json.dumps(request,ensure_ascii=False,sort_keys=True,
                          separators=(",",":"))).encode("utf-8")).digest()


def _replay(session, scope: VerifiedFinanceScope, mutation: UUID, digest: bytes):
    existing = session.execute(text("""
        SELECT request_sha256,committed_revision,response_body FROM command_receipts
        WHERE profile_id=:p AND client_mutation_id=:id
    """), {"p": scope.profile_id, "id":mutation}).mappings().one_or_none()
    if existing is None:
        return None
    if bytes(existing["request_sha256"]) != digest:
        raise FinanceCommandError("idempotency_key_reuse",
                                  "Идентификатор команды уже использован",409)
    ack = dict(existing["response_body"])
    ack["replayed"] = True
    ack["new_operations"] = 0
    return FinanceResult(200,ack,_opaque_etag(scope.profile_id,int(existing["committed_revision"])))


def _receipt(session, scope, mutation, digest, revision, ack):
    session.execute(text("""
        INSERT INTO command_receipts
          (profile_id,client_mutation_id,request_sha256,status_code,
           committed_revision,response_body)
        VALUES (:p,:id,:sha,201,:r,CAST(:body AS jsonb))
    """), {"p":scope.profile_id,"id":mutation,"sha":digest,"r":revision,
           "body":json.dumps(ack,ensure_ascii=False)})


def _snapshot_barrier(session, scope, revision, batch_id, action, count):
    session.execute(text("""
        UPDATE finance_profiles
        SET revision=:r,min_available_revision=:r,updated_at=now()
        WHERE id=:p
    """), {"p":scope.profile_id,"r":revision})
    session.execute(text("""
        INSERT INTO change_log
          (profile_id,revision,ordinal,schema_version,kind,entity_id,payload)
        VALUES (:p,:r,0,1,'import_requires_snapshot',:id,CAST(:body AS jsonb))
    """), {"p":scope.profile_id,"r":revision,"id":batch_id,
           "body":json.dumps({"batch_id":str(batch_id),"action":action,
                              "operation_count":count})})


def _validate_accounts(session, scope, versions):
    rows = session.execute(text("""
        SELECT id,entity_revision,archived_at,currency FROM accounts
        WHERE profile_id=:p AND id=ANY(:ids)
    """), {"p":scope.profile_id,"ids":list(versions)}).mappings().all()
    if len(rows)!=len(versions):
        _conflict()
    for row in rows:
        if (row["archived_at"] is not None or row["currency"].strip()!="RUB"
            or row["entity_revision"]!=versions[row["id"]]):
            _conflict()


def _preflight_row(session, scope, op):
    # Source identity is unique for every profile across ALL prior batches.
    conflict = session.execute(text("""
        SELECT 1 FROM bank_import_rows
        WHERE profile_id=:p AND (source_key=:key OR
          (external_id IS NOT NULL AND external_id=:external AND account_id=:account))
        LIMIT 1
    """), {"p":scope.profile_id,"key":op["source_key"],
           "external":op["external_id"],"account":op["account_id"]}).first()
    if conflict:
        _conflict()
    if op["kind"]=="transfer":
        # Both legs can be exported separately from owned accounts. A matching
        # already-posted internal transfer is never silently duplicated.
        match = session.execute(text("""
            SELECT 1 FROM ledger_transactions t
            JOIN ledger_postings p ON p.profile_id=t.profile_id AND p.transaction_id=t.id
            JOIN ledger_postings destination
              ON destination.profile_id=t.profile_id
             AND destination.transaction_id=t.id
            WHERE t.profile_id=:profile AND t.occurred_on=:d AND t.kind='transfer'
              AND p.account_id=:account AND p.signed_minor=:amount
              AND destination.account_id=:target
              AND destination.signed_minor=:incoming
              AND NOT EXISTS (
                  SELECT 1 FROM ledger_transactions v WHERE v.profile_id=t.profile_id
                  AND v.reversed_transaction_id=t.id
              )
            LIMIT 1
        """), {"profile":scope.profile_id,"d":op["occurred_on"],
               "account":op["account_id"],"amount":-op["amount_minor"],
               "target":op["target_account_id"],
               "incoming":op["amount_minor"]}).first()
        if match:
            _conflict()
        return
    sign = op["amount_minor"] if op["kind"]=="income" else -op["amount_minor"]
    matches = session.execute(text("""
        SELECT t.id,t.kind,
          EXISTS(SELECT 1 FROM ledger_payment_links l
                 WHERE l.profile_id=t.profile_id AND l.transaction_id=t.id) AS linked
        FROM ledger_postings p
        JOIN ledger_transactions t ON t.profile_id=p.profile_id AND t.id=p.transaction_id
        WHERE t.profile_id=:profile AND p.account_id=:account
          AND t.occurred_on=:d AND p.signed_minor=:amount AND t.kind <> 'reversal'
          AND NOT EXISTS (
              SELECT 1 FROM ledger_transactions v WHERE v.profile_id=t.profile_id
              AND v.reversed_transaction_id=t.id
          )
        LIMIT 33
    """), {"profile":scope.profile_id,"account":op["account_id"],
           "d":op["occurred_on"],"amount":sign}).mappings().all()
    if len(matches)>32:
        _conflict()
    for row in matches:
        # Payments already linked to a loan/obligation must NEVER be reposted.
        if row["kind"]=="payment" or row["linked"]:
            _conflict()
    if set(row["id"] for row in matches) != op["reviewed_transaction_ids"]:
        _conflict()


def commit_bank_import_candidate(
    engine: Engine, *, scope: VerifiedFinanceScope, request: object,
    if_match: str, idempotency_key: str,
) -> FinanceResult:
    """Commit the whole confirmed batch or nothing. Never call from an unverified session."""
    body, operations, versions, payload_hash = _validate_commit(request)
    mutation = _uuid(body["client_mutation_id"])
    if idempotency_key != body["client_mutation_id"] or type(if_match) is not str:
        raise FinanceCommandError("precondition_required","Требуется If-Match и Idempotency-Key",428)
    raw = json.dumps(request,ensure_ascii=False,sort_keys=True,separators=(",",":"))
    if len(raw.encode("utf-8")) > 2_000_000:
        raise FinanceCommandError("invalid_command","Превышен размер партии",413)
    digest = _receipt_hash(request,"bank_import_commit_v1")
    batch_id = uuid5(scope.profile_id,"bank-import:v1:"+body["batch_key"])
    with finance_transaction(engine,verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        revision = _profile_lock(session,scope.profile_id)
        replay = _replay(session,scope,mutation,digest)
        if replay is not None:
            return replay
        batch = session.execute(text("""
            SELECT status,payload_sha256,committed_revision,file_digest FROM bank_import_batches
            WHERE profile_id=:p AND id=:id FOR UPDATE
        """), {"p":scope.profile_id,"id":batch_id}).mappings().one_or_none()
        if batch is not None:
            if (bytes(batch["payload_sha256"]) != payload_hash or
                batch["file_digest"] != body["file_digest"] or
                batch["status"] != "committed"):
                _conflict()
            return FinanceResult(200,{
                "status":"COMMITTED","batch_id":str(batch_id),
                "revision":int(batch["committed_revision"]),
                "new_operations":0,"replayed":True,
            },_opaque_etag(scope.profile_id,int(batch["committed_revision"])))
        if if_match != _opaque_etag(scope.profile_id,revision):
            raise FinanceCommandError("stale_revision","Необходимо обновить финансовый профиль",412,revision)
        if body["base_revision"] != revision:
            _conflict()
        _validate_accounts(session,scope,versions)
        for op in operations:
            _preflight_row(session,scope,op)
        next_revision = revision+1
        session.execute(text("""
            INSERT INTO bank_import_batches
              (profile_id,id,batch_key,file_digest,payload_sha256,status,
               committed_revision,operation_count)
            VALUES (:p,:id,:key,:file,:sha,'committed',:r,:count)
        """), {"p":scope.profile_id,"id":batch_id,"key":body["batch_key"],
               "file":body["file_digest"],"sha":payload_hash,
               "r":next_revision,"count":len(operations)})
        for op in operations:
            txid = uuid5(batch_id,op["source_key"])
            acc = op["account_id"]
            if op["kind"]=="transfer":
                postings = [(acc,-op["amount_minor"]),
                            (op["target_account_id"],op["amount_minor"])]
            else:
                postings = [(acc,op["amount_minor"] if op["kind"]=="income"
                             else -op["amount_minor"])]
            _post(session,scope.profile_id,txid,op["kind"],scope.user_id,
                  op["occurred_on"],postings,note=op["description"])
            session.execute(text("""
                INSERT INTO bank_import_rows
                 (profile_id,batch_id,source_key,fingerprint,external_id,
                  account_id,target_account_id,transaction_id,kind,occurred_on,
                  amount_minor,description,category)
                VALUES (:p,:batch,:key,:fingerprint,:external,:acc,:target,:tx,
                        :kind,:day,:minor,:note,:category)
            """), {"p":scope.profile_id,"batch":batch_id,
                   "key":op["source_key"],"fingerprint":op["fingerprint"],
                   "external":op["external_id"],"acc":acc,
                   "target":op["target_account_id"],"tx":txid,
                   "kind":op["kind"],"day":op["occurred_on"],
                   "minor":op["amount_minor"],"note":op["description"],
                   "category":op["category"]})
        ack = {"status":"COMMITTED","batch_id":str(batch_id),
               "revision":next_revision,"new_operations":len(operations),
               "replayed":False}
        _snapshot_barrier(session,scope,next_revision,batch_id,"commit",len(operations))
        _receipt(session,scope,mutation,digest,next_revision,ack)
        return FinanceResult(201,ack,_opaque_etag(scope.profile_id,next_revision))


def undo_bank_import_candidate(
    engine: Engine, *, scope: VerifiedFinanceScope, request: object,
    if_match: str, idempotency_key: str,
) -> FinanceResult:
    """Atomically append a reversal for every imported transaction, or reject."""
    body = _keys(request,{
        "schema_version","client_mutation_id","base_revision","batch_key","reason",
    })
    if type(body["schema_version"]) is not int or body["schema_version"]!=1:
        _invalid()
    mutation = _uuid(body["client_mutation_id"])
    _revision(body["base_revision"])
    _hash(body["batch_key"])
    reason = body["reason"]
    if type(reason) is not str or not 1<=len(reason.strip())<=500:
        _invalid()
    if idempotency_key != body["client_mutation_id"] or type(if_match) is not str:
        raise FinanceCommandError("precondition_required","Требуется If-Match и Idempotency-Key",428)
    digest = _receipt_hash(request,"bank_import_undo_v1")
    batch_id = uuid5(scope.profile_id,"bank-import:v1:"+body["batch_key"])
    with finance_transaction(engine,verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        revision = _profile_lock(session,scope.profile_id)
        replay = _replay(session,scope,mutation,digest)
        if replay is not None:
            return replay
        if if_match != _opaque_etag(scope.profile_id,revision):
            raise FinanceCommandError("stale_revision","Необходимо перечитать историю",412,revision)
        if body["base_revision"]!=revision:
            _conflict()
        batch = session.execute(text("""
            SELECT status,committed_revision,operation_count FROM bank_import_batches
            WHERE profile_id=:p AND id=:id FOR UPDATE
        """), {"p":scope.profile_id,"id":batch_id}).mappings().one_or_none()
        if batch is None or batch["status"]!="committed":
            _conflict()
        # A later financial command could have spent these funds. Do not guess
        # whether undo is economically compatible with subsequent payments.
        if revision != int(batch["committed_revision"]):
            _conflict()
        rows = session.execute(text("""
            SELECT b.transaction_id,b.kind,t.entity_revision,t.reversed_transaction_id
            FROM bank_import_rows b
            JOIN ledger_transactions t
              ON t.profile_id=b.profile_id AND t.id=b.transaction_id
            WHERE b.profile_id=:p AND b.batch_id=:id ORDER BY b.transaction_id
        """), {"p":scope.profile_id,"id":batch_id}).mappings().all()
        if len(rows)!=int(batch["operation_count"]):
            _conflict()
        prepared=[]
        for row in rows:
            original=row["transaction_id"]
            if (row["entity_revision"]!=1 or row["reversed_transaction_id"] is not None
                or row["kind"] not in ("income","expense","transfer")):
                _conflict()
            linked=session.execute(text("""
                SELECT 1 FROM ledger_payment_links
                WHERE profile_id=:p AND transaction_id=:id LIMIT 1
            """),{"p":scope.profile_id,"id":original}).first()
            already=session.execute(text("""
                SELECT 1 FROM ledger_transactions
                WHERE profile_id=:p AND reversed_transaction_id=:id LIMIT 1
            """),{"p":scope.profile_id,"id":original}).first()
            if linked or already:
                _conflict()
            postings=session.execute(text("""
                SELECT account_id,signed_minor FROM ledger_postings
                WHERE profile_id=:p AND transaction_id=:id ORDER BY account_id
            """),{"p":scope.profile_id,"id":original}).all()
            if len(postings)!=(2 if row["kind"]=="transfer" else 1):
                _conflict()
            prepared.append((original,postings))
        next_revision=revision+1
        for original,postings in prepared:
            _post(session,scope.profile_id,uuid5(batch_id,"undo:"+str(original)),
                  "reversal",scope.user_id,date.today(),
                  [(row.account_id,-int(row.signed_minor)) for row in postings],
                  reversed_id=original,note=reason.strip())
        session.execute(text("""
            UPDATE bank_import_batches
            SET status='cancelled',cancelled_revision=:r
            WHERE profile_id=:p AND id=:id
        """),{"p":scope.profile_id,"id":batch_id,"r":next_revision})
        ack={"status":"CANCELLED","batch_id":str(batch_id),
             "revision":next_revision,"new_operations":0,"reversed_operations":len(rows),
             "replayed":False}
        _snapshot_barrier(session,scope,next_revision,batch_id,"cancel",len(rows))
        _receipt(session,scope,mutation,digest,next_revision,ack)
        return FinanceResult(201,ack,_opaque_etag(scope.profile_id,next_revision))


def get_bank_import_history(
    engine: Engine, *, scope: VerifiedFinanceScope,
    before_revision: int | None = None, page_size: int = 50,
) -> FinanceResult:
    """Read-only private batch history for #38; no original bank file or notes."""
    if type(page_size) is not int or not 1 <= page_size <= 100:
        _invalid()
    if before_revision is not None and (
        type(before_revision) is not int or not 1 <= before_revision <= _MAX_REVISION
    ):
        _invalid()
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        current = session.execute(text("""
            SELECT revision FROM finance_profiles WHERE id=:p FOR SHARE
        """), {"p":scope.profile_id}).scalar_one_or_none()
        if current is None:
            raise FinanceCommandError("forbidden", "Нет доступа к финансовому профилю", 403)
        rows = session.execute(text("""
            SELECT id,batch_key,status,operation_count,committed_revision,
                   cancelled_revision,committed_at
            FROM bank_import_batches
            WHERE profile_id=:p
              AND (CAST(:before AS bigint) IS NULL
                   OR committed_revision < CAST(:before AS bigint))
            ORDER BY committed_revision DESC LIMIT :limit
        """), {"p":scope.profile_id,"before":before_revision,
               "limit":page_size+1}).mappings().all()
        has_more=len(rows)>page_size
        entries=[{
            "batch_id":str(row["id"]),
            "batch_key":row["batch_key"].strip(),
            "status":row["status"],
            "operation_count":int(row["operation_count"]),
            "committed_revision":int(row["committed_revision"]),
            "cancelled_revision":(
                int(row["cancelled_revision"])
                if row["cancelled_revision"] is not None else None
            ),
            "committed_at":row["committed_at"].isoformat(),
        } for row in rows[:page_size]]
        return FinanceResult(200, {
            "schema_version":1, "revision":int(current), "batches":entries,
            "has_more":has_more,
            "next_cursor":(
                entries[-1]["committed_revision"] if has_more else None
            ),
        },_opaque_etag(scope.profile_id,int(current)))

def get_bank_import_rows(
    engine: Engine, *, scope: VerifiedFinanceScope,
) -> FinanceResult:
    """Scoped immutable bank-entry identities for full browser reconciliation.

    The caller must compare this revision with its COMPLETE /state revision.
    Never return a truncated list: missing one imported row could create cash
    twice. File contents and filenames are neither stored nor returned.
    """
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        revision = session.execute(text("""
            SELECT revision FROM finance_profiles WHERE id=:p FOR SHARE
        """), {"p":scope.profile_id}).scalar_one_or_none()
        if revision is None:
            raise FinanceCommandError("forbidden", "Нет доступа к профилю", 403)
        rows = session.execute(text("""
            SELECT r.source_key,r.fingerprint,r.external_id,r.account_id,
                   r.target_account_id,r.transaction_id,r.kind,r.occurred_on,
                   r.amount_minor,r.description,r.category,b.status
            FROM bank_import_rows r
            JOIN bank_import_batches b ON b.profile_id=r.profile_id
             AND b.id=r.batch_id
            WHERE r.profile_id=:p ORDER BY r.transaction_id LIMIT 5001
        """), {"p":scope.profile_id}).mappings().all()
        if len(rows)>5000:
            raise FinanceCommandError("service_unavailable",
                                      "Требуется постраничная сверка импорта", 503)
        return FinanceResult(200,{
            "schema_version":1,"revision":int(revision),
            "rows":[{
                "source_key":row["source_key"].strip(),
                "fingerprint":row["fingerprint"].strip(),
                "external_id":row["external_id"],
                "account_id":str(row["account_id"]),
                "target_account_id":str(row["target_account_id"])
                     if row["target_account_id"] is not None else None,
                "transaction_id":str(row["transaction_id"]),
                "kind":row["kind"],"occurred_on":row["occurred_on"].isoformat(),
                "amount_minor":int(row["amount_minor"]),
                "description":row["description"],"category":row["category"],
                "status":row["status"],
            } for row in rows],
        },_opaque_etag(scope.profile_id,int(revision)))
