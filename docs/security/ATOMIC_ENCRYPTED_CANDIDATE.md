# Financial Horizon #34 - atomic encrypted offline candidate (stage 4)

**Status: isolated code, NOT imported by the app. NO cutover, NO production encryption claim.**
This candidate complements [stage 2](PROTECTED_STAGING.md) and the [approved local unlock contract](APPROVED_LOCAL_UNLOCK_FLOW.md). It does not modify the existing `financial-horizon-browser-v1`, the dormant staging database, user data, Service Worker, cloud API or auth.

## Why the candidate is separate

The existing legacy `finance` object store and the stage-2 `financial-horizon-protected-staging-v1` are deliberately preserved. The new, inert `financial-horizon-encrypted-atomic-candidate-v1` is a clean integration prototype for #34/#68, not an automatic migration or a replacement for a user's backup.

`src/security/protected-atomic-candidate.ts` creates two IndexedDB stores:
- `keysets[scope]`: one versioned, AES-GCM wrapped random DEK from `local-vault.ts`; **never** a passphrase, recovery secret or raw key.
- `bundles[scope]`: one atomic envelope containing three separate AES-256-GCM records: `snapshot`, `outbox` and `conflicts`. The entire content of each is encrypted. Public metadata contains only opaque `scope`, `keyId`, `epoch` and `schemaVersion` (plus authenticated record headers and nonces). Every record uses scope/key ID/kind/record ID/schema version/epoch in GCM AAD.

This is **not** a complete sync engine or E2EE design. The approved ADR #65 still processes cloud financial data on a trusted server.

## Critical transaction and lifecycle invariants

1. **Initial creation:** validate strict scope and data bundle; clone all input data synchronously *before* starting PBKDF2, sealing all three parts with one per-scope DEK. Only after encryption is complete, one native readwrite transaction atomically commits both `keysets` and `bundles`. If either write aborts, both remain absent. Never overwrite existing scope or quietly reinitialize its recovery key. Return the one-time recovery key only after successful commit.
2. **Unlock and read:** the caller obtains only the wrapped keyset, explicitly selects the account/guest namespace in `LocalBudgetSession`, unlocks using a local passphrase/recovery key, and then decrypts the three records. `LocalBudgetSession` checks its in-memory lifecycle counter, scope and lock status throughout the operation. Wrong credentials or tampered ciphertext/metadata fail closed.
3. **Updating:** clone the full new snapshot/outbox/conflicts before the first asynchronous encryption, then encrypt all three **before** starting any IndexedDB transaction. Inside a single `readwrite` transaction compare the expected local epoch, key ID and schema version against the current sealed bundle. Commit only the complete new envelope. A stale concurrent writer gets a conflict, **never** silent last-write-wins.
4. **Logout and lock:** `LocalBudgetSession.lifecycleVersion` invalidates pending crypto results. An operation aborted during crypto must not start a write. A logout racing with the final native IDB commit can leave a **fully encrypted atomic commit** whose success is not returned to the caller; the later integration still needs a cross-tab writer fence to coordinate this lifecycle.
5. **Browser restart/offline:** a new `LocalBudgetSession` starts locked. With an existing keyset, encrypted bundle and independent credential, Web Crypto can restore the snapshot without network requests. Neither the persisted envelope nor a session cookie grants automatic unlock.

The local epoch is a concurrency token, **not** an authoritative server revision or anti-rollback proof. A storage attacker able to restore an older valid ciphertext+keyset cannot be detected without an independent trusted checkpoint. Data validation here checks the structural envelope only; `migrateState`, ledger invariants, financial API/schema validation, idempotency, offline outbox semantics and account authorization belong to the eventual coordinated #33/#66/#67/#68 integration. Unknown top-level fields are rejected rather than silently discarded.

## Explicit non-goals and blockers

- No automatic import, backup creation, UI, cloud upload, transfer, feature flag, PWA activation, deletion of plaintext or migration. **Creating a candidate does not attest that an independently saved encrypted backup exists.**
- Physical storage for old IndexedDB pages, browser caches, OS snapshots and erased flash cells cannot be guaranteed securely wiped by JavaScript.
- Protection does not apply against XSS, malicious extensions, compromised browser/OS, keyloggers or hostile scripts running while the budget is unlocked.
- E2E verification must exercise native IndexedDB + real Web Crypto in Chromium and WebKit, including two genuine browser tabs with a preparation barrier proving both read epoch 1 before attempting different outbox writes (one commit, one CAS rejection), two local sessions/scopes, offline reload, tampering, wrong key, aborted writes and CAS. Node fake-IDB tests alone are not sufficient.
- Do not enable or expose this candidate in production UI until the user confirms a backup saved outside the browser; all relevant writers across tabs are quiesced; source revision/outbox are checked; financial validation is wired; rollback and recovery have been tested; and a separately approved visual flow is accepted.
- `storage.js`, `state-migrations.ts`, `backup.js`, `app.js`, React UI, Service Worker and PostgreSQL migrations remain untouched. Full Issue #34 stays **OPEN** until actual protected-storage cutover, data/restore acceptance and production verification.

## Focused checks

- `npx --no-install tsc -p src/security/tsconfig.json`
- `node --test tests/protected-atomic-candidate.test.mjs tests/local-budget-session.test.mjs`
- `npm test` and `npm run test:e2e` (Chromium and WebKit in GitHub Actions).
- Review exact-head CodeQL, independent code/security review, unresolved threads and required CI jobs before any merge. Never treat merging an inert library as production encryption.
