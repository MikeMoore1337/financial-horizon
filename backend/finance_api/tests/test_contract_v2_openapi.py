"""Read-only checks for the non-public account v2 OpenAPI proposal (#33/#67)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import get_args

from backend.finance_api.contracts import V1Command
from backend.finance_api.contracts_v2_candidate import (
    ACTIONS, ACCOUNT_KINDS, AccountV2Candidate, AccountCreateV2,
    AccountUpdateV2, AccountArchiveV2, TransactionRecordV2,
    SettlementPaymentRecordV2, LoanPaymentRecordV2, PaymentVoidV2,
)

ROOT = Path(__file__).resolve().parents[3]
CANDIDATE = ROOT / "backend/finance_api/finance-v2-accounts-candidate.openapi.json"
ACCEPTED = ROOT / "docs/architecture/finance-sync-v1.openapi.json"

PAYLOADS = {
    "account.create": ("AccountCreateV2", AccountCreateV2),
    "account.update": ("AccountUpdateV2", AccountUpdateV2),
    "account.archive": ("AccountArchiveV2", AccountArchiveV2),
    "account.unarchive": ("AccountUnarchiveV2", AccountArchiveV2),
    "transaction.record": ("TransactionRecordV2", TransactionRecordV2),
    "settlement.payment.record": ("SettlementPaymentRecordV2", SettlementPaymentRecordV2),
    "loan.payment.record": ("LoanPaymentRecordV2", LoanPaymentRecordV2),
    "settlement.payment.void": ("PaymentVoidV2", PaymentVoidV2),
    "loan.payment.void": ("PaymentVoidV2", PaymentVoidV2),
}


def read():
    return json.loads(CANDIDATE.read_text(encoding="utf-8")), json.loads(
        ACCEPTED.read_text(encoding="utf-8")
    )


def test_candidate_is_not_public_and_leaves_v1_contract_untouched():
    v2, v1 = read()
    assert v2["openapi"] == "3.1.0"
    assert v2["x-go-live"] == "NO_GO"
    assert v2["x-approved"] is False
    assert v2["x-account-v2-opt-in-default"] is False
    assert set(v2["paths"]) == {"/api/finance/v2/commands"}
    assert v2["x-authoritative-read"] == "/api/finance/v1/state"
    assert v2["x-related-bootstrap"] == "/api/auth/email/finance/session"
    assert v2["info"]["version"] != v1["info"]["version"]
    assert "account.create" not in set(
        get_args(V1Command.model_fields["action"].annotation)
    )
    assert v2["components"]["securitySchemes"]["financeV2Cookie"]["x-cookie-path"] == "/api/finance/v2"


def test_v2_command_schema_matches_exact_five_backend_candidate_actions():
    v2, _ = read()
    schemas = v2["components"]["schemas"]
    cmd = schemas["AccountV2Candidate"]
    actions = set(cmd["properties"]["action"]["enum"])
    assert actions == set(ACTIONS) == set(PAYLOADS)
    assert cmd["additionalProperties"] is False
    assert set(cmd["properties"]) == set(AccountV2Candidate.model_fields)
    assert set(cmd["required"]) == {
        name for name, value in AccountV2Candidate.model_fields.items()
        if value.is_required()
    }
    assert cmd["properties"]["schema_version"] == {"type": "integer", "const": 2}
    assert len(cmd["allOf"]) == len(actions)
    assert len(cmd["properties"]["expected_entity_revisions"]["patternProperties"]) == 1
    assert cmd["properties"]["expected_entity_revisions"]["additionalProperties"] is False

    for action, (payload_name, cls) in PAYLOADS.items():
        model = schemas[payload_name]
        assert model["additionalProperties"] is False
        assert set(model["properties"]) == set(cls.model_fields)
        assert set(model["required"]) == {
            key for key, field in cls.model_fields.items() if field.is_required()
        }
        assert any(
            case["if"]["properties"]["action"]["const"] == action
            and case["then"]["properties"]["payload"]["$ref"] ==
                f"#/components/schemas/{payload_name}"
            for case in cmd["allOf"]
        )
    assert schemas["AccountCreateV2"]["properties"]["kind"]["enum"] == list(ACCOUNT_KINDS)
    assert schemas["AccountCreateV2"]["properties"]["currency"]["const"] == "RUB"
    assert schemas["AccountCreateV2"]["properties"]["opening_minor"]["minimum"] == -1_000_000_000_000
    assert schemas["TransactionRecordV2"]["properties"]["signed_minor"]["maximum"] == 1_000_000_000_000
    assert v2["x-payment-id-allocation"].startswith("Both fact_id and transaction_id")
    assert "one PostgreSQL COMMIT" in v2["x-atomic-linked-void"]
    assert {"settlement.payment.record", "loan.payment.record",
            "settlement.payment.void", "loan.payment.void"} <= actions


def test_contract_lists_exact_existing_api_transport_guards():
    v2, _ = read()
    route = v2["paths"]["/api/finance/v2/commands"]["post"]
    assert route["x-feature-off"] is True
    assert route["security"] == [{"financeV2Cookie": []}]
    assert route["x-http-body-max-bytes"] == 32768
    assert route["x-reject-duplicate-json-keys"] is True
    assert route["x-verified-session-required"] is True
    assert route["x-no-client-identity"] is True
    assert {p["name"] for p in route["parameters"] if p["required"]} == {
        "If-Match", "Idempotency-Key",
    }
    assert {"200", "201", "401", "403", "409", "412", "413", "422",
            "428", "429", "503"} <= set(route["responses"])


def test_json_schema_refs_are_closed_to_local_components():
    v2, _ = read()
    schemas = v2["components"]["schemas"]

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                ref = node["$ref"]
                assert ref.startswith("#/components/schemas/")
                assert ref.removeprefix("#/components/schemas/") in schemas
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(v2)
