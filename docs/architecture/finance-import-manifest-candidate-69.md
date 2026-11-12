# Financial Horizon #69 - server import manifest staging proposal

**STATUS: UNPUBLISHED / FEATURE OFF / DOES NOT IMPORT FINANCIAL RECORDS.**

`backend/finance_db/import_manifest_candidate.py` stages only a bounded
inventory of source record IDs in the existing `finance.import_batches`
and `finance.import_record_map` tables (created by #66 migration 0001).
The module is not mounted as a FastAPI route and must never be called using
a user-supplied `profile_id` or an unauthenticated session.

## Verified protocol shape

The required manifest is an explicit `schema_version=1` object containing:

- `source_scope`: either exactly the verified FH owner's account namespace
  or a guest namespace accompanied by a separate explicit guest transfer
  confirmation
- `source_sha256`: lowercase SHA-256 fingerprint **claimed by the client**
  from a physically saved external encrypted backup; the server has not
  verified the source data or financial totals yet
- `source_revision`, `expected_server_revision` (integer, CAS)
- `external_encrypted_backup_checked=true`,
  `explicit_owner_consent=true`, `explicit_guest_transfer` flag
- At most 10,000 records with unique `(record_type,source_record_id)`.
  Types: `entries`, `loans`, `settlements`, `loanPayments`

The account identity is always derived from the verified FH session and
`VerifiedFinanceScope` server namespace, never the request body.

The service locks the profile row, requires the exact server revision, rejects
an existing financial dataset or concurrent staged import, and inserts one
RLS-protected batch with a deterministic UUID5 source-record map. The same
manifest is an idempotent replay; conflicting record IDs under the same hash
produce 409. It returns `UNVERIFIED_MANIFEST_STAGED`, NEVER `COMMITTED`.

No accounts, balances, obligations, loan payment facts, ledger transactions,
server financial revisions, old browser data or email auth records are
modified by this action. It performs no HTTP, Service Worker, PWA or disk
backup operations. The client-supplied SHA-256 claim is **not** sufficient
to authorize any financial import.

## Remaining necessary implementation

- A separately accepted and reviewed versioned server import contract that
  binds the **actual encrypted source bytes** and the deterministic record
  map to an independently validated SHA-256 and human-approved preview
- Financially correct v1/v2 mapping for planned obligations, loan schedules
  and historical payment facts; no opening balance inference, no duplicate
  settlement postings, no cross-user merges
- One SQL COMMIT for the final batch, new rows, financial revision, change
  log, durable receipt and source map, plus safe retry and failure rollback
- Real FH AuthStore session protection, owner consent, conflict UI, 409/412/
  logout/timeout, old guest vs account scope and two-device WebKit/Chromium
- Independently verified encrypted backup/restore, #66 LUKS2/PITR/RPO/RTO
  and human security QA #51/#70 before deployment

Test coverage: `backend/finance_db/tests/test_import_manifest_candidate.py`
executes on disposable PostgreSQL with FORCE RLS and two concurrent requests.
It proves idempotent **metadata staging**, not a complete source migration.

**Release decision: NO_GO.** Keep #69 OPEN. Production remains unchanged.
