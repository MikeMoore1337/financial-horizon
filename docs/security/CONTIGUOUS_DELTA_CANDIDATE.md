# #34/#68 - contiguous local delta persistence candidate (INACTIVE)

**Status: synthetic proof-of-concept only. No active PWA import, no real server verification, no protected source switch, no legacy migration or production deploy.** Existing financial-horizon-browser-v1 stays plaintext.

## Why

After #131/#132, local replay-ACK reconciliation requires an `applied` proof tied to scope, generation, epoch, UUID, fingerprint and revision. That proof is only trustworthy if the **corresponding verified server deltas, finance state, monotonic cursor and proof are persisted atomically**. A standalone `applied:true` bit or HTTP 200 is not enough.

`src/security/contiguous-delta-candidate.js` is an isolated native IndexedDB persistence candidate. Its input has already been authenticated, validated against the real server contract, transformed to a valid finance snapshot and grouped by contiguous **server revision** by a *future upstream verifier that does not yet exist*. Multiple events may be grouped under one revision. The primitive itself **does not authenticate a server, validate a server signature, parse real deltas, validate monetary amounts, prove API idempotency or verify an encrypted snapshot**. An arbitrary caller could forge the injected proof; this is not production-ready security.

## Native transaction contract

- One transaction spans `meta`, `finance`, `applied` and `outbox` stores in a **throwaway synthetic database**, not the real financial IndexedDB.
- Before committing, compare the current persisted `scope + generation + epoch + cursor` and existing finance snapshot revision to the caller's exact starting state.
- Require contiguous integer server revisions with no gaps; reject duplicate UUIDs in a batch. Each command has an immutable UUID and canonical fingerprint. Fail closed if a queued row of the same UUID has a mismatching scope, epoch, generation, status or payload fingerprint. An existing proof for a supposedly new revision is a hard recovery hold.
- Persist new finance state, monotonic cursor and `applied` proofs in the **same native readwrite transaction**, or abort them all. The module **does not delete, re-key or overwrite any outbox entry**. Other accounts and pending/sending/conflict items are untouched.
- Abort on logout signal before commit where IndexedDB permits. A completed transaction cannot be retroactively reversed. A later replay ACK may be reconciled by the inactive #132 strict proof/outbox CAS; a local generation/epoch is not a server idempotency key.
- Native Chromium/WebKit tests use one disposable `fh-e2e-contiguous-*` database, two tabs, two account scopes, synthetic financial values, stale epoch/cursor, mismatched queued fingerprint, immediate logout abort and browser reload. A browser reload is not a process crash. Unit tests assert pre-transaction validation.

## Hard external dependencies (NOT MET)

1. **#33/#66/#67:** trusted integer-minor-unit finance schema, serialized PostgreSQL transaction and authenticated, canonical idempotent receipts; preserve the original UUID/fingerprint across local generation changes. The current #67 branches are feature OFF and stacked on unmerged #66. No claims about the real database are made here.
2. **#68:** implement the missing upstream **authenticated, contiguous, complete server delta verifier** (including multiple ordinal events per revision and snapshot pagination/410 handling); actual cross-tab and historical cached/versionless writer fencing; revocable per-scope generation and epoch; genuine protected encrypted finance/outbox stores. Without these, the synthetic injected state is untrusted.
3. **#69:** durable commit marker/migration journal, source+queue final CAS under proved writer fence; preserve pending/sending/conflict on rollback, restore an independent external encrypted backup, and require explicit per-scope import/cutover consent. Nothing here writes a journal or creates a safe rollback.
4. **#70:** integrated real PostgreSQL + two users/two devices/two tabs, crash/restore across journal boundaries, stale ACK and lost reply after server commit, historical SW/PWA versions, physical iPhone Safari PWA restore, independent human security acceptance and exact production SHA/rollback receipts.

**Decision: activation NO_GO; Issue #34 OPEN.** There is no approval of a visual unlock design, no physically verified separate external encrypted backup, and no authorization to delete legacy plaintext. This stage deliberately changes no SW, runtime app, `storage.js`, real IndexedDB, API, PostgreSQL, production config or feature gate.
