# Financial Horizon #33 - connected accounts UI review candidate

**Status: FEATURE OFF / NOT DEPLOYED / NOT ACCEPTED FOR PRODUCTION.**

This isolated PR combines the owner-approved `Accounts` React screen (#120)
with the #111 TypeScript-to-FastAPI/PostgreSQL snapshot adapter. The current
public `app.js` and five-item navigation are not changed. Merely adding the
`accounts-connected` screen variant does not make the UI accessible.

## Exact browser-to-server path

1. A trusted FH authenticated host supplies its **verified** actor ID. Guest
   mode does not provide a server identity. The browser POSTs to
   `/api/auth/email/finance/session`, using same-origin cookies and requiring
   a server-minted profile UUID. The host must not invent IDs.
2. GET `/api/finance/v1/state?limit_entities=5000` must return HTTP 200,
   a strong ETag and a complete matching profile. A 206/next_cursor page,
   stale/foreign record, missing reserve or any accounting mismatch is
   rejected instead of displaying an undercounted bank balance.
3. `account.transfer` uses the existing **v1** request encoder and two
   expected account revisions. The draft account CRUD actions use the
   *unapproved, explicitly gated v2 candidate* from #100. No client user or
   profile IDs are accepted in command bodies. The PostgreSQL server must
   enforce authentication, RLS, idempotency, CAS and one SQL transaction.
4. The client supplies one per-command UUID and the **original** server ETag.
   It never performs optimistic balance changes. After HTTP 201 the client
   requires a complete authoritative snapshot with the same committed revision
   and ETag before reporting success.
5. Network ambiguity, 401/403, 409/412, 206, unexpected receipt or a missing
   v2 route blocks writes. A generic refresh does not resolve an ambiguous
   debit; durable receipt reconciliation and reload protection belong to #68.
6. There is no offline dispatch, auto-retry, IndexedDB mutation, legacy import,
   automatic account migration or background syncing in this module.

## Important stack limitation

The parent #111 branch is based on an **older** #100 server stack. The
account CRUD v2 HTTP proposal was added to #100 subsequently and is **not**
implicitly published or installed by importing this React component. The v2
client-facing contract is a candidate, not an approved public API; the
integration must be reconciled with the final reviewed #100 branch and its
versioned contract before activation. Mocked fetch tests do not establish that
v2 is running in production.

## Acceptance and release gates

- [ ] #67 final reviewed/approved public v2 contract, linked payment void
      and exact React-client parity on a current integrated stack.
- [ ] #66 physically encrypted PostgreSQL with backed-up keys, isolated
      secrets, offsite encrypted backup, WAL/PITR and independent restore.
- [ ] #68 authenticated, encrypted persistent outbox/receipt reconciliation,
      safe logout/reload/offline and cross-tab/profile behavior.
- [ ] #69 explicit, previewed, backed-up v1/v2 data migration with rollback.
- [ ] #51/#70 two real users, two devices and tabs, session revoke, negative
      security tests, physical browser validation and human independent review.
- [ ] Exact release SHA with CI, release verification and a demonstrated
      production rollback from the authorized production execution host.

Until all gates are independently verified: **NO_MERGE / NO_DEPLOY /
NO_PRODUCTION_ACCEPTANCE**. No real financial records or access tokens should
be copied into issues or CI. 
