# Financial Horizon #67 - hardening the existing finance routes

This directory contains **transport security and strict DTO validation** for
the finance routes in backend/finance_db/finance_router.py from PR #98.
There is only ONE finance HTTP router, integrated through existing FH AuthStore
when explicitly enabled with finance_engine and finance_profile_namespace.

Snapshot pagination from the upstream #98 core is retained: HTTP 206 and
revision-pinned `next_cursor` require explicit #65/#68 client acceptance.
Malformed or repeated query parameters are rejected without echoing input.

No production wiring is changed by this PR. The application remains feature
OFF until verified dependencies and owner-approved release gates complete.

## In this change

- Bound POST bodies to 32 KiB while streaming, even without Content-Length.
- Accept ONLY four implemented actions from the accepted v1 contract:
  obligation.create, account.transfer, reserve.allocate and transaction.reverse.
  Internal CRUD and account-linked payments remain unpublished.
- Reject unexpected payload fields, invalid canonical UUID/date, floats, booleans
  for minor-unit money, missing/extra request fields, invalid entity revisions,
  nonfinite JSON values; keep validation error text out of HTTP/logs.
- Require the PostgreSQL engine at route mounting and preserve existing strong
  Origin/CSRF checks, secure FH-cookie bridge, FORCE RLS and SQL command receipts.
- Independent synthetic HTTP regression tests exercise **the same router used
  by the existing auth app** with real PostgreSQL 17 and real SQLite AuthStore.
- Dedicated CI provisions disposable PostgreSQL and least-privilege runtime.
  This is not evidence of production availability.

## Release gates (still OPEN)

- PostgreSQL #66 PR #79 independent approval, encrypted data volume, offsite
  backup, verified restore and exact-SHA production release.
- #98 financial ledger atomicity and final action coverage; current OpenAPI v1
  still includes loan.payment.record, blocked on an agreed linked-account
  payment DTO and atomic void semantics. Do not publish partial payments.
- No linked payment cancellation until SQL deferred invariants and runtime
  grants support one atomic void+compensation without a second debit.
- Owner-approved versioned contracts for internal account creation, income,
  expense and adjustment. Client must never supply user/profile as authority.
- #68 offline sync, #69 opt-in import, #70 full-stack security/UX acceptance,
  a fresh independent security review, and controlled rollback validation.

Do not merge or expose the financial API until all mandatory gates pass.


## Public HTTP v1 wire examples (feature OFF until release gates)

These examples use **synthetic UUIDs and amounts**. They describe the public
implementation in this PR. The accepted ADR-0065
`docs/architecture/finance-sync-v1.openapi.json` is the target contract;
**`loan.payment.record` remains unavailable**, because the approved payload has
no account/transaction identity. Publishing it as a cash debit would
misstate the user's account balance. A versioned atomic-payment contract is needed.

1. Send an existing verified FH login cookie in
   `POST /api/auth/email/finance/session` (same Origin, CSRF requirements).
   This authenticates using the existing SQLite AuthStore and sets a separate
   path-scoped, HttpOnly `fh_finance_session`; do not set a user/profile from JSON.
2. `GET /api/finance/v1/state` returns a revision-pinned snapshot and strong
   `ETag`. When `next_cursor` exists, the response is **206** and subsequent
   pages must use `GET /api/finance/v1/state?cursor=<opaque>&limit_entities=1000`.
   Revision changes during pagination trigger **412**, requiring a fresh start.
   Never assume a first 206 page is a full snapshot.
3. `POST /api/finance/v1/commands`: set
   `Content-Type: application/json`, same `Origin`,
   `Idempotency-Key: <client_mutation_id>` and
   `If-Match: <strong ETag from state>`. Maximum request body **32 KiB**.
   All IDs below must be genuine canonical versioned UUIDs in the real client.

```json
{
  "schema_version": 1,
  "client_mutation_id": "12eb3db3-12e1-45fe-9bf7-ef80d33af47f",
  "base_revision": 0,
  "action": "obligation.create",
  "expected_entity_revisions": {},
  "payload": {
    "title": "Аренда",
    "direction": "expense",
    "amount_minor": 1200000,
    "starts_on": "2026-12-01",
    "timezone": "Europe/Helsinki",
    "recurrence_unit": "month",
    "recurrence_every": 1
  }
}
```

