# Financial Horizon #34 - approved local unlock behavior (2026-11-08)

**Owner approval:** the unlock/recovery **interaction scenario** was explicitly confirmed in the project conversation on 2026-11-08 and recorded in [Issue #34](https://github.com/MikeMoore1337/financial-horizon/issues/34#issuecomment-6718670579). This is **not** approval to delete legacy financial records, turn on an existing-user migration, publish a visual design, or claim end-to-end encryption. The visual layout remains subject to the repository's visual review policy.

## User flow contract

1. On explicit local-encryption setup for one verified account or a guest namespace, the user chooses a **local** passphrase (12-1024 characters), which is different from and not derived from their login password or session cookie. A failed setup leaves all original data intact.
2. After the encrypted keyset and candidate snapshot have been durably committed and verified, show the independent 256-bit recovery key **once**. The user acknowledges storing it outside this browser/device. Do not persist the plaintext recovery key, passphrase, or raw DEK.
3. A returning user must explicitly unlock that particular account/guest scope with their local passphrase or recovery key. A recovery key can be used to rewrap the passphrase. A server-side password reset does not decrypt local data; when both local credentials are gone, recovery of that encrypted copy cannot be promised.
4. Manual lock, logout, **even a same-account re-selection**, account switch and session revocation invalidate all active and pending local-crypto operations. The integration must also clear financial React/legacy state, DOM history, cached data and stop the outgoing sync queue. A cleared server session alone cannot be treated as proof that the UI has cleared sensitive data.
5. Offline unlock is allowed only for an already-prepared local scope with persisted ciphertext and keyset. It does not provide server authorization or permission to sync financial changes.
6. Migration additionally requires a verified *separately saved* encrypted backup, confirmation of the target scope and independent opt-in. No plaintext legacy deletion or active-store cutover is permitted without post-migration restore and rollback validation and **separate explicit consent**.

## Code boundary (stage 3: independent controller)

`src/security/local-budget-session.ts` implements a **non-persistent** controller around `unlockLocalKeyset`:

- Host must select a validated scope using `selectScope` after checking the real authenticated user or explicitly choosing guest. This class is **not** an authorization provider.
- `state` is `unselected`, `locked` or `unlocked`. `unlock` stores an unextractable `LocalVault` only in memory. It never reads `localStorage`, auth cookies, IndexedDB, or network services.
- `lock` destroys the vault reference, and `logout` also drops the selected scope. A generation counter invalidates any in-flight or competing unlock/encrypt/decrypt completion. The host must call these methods on every relevant lifecycle event; this module does **not** wire itself into the UI yet.
- The underlying `LocalVault` performs authenticated encryption and decryption; the controller prevents stale completion delivery after a local lock, and refuses keysets belonging to a different scope.
- A browser restart constructs a fresh locked session. The existing stage-2 storage module can supply a keyset and sealed snapshot after explicit scope selection; no auto-unlock is allowed.

## Remaining security gates

**Not implemented:** live UI screen, full logout/DOM cleanup wiring, cross-tab revocation, idle-lock scheduling, pause-and-resume of offline sync, coordinated migration journal, atomic active-store cutover, safe deletion of legacy plaintext, post-cutover rollback with pending mutations and physical device acceptance.

#33 (accounts domain), #66 (PostgreSQL) and #68 (offline sync) contracts must be validated before integration touches `storage.js`, `state-migrations.ts`, React screens, backup APIs, Service Worker or the production finance API. Neither these isolated modules nor a successful CI run protects existing plaintext IndexedDB records; Issue #34 stays open until a verified, consented production migration and restore drill. Browser/PWA cannot guarantee secure deletion of historical plaintext from caches, filesystem snapshots or flash storage.
