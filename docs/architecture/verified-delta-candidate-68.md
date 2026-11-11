# Issue #68 - verified cloud snapshot/delta candidate (INACTIVE)

**Status: SOURCE-ONLY / NO_GO / NO PRODUCTION SYNC.** The source and tests
are intentionally absent from the active PWA entrypoints. Guest and existing
IndexedDB records are never read, migrated, deleted or uploaded by this module.

## Trust and input

The only accepted namespace is an active, authenticated
`account:<32-lower-hex>` scope with a **server-derived** UUID profile ID,
generation >=1, a 32-lower-hex cutover epoch and a live abort signal. These
are supplied by the verified host; client input never determines user ownership.

`verifyFinanceSnapshotPagesCandidate` requires every paginated HTTP /state
page to have the same profile/revision/currency, a complete cursor chain,
no duplicate entities, and an explicit last page. It rejects incomplete or
mixed-user snapshots before returning any proposed state.

`applyFinanceDeltaCandidate` consumes real `/api/finance/v1/changes`
envelopes, requiring contiguous revisions and ordinal events. It rejects
stale/replayed pages, missing account images, changed/invalid money, unknown
owners and separated linked payment fact events (including compensation
and fact void). It does **not** trust local calculations for bank balances.
All pending outbox entries and manual conflicts are preserved unchanged.

## Important integration and release gates

The pure validator's returned in-memory state is **not durable** on its own.
`src/cloud/encrypted-cloud-cache-candidate.mjs` now performs a separate
inactive encrypted-cache step through the existing #34 native IndexedDB
CAS mechanism. After explicit account-scoped initialization it seals the
server image and cursor as a `snapshot.cloudFinance` sidecar, preserving
legacy financial state, outbox and conflict arrays in one encrypted commit.
It refuses to overwrite a pre-existing sidecar or pending local operations,
and a stale tab or revoked/unlocked local keyset cannot report success.
This is a verified **cache candidate**, not an account cutover or a sync
engine: no HTTP upload, applied receipt proof, queue flush, encrypted remote
reconciliation, live UI state or real multi-device acceptance is enabled.

A real integration must additionally implement:

1. FH session bootstrap and session-derived namespace (never trust cache IDs)
2. 401/logout/revoke hard stop and cross-tab generation fencing
3. Conflict/409/412/410 handling with explicit user resolution (no LWW)
4. Retry with unchanged mutation UUID, fingerprint and If-Match; bounded backoff
5. Atomic persisted proof before replay reconciliation and multi-tab locks
6. Import #69 only after verified external encrypted backup and explicit consent
7. Actual two-account, two-device Chromium/WebKit and independent security QA #70
8. Encrypted production PostgreSQL/backup/restore and reviewed release gates

Until then this module is deliberately pure and unmounted. All tests use
only synthetic data; no real financial information is stored in GitHub or CI.
