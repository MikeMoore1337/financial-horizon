"""#33/#67: nonpublic v2 account transport proposal, no DB or HTTP exposure."""
from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from backend.finance_api.contracts import V1Command
from backend.finance_api.contracts_v2_candidate import (
    validate_v2_account_candidate,
)

ACCOUNT = "a0000000-0000-4000-8000-000000000001"
TRANSACTION = "b0000000-0000-4000-8000-000000000002"
MUTATION = "c0000000-0000-4000-8000-000000000003"
ETAG = '"fh.1.3.0123456789abcdef"'


def cmd(action, payload, revisions=None):
    return {
        "schema_version": 2,
        "client_mutation_id": MUTATION,
        "base_revision": 3,
        "action": action,
        "expected_entity_revisions": {} if revisions is None else revisions,
        "payload": payload,
    }


def validate(command, **overrides):
    return validate_v2_account_candidate(
        command,
        if_match=overrides.get("if_match", ETAG),
        idempotency_key=overrides.get("idempotency_key", MUTATION),
    )


def test_candidate_create_requires_explicit_int_kopecks_and_original_identity():
    for amount in (0, -127, 100_000_000_000):
        request = cmd("account.create", {
            "id": ACCOUNT, "name": "Синтетический счёт",
            "kind": "bank", "currency": "RUB", "opening_minor": amount,
        })
        accepted = validate(request)
        assert accepted["payload"]["id"] == ACCOUNT
        assert accepted["payload"]["opening_minor"] == amount
        assert accepted["expected_entity_revisions"] == {}
        assert accepted["client_mutation_id"] == MUTATION
        assert accepted["schema_version"] == 2


@pytest.mark.parametrize("override", [
    {"opening_minor": True},
    {"opening_minor": 10.0},
    {"opening_minor": 1000000000001},
    {"currency": "EUR"},
    {"name": "  "},
    {"kind": "external"},
    {"id": ACCOUNT.upper()},
    {"owner_user_id": "fake-owner"},
])
def test_candidate_rejects_unsafe_opening_balance_and_client_claims(override):
    payload = {
        "id": ACCOUNT, "name": "Синтетический счёт",
        "kind": "bank", "currency": "RUB", "opening_minor": 0,
    }
    payload.update(override)
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd("account.create", payload))


def test_candidate_create_without_opening_and_with_untrusted_entity_versions_fails():
    payload = {"id": ACCOUNT, "name": "Касса", "kind": "cash", "currency": "RUB"}
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd("account.create", payload))
    payload["opening_minor"] = 0
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd("account.create", payload, {ACCOUNT: 1}))


@pytest.mark.parametrize("action,payload", [
    ("account.update", {"account_id": ACCOUNT, "name": "Новый счёт", "kind": "cash"}),
    ("account.archive", {"account_id": ACCOUNT}),
    ("account.unarchive", {"account_id": ACCOUNT}),
])
def test_candidate_account_updates_require_exact_entity_revision(action, payload):
    request = cmd(action, payload, {ACCOUNT: 4})
    assert validate(request)["expected_entity_revisions"] == {ACCOUNT: 4}
    for invalid in ({}, {TRANSACTION: 2}, {ACCOUNT: 4, TRANSACTION: 1}):
        with pytest.raises((ValidationError, ValueError)):
            validate(cmd(action, payload, invalid))


@pytest.mark.parametrize("kind,minor", [
    ("income", 50), ("expense", -50), ("adjustment", -50),
    ("adjustment", 50),
])
def test_candidate_transaction_record_uses_signed_minor(kind, minor):
    payload = {
        "id": TRANSACTION, "account_id": ACCOUNT,
        "kind": kind, "signed_minor": minor,
        "occurred_on": "2026-11-11",
    }
    accepted = validate(cmd("transaction.record", payload, {ACCOUNT: 2}))
    assert accepted["payload"]["signed_minor"] == minor
    assert "note" not in accepted["payload"]


@pytest.mark.parametrize("invalid", [
    {"signed_minor": 0},
    {"kind": "income", "signed_minor": -1},
    {"kind": "expense", "signed_minor": 1},
    {"signed_minor": 1.5},
    {"signed_minor": False},
    {"occurred_on": "2026-02-30"},
    {"note": "a" * 501},
    {"profile_id": ACCOUNT},
])
def test_candidate_rejects_incorrect_or_spoofed_financial_record(invalid):
    payload = {
        "id": TRANSACTION, "account_id": ACCOUNT, "kind": "expense",
        "signed_minor": -50, "occurred_on": "2026-11-11",
    }
    payload.update(invalid)
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd("transaction.record", payload, {ACCOUNT: 1}))


