# Bank statement import - isolation and ledger handoff (#38)

## Status

This document describes an isolated parser and **proposal-only** workflow.
It does NOT persist, post, delete, or cancel bank movements. The #33 financial
accounts/ledger contract is not yet accepted. The new feature must remain
unreachable from production navigation and must not be marked released.

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
8. projectAccountBalances checks each affected account with optional
   statement closing balances, without applying any movements.
9. After successful posting by #33, draftBankImportUndo can propose a
   fail-closed rollback only when *all* movements still belong to that batch
   and their essential financial fields are unchanged. An existing payment
   link also blocks an undo proposal. Actual rollback needs another atomic
   #33 revision check and audit trail, and is not implemented here.

## Required #33 integration contract (NOT IMPLEMENTED)

- Implement ledger and account IDs scoped to the active authenticated user
  or guest. Never compare or import into another scope.
- One database transaction: validate accounts/category/permissions, compare
  revision, re-check sourceKey (unique per scope) and external bank identity
  (at least account ID + external ID), check selected rows and confirmation
  digest, post exactly one movement or transfer per operation, record batch
  and audit, then commit. On any error roll back entirely.
- An internal transfer is a paired debit/credit with one logical transfer ID
  and no income/expense effect. Credit/loan settlements must never be posted
  a second time as independent spending.
- Cancellation must void the entire batch atomically with revision checks,
  preserve an audit trail, and refuse if any member was modified or linked.
  Never delete imported history silently.
- Store only necessary financial metadata in the user's financial data
  boundary. Avoid names/file bytes/raw statement lines in application logs.
- Keep batchKey as batch identifier; sourceKey is a uniqueness key,
  not an authentication/authorization token. Fingerprints are heuristic.
- Re-query records at commit time: a preview is stale as soon as another
  tab/device posts a movement.
- Add a focused migration, cross-tab/remote idempotency tests, undo and
  account-balance E2E only AFTER #33 defines its transaction contract.
- Hide the new import in production until owner-approved UI design, browser
  review, CI, release approval and verified rollback. Do not enable via
  feature flags preemptively.

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
- **Acceptance pending:** design approval; #33 financial ledger contract;
  real persisted idempotency, cancellation, mobile/desktop UI and production
  verification. Until then use a draft PR, no merge/deploy/Issue closure.
