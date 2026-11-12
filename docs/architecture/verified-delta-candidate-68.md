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
The new `src/cloud/encrypted-command-outbox-candidate.mjs` can additionally
queue a validated v2 command under the same encrypted native IndexedDB CAS,
binding account scope, authenticated profile, session epoch, exact mutation
UUID, strong If-Match and SHA-256 fingerprint. A duplicate UUID with an
identical fingerprint is a no-op; a reused UUID with altered money/ETag
is rejected. Existing confirmed balances remain unchanged by offline writes.
The module rejects untrusted JSON getters, guest/cross-account contexts,
stale tabs, unsupported actions and queue overflow. A pure retry classifier
handles network failure, 401, 409/412, 410 and HTTP success without deleting
an entry or inventing a confirmed settlement.

These are isolated **encrypted cache + offline outbox + explicit one-shot
dispatcher candidates**, not a production account cutover or a live sync engine.
`src/cloud/finance-offline-dispatch-candidate.mjs` supports an explicitly
opted-in, **same-origin HTTPS** POST of only the first encrypted queued
command, without storing HTTP credentials or allowing redirects. Its original
UUID, body and strong If-Match are preserved even across network interruption.
It then fetches an independent, bounded, uncached server /changes page.

`persistAuthenticatedFinanceReceiptCandidate` requires the complete receipt
and authoritative journal event images to match before it can remove the first
outbox entry. Receipt proof, new cursor, account images, unchanged remaining
queue and conflicts are saved together in one **encrypted native IDB CAS**
transaction. A 200/201 alone never clears the queue. If a verified delta was
already saved but the ACK was lost, the dispatcher re-reads the historical
server revision and durably records its proof without changing balances again.
The original UUID cannot be reused for different money. Network timeout and
retryable errors persist a bounded exponential retry counter in the same
encrypted store, not in a timer or Service Worker background task.

The one-shot sender now requires an **exclusive browser Web Lock**
named `financial-horizon-finance-v2-network-dispatch` throughout the
POST, independent /changes fetch and encrypted receipt COMMIT. A second
concurrent tab receives `LEASE_BUSY` and never issues another POST.
No user ID, financial amount or account name enters the lock name. The
absence of the browser Web Locks API (including hardened browser settings)
causes a fail-closed refusal, **not** an unsafe localStorage fallback.
Server-side idempotency remains mandatory across devices and process crashes.

A synthetic browser-native 2-tab Web Lock test in
`tests/e2e/finance-cloud-candidate.spec.mjs` exercises the actual
Chromium/WebKit native lock and encrypted IDB candidate on an intercepted
HTTPS origin. It does not claim that a live FastAPI production service was
accessed.

**What remains OFF:** the active PWA does not import any of these modules,
there is no authenticated host integration, no conflict-resolution UI and
no full two-user/two-device live PostgreSQL E2E.
Only synthetic disposable fixtures exercise the explicit opt-in transport.
A live backend runtime remains separately guarded by #66/#67/#51/#70.

A real integration must additionally implement:

1. FH session bootstrap and session-derived namespace (never trust cache IDs)
2. 401/logout/revoke hard stop and cross-tab generation fencing
3. Conflict/409/412/410 handling with explicit user resolution (no LWW)
4. Mount the Web-Lock-guarded dispatcher into the actually authenticated FH session/UI, including conflict resolution and cross-device idempotency
5. Validate durable receipt+delta recovery on a real backend and real two-tab encrypted IndexedDB, not just isolated candidate tests
6. Import #69 only after verified external encrypted backup and explicit consent
7. Actual two-account, two-device Chromium/WebKit and independent security QA #70
8. Encrypted production PostgreSQL/backup/restore and reviewed release gates

Until then the full sync candidate remains unmounted in the PWA.
All tests use only synthetic data; no real financial information is stored
in GitHub or CI. The unapproved public v2 route is OFF by default.
