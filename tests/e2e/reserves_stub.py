"""Synthetic, single-user in-memory finance reserve stub for browser UI tests.

Never imported by production. PostgreSQL/RLS correctness is covered by the
separate real finance-postgres CI lane. This covers real Chromium/WebKit UI
against HTTP without fabricating a production write.
"""
import copy
import threading
from datetime import date
from uuid import UUID, uuid4, uuid5

PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ACCOUNT = "11111111-1111-4111-8111-111111111111"
HOSTING_OBLIGATION = "22222222-2222-4222-8222-222222222222"
HOSTING_RESERVE = "33333333-3333-4333-8333-333333333333"
INSURANCE_OBLIGATION = "44444444-4444-4444-8444-444444444444"
INSURANCE_RESERVE = "55555555-5555-4555-8555-555555555555"

def _reserve(identifier, obligation, title, target, allocated):
    return {
        "id": identifier, "kind": "reserve", "entity_revision": 1,
        "data": {
            "title": title, "obligation_id": obligation, "account_id": ACCOUNT,
            "opened_on": "2026-11-01", "first_due_on": "2026-12-12",
            "target_on": "2026-12-12", "period_months": 12, "due_day": 12,
            "contribution_mode": "auto", "fixed_monthly_minor": None,
            "opening_reserved_minor": allocated, "opening_target_minor": target,
            "target_minor": target, "cycle_number": 1, "allocated_minor": allocated,
            "archived_at": None,
            "allocations_by_account": [{
                "account_id": ACCOUNT, "allocated_minor": allocated,
            }],
            "event_log": [],
        },
    }

def _obligation(identifier, title, amount):
    return {
        "id": identifier, "kind": "obligation", "entity_revision": 1,
        "data": {
            "title": title, "direction": "expense", "amount_minor": amount,
            "starts_on": "2026-12-12", "timezone": "UTC",
            "recurrence_unit": "year", "recurrence_every": 1,
            "category": None, "deleted_at": None,
        },
    }

