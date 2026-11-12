# Financial Horizon #33 / #67 - account command v2 candidate (FEATURE OFF)

**Status: PROPOSAL / NOT APPROVED / NOT PUBLIC / NOT DEPLOYED.**
This document and `backend/finance_api/contracts_v2_candidate.py` describe a
strictly validated candidate, not a replacement for
`docs/architecture/finance-sync-v1.openapi.json`. A candidate v2 route exists
only behind explicit test-host opt-in; no v2 route is mounted by default.
The existing `/api/finance/v1/commands` whitelist stays unchanged.

## Scope and server authority

The proposed v2 envelope contains **only**
`schema_version=2`, `client_mutation_id` (canonical UUID),
`base_revision` (nonnegative safe integer),
`action`, `expected_entity_revisions`, and `payload`.
A strong server-provided `If-Match` and matching `Idempotency-Key` are required.

The server authenticates the current FH session and derives the financial
profile itself; a client-supplied user, actor, profile, `paid`, or `verified`
claim is never trusted. Reject unexpected fields and invalid UUIDs, money,
dates, versions, signs, and inconsistent entity revision sets **before**
writing. Monetary values are integer kopecks, `RUB` only.

| Candidate action | Required payload | Entity revisions |
| --- | --- | --- |
| `account.create` | `id`, `name`, `kind`, `currency=RUB`, explicit `opening_minor` | Empty |
| `account.update` | `account_id`, `name`, `kind` | Exactly this account |
| `account.archive` | `account_id` | Exactly this account |
| `account.unarchive` | `account_id` | Exactly this account |
| `transaction.record` | `id`, `account_id`, `kind`, signed `signed_minor`, `occurred_on`, optional `note` | Exactly this account |
| `settlement.payment.record` | `obligation_id`, `account_id`, `amount_minor`, `paid_on`, `occurrence_on` | Funding account + obligation |
| `loan.payment.record` | `loan_id`, `account_id`, `amount_minor`, `paid_on`, `strategy` | Funding account + loan |
| `settlement.payment.void` | `transaction_id`, `fact_id`, `account_id`, `reason` | Original transaction + fact + account |
| `loan.payment.void` | `transaction_id`, `fact_id`, `account_id`, `reason` | Original transaction + fact + account |

UUIDs for a proposed new account or transaction come from the client
and are checked for canonical format; the server-generated **actor/profile**
IDs never come from the body. On an accepted request the authoritative
PostgreSQL engine must validate uniqueness, RLS ownership, account state,
revision, balances, reserve floors and idempotency again in one transaction.
The resulting receipt and delta carry the server-committed IDs and version.

Archive timestamps are **server-generated**. Archived accounts remain
visible in history and retain prior postings, but account metadata cannot
change until explicit unarchive. Only verified, server-committed transactions
alter real balances. Planned obligations and reserves are distinct.

## Non-goals and publication blockers

- This candidate validator by itself does **not** perform a transaction,
  start sync, import old records, enable a feature flag, or approve the protocol.
  The opt-in `/api/finance/v2/commands` route executes only the five validated
  actions using a distinct path-scoped HttpOnly session cookie and rechecks
  the revocable FH SQLite session after reading the entire bounded request.
  The application factory defaults to `enable_account_v2_candidate=False`.
  The production configuration never enables it; only synthetic tests opt in.
  Never expose `allow_internal=True` to HTTP.
- Linked obligation/loan payment commands now have **unapproved candidate**
  v2 DTOs with an explicit funding account and SQL checks from
  `0002_linked_void`. Payment record IDs are minted deterministically from
  the authenticated profile, action and mutation UUID; the client cannot
  provide these IDs. Payment void and compensating reversal commit together.
  The new DDL/grants/triggers require independent database review and a
  controlled migration/restore before this can become a public feature.
  Generic v1 reversal deliberately refuses linked payments.
- An approved, reviewed HTTP OpenAPI contract and explicit #67 agreement are
  required **before deployment or runtime enablement** of the candidate.
- Required readiness: #66 encrypted PostgreSQL/offsite backup/restore/PITR,
  #34/#68 isolated encrypted outbox, #69 consent-based legacy migration,
  #70 real two-user/two-device E2E, independent human approval, exact-SHA CI,
  and a rollback-tested production release.

## Current verification

The machine-readable but **not approved** candidate lives in
`backend/finance_api/finance-v2-accounts-candidate.openapi.json`.
`backend/finance_api/tests/test_contract_v2_openapi.py` checks all nine
Pydantic action/payload definitions against this draft, its session-cookie
scope and the required HTTP errors. It does not publish or authorize the
API; production and the accepted v1 OpenAPI remain unchanged.

`backend/finance_api/tests/test_contract_v2_candidate.py` validates the strict
unpublished transport without database access. The separately unmounted
`backend/finance_api/accounts_v2_service.py` binds the validated five-action
allowlist to the existing authoritative RLS/CAS/receipt PostgreSQL core,
including source-verified payment records and append-only compensation.
`backend/finance_api/tests/test_account_v2_service.py` exercises that private
adapter on disposable PostgreSQL with real FH SQLite session bootstrapping,
including stale/replayed commands, actual expense, archive and cross-profile
denials. `backend/finance_api/tests/test_http_v2_candidate.py` runs the
explicitly enabled test-only FastAPI route against the same disposable SQL
engine, including CSRF/Origin, malformed JSON, session revocation, profile
separation and retry/ETag behavior. No public or production deployment of
the v2 route has been approved or performed.

The SQL command core refuses version 2 by default. The v2 allowlist cannot be
combined with its trusted v1 internal-payment mode. These safeguards are
necessary but not a public protocol approval. A separate approved versioned
HTTP contract, real app integration, migration/restore and #70 production
security acceptance are still mandatory; the current feature gate remains OFF.
