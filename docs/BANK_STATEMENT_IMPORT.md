# Bank statement import - isolation and ledger handoff (#38)

## Status

The CSV/XLSX parser and reconciliation are read-only until the owner confirms a
batch. PR #86 now contains the **owner-approved** mobile/desktop React import
screen, atomic guest IndexedDB bank ledger with full-batch cancellation, and an
isolated PostgreSQL implementation with protected API commit/undo/history.
This code has **not yet been merged or released to production**.

On 20 November 2026 the owner approved the ChatGPT mockups and confirmed an
encrypted backup and isolated restore of the live `0006_reserve_events` database
(16 RLS tables). Synthetic guest/browser and two-browser PostgreSQL CI passed
on an earlier exact SHA. The production `0007_bank_statements` migration,
native server/Caddy release and final static activation are still pending.

The approved mockup is a ChatGPT-produced visual concept. The three native
third-party design-original executors were not run; no ALL_THREE completion is
claimed. Existing domestic XLSX (`excel-import.js`) and loan schedule CSV
(`schedule.js`) remain unchanged.

## Import pipeline

1. Browser UI reads a user-selected file using file.arrayBuffer();
   never send its bytes to a server, analytics, crash reporter or third party.
2. readBankStatementFile recognizes CSV/XLSX, enforces format limits, returns
   file digest, headers, rows and warnings. Use filename only as text.
3. Optional headerRowNumber (1-100) skips an introductory bank report preamble,
   retaining the original physical row numbers for every imported operation.
4. suggestColumnMapping proposes indexes; the user explicitly reviews
   mappings, account aliases, direction, date order, number format and target
   account for transfers. Positive transfers cannot be accepted unless the
   user explicitly selects transferDirection. In signed-source mode, the
   account of a positive row is the recipient and targetAccount is the other
   owned account (source); normalization swaps the two for the ledger.
5. normalizeBankStatement creates integer RUB cents, safe ISO dates,
   source keys, row-level errors and P&L totals. It **does not** mutate state.
   Unknown account/category and ambiguous amounts/dates block that row.
6. reconcileBankStatement compares a **scope-restricted** ledger snapshot:
   sourceKey or matching bank external ID is an exact duplicate;
   content-only matches and opposite transfer legs are *possible* duplicates.
   Never auto-insert possible duplicates.
7. After manual confirmation, draftBankImportBatch produces an immutable
   proposal with deterministic batchKey and sourceKeys.
7a. summarizeBankImportAudit returns counts and error codes only (no account IDs,
   notes, bank IDs, amounts, filenames or raw statements); persistence of
   confirmed rows is handled by the unpublished PostgreSQL import candidate.
8. projectAccountBalances checks each affected account with optional
   statement closing balances, without applying any movements.
9. An authenticated user may build a normalized v2 commit request from a
   manually reviewed batch. The client uses the current finance account
   revisions, a strong ETag, a stable mutation UUID and validated server receipt.
   No original CSV/XLSX bytes or filenames are sent to the finance API.
10. The unpublished PostgreSQL candidate commits all confirmed operations in
    one transaction or rejects the entire batch. A source-key conflict,
    conflicting bank ID, linked loan/obligation payment, unreviewed matching
    movement, stale revision or foreign account blocks the write.
11. An unpublished private batch-history endpoint lists committed and
    cancelled batches. A later explicit undo creates linked append-only
    compensating ledger transactions atomically. Undo is conservatively denied
    if *any* later financial revision exists, even an unrelated change.

## Implemented bank integration candidate (SERVER OFF BY DEFAULT)

- Schema: `backend/finance_db/migrations/versions/0007_bank_statements.py`,
  separate append-only RLS `bank_import_batches` / `bank_import_rows`.
- SQL core: `backend/finance_db/bank_import_candidate.py`, verified session,
  PostgreSQL transaction locks, ETag CAS, receipts, source-key replay
  protection, linked-payment checks and all-or-nothing compensating undo.
