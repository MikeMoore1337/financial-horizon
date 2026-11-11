# Financial Horizon #33 / #67 - account command v2 candidate (FEATURE OFF)

**Status: PROPOSAL / NOT APPROVED / NOT PUBLIC / NOT DEPLOYED.**
This document and `backend/finance_api/contracts_v2_candidate.py` describe a
strictly validated candidate, not a replacement for
`docs/architecture/finance-sync-v1.openapi.json`. No v2 route is mounted,
and the existing `/api/finance/v1/commands` whitelist stays unchanged.

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

- This candidate validator does **not** perform a financial transaction,
  start sync, import old records, create an HTTP route, enable a feature flag,
  or approve a wire protocol. Never expose `allow_internal=True` to HTTP.
- Linked obligation/loan payments, funding accounts, and atomic
  `void + compensated reversal` need a separately approved v2 DTO and
  the required #66 database grants/deferred invariants. Generic v1 reversal
  deliberately refuses linked payments.
- A new public versioned route and reviewed HTTP OpenAPI document require
  explicit agreement in #67 before implementation or exposure.
- Required readiness: #66 encrypted PostgreSQL/offsite backup/restore/PITR,
  #34/#68 isolated encrypted outbox, #69 consent-based legacy migration,
  #70 real two-user/two-device E2E, independent human approval, exact-SHA CI,
  and a rollback-tested production release.

## Current verification

`backend/finance_api/tests/test_contract_v2_candidate.py` validates the strict
unpublished transport without database access. The separately unmounted
`backend/finance_api/accounts_v2_service.py` binds the validated five-action
allowlist to the existing authoritative RLS/CAS/receipt PostgreSQL core.
`backend/finance_api/tests/test_account_v2_service.py` exercises that private
adapter on disposable PostgreSQL with real FH SQLite session bootstrapping,
including stale/replayed commands, actual expense, archive and cross-profile
denials. No production finance entrypoint imports this service.

The SQL command core refuses version 2 by default. The v2 allowlist cannot be
combined with its trusted v1 internal-payment mode. These safeguards are
necessary but not a public protocol approval. A separate approved versioned
HTTP contract, real app integration, migration/restore and #70 production
security acceptance are still mandatory; the current feature gate remains OFF.
