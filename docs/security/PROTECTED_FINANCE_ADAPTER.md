# Financial Horizon #34 - dormant finance API adapter over encrypted IndexedDB

**Status: isolated adapter, not imported by the running PWA and NOT a replacement for production `storage.js`.** Existing financial data still reside in the historical plaintext database until a separately approved, reviewed, backup-first cutover.

## Purpose and interface

The existing application's `storage.js` relies on `readState`, `updateState(change,{expectedRevision})` and `replaceState`, with versioned v2 finance payloads. The protected atomic candidate already encrypts a snapshot, pending outbox and conflicts under one scope-specific AES-256-GCM DEK. The new `src/security/protected-finance-adapter.ts` demonstrates the **non-destructive**, atomic finance read/update API using only the new encrypted database and an explicitly unlocked `LocalBudgetSession`.

`readProtectedFinance(scope,session)` decrypts all three parts, validates/migrates the finance snapshot to v2 in memory, and returns `{state,epoch,outbox,conflicts}`. No login-cookie auto-unlock or plaintext fallback exists. Missing, unknown-version or corrupted protected records reject rather than using the legacy database.

`updateProtectedFinance(scope,session,change,{expectedRevision?,expectedEpoch?})`:
- Reads/validates the current encrypted snapshot with its local epoch and preserves the existing encrypted outbox and conflict inbox.
- Checks optional expected financial revision and local epoch; mismatches fail closed.
- Runs a **synchronous** mutation callback on **cloned** finance/outbox/conflicts drafts. A thrown exception, an async callback or invalid monetary amount fails before writing.
- Increments the finance payload revision exactly once and revalidates all financial values via the existing `migrateState` / `validateState`.
- Asynchronously encrypts all three parts **before** the native IndexedDB transaction, then commits them with a single CAS against the previous epoch/keyset/schema. A stale writer cannot silently erase another tab's payment or outbox. There is no hidden retry.
- Returns the new in-memory snapshot and epoch after the atomic write. In-flight crypto operations reject after logout/account-switch via generation fencing. No server fetch is performed.

The local epoch is a concurrency token, **not** a server revision or anti-rollback proof. The callback's outbox semantics are intentionally generic; the authoritative #68 sync engine must supply operation identities, idempotency, durable acknowledgements and conflict reconciliation. This adapter **does not implement** account authorization, cloud persistence, account transfers, password UI, importing a backup, overwriting encrypted records or deletion.

## Tests and operational boundaries

- Node `tests/protected-finance-adapter.test.mjs`: read, atomic snapshot/outbox mutation, revision guards, rollback after transaction failure, missing/tampered DB, account isolation, invalid amount, invalid async/throwing callback, offline update, recovery key, logout fencing.
- Browser `tests/e2e/protected-finance-adapter.spec.mjs`: native Chromium/WebKit IndexedDB, Web Crypto, optimistic-finance update + outbox, stale-epoch rejection, absence of readable sensitive text from protected storage and offline restart/unlock.
- The separate atomic candidate E2E already proves a synchronized **two-real-tab** CAS conflict with one winner and no duplicate queued payment.
- Required exact-SHA checks: `tsc -p src/security/tsconfig.json`, isolated-crypto Node tests, `npm test`, Chromium/WebKit E2E, independent code/security review and CodeQL.

**NOT INCLUDED:** imports in `app.js`, `storage.js`, `state-migrations.ts`, React, SW, FastAPI/PostgreSQL, active feature flags, UI, background sync, ledger #33 contracts, migration journal, cross-tab writer fence for legacy DB, deletion of plaintext, exact-production SHA or physical recovery proof. A green test of this inert adapter is not sufficient to close #34.

**Next integration gates:** stabilize #33/#66/#67/#68 interfaces; design visually approved opt-in unlock/recovery; ensure a verified outside-the-browser encrypted backup and confirmation for the exact account; quiesce every legacy writer in every tab; prepare/re-read the encrypted candidate; atomically choose the protected source without dropping pending operations; test rollback and recovery across restarts; explicitly approve any removal of legacy plaintext; independent security review and on-device production acceptance. Loss of both local credentials is not recoverable by server password reset. Browser JavaScript cannot prove physical erasure of old DB files.
