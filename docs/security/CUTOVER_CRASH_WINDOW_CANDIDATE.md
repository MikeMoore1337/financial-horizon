# #34/#68 - synthetic staged-candidate crash-window experiment (INACTIVE)

**Design-gate evidence only.** This is not a financial migration, encryption, durable production journal implementation, recovery drill, or permission to activate a new source.

## Hypothesis and observed failure that must be fenced

A verified candidate snapshot can become obsolete before an old IndexedDB writer is actually stopped. Merely verifying a candidate once, or requesting a version-2 upgrade, is not an atomic cutover across separate databases. While an old version-1 connection blocks an upgrade, it can still commit an additional pending operation. Following a reload, the original source and the earlier candidate may each be durable but **different**. Activating the candidate would silently omit the new offline operation.

The native Chromium/WebKit test `tests/e2e/cutover-crash-window-candidate.spec.mjs` uses two exclusively synthetic, throwaway IndexedDB databases (`fh-e2e-cutover-source-*` and `fh-e2e-cutover-candidate-*`), never `financial-horizon-browser-v1`. A candidate store and journal entry are written together **inside one candidate-DB transaction**, not across both databases. The test stages an initial `pending`, `sending`, and `conflict` outbox, keeps a cached v1 source connection open, requests a blocked v2 upgrade, and then records a fresh `pending` operation through the old connection. Only after that write does it permit the upgrade and reload the browser page. The final source has revision 2 and four queue entries; the staged candidate still has revision 1 and three. The persisted journal remains `CANDIDATE_STAGED`, not `COMMITTED`. A final comparison must reject it.

## Limitations and required contract

- This demonstrates a **race and the need to reject a stale candidate**, not a production-ready comparison, writer fence, encryption scheme, or crash-safe cross-database commit. The test uses a page reload, not a process crash or physical iPhone test.
- A source revision alone is insufficient if a historical writer can mutate data without incrementing it. The future gate must prove all writers are frozen, compare authenticated final contents and every `pending/sending/conflict` entry **after** the durable barrier, and bind the journal to the correct scope/fence epoch.
- IndexedDB does not supply a shared ACID transaction across the old DB, the candidate DB and PostgreSQL. A commit marker, recovery journal and idempotent replay/ACK protocol must define safe intermediate states and fail closed on ambiguity.
- Coordinate with #33/#66/#67 for integer-money ledger, scoped server revision and idempotency; #68 for mixed-version writers, offline replay, cross-tab locks and cursor/ACK; #69 for explicit backup/consent/rollback; #70 for real E2E and physical QA.
- Until a future reviewed cutover implementation actually enforces these invariants, do not turn on encryption, migrate or delete plaintext records, upload finance data, change flags, or claim production at-rest protection. The existing IndexedDB is plaintext and Issue #34 stays OPEN.

Reference: `docs/security/INACTIVE_CUTOVER_FENCING_CONTRACT.md`.
