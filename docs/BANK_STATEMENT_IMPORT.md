# Bank statement import - isolation and ledger handoff (#38)

## Status

The browser CSV/XLSX parser, reconciliation and draft generation are read-only.
The #38 branch now also contains **unpublished** SQL-atomic bank-import,
compensating undo, private batch-history and v2 HTTP candidates. These do
persist real ledger movements if explicitly wired, but are **not enabled by
default, deployed to production, or connected to the application UI**.

This is a Draft PR, not an accepted release. Neither CI nor a candidate
module proves guest-mode integration, owner-approved mobile/desktop UI, full
integration acceptance or production deployment.

Existing domestic XLSX (excel-import.js) and loan schedule CSV (schedule.js)
are deliberately left unchanged.

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

## Implemented bank integration candidate (DISABLED BY DEFAULT)

- Schema: `backend/finance_db/migrations/versions/0007_bank_statements.py`.
  Separate RLS-protected `bank_import_batches` and immutable
  `bank_import_rows`; neither replaces legacy migration #69 data.
- SQL core: `backend/finance_db/bank_import_candidate.py`, scoped by the
  verified auth principal and `finance_profiles FOR UPDATE`. The candidate
  uses integer minor units, journal receipts, ETag and current revisions.
- Private HTTP: `backend/finance_api/bank_import_http_candidate.py` and
  `backend/finance_db/finance_router.py`: POST `/api/finance/v2/bank-import/commit`,
  POST `/undo`, GET `/batches`. All bank endpoints are **unmounted** unless
  the host explicitly passes `enable_bank_import_candidate=True` with finance
  v2 enabled. No production environment toggle enables it.
- TypeScript: `src/importers/bank-statements/save.ts`; builds normalized
  confirmed requests, sends same-origin credentials and checks authoritative
  server results. The module is not mounted in production navigation.
- PostgreSQL commit currently accepts up to **1,000 operations per atomic
  batch** and 2 MB of JSON. The browser parser accepts up to 10,000 rows, so
  a larger confirmed selection must fail clearly; **never split an import
  without an explicit product decision**.
- Reimport with the same committed `batch_key` and identical payload
  acknowledges zero new movements. Partial overlap must be reconciled before
  committing; a conflicting source key or external ID cannot be overwritten.
- This is an owner-only personal-finance candidate, not a general bank API:
  RUB only, no automatic FX, no bank scraping, no original statement storage.

## Outstanding release gates

- Design originals / UI workflow and explicit owner visual approval for both
  mobile and desktop. No new bank import UI has been implemented.
- Wire accepted UI state to the authenticated finance v2 snapshot and
  reconciled bank history, and implement matching **atomic IndexedDB guest
  storage/undo** without impacting existing offline PWA or encrypted export.
- Reconcile the confirmed selection with all existing transactions and
  already-posted obligation/loan payment facts in both device and server
  scopes. Ensure proposed matches are resolved manually.
- Complete real PostgreSQL, Chromium/WebKit, security, concurrency and offline
  regression tests on the **final** exact HEAD; review migration, permissions,
  credit/payment invariants and restore drill. Earlier green CI is insufficient.
- No merge, production migration, server flag activation or Issue closure
  until all gates are actually passed. Production must preserve existing
  financial data and have a verified rollback procedure.

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
- **Acceptance pending:** owner UI approval, guest IndexedDB atomic
  commit/undo, released UI integration, full exact-HEAD review and verification
  on the deployed production SHA. Until then leave this PR Draft and Issue #38
  open; do not claim that passing isolated PostgreSQL CI is a production release.

Additional parsing rules: a split credit/debit column determines transaction direction and a conflicting explicit kind blocks the row. For XLSX, sourceKey includes a stable sheet identity in addition to file digest and physical row, preventing cross-sheet collisions. Missing trailing optional XLSX cells are treated as blank (but surplus columns and malformed CSV widths remain invalid).

Additional XLSX safety limits: shared string dictionaries reject nested `<si>` elements, more than 128 rich-text runs per item, text beyond 16,384 characters per cell, over 50,000 entries, and over 2 million aggregate characters. Unsafe integer numeric scalars remain raw strings to prevent bank transaction ID collisions beyond JavaScript's safe integer range.