@pytest.mark.parametrize("bad_version", [1, "2", 2.0, True, None])
def test_v2_never_coerces_versions_or_changes_accepted_v1(bad_version):
    body = cmd("account.archive", {"account_id": ACCOUNT}, {ACCOUNT: 1})
    body["schema_version"] = bad_version
    with pytest.raises((ValidationError, ValueError)):
        validate(body)
    # The already accepted v1 transport still rejects account commands.
    old = deepcopy(body)
    old["schema_version"] = 1
    with pytest.raises(ValidationError):
        V1Command.model_validate(old)


@pytest.mark.parametrize("change", [
    {"base_revision": True},
    {"expected_entity_revisions": {ACCOUNT: True}},
    {"expected_entity_revisions": {ACCOUNT: 1.5}},
    {"expected_entity_revisions": {ACCOUNT: 0}},
    {"client_mutation_id": MUTATION.upper()},
    {"profile_id": ACCOUNT},
])
def test_candidate_rejects_identity_and_precondition_spoofing(change):
    body = cmd("account.archive", {"account_id": ACCOUNT}, {ACCOUNT: 1})
    body.update(change)
    with pytest.raises((ValidationError, ValueError)):
        validate(body)


@pytest.mark.parametrize("kwargs", [
    {"if_match": "W/" + ETAG},
    {"if_match": "123"},
    {"if_match": ETAG + "\n"},
    {"idempotency_key": TRANSACTION},
])
def test_candidate_rejects_weak_etag_and_mismatched_idempotency(kwargs):
    with pytest.raises(ValueError):
        validate(cmd("account.archive", {"account_id": ACCOUNT}, {ACCOUNT: 1}), **kwargs)


@pytest.mark.parametrize("action,payload,related_id", [
    ("settlement.payment.record", {
        "obligation_id": TRANSACTION, "account_id": ACCOUNT,
        "amount_minor": 100, "paid_on": "2026-11-11", "occurrence_on": "2026-11-11",
    }, TRANSACTION),
    ("loan.payment.record", {
        "loan_id": TRANSACTION, "account_id": ACCOUNT,
        "amount_minor": 100, "paid_on": "2026-11-11", "strategy": "term",
    }, TRANSACTION),
])
def test_candidate_funded_payment_requires_account_and_source_revision(action, payload, related_id):
    clean = cmd(action, payload, {ACCOUNT: 2, related_id: 1})
    accepted = validate(clean)
    assert accepted["action"] == action
    assert accepted["payload"]["amount_minor"] == 100
    assert "fact_id" not in accepted["payload"]
    assert "transaction_id" not in accepted["payload"]
    for changes in ({ACCOUNT: 2}, {related_id: 1}, {}):
        with pytest.raises((ValidationError, ValueError)):
            validate(cmd(action, payload, changes))
    for extra in ({"fact_id": ACCOUNT}, {"transaction_id": TRANSACTION},
                  {"paid": True}, {"actor_user_id": "f" * 32}):
        with pytest.raises((ValidationError, ValueError)):
            validate(cmd(action, {**payload, **extra}, {ACCOUNT: 2, related_id: 1}))


@pytest.mark.parametrize("invalid", [
    {"amount_minor": 0}, {"amount_minor": -1}, {"amount_minor": 1.1},
    {"amount_minor": True}, {"paid_on": "2026-02-30"},
])
def test_candidate_funded_payment_rejects_bad_money_and_dates(invalid):
    payload = {"loan_id": TRANSACTION, "account_id": ACCOUNT,
               "amount_minor": 100, "paid_on": "2026-11-11", "strategy": "term"}
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd("loan.payment.record", {**payload, **invalid},
                     {TRANSACTION: 1, ACCOUNT: 1}))


@pytest.mark.parametrize("action", ["loan.payment.void", "settlement.payment.void"])
def test_candidate_void_requires_exact_fact_account_and_original_revision(action):
    payload = {"transaction_id": TRANSACTION, "fact_id": MUTATION,
               "account_id": ACCOUNT, "reason": "Ошибочная оплата"}
    validated = validate(cmd(action, payload, {TRANSACTION: 1, MUTATION: 2, ACCOUNT: 3}))
    assert validated["payload"]["reason"] == "Ошибочная оплата"
    for missing in (TRANSACTION, MUTATION, ACCOUNT):
        without = {TRANSACTION: 1, MUTATION: 2, ACCOUNT: 3}
        del without[missing]
        with pytest.raises((ValidationError, ValueError)):
            validate(cmd(action, payload, without))
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd(action, {**payload, "reason": "  "}, {TRANSACTION: 1, MUTATION: 2, ACCOUNT: 3}))
    with pytest.raises((ValidationError, ValueError)):
        validate(cmd(action, {**payload, "voided_at": "2026-11-11T00:00:00Z"},
                     {TRANSACTION: 1, MUTATION: 2, ACCOUNT: 3}))