- Private endpoints: POST `/api/finance/v2/bank-import/commit` and `/undo`,
  GET `/batches` and `/rows`. All four are **unmounted by default** until
  `FH_FINANCE_BANK_IMPORT_RUNTIME=on` with personal finance v2 enabled.
  This is independent of the legacy `FH_FINANCE_IMPORT_RUNTIME` flag (#69).
- `src/importers/bank-statements/BankImport.tsx`, `server.ts`, `save.ts`:
  manual mapping, protected full finance snapshot + row identities,
  signed write intent and validated receipts. No raw statement file is
  transmitted; date/amount/description/IDs from confirmed operations are
  sent to finance API only after explicit confirmation.
- Guest `guest-ledger.js`: actual bank accounts and balances separate from
  the legacy planner, atomically persisted and included in encrypted backups.
- Signed UI requires a separate static meta flag
  `fh-finance-bank-import=enabled`; initial release has it **disabled**.
  Guest local import remains available without banking API.
- Up to 1,000 operations per atomic batch and 2 MB API JSON; the browser
  parser accepts up to 10,000 rows, so a larger selection must be reduced
  before confirmation. RUB only, no bank scraping or automatic FX.
- Reimport of identical committed source rows creates zero new movements.
  Partial overlap must be reconciled manually before committing; conflicting
  source keys and bank IDs cannot be overwritten.

## Outstanding release gates

- Complete final exact-HEAD lint, typecheck, build, Node, pytest,
  PostgreSQL, Chromium/WebKit and multi-device CI, plus an independent
  release review. Earlier green CI is not proof for a later commit.
- Real owner backup/restore of `0006` (16 tables) is **PASS**.
  This does not prove migrated production `0007` (18 FORCE RLS tables).
- Follow `docs/operations/BANK_STATEMENT_RELEASE_38.md`: main merge,
  protected backend stage, encrypted backup/restore before migration,
  additive `0007` migration, RLS/ACL proof, encrypted backup/restore
  after migration, exact-SHA backend publication.
- Run `scripts/fh_bank38_release.py` only on the authorized native VPS
  for exact Caddy GET/POST allowlist and separate systemd bank flag;
  verify same-origin credentials, anonymous 401, wrong-Origin 403,
  strong ETag, OAuth and old finance routes. No user write in operator.
- Separately release the signed UI meta flag once the backend is confirmed
  live; verify the public exact SHA, guest and signed browser reimport,
  partially overlapping CSV/XLSX, transfers, whole-batch undo, encrypted
  backup/restore and logout. Close #38 only after real acceptance.

## Limits and threat boundaries

- CSV: 4 MB, 10,000 data rows, 64 columns, 16 KiB per cell. Reject over-limit
  data before computing any SHA-256 digest.
  UTF-8, Windows-1251/1252, IBM866, UTF-16 LE/BE. Auto mode tests UTF-8
  then Windows-1251; other encodings require explicit selection.
  The returned table exposes csvEncoding/csvDelimiter; a guessed Windows-1251
  encoding produces a warning for manual review before confirmation.
- XLSX: 6 MB archive, 256 ZIP members, 8 MB per part, 24 MB total declared
  uncompressed, 10,000 rows, 120,000 cells. CRC32 validated, streaming
  inflation length-capped. ZIP encryption, zip64, macros, links to external
  workbook parts, DTD/ENTITY and unsupported workbook targets rejected.
  Formulas are never evaluated and their cached results are skipped.
- No HTML interpolation of descriptions, filenames or warnings: render
  strings through React text children or DOM textContent, never innerHTML.
- No background services, bank account scraping or API credentials.
- No real transactions or sensitive financial documents in repo/CI.
- The parser does not validate economic correctness of a transaction;
  posting the resulting proposal must be a separate user decision.

## QA gates

- Unit: CSV dialects/encoding, quoted newlines, numbers/dates, invalid
  mappings, signed and split amounts, transfers, duplicates, rollback plans,
  account-balance projections, malformed and oversized files, XSS strings.
- Browser: native DOMParser/DecompressionStream + synthetic XLSX
  (shared/inline strings, Excel serials, ignored formulas), file isolation.
- Compatibility: run the existing domestic Excel and loan schedule tests.
- Before merge: Node 24 lint, strict tsc, build, unit, component, audit and
  Chromium/WebKit CI on the precise PR HEAD.
- **Acceptance pending:** live native-host schema/backend/Caddy/static release
  and owner real-site E2E. Synthetic QA and approved UI do not constitute
  a production release.

Additional parsing rules: a split credit/debit column determines transaction direction and a conflicting explicit kind blocks the row. For XLSX, sourceKey includes a stable sheet identity in addition to file digest and physical row, preventing cross-sheet collisions. Missing trailing optional XLSX cells are treated as blank (but surplus columns and malformed CSV widths remain invalid).

Additional XLSX safety limits: shared string dictionaries reject nested `<si>` elements, more than 128 rich-text runs per item, text beyond 16,384 characters per cell, over 50,000 entries, and over 2 million aggregate characters. Unsafe integer numeric scalars remain raw strings to prevent bank transaction ID collisions beyond JavaScript's safe integer range.
