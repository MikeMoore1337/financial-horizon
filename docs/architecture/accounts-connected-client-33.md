# Financial Horizon #33 - connected accounts in the existing PWA

**Status: CODE CANDIDATE / DEFAULT OFF / NOT DEPLOYED TO PRODUCTION.**

The owner-approved React `Accounts` screen is linked to the existing PWA
navigation without adding a sixth mobile dock item. When a reviewed production
release explicitly sets `<meta name="fh-finance-accounts" content="enabled">`,
an authenticated user sees a **Счета и кошельки** card in Settings, leading
to the server-backed screen. The default `disabled` value hides it for
guests, installed old builds and unaudited releases. The `data-view`
handler also refuses manually forged navigation attempts while locked.

The PWA host supplies only the FH AuthStore verified user ID, never a
client-chosen `profile_id`. The existing `AuthBoundary` verifies that
identity matches the selected IndexedDB owner scope. The actual finance
profile UUID is minted by the server at session bootstrap.

## Read and write contract

1. POST `/api/auth/email/finance/session` with same-origin credentials
   and the verified FH session. A missing or revoked session denies access.
2. GET `/api/finance/v1/state?limit_entities=5000` must be an HTTP 200
   *complete*, matching-profile response with a strong ETag. A partial 206,
   invalid balance, stale account revision, illegal currency or foreign
   record never becomes an apparently authoritative bank balance.
3. Server-approved account creation/rename/archive uses the opt-in v2
   `/api/finance/v2/commands` contract; internal transfers use approved
   v1 commands. Every mutating request has one stable UUID, original
   `If-Match`, required entity revisions and integer RUB minor units.
   Client bodies cannot claim another user's identity.
4. After a 201 the UI requires a matching authoritative GET and revision
   before displaying success. A network timeout, server conflict or malformed
   receipt locks writes; a generic refresh does not retry ambiguous money.
   Cross-request GET ordering is fenced, and responses exceeding 2 MB are
   stopped before full buffering.
5. Leaving the screen, account switching or logout invalidates pending
   UI requests and clears the retained server snapshot. No IndexedDB
   import, cross-device sync, blind auto-retry or local ledger replacement
   is triggered by opening this view.

## Owner-approved simplified release criteria

The finance API v2 owner approval for PR #100 is recorded. PostgreSQL
source and its strict test suite are in main. Separate LUKS2, offsite VPS,
continuous WAL/PITR, and fixed RPO/RTO **are not required** by the owner
for this personal Excel-replacement app.

The following are still mandatory before enabling the Settings entry:
a running **private** finance PostgreSQL on the authorized production VPS,
real encrypted backup and isolated restore on that runtime, the current
FH-session API and v2 write route verified over HTTPS, consistent account
balances and linked payment reversals, CI on exact deployed SHA, revoked
session/foreign account negative tests, and a tested app rollback. Complete
local encrypted source migration and two-device conflict resolution remain
under #68/#69/#70; do not claim them from mocked React component tests.

**A merge of this source while `disabled` is safe but does NOT satisfy
production acceptance or close Issue #33.** Do not edit an installed PWA,
force a feature flag on or publish real user finance values in CI/issues.