class ReserveStub:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = {}

    def activate(self, user_id, transaction=False):
        with self.lock:
            self.users[user_id] = {
                "revision": 1, "balance": 7000000, "account_revision": 1,
                "obligations": [
                    _obligation(HOSTING_OBLIGATION, "Хостинг", 900000),
                    _obligation(INSURANCE_OBLIGATION, "Страхование", 2400000),
                ],
                "reserves": [
                    _reserve(HOSTING_RESERVE, HOSTING_OBLIGATION, "Хостинг", 900000, 600000),
                    _reserve(INSURANCE_RESERVE, INSURANCE_OBLIGATION, "Страхование", 2400000, 800000),
                ],
                "transactions": [], "facts": [], "mutations": {},
            }
            if transaction:
                self.users[user_id]["transactions"].append({
                    "id": "66666666-6666-4666-8666-666666666666", "kind": "transaction", "entity_revision": 1,
                    "data": {"kind": "expense", "occurred_on": "2026-11-01", "note": "Synthetic transaction",
                             "posted_at": "2026-11-01T12:00:00Z",
                             "postings": [{"account_id": ACCOUNT, "signed_minor": -12345}]},
                })

    def exists(self, user_id):
        with self.lock:
            return user_id in self.users

    @staticmethod
    def etag(revision):
        return '"fh.1.' + str(revision) + '.synthetic-reserves"'

    def snapshot(self, user_id):
        with self.lock:
            state = self.users[user_id]
            allocated = sum(item["data"]["allocated_minor"] for item in state["reserves"])
            bank = state["balance"]
            account = {
                "id": ACCOUNT, "kind": "account",
                "entity_revision": state["account_revision"],
                "data": {
                    "name": "Основной счёт", "type": "bank",
                    "currency": "RUB", "opening_minor": 7000000,
                    "balance_minor": bank, "reserved_minor": allocated,
                    "available_minor": bank - allocated, "archived_at": None,
                },
            }
            entities = [
                account, *state["obligations"], *state["reserves"],
                *state["transactions"], *state["facts"],
            ]
            return copy.deepcopy({
                "schema_version": 1, "profile_id": PROFILE,
                "revision": state["revision"], "currency": "RUB",
                "entities": entities, "server_at": "2026-11-17T12:00:00+00:00",
            }), self.etag(state["revision"])

    def execute(self, user_id, request, if_match, idem_key):
        with self.lock:
            state = self.users[user_id]
            if not isinstance(request, dict) or request.get("schema_version") != 2:
                return 422, {"code": "invalid_command"}, None
            mutation = request.get("client_mutation_id")
            if not isinstance(mutation, str) or mutation != idem_key:
                return 422, {"code": "invalid_command"}, None
            if mutation in state["mutations"]:
                prev = copy.deepcopy(state["mutations"][mutation])
                prev["replayed"] = True
                return 200, prev, self.etag(prev["revision"])
            current_revision = state["revision"]
            if if_match != self.etag(current_revision):
                return 412, {"code": "stale_revision"}, None
            if request.get("base_revision") != current_revision:
                return 409, {"code": "semantic_conflict"}, None
            payload = request.get("payload")
            expected = request.get("expected_entity_revisions")
            if not isinstance(payload, dict) or not isinstance(expected, dict):
                return 422, {"code": "invalid_command"}, None
            relevant = {
                ACCOUNT: state["account_revision"],
                **{row["id"]: row["entity_revision"] for row in [
                    *state["obligations"], *state["reserves"], *state["transactions"], *state["facts"],
                ]},
            }
            if any(relevant.get(key) != value for key, value in expected.items()):
                return 409, {"code": "semantic_conflict"}, None
            action = request.get("action")
            reserve = next((row for row in state["reserves"]
                            if row["id"] == payload.get("reserve_id")), None)
            if action in ("reserve.allocate", "settlement.payment.record", "reserve.cycle.close"):
                if action == "settlement.payment.record":
                    reserve = next((row for row in state["reserves"]
                                    if row["id"] == payload.get("reserve_id")), None)
                if not reserve or reserve["id"] != HOSTING_RESERVE:
                    return 409, {"code": "semantic_conflict"}, None
            if action == "reserve.allocate":
                delta = payload.get("delta_minor")
                if (not isinstance(delta, int) or delta <= 0 or
                    payload.get("account_id") != ACCOUNT or
                    state["balance"] - sum(x["data"]["allocated_minor"] for x in state["reserves"]) < delta):
                    return 422, {"code": "invalid_command"}, None
                reserve["data"]["allocated_minor"] += delta
                reserve["data"]["allocations_by_account"][0]["allocated_minor"] += delta
                state["account_revision"] += 1
                reserve["entity_revision"] += 1
                reserve["data"]["event_log"].append({
                    "id": str(uuid4()), "reserve_id": reserve["id"],
                    "kind": "contribution", "occurred_on": payload.get("occurred_on"),
                    "cycle_number": 1, "revision": current_revision + 1,
                    "amount_minor": delta, "reserved_used_minor": None, "target_minor": None,
                    "slot_on": None, "note": None, "target_event_id": None,
                    "allocation_id": str(uuid4()), "transaction_id": None,
                })
            elif action == "settlement.payment.record":
                amount = payload.get("amount_minor")
                used = payload.get("reserved_used_minor")
                seed = f"financial-horizon:payment:v2:{action}:{mutation}"
                transaction_id = str(uuid5(UUID(PROFILE), seed + ":transaction"))
                fact_id = str(uuid5(UUID(PROFILE), seed + ":fact"))
                if (not isinstance(amount, int) or amount != 900000 or
                    not isinstance(used, int) or used < 0 or
                    used > amount or used > reserve["data"]["allocated_minor"] or
                    state["balance"] < amount or
                    set(payload) != {"account_id", "obligation_id", "amount_minor", "paid_on",
                                     "occurrence_on", "reserve_id", "reserved_used_minor"} or
                    payload.get("account_id") != ACCOUNT or
                    payload.get("obligation_id") != HOSTING_OBLIGATION):
                    return 422, {"code": "invalid_command"}, None
                reserve["data"]["allocated_minor"] -= used
                reserve["data"]["allocations_by_account"][0]["allocated_minor"] -= used
                if reserve["data"]["allocated_minor"] == 0:
                    reserve["data"]["allocations_by_account"] = []
                state["balance"] -= amount
                state["account_revision"] += 1
                reserve["entity_revision"] += 1
                reserve["data"]["event_log"].append({
                    "id": str(uuid4()), "reserve_id": reserve["id"],
                    "kind": "payment", "occurred_on": payload.get("paid_on"),
                    "cycle_number": 1, "revision": current_revision + 1,
                    "amount_minor": amount, "reserved_used_minor": used, "target_minor": None,
                    "slot_on": None, "note": None, "target_event_id": None,
                    "allocation_id": str(uuid4()), "transaction_id": transaction_id,
                })
                state["transactions"].append({
                    "id": transaction_id, "kind": "transaction", "entity_revision": 1,
                    "data": {
                        "kind": "payment", "occurred_on": payload["paid_on"],
                        "note": None, "reversed_transaction_id": None,
                        "postings": [{"account_id": ACCOUNT, "signed_minor": -amount}],
                        "payment_link": {
                            "settlement_id": fact_id, "loan_payment_id": None,
                        },
                    },
                })
                state["facts"].append({
                    "id": fact_id, "kind": "settlement", "entity_revision": 1,
                    "data": {
                        "obligation_id": HOSTING_OBLIGATION, "occurrence_on": payload["occurrence_on"],
                        "paid_on": payload["paid_on"], "amount_minor": amount, "voided_at": None,
                    },
                })
            elif action == "reserve.cycle.close":
                if reserve["data"]["cycle_number"] != 1 or not any(
                    entry["kind"] == "payment" for entry in reserve["data"]["event_log"]
                ):
                    return 409, {"code": "semantic_conflict"}, None
                reserve["data"]["event_log"].append({
                    "id": str(uuid4()), "reserve_id": reserve["id"],
                    "kind": "cycle_close", "occurred_on": payload.get("occurred_on"),
                    "cycle_number": 1, "revision": current_revision + 1,
                    "amount_minor": None, "reserved_used_minor": None, "target_minor": None,
                    "slot_on": None, "note": None, "target_event_id": None,
                    "allocation_id": None, "transaction_id": None,
                })
                reserve["data"]["cycle_number"] = 2
                reserve["data"]["target_on"] = "2027-12-12"
                reserve["entity_revision"] += 1
            else:
                return 422, {"code": "unsupported"}, None
            state["revision"] += 1
            acknowledgement = {
                "schema_version": 2, "client_mutation_id": mutation,
                "revision": state["revision"], "replayed": False,
                "changes": [{"kind": "upsert", "revision": state["revision"]}],
            }
            if action == "settlement.payment.record":
                transaction, fact = state["transactions"][-1], state["facts"][-1]
                acknowledgement["changes"] = [
                    {"kind": kind, "revision": state["revision"], "ordinal": ordinal,
                     "entity_id": entity["id"], "entity_revision": entity["entity_revision"],
                     "payload": {"entity": copy.deepcopy(entity)}}
                    for ordinal, (kind, entity) in enumerate([
                        ("ledger_posted", transaction), ("upsert", fact)])
                ]
            state["mutations"][mutation] = copy.deepcopy(acknowledgement)
            return 201, acknowledgement, self.etag(state["revision"])
