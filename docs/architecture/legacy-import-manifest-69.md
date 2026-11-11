# Issue #69 - verified legacy import manifest candidate (INACTIVE)

**Status: SOURCE-ONLY / NOT AN IMPORT / NO CLOUD UPLOAD / NOT DEPLOYED.**

Existing local-first IndexedDB, guest scopes and encrypted v1 backups remain
unchanged. `src/cloud/legacy-import-manifest-candidate.mjs` creates a read-only
preview from a trusted result of `verifyLiveLegacyBackup`; it cannot validate
an untrusted snapshot on its own, and it does not claim that the user has
physically retained the backup.

## Safe preview inputs

- Explicit authenticated destination `account:<verified FH user ID>` and
  server-derived profile UUID/revision. Guest imports require their own
  additional explicit confirmation; an account source cannot target a
  different authenticated account.
- User confirmation that an **independently saved encrypted backup** was
  verified against the local v1/v2 source, plus a preview decision.
- A live, revocable session `AbortSignal` checked both before and after
  snapshot hashing.
- Original local record counts/IDs, source version/revision and deterministic
  SHA-256 fingerprint over a cloned, canonical JSON snapshot.
- Existing server records cause `NEEDS_CONFLICT_DECISION`, never a silent
  merge or import.

The result always has `sendAllowed=false`,
`requiresExplicitOpeningBalances=true`, empty `plannedAccounts` and
`plannedLedgerPostings`, and `originalPreserved=true`. No historical
obligation, loan, settlement or loan payment is converted into a new cash
movement or opening balance by the preview.

## Still required for actual import

1. Safe UI for explicit source/target selection, preview, conflict resolution
   and preservation of original and external encrypted recovery key.
2. Real FH session/owner check, #34 protected IndexedDB keyset isolation,
   #68 atomic cursor/outbox/receipt CAS, and serialization across tabs.
3. Approved versioned server import action with per-record mapping and
   idempotent batch receipts in the same PostgreSQL transaction, including
   hard rollback on timeout, 409/412, 500, logout or network partition.
4. User-supplied opening balances and separate confirmed actual payment
   handling; zero must not be inferred for missing amounts.
5. Verified replay from original encrypted backup, two-user/two-device
   Chromium/WebKit integration and independent #70 security acceptance.
6. Real #66 backup/offsite/PITR/restore with proven RPO/RTO and controlled
   production deployment, never silent data upload.

No component in this change calls `fetch()`, writes IndexedDB or changes
active app routing. Node unit tests cover v1/v2, consent, guest transfer,
cross-account isolation, unsafe money, duplicate IDs, deterministic hash,
conflict preview, abort and no implicit network or storage effects.
