# Financial Horizon #67 - isolated account SQL command core (NOT LIVE)

This is a **prerequisite implementation**, not a finance API release.

- Parent branch / schema: #66 PR #79, feat/issue-66-postgres-foundation.
- Business driver: #33 PR #84 (TypeScript domain), ADR #65.
- The code has **no registered FastAPI endpoint, no frontend import, no auth-cookie change,
  no Service Worker changes and no production deployment**.

## Implemented

backend/finance_db/ledger_service.py accepts an internally supplied
VerifiedFinanceScope (user id verified from an actual FH email session;
profile UUID resolved/created **server side**) and uses the
finance_transaction from #66. PostgreSQL FORCE RLS verifies user and profile
for every statement. Public-call mode only accepts existing OpenAPI v1 actions
account.transfer and transaction.reverse. Internal opt-in mode also exercises
account creation/update/archive/unarchive and income/expense/adjustment recording,
but **must not** be exposed as v1.

Each mutation:

1. Validates input, integer kopecks, calendar date, canonical UUIDs, strong
   If-Match, matching Idempotency-Key, schema version, entity revisions and
   bounded canonical SHA-256 request fingerprint.
2. Locks profile row via FOR UPDATE, checks receipt reuse **before** stale
   ETag/revision, and serializes concurrent multi-device writes.
3. Uses the least-privilege PostgreSQL runtime role, approved INSERT and
   column-level UPDATE. Opening balances and original ledger rows are immutable.
4. Writes movement, account/profile revisions, audit change_log and receipt
   within one commit. No detached write or partial commit.
5. Returns the OpenAPI v1 acknowledgement shape. An exact retry returns the
   stored receipt and never posts money a second time.

get_account_snapshot reads an RLS-scoped, transaction-consistent **accounts
subset** with calculated balances. It is deliberately **not** advertised as
the full /api/finance/v1/state until all expected entity kinds are implemented.

## Synthetic CI (no live data)

The added workflow runs only on this branch or its stacked PR. It provisions
a disposable PostgreSQL 17 service, synthetic least-privileged roles, the
reviewed #66 Alembic migration, real PostgreSQL pytest tests, compilation and
Bandit. test_ledger_service.py skips outside the explicit synthetic
FH_FINANCE_CI_ALLOW_BOOTSTRAP=yes environment. Never point it at production.

## Release blockers

1. #66 PR #79 requires independent approval, encryption-at-rest, offsite
   recovery, real restore drill, measured RPO/RTO and exact-SHA release.
2. FH email login cookie currently uses Path=/api/auth, whereas the approved
   financial URL is /api/finance/v1. A reviewed same-origin session bridge
   or safely migrated scoped cookie must preserve existing authenticated
   users and CSRF/Origin protection. VerifiedFinanceScope is **not** HTTP JSON.
3. Authoritative owner/profile mapping and safe first-profile provisioning must
   be agreed and tested with real AuthStore-backed login.
4. Existing OpenAPI v1 does not accept account create/update/archive/record.
   These actions remain internal until a versioned contract is approved.
5. Linked loan/obligation/reserve payments need one atomic fact+ledger
   transaction and coordinated cancellations (#6/#33/#39), still pending.
6. #68 encrypted per-user outbox, #69 consent-based backup/import and #70
   full-stack multi-user browser+PostgreSQL security acceptance remain.
   A passing isolated SQL service is not evidence of deployed API/sync.

No paid API, proprietary runtime, personal finance data or cross-project token.
