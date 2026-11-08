"""#33: exact TypeScript account command envelope -> authenticated FastAPI -> PostgreSQL.

Uses the actual production TS encoder via Node 24, the real FH AuthStore cookie
bridge and the real SQL runtime role. All identities and balances are synthetic.
No account UI, production service, or user IndexedDB is touched.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4

import pytest

from backend.finance_api.tests.test_http import env

pytestmark = pytest.mark.skipif(
    os.getenv("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes",
    reason="Only isolated synthetic PostgreSQL CI is authorized",
)

REPO = Path(__file__).resolve().parents[3]
ORIGIN = "http://127.0.0.1:8791"

NODE_SCRIPT = """
import {encodeTransfer, encodeReversal} from './src/domain/accounts/api-wire.ts';
const request = JSON.parse(process.argv[1]);
const result = request.kind === 'transfer'
  ? encodeTransfer(request.input)
  : encodeReversal(request.input);
process.stdout.write(JSON.stringify(result));
"""


def encode(kind: str, input_data: dict) -> dict:
    """Real JS -> TypeScript transport encoding, no handwritten Python mirror."""
    process = subprocess.run(  # noqa: S603 - fixed executable and fixed source, no shell
        ["node", "--disable-warning=ExperimentalWarning", "--input-type=module",
         "-e", NODE_SCRIPT, json.dumps({"kind": kind, "input": input_data})],
        cwd=REPO, capture_output=True, text=True, check=False, timeout=8,
    )
    assert process.returncode == 0, (
        "TypeScript encoder rejected valid synthetic command: " + process.stderr[:500]
    )
    return json.loads(process.stdout)


def revisions(response: dict) -> dict[str, int]:
    return {entity["id"]: entity["entity_revision"] for entity in response["entities"]}


def post(client, envelope: dict):
    return client.post(
        "/api/finance/v1/commands",
        json=envelope["body"],
        headers={**envelope["headers"], "Origin": ORIGIN},
    )


def balances(state):
    return {entity["id"]: entity["data"]["balance_minor"]
            for entity in state["entities"] if entity["kind"] == "account"}


def test_real_ts_transfer_and_reversal_roundtrip_without_double_debit(env):
    user, cookie = env["first"]
    source = env["account"](user, opening=15_000)
    destination = env["account"](user, opening=-500)
    client = env["client"](cookie)

    initial = client.get("/api/finance/v1/state")
    assert initial.status_code == 200
    a, b = source, destination
    before = balances(initial.json())
    assert before == {a: 15_000, b: -500}
    assert sum(before.values()) == 14_500

    envelope = encode("transfer", {
        "clientMutationId": str(uuid4()),
        "baseRevision": initial.json()["revision"],
        "expectedEntityRevisions": {
            a: revisions(initial.json())[a],
            b: revisions(initial.json())[b],
        },
        "ifMatch": initial.headers["ETag"],
        "fromAccountId": a, "toAccountId": b,
        "amountMinor": 100_000,  # 1000.00 RUB: negative balance permitted.
        "occurredOn": "2026-11-08",
    })
    assert set(envelope["headers"]) == {"If-Match", "Idempotency-Key"}
    assert set(envelope["body"]) == {
        "schema_version", "client_mutation_id", "base_revision",
        "expected_entity_revisions", "action", "payload",
    }
    assert envelope["body"]["action"] == "account.transfer"
    posted = post(client, envelope)
    assert posted.status_code == 201, posted.text
    assert posted.json()["revision"] == initial.json()["revision"] + 1

    replay = post(client, envelope)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert replay.json()["revision"] == posted.json()["revision"]

    moved = client.get("/api/finance/v1/state")
    assert moved.status_code == 200
    cash = balances(moved.json())
    assert cash == {a: -85_000, b: 99_500}
    assert sum(cash.values()) == sum(before.values())
    tx = next(x for x in moved.json()["entities"] if x["kind"] == "transaction")
    assert tx["data"]["kind"] == "transfer"
    assert tx["data"]["occurred_on"] == "2026-11-08"
    assert sorted(x["signed_minor"] for x in tx["data"]["postings"]) == [-100_000, 100_000]

    transfer_revision = tx["entity_revision"]
    reverse = encode("reversal", {
        "clientMutationId": str(uuid4()),
        "baseRevision": moved.json()["revision"],
        "expectedEntityRevisions": {
            **{k: revisions(moved.json())[k] for k in (a, b)},
            tx["id"]: transfer_revision,
        },
        "ifMatch": moved.headers["ETag"],
        "transactionId": tx["id"], "transactionKind": "transfer",
        "postingAccountIds": [a, b],
        "reason": "Синтетическая отмена перевода",
    })
    assert reverse["body"]["payload"] == {
        "transaction_id": tx["id"], "reason": "Синтетическая отмена перевода",
    }
    cancelled = post(client, reverse)
    assert cancelled.status_code == 201, cancelled.text
    assert post(client, reverse).status_code == 200

    final = client.get("/api/finance/v1/state")
    assert final.status_code == 200
    assert balances(final.json()) == before
    transactions = [x for x in final.json()["entities"] if x["kind"] == "transaction"]
    assert len(transactions) == 2
    original = next(x for x in transactions if x["id"] == tx["id"])
    assert original["entity_revision"] == transfer_revision
    revert = next(x for x in transactions if x["data"]["kind"] == "reversal")
    assert revert["data"]["reversed_transaction_id"] == tx["id"]
    assert sum(balances(final.json()).values()) == 14_500

    delta = client.get("/api/finance/v1/changes", params={
        "since_revision": initial.json()["revision"],
    })
    assert delta.status_code == 200
    assert len(delta.json()["changes"]) == 2
    assert [x["kind"] for x in delta.json()["changes"]] == ["ledger_posted", "ledger_posted"]
    assert delta.json()["changes"][0]["payload"]["entity"] == tx
    assert delta.json()["changes"][1]["payload"]["entity"] == revert


def test_real_ts_wire_respects_etag_conflicts_and_foreign_account_scope(env):
    owner, owner_cookie = env["first"]
    foreign, foreign_cookie = env["new_user"]()
    account_a = env["account"](owner, opening=4000)
    account_b = env["account"](owner, opening=2000)
    account_foreign = env["account"](foreign, opening=8000)
    owner_client = env["client"](owner_cookie)
    foreign_client = env["client"](foreign_cookie)

    before = owner_client.get("/api/finance/v1/state")
    versions = revisions(before.json())
    envelope = encode("transfer", {
        "clientMutationId": str(uuid4()), "baseRevision": before.json()["revision"],
        "expectedEntityRevisions": {account_a: versions[account_a], account_b: versions[account_b]},
        "ifMatch": before.headers["ETag"],
        "fromAccountId": account_a, "toAccountId": account_b,
        "amountMinor": 500, "occurredOn": "2026-11-08",
    })
    assert post(owner_client, envelope).status_code == 201
    stale = json.loads(json.dumps(envelope))
    stale["body"]["client_mutation_id"] = str(uuid4())
    stale["headers"]["Idempotency-Key"] = stale["body"]["client_mutation_id"]
    conflict = post(owner_client, stale)
    assert conflict.status_code == 412
    assert conflict.json()["code"] == "stale_revision"

    outsider = foreign_client.get("/api/finance/v1/state")
    external = encode("transfer", {
        "clientMutationId": str(uuid4()),
        "baseRevision": outsider.json()["revision"],
        "expectedEntityRevisions": {
            account_a: 1, account_foreign: revisions(outsider.json())[account_foreign],
        },
        "ifMatch": outsider.headers["ETag"],
        "fromAccountId": account_a, "toAccountId": account_foreign,
        "amountMinor": 100, "occurredOn": "2026-11-08",
    })
    refused = post(foreign_client, external)
    assert refused.status_code == 409
    assert balances(owner_client.get("/api/finance/v1/state").json()) == {
        account_a: 3500, account_b: 2500,
    }
    assert balances(foreign_client.get("/api/finance/v1/state").json()) == {
        account_foreign: 8000,
    }
