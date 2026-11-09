# #34/#67/#68 - HTTP v1 replay ACK / paginated delta shape guard (INACTIVE)

**Status:** isolated negative-regression candidate, not an authenticated server verifier, not a production proof, and not an IndexedDB migration. No imports from active PWA.

## Contract defect being constrained

At #67 PR #100 HEAD `de4da1d75e93649e9cfdada06f10273ee8cccd4e`, v1 `Delta.changes[]` carries `revision, ordinal, kind, entity_id, entity_revision, payload`, but **no mutation UUID or canonical request SHA-256**. The server's stored `CommandAck` carries `client_mutation_id, revision, replayed, changes`. The inactive #133 local persistence primitive instead accepts caller-injected `revisions[].commands[{mutationId,fingerprint}]`; inventing these from a delta cursor or HTTP 200 alone would be unsafe.

`checkV1AckDeltaShape()` only compares a replayed-or-original v1 `CommandAck` against **the entire revision's exact change events** from an uninterrupted series of v1 delta pages. It fails closed on mismatched UUID, wrong/schema-extra fields, partial pages, ordinal gaps, duplicate/missing events, altered payload and moving `to_revision` high-water mark. This prevents a naïve caller from treating `Delta.to_revision` as the committed cursor while `has_more=true`; only `next_since_revision` names the page boundary. It returns only `MATCHED_STRUCTURALLY` or `RECOVERY_HOLD`. **It never creates an applied proof, edits a queue, calculates a server fingerprint, encrypts records, or writes IndexedDB.**

### Mandatory upstream trust gates not supplied by this candidate

1. #67 authenticates current session/profile and produces durable SQL idempotency receipt. After lost HTTP response, resend **exact** original command with unchanged UUID, Idempotency-Key, byte-equivalent body, strong If-Match/base_revision and headers; no new UUID or changing preconditions. The Python server dedupe hash is not interchangeable with ordinary JS JSON.stringify digest. Binding of receipt to source request/profile/session must be tested against real FastAPI/PostgreSQL.
2. #68 validates authenticated response provenance and full financial schema, strict integer-minor-unit invariants, complete snapshot 206 pagination under revision pinning (restart on 412), 410 snapshot recovery, and strict per-profile contiguous change stream. The current candidate checks shape of supplied JSON **not transport identity**, meaning a malicious caller could forge mutually consistent ACK and changes. A structural match must therefore **not** be passed as `applied:true` to #133.
3. #68/#69 provide a functioning historical explicit-v1 **and versionless** cached writer fence before final re-read of legacy state and every `pending/sending/conflict` outbox row, cross-tab scope/generation/epoch isolation, durable single commit marker and migration journal; abort/rollback without losing the original UUID/fingerprint or offline operations. ADR-0065's separate new database alone does not stop writers in legacy `financial-horizon-browser-v1`.
4. #69 independent external encrypted backup **physically restored**, explicit user consent and approved unlock visuals; #70 full real-db/crash/browser-restart/physical iPhone Safari acceptance, human AppSec sign-off, and exact prod SHA + rollback evidence. No consent to delete legacy plaintext exists.

## Coverage / limits

Node tests check high-watermark, missing pages, revision/ordinal integrity and mismatched ACK/payload. Native Chromium and WebKit E2E only import the isolated checker, simulate lost-response replay and browser reload; they do **not** connect to finance API, perform a process crash or assert real on-device encryption. There is no code path to the active Service Worker, IndexedDB, accounts, PostgreSQL, auth or deployment.

**Current decision:** `RECOVERY_HOLD` for untrusted/incomplete v1 server evidence. Issue #34 OPEN; encryption cutover, legacy deletion, server/cloud activation and production switch NO_GO.
