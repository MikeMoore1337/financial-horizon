# Financial Horizon #34 - live legacy IndexedDB read-only preflight (stage 5)

**This is a non-destructive, inactive preflight. It does not encrypt the active ledger or perform migration.** It is intended to complement the existing [encrypted staging](PROTECTED_STAGING.md), [atomic encrypted candidate](ATOMIC_ENCRYPTED_CANDIDATE.md) and [approved local unlock flow](APPROVED_LOCAL_UNLOCK_FLOW.md). It is not imported by `storage.js`, `app.js`, React, auth, Service Worker or the financial API.

## Legacy data mapping

The historical database is `financial-horizon-browser-v1`, structural IndexedDB schema version 1, store `finance`. Account-specific states are located only at `account-state-v2:<verified-user-id>`. A guest uses the legacy `state` key **only before any valid `legacy-account-claim-v2` claim exists**; once a claim exists, the guest uses `guest-state-v2`. An explicit guest selection never exposes the previous account's `state` after that claim. Missing exact account/guest keys fail closed without inferring a transfer.

`verifyLiveLegacyBackup` requires an explicit identity and two consent flags. The account identifier **must be supplied from an already verified authentication session**; the helper itself cannot authenticate a user. Guest namespaces must be explicitly selected in the host. The function never reads auth cookies or localStorage. It opens the original IndexedDB **without requesting a version upgrade** and aborts creation if it does not already exist. All reads use an IndexedDB `readonly` transaction and the function neither calls `selectStateScope` nor mutates `storage.js`'s activeKey.

## Verifying an independent encrypted backup

1. The user independently saves an existing AES-256-GCM encrypted backup in **v1 file format** outside this browser/device, supplies the file text and separate backup password, and confirms both that fact and the read-only preflight.
2. Select the confirmed account/guest namespace **synchronously**, before starting asynchronous reads/KDF. Read the claim marker and the exact corresponding stored state in one native readonly transaction; if missing/invalid, abort rather than falling back to someone else's state.
3. Migrate the selected v1/v2 state **only in memory** to schema v2. Decrypt the supplied saved backup v1; apply the same pure migration; compare every financial field canonically, ignoring only JSON object key insertion order (not array order, revision or amounts). Mismatch/wrong password aborts.
4. Read the original IndexedDB and claim again **after** the expensive backup KDF; compare full normalized content, claim and source key. Any change from another tab aborts with an explicit stale-source error.
5. Return the verified `scope`, selected `sourceKey`, `sourceRevision` and in-memory `snapshot`. No key, secret, copy or marker is written to any storage; caller must clear returned financial data from memory on lock/logout. This result is **not cutover permission**: a writer can edit the original after verification.

**Important limitations:** A boolean `savedEncryptedBackupOutsideThisBrowser: true` represents an explicit user assertion, not proof of file availability; the final flow must guide a real file download and restoration drill. A verified account ID in a JS object is not server authorization; the host must use the authenticated identity. No promise of physical erasure of browser DB pages is made. Password- and recovery-key loss cannot be repaired by the server. This module does not stop current `storage.js` writers; it only detects changes between two reads. Before any real cutover, #68 requires cross-tab quiescence and a durable atomic revision/outbox contract, and #33/#66/#67 require approved ledger/cloud interfaces.

## Verification

- `node --test tests/live-legacy-preflight.test.mjs` on Node 24: guest before/after claim, exact account key (no fallback), wrong/mismatched backup, v1→v2 parity, KDF-time concurrent edit and claim change, consent and identity enforcement, no network, source unchanged.
- `tests/e2e/live-legacy-preflight.spec.mjs`: real Chromium/WebKit native IndexedDB, encrypted v1 backup verification offline after reload and cross-account/guest isolation. Test contexts use only synthetic financial records.
- `npx --no-install tsc -p src/security/tsconfig.json`, `npm test`, `npm run test:e2e`, CodeQL, independent exact-SHA security/code review.

**Do not merge without exact-head required checks. Do not close #34 or claim protected production IndexedDB based on this read-only helper.** The final user migration still needs a visually approved UI, explicit per-scope backup/cutover consent, restart/rollback verification, secure guest/account separation, actual release SHA and physical device acceptance.
