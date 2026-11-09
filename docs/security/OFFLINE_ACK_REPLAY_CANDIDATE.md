# #34/#68 - isolated replay-ACK CAS candidate (INACTIVE)

**Status:** experimental primitive plus synthetic tests, **not wired to Financial Horizon PWA, offline sync, live IndexedDB or PostgreSQL**. The active `financial-horizon-browser-v1` is still plaintext. No migration or release consent.

## Narrow invariant tested

A server can return an idempotent replay receipt for revision R after the browser has already applied a **newer** revision R+N. A client must never overwrite newer finance state or move its cursor backwards merely because the receipt is valid. A replayed response can settle exactly one queued command **only if** the local database has durable evidence that the command's matching UUID, canonical fingerprint and revision were already included in a *contiguous verified delta application*. A server HTTP 200 alone is not this evidence.

The isolated `src/security/offline-ack-replay-candidate.js` accepts an IndexedDB handle **injected by the synthetic test** and reads `meta`, `applied`, `outbox` in one native `readwrite` transaction. It refuses to settle an operation if the account scope, local generation, applied-proof fields, fingerprint or revision differ, if the ACK is ahead of the persisted cursor, or if the queued operation is a conflict. Replayed ACK at or below cursor with matching persisted applied proof removes *only* the acknowledged pending/sending entry. Duplicate delivery is idempotent. Logout `AbortSignal` aborts before commit, where the browser permits an abort. Neither cursor nor unrelated accounts or queues are changed.

**Critical assumption:** the `applied` evidence is trustworthy **only if #68 writes it in the exact same durable IndexedDB transaction as the corresponding verified server deltas, financial state, and cursor advance**. This candidate does not implement or prove that prerequisite, does not validate a server signature, and does not authenticate the caller; #67 owns server command receipts, profile serialization, `If-Match` and idempotency. Never treat a free-standing `applied: true` field as a security proof. If no evidence exists, preserve pending and enter recovery; do not infer success.

## Acceptance boundaries

The Chromium/WebKit test uses solely `fh-e2e-ack-replay-*` throwaway databases, two browser tabs, two synthetic account scopes, and valid/invalid simulated receipts. It exercises stale generation, wrong fingerprint, unverified or future ACK, precommit logout cancellation, reload before local ACK reconciliation, preservation of unrelated pending/conflict entries and idempotent repeat. This is a browser reload, **not an OS process crash**, and does not demonstrate a working server, encryption, historical-client writer fencing or physical Safari.

#33/#66/#67 must guarantee integer-money ledger, scoped serialized PostgreSQL commands and durable receipt replay. #68 must add authenticating session scope, verified contiguous delta application and atomic cursor+receipt+outbox CAS, cross-tab synchronization and stale-writer exclusion. #69 must require approved external encrypted backup, explicit import consent and rollback without deleting the original. #70 must execute real integrated multi-device fault and recovery QA, plus physical iPhone checks. Until all gates pass, **NO_GO for source activation, deletion, cloud upload and production cutover; keep #34 OPEN.**
