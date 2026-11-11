# Financial Horizon #70 - independent cloud finance acceptance

**Current decision: NO_GO.** This is an evidence inventory, not a production
receipt, independent reviewer approval or authority to change an installation.

## Required release dependencies

1. **#51 real email auth acceptance**: independent human APPROVED on exact SHA,
   two distinct real inboxes with full email-change/old-email notification,
   authentic Turnstile Siteverify/replay/rate-limit/CSRF-IDOR checks. OAuth
   support is not a replacement for this requirement.
2. **#66 PostgreSQL durability**: inspected dedicated LUKS2 mount, independent
   encrypted offsite recovery, actual isolated restore, verified encrypted WAL
   / point-in-time recovery meeting RPO (target 15 minutes), measured RTO,
   filesystem capacity, connection/lock monitoring and successful rollback.
   Synthetic CI database is not production evidence.
3. **#67 payment invariants**: one money movement per verified fact,
   atomic payment fact void + append-only compensating posting,
   idempotency/replay/concurrent writes/RLS and authenticated sessions. An
   unapproved opt-in HTTP v2 candidate is not a public-ready API contract.
4. **#34/#68 offline-first sync**: real encrypted IndexedDB durable snapshot
   + cursor + outbox + applied receipt atomic CAS, two accounts x two devices
   x two tabs, logout/revoke, reconnect, old PWA, resume and crash tests.
5. **#69 migration**: physical independent encrypted v1/v2 backup, preview,
   explicit consent/account scope, deterministic source inventory, accepted
   server import transaction, collision/idempotency/timeout recovery and
   independently exercised restore of actual controlled test data.
6. **#70 delivery**: exact-SHA all-required CI, signed human security review,
   Chromium and WebKit E2E, physical iOS Safari PWA marked NOT_RUN unless
   actually tested, load/failure matrix, source/DB rollback procedure and
   verified production receipt from a restricted *backend* executor. Existing
   static-asset SSH deploy cannot attest PostgreSQL release.

## Evidence recording

The source-only inventory
`src/cloud/release-gate-candidate.mjs` lists required checks. It marks a
missing, blocked, failing, unrun or different-SHA check as NO_GO.

**Even if an untrusted JSON document claims every check PASS, the helper
returns NEEDS_EXTERNAL_ATTESTATION and never returns GO or approves
deployment.** An independent reviewer must authenticate GitHub approval
identity and exact SHA, real device/inbox test receipts, restore logs, current
production runtime and rollback separately. Recording a public link alone
is not evidence that the claimed test occurred.

Use synthetic local CI only to verify the inventory's fail-closed logic.
Never place real bank amounts, emails, OAuth tokens, keys, dumps, or other
private data in the public repository or CI artifacts.

## Required result format per release

Record the exact merged source SHA, GitHub PR and CI IDs, reviewer identity
and decision, LUKS2/WAL/backups/restore check statuses, two-user E2E matrix
and PWA browser/device matrix, a guarded deployment manifest, public
health/API smoke and a verified rollback command/result.

Until all external conditions are really met, keep Issues #33/#66/#67/#68/
#69/#70 and #51 OPEN as appropriate; new financial operations, public cloud
feature flags and backend deployment remain OFF.
