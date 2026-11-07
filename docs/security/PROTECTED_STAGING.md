# Financial Horizon #34 - isolated IndexedDB migration staging

**Status: implementation candidate, NOT an enabled storage migration.** This code has no imports from `storage.js`, `app.js`, the UI, cloud sync, or the Service Worker and does not change existing production state. It is designed to remain inert until a separate reviewed integration is approved.

## Boundaries and data format

- Independent origin-local IndexedDB `financial-horizon-protected-staging-v1`, physical database schema version 1, stores `keysets` and `records`; each item is keyed by strict account/guest scope.
- `keysets[scope]` contains only the versioned, passphrase/recovery-key-wrapped DEK envelope from `local-vault.ts`. It **never** contains the passphrase, recovery secret, raw DEK, login cookie, email, name or financial state.
- `records[scope]` contains a wrapper `{format:'financial-horizon.staged-snapshot',version:1,scope,record:<AES-GCM sealed record>}`. The plaintext snapshot, account titles, amounts, schedules, and audit entries reside **only** in AES-256-GCM ciphertext. The exposed scope/revision/schema/key ID/IV are metadata bound by authenticated AAD, not secret.
- A single native IndexedDB readwrite transaction writes both stores; a failed/aborted transaction commits **neither** store. A second writer cannot silently replace an existing scope; an existing stage is decrypted and compared before an idempotent retry can report `already-staged`.
- A migration is a **copy**, never a destructive move. Existing `financial-horizon-browser-v1` and its legacy account/guest keys are not even opened by this module. No cloud upload, login side effect, automatic key rotation, key caching in `localStorage` or automatic activation.

## Required preflight (`stageVerifiedLegacyBackup`)

1. Stop legacy writers in all tabs using an integration-owned cross-tab gate, select the explicit verified account or guest scope, and capture a stable v1/v2 source snapshot. The staging module does **not** implement quiescing or automatically choose the owner.
2. Save an **independently stored encrypted backup v1** (file outside this browser, not a second IndexedDB record), verify that it can be decrypted with the correct backup password, and confirm its financial content is identical to the selected source after pure `migrateState` conversion. `stageVerifiedLegacyBackup()` performs the cryptographic decryption and exact content comparison, but **cannot** prove that a file was actually saved elsewhere: this confirmation is a user action.
3. Obtain explicit separate migration consent. The API refuses the call unless both `savedEncryptedBackupOutsideThisBrowser` and `confirmedSeparateStaging` are true; **these boolean flags are not a substitute for a genuinely approved UI** or authentication.
4. Create a fresh 256-bit random per-scope DEK; seal the migrated snapshot; decrypt it immediately and compare with the in-memory source before committing the separate DB. Display the generated 256-bit recovery key **only after successful commit** and have the user store it independently. No recovery key is minted on an idempotent repeat.
5. Verify post-restart and offline unlock, incorrect credentials, scope isolation, tampering, and backup restore. **Do not** activate the sealed copy until every original-source revision is rechecked, the cross-tab writer gate is functioning, and legacy/cloud/sync contracts (#33/#66/#68) are reconciled.

## Recovery, rollback and limitations

- `readStagedSnapshot(scope,{passphrase})` or `{recoveryKey}` can decrypt after restart without fetching the server. Keys exist only for the operation and are `lock()`ed afterwards. The caller must purge any displayed financial data and its references on logout/lock; this staging module does not control the UI lifecycle.
- Wrong credentials, missing keysets, a half-written copy, other-account credentials, and authenticated metadata/ciphertext tampering **fail closed**. If the backup/password and both local unlock credentials are lost, no recovery is promised.
- **Rollback before cutover:** keep using the legacy source; the new staging DB can be ignored. It does not change or delete original data. **Rollback after cutover is not implemented** and must separately account for queued unsynced writes and post-migration operations.
- This protection is **not** anti-rollback against an attacker who can replace the whole encrypted record + envelope with an older valid pair: the client must compare a trustworthy external revision (e.g. server ETag) when relevant. Guests offline have no authoritative external monotonic counter.
- It does not protect against XSS, malicious browser extensions, a compromised operating system or hostile code while a budget is unlocked. It does not guarantee physical erasure of historical plaintext in browser database pages, OS caches or disk snapshots. **As long as legacy IndexedDB is retained in plaintext, at-rest financial privacy is NOT achieved for existing users.**
- It is not E2EE for the cloud-first PostgreSQL architecture from ADR #65. The server still processes financial data in the accepted model.
- Real multi-tab cutover, isolation across 2 users and 2 devices, independently saved backup proof, migration rollback with live mutations, physical iOS/macOS UX and production verification remain **NO_GO** until separate implementation and acceptance. Do not close #34 for this staging milestone.

## Test evidence and delivery gates

- Node tests `tests/protected-staging.test.mjs`: encryption / wrong key / recovery / two scopes / metadata tampering / no plaintext / staged-transaction abort + retry / offline / exact idempotence.
- Node test `tests/protected-legacy-backup.test.mjs`: version 1 encrypted backup -> version 2 state, explicit consent required, incorrect backup password, wrong source, separate rollback preservation. Uses only generated synthetic finance data.
- Browser test `tests/e2e/protected-staging.spec.mjs`: native IndexedDB with synthetic legacy+encrypted copies, reload then offline unlock, wrong credentials, tamper rejection, source unchanged, no persisted plaintext, no JS exceptions (Chromium/WebKit in GitHub Actions). A mocked IndexedDB test is **not** a substitute for this browser test.
- TypeScript check: `tsc -p src/security/tsconfig.json` (requires real repository, Node >=24 for built-in TS stripping during Node tests). Standard `npm test`, CI, E2E, exact-head independent code/security review must pass before merge. No user migration, deletion, toggle or deployment may be inferred from a green CI alone.

## Unlock UI proposal - NOT approved and NOT implemented

First activation: confirm an independent encrypted backup and its password, set a separate local passphrase (minimum 12 characters), display the local 256-bit recovery key once, confirm safe storage, then explicitly approve staging. Subsequent opens: passphrase unlock; lost passphrase: recovery key + immediate rewrap; logout: block in-memory keys and stop access to decrypted data. Offline unlock works only where the encrypted copy already exists. **Owner UX approval is required before modifying any UI.**