This creates **only a planned obligation**. It does **not** reduce an account
balance, claim a settlement or create a ledger posting. Entity ID is generated
**server-side**, returned with the complete entity image in the same revision
and stored idempotency receipt. An exact retry with the same key returns the
same entity, `replayed=true` and HTTP 200 without adding another obligation.

```json
{
  "schema_version": 1,
  "client_mutation_id": "a1482579-ce52-4eb6-a43d-997b6d18eadb",
  "base_revision": 3,
  "action": "account.transfer",
  "expected_entity_revisions": {
    "7bbf13a7-211c-4ec7-b3f3-5f507ed682bb": 2,
    "c32382c9-acb7-448f-9166-e51620f623c1": 1
  },
  "payload": {
    "from_account_id": "7bbf13a7-211c-4ec7-b3f3-5f507ed682bb",
    "to_account_id": "c32382c9-acb7-448f-9166-e51620f623c1",
    "amount_minor": 250000,
    "occurred_on": "2026-12-01"
  }
}
```

Amounts are **integer RUB kopecks**. The transfer moves the exact amount
between two distinct verified accounts and preserves overall wealth.
`transaction.reverse` requires `transaction_id` and nonblank `reason`;
it creates compensating postings rather than deleting ledger history.
**Payment-linked transactions are not individually reversible** until a
reviewed atomic fact-void protocol exists.

Reserve allocation/release reserves cash **without posting a transaction**.
Both the affected account and reserve are incremented in one committed
revision, with full images in two ordered change-log events. The server refuses
allocation beyond the reserve target or available account funds and refuses
to release more than was allocated from that specific account.

```json
{
  "schema_version": 1,
  "client_mutation_id": "0693b5a5-e313-42b8-b2ce-ad7d50a70aa9",
  "base_revision": 4,
  "action": "reserve.allocate",
  "expected_entity_revisions": {
    "837c96b3-73d6-4c69-a47e-7626bbf78ab4": 1,
    "7bbf13a7-211c-4ec7-b3f3-5f507ed682bb": 2
  },
  "payload": {
    "reserve_id": "837c96b3-73d6-4c69-a47e-7626bbf78ab4",
    "account_id": "7bbf13a7-211c-4ec7-b3f3-5f507ed682bb",
    "delta_minor": 250000
  }
}
```

Use a negative `delta_minor` to release a previously allocated amount.
The reserve's `allocated_minor` and account's
`reserved_minor`/`available_minor` are server-calculated from the ledger.

4. After a successful POST, consume
   `GET /api/finance/v1/changes?since_revision=<last_committed_revision>&limit_revisions=50`.
   Each page contains complete ordered revisions; advance the client cursor
   only after **one local atomic IndexedDB transaction**.
   HTTP **410** `snapshot_required` mandates a new snapshot without dropping
   pending operations.

| Code | Meaning |
|---|---|
| 200/201 | Snapshot/delta or command receipt; replay returns 200 |
| 206 | Snapshot page incomplete - follow `next_cursor` |
| 401 | FH session missing, expired or revoked - never fall back to client headers |
| 403 | Invalid Origin/Fetch Metadata or cross-profile denial |
| 409 | Semantic conflict or reused key with different input |
| 410 | Delta compacted; fetch new snapshot |
| 412 | Stale If-Match/revision or paged snapshot cursor |
| 413 | Oversized request (including chunked) |
| 422 | Invalid DTO, unsupported command, duplicated JSON keys or query parameters |
| 428 | Missing/non-strong If-Match |
| 429 | Verified quota exhausted |
| 503 | Auth/quota/finance DB unavailable, incomplete delta or overlarge response |

Security boundary: only existing FH sessions are authoritative. The published
finance JSON never accepts `owner_user_id`, `profile_id`, synthetic payment
fact flags, database connection strings, encryption keys or arbitrary SQL.
The JSON wire parser rejects noncanonical UUIDs, booleans/floats in money,
duplicate object keys (also nested) and excessive nesting. Every successful
mutation is one PostgreSQL transaction with its revision, change log and
SHA-256 idempotency receipt.

**No release claim:** The current PR contains only an opt-in candidate. The
existing PWA continues to use IndexedDB, and existing browser E2E validates
that unchanged mode, **not** production finance sync.
