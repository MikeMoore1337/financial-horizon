# Financial Horizon #34 - verified inactive atomic staging bridge (stage 6)

**Status: candidate preparation only. No active IndexedDB cutover. No user data deletion, sync or upload.** The functionality is implemented in `src/security/verified-atomic-staging.ts`. It composes the read-only [legacy preflight](LIVE_LEGACY_PREFLIGHT.md), [atomic encrypted candidate](ATOMIC_ENCRYPTED_CANDIDATE.md), [local unlock controller](APPROVED_LOCAL_UNLOCK_FLOW.md) and Web Crypto. This file is not imported by `app.js`, `storage.js`, React, Service Worker or the FastAPI backend.

## Required consent and verification

1. Obtain a fresh, **separately saved, encrypted legacy backup v1** file and its backup password. Verify the correct currently authenticated account or explicit guest scope, rather than trusting an identifier from the backup file. The account's login password/cookie must never be used as a local encryption key.
2. Collect four explicit confirmations: external backup saved, read-only source preflight, independent encrypted candidate creation, and one-time recovery-key handling. These flags are representations of real user actions, not evidence of physical file retention. UI + physical restore verification are separate gates.
3. Pin the selected identity, backup ciphertext, backup password and **distinct** local passphrase before any async KDF operation. Validate source snapshot and legacy claim before and after backup decrypt via `verifyLiveLegacyBackup`.
4. Create a **new**, separate encrypted atomic candidate containing the migrated v2 snapshot with empty legacy outbox/conflict arrays. This legacy schema has no outbox, but the future #68 sync schema must supply all actual pending operations before its own cutover. **Never silently overwrite** a pre-existing protected keyset.
5. After the initial encrypted IDB transaction is committed, return a one-time recovery receipt even if verification later fails. Re-open the candidate in a fresh local in-memory session with the user's local passphrase, decrypt its snapshot, compare all financial values and ensure outbox/conflicts are empty and epoch 0. Recheck the original legacy source/backup a final time to detect writes during staging.

## Receipt and failure handling

Every committed candidate receipt has `active:false` and one of:
- `prepared`: encrypted copy decrypted and matched an independently verified legacy source at the last read. **Not** permission to cut over; active legacy writers may still edit later.
- `stale-source`: the original source changed during preparation; the encrypted candidate **remains inactive**. It and its recovery key must be preserved for a future operator-guided reconciliation, not silently deleted.
- `unverified`: read-back, keyset, password, source or metadata verification after commit failed. The copy remains inactive. The recovery key is still returned; never throw it away or claim success.

Before the initial atomic commit, errors (invalid consent, backup mismatch, lost source, wrong password, duplicate scope, quota/abort) reject without creating an active protected source. **No automatic retry can overwrite a previous keyset or rotate its recovery secret.** Future application integration needs a clearly reviewed abort/restart path for a stale candidate and proof of independent recovery, without deleting original financial records.

## What is deliberately NOT implemented

- No migration journal, multi-tab writer quiescence for `storage.js`, atomic active-source switch, removal of legacy plaintext, physically verified restore, passphrase UI, pause/resume sync, backend reconciliation or server-side anti-rollback counter.
- An attacker who can replace an entire old valid GCM record and keyset can cause rollback without a trusted monotonic server checkpoint. AES-GCM is not XSS protection or encryption of server-processed finance data (not cloud E2EE).
- A background update from legacy `storage.js` **after** the final read cannot be excluded; #68 must gate live writers during actual cutover. The presence of an inactive encrypted copy does not make the original plaintext IndexedDB private.
- Device encryption, browser file page reclamation and flash/storage physical erase are outside the guarantees of JavaScript. Loss of both the local password and recovery secret makes that encrypted copy unrecoverable.

## Test boundaries and acceptance

- Node tests `tests/verified-atomic-staging.test.mjs`: initial commit, read-back, no plaintext in new stores, original preserved, wrong external password, explicit consent, duplicate scope, concurrent source changes, corrupted postcommit readback preserving recovery key, scope TOCTOU and network-offline.
- Browser `tests/e2e/verified-atomic-staging.spec.mjs`: real native legacy + protected IndexedDB in synthetic Playwright context, independent backup v1, one-time recovery key, offline unlock after restart and no sensitive plaintext in the **new** stores.
- `tsc -p src/security/tsconfig.json`, isolated-crypto GitHub Actions, `npm test` and Chromium/WebKit E2E, independent exact-SHA code/security review. **Passing tests proves only candidate preparation.**

Issue #34 remains **OPEN** until the active PWA uses the encrypted source after a separately approved UI, verified external backup, per-scope user consent, migration journal + crash/cross-tab rollbacks, actual secure source selection, cleanup of legacy plaintext with explicit confirmation, and production/physical restore and audit.
