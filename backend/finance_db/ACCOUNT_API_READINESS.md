# Financial Horizon #67 - isolated account SQL command core (NOT LIVE)

This is a **prerequisite implementation**, not a finance API release.

- Parent branch / schema: #66 PR #79, feat/issue-66-postgres-foundation.
- Business driver: #33 PR #84 (TypeScript domain), ADR #65.
- The new FastAPI routers are **mounted only when** `create_app` receives an explicit finance engine and stable server-side namespace. The default `app=create_app()` **does not mount or deploy finance endpoints**. No frontend/Service Worker or production deployment changes.

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

get_account_snapshot reads a transaction-consistent, profile-scoped account subset.
snapshot.py also implements full (account/obligation/loan/reserve/posted transaction,
settlement/loan payment) snapshots and revision-aligned delta pagination. The HTTP
router provides GET /api/finance/v1/state, GET /api/finance/v1/changes, and POST
/api/finance/v1/commands, but only the two approved v1 commands are allowed.

**Safe opt-in auth bridge:** The legacy `fh_email_session` cookie is scoped to
`/api/auth`. Authenticated, Origin-checked POST `/api/auth/email/finance/session`
verifies the existing AuthStore session and sets a second
`HttpOnly; SameSite=Strict; Secure` (except synthetic test)
`fh_finance_session` scoped to `/api/finance/v1`. This token is checked against
the *same* AuthStore on every finance request. Logout deletes the finance
cookie and revokes the underlying SQLite session; session revocation also
invalidates remote finance cookies. No cookie is accepted from a header/JSON body.

**No production activation:** Neither the default FH FastAPI app nor
the existing production deployment settings supplies a finance engine
or server-owned profile namespace. The router is not registered live.

## Synthetic CI (no live data)

The added workflow runs only on this branch or its stacked PR. It provisions
a disposable PostgreSQL 17 service, synthetic least-privileged roles, the
reviewed #66 Alembic migration, real PostgreSQL and existing AuthStore SQLite pytest tests, compilation and Bandit. 
Tests cover two authenticated browser sessions sharing one authoritative ledger, idempotent
retry, stale 412 and logout-others token revocation. test_ledger_service.py skips outside the explicit synthetic
FH_FINANCE_CI_ALLOW_BOOTSTRAP=yes environment. Never point it at production.

## Release blockers

1. #66 PR #79 requires independent approval, encryption-at-rest, offsite
   recovery, real restore drill, measured RPO/RTO and exact-SHA release.
2. The opt-in same-origin session bridge and deterministic server-owned profile
   provisioning now have real AuthStore/SQLite/PostgreSQL integration tests.
   This remains unactivated pending independent security review, production
   credential handling, session/revocation testing and deployment configuration.
3. The server-owned profile namespace must be stable and included in backup/
   recovery configuration. `VerifiedFinanceScope` is **not** accepted as HTTP JSON.
4. Existing OpenAPI v1 does not accept account create/update/archive/record.
   These actions remain internal until a versioned contract is approved.
5. Linked loan/obligation/reserve payments need one atomic fact+ledger
   transaction and coordinated cancellations (#6/#33/#39), still pending.
6. #68 encrypted per-user outbox, #69 consent-based backup/import and #70
   full-stack multi-user browser+PostgreSQL security acceptance remain.
   A passing isolated SQL service is not evidence of deployed API/sync.

No paid API, proprietary runtime, personal finance data or cross-project token.


### Internal atomic payment facts (feature OFF)

The SQL core also supports internal-only settlement.payment.record and loan.payment.record commands: in one RLS-locked SQL transaction it inserts the verified obligation/loan fact, **exactly one signed ledger posting**, one uniquely constrained payment link, one receipt and two ordered change_log rows under **one** finance revision. No separate debit can be accidentally applied by the operation itself. The accepted public v1 HTTP router refuses these unpublished action names; their final UI/API semantics and safe cancellation must be version-reviewed with #6/#39/#67. This is not a claim that payments are live.
