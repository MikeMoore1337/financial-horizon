"""Feature-off OpenAPI drift guard: accepted ADR vs implemented #67 transport.

These tests are independent of PostgreSQL and use no personal financial data.
The proposed extension is NOT automatic approval of protocol changes.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import get_args

from backend.finance_api.contracts import (
    AccountTransfer, ObligationCreate, ReserveAllocate, TransactionReverse,
    V1Command,
)

ROOT = Path(__file__).resolve().parents[3]
CANDIDATE = ROOT / "backend/finance_api/finance-v1-http-candidate.openapi.json"
ACCEPTED = ROOT / "docs/architecture/finance-sync-v1.openapi.json"

PAYLOAD_TYPES = {
    "obligation.create": ("ObligationCreatePayload", ObligationCreate),
    "account.transfer": ("AccountTransferPayload", AccountTransfer),
    "reserve.allocate": ("ReserveAllocatePayload", ReserveAllocate),
    "transaction.reverse": ("TransactionReversePayload", TransactionReverse),
}


def docs():
    return json.loads(CANDIDATE.read_text(encoding="utf-8")), json.loads(
        ACCEPTED.read_text(encoding="utf-8")
    )


def test_candidate_is_feature_off_and_does_not_replace_accepted_design():
    candidate, accepted = docs()
    assert candidate["x-go-live"] == "NO_GO"
    assert candidate["info"]["version"] != accepted["info"]["version"]
    assert "loan.payment.record" in accepted["components"]["schemas"]["Command"]["properties"]["action"]["enum"]
    assert "loan.payment.record" not in candidate["components"]["schemas"]["Command"]["properties"]["action"]["enum"]
    assert "loan.payment.record" in candidate["x-deferred-actions"]
    assert set(candidate["paths"]) == {
        "/api/auth/email/finance/session",
        "/api/finance/v1/state",
        "/api/finance/v1/changes",
        "/api/finance/v1/commands/{mutation_id}/changes",
        "/api/finance/v1/commands",
        "/api/finance/v1/commands/cancel",
    }


def test_candidate_action_enumeration_and_payload_fields_match_strict_pydantic():
    candidate, _ = docs()
    schema = candidate["components"]["schemas"]
    cmd = schema["Command"]
    actions = set(cmd["properties"]["action"]["enum"])
    assert actions == set(get_args(V1Command.model_fields["action"].annotation))
    assert actions == set(PAYLOAD_TYPES)
    assert cmd["additionalProperties"] is False
    assert set(cmd["required"]) == set(V1Command.model_fields)
    conditionals = cmd["allOf"]
    assert len(conditionals) == len(actions)

    for action, (payload_name, wire_model) in PAYLOAD_TYPES.items():
        payload = schema[payload_name]
        assert set(payload["properties"]) == set(wire_model.model_fields)
        assert set(payload["required"]) == set(wire_model.model_fields)
        assert payload["additionalProperties"] is False
        assert any(
            case.get("if", {}).get("properties", {}).get("action", {}).get("const") == action
            and case.get("then", {}).get("properties", {}).get("payload", {}).get("$ref")
                == f"#/components/schemas/{payload_name}"
            for case in conditionals
        )


def test_protocol_documents_auth_rate_bounds_pagination_and_exact_conflicts():
    candidate, _ = docs()
    paths = candidate["paths"]
    schemes = candidate["components"]["securitySchemes"]
    assert schemes["authBootstrap"]["name"] == "fh_email_session"
    assert schemes["financeCookie"]["name"] == "fh_finance_session"
    assert paths["/api/auth/email/finance/session"]["post"]["security"] == [
        {"authBootstrap": []}
    ]
    bootstrap_schema = paths["/api/auth/email/finance/session"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert bootstrap_schema["properties"]["payment_guard_v1"]["type"] == "boolean"
    assert bootstrap_schema["properties"]["sync_profile_fence_v1"]["type"] == "boolean"
    assert bootstrap_schema["properties"]["sync_cancel_fence_v1"]["type"] == "boolean"
    for path, verb in [
        ("/api/finance/v1/state", "get"),
        ("/api/finance/v1/changes", "get"),
        ("/api/finance/v1/commands/{mutation_id}/changes", "get"),
        ("/api/finance/v1/commands", "post"),
        ("/api/finance/v1/commands/cancel", "post"),
    ]:
        assert paths[path][verb]["security"] == [{"financeCookie": []}]
        assert paths[path][verb]["x-feature-off"] is True

    state = paths["/api/finance/v1/state"]["get"]
    assert {p["name"] for p in state["parameters"]} == {"cursor", "limit_entities"}
    limits = next(p for p in state["parameters"] if p["name"] == "limit_entities")
    assert limits["schema"]["maximum"] == 5000
    assert {"200", "206", "401", "412", "422", "429", "503"} <= set(state["responses"])
    assert "next_cursor" in candidate["components"]["schemas"]["Snapshot"]["properties"]
    assert "allocations_by_account" in candidate["components"]["schemas"]["Entity"]["x-reserve-addendum"]
    assert candidate["x-reserve-pair-page-max"] == 10000
    allowed_errors = set(candidate["components"]["schemas"]["Error"]["properties"]["code"]["enum"])
    assert {"unauthenticated", "forbidden", "rate_limited",
            "service_unavailable", "invalid_command"} <= allowed_errors
    assert "unauthorized" not in allowed_errors
    assert {"command_cancelled", "command_already_committed"} <= allowed_errors
    cancel = paths["/api/finance/v1/commands/cancel"]["post"]
    assert {"If-Match", "Idempotency-Key", "X-FH-Expected-Profile"} == {p["name"] for p in cancel["parameters"]}
    assert {"200", "401", "403", "409", "422", "428", "429", "503"} <= set(cancel["responses"])
    changes = paths["/api/finance/v1/changes"]["get"]
    assert {"200", "401", "410", "422", "429", "503"} <= set(changes["responses"])
    recovery = paths["/api/finance/v1/commands/{mutation_id}/changes"]["get"]
    assert {p["name"] for p in recovery["parameters"]} == {"mutation_id", "X-FH-Expected-Profile"}
    assert {"200", "401", "403", "410", "422", "429", "503"} <= set(recovery["responses"])
    assert recovery["responses"]["200"]["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"
    cmd = paths["/api/finance/v1/commands"]["post"]
    assert cmd["x-http-body-max-bytes"] == 32768
    assert cmd["x-no-duplicate-json-keys"] is True
    assert {"200", "201", "401", "403", "409", "412", "413", "422",
            "428", "429", "503"} <= set(cmd["responses"])


def test_all_local_schema_refs_are_resolvable_and_json_is_valid():
    candidate, _ = docs()
    schemas = candidate["components"]["schemas"]

    def walk(value):
        if isinstance(value, dict):
            if "$ref" in value:
                ref = value["$ref"]
                assert ref.startswith("#/components/schemas/"), ref
                assert ref.removeprefix("#/components/schemas/") in schemas
            for nested in value.values():
                walk(nested)
        elif isinstance(value, list):
            for nested in value:
                walk(nested)

    walk(candidate)
