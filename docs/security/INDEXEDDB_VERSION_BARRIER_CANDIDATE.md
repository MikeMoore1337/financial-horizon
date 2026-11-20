# IndexedDB version barrier for cached legacy writers - INACTIVE candidate (#34/#68)

**Status: security design candidate and synthetic-only QA, NOT a cutover implementation or approval.** Existing `financial-horizon-browser-v1`, its contents, the active PWA, Service Worker, auth and finance API must remain unchanged. Issue #34 remains OPEN; current finance remains plaintext.

## What the experiment establishes

The current `storage.js` opens `financial-horizon-browser-v1` with an explicit schema version `1`. A potential *future* migration coordinator could consider an **atomic non-destructive version-2 upgrade of that same database** after separately approved recovery and user-facing compatibility gates. Native IndexedDB semantics imply:

| Condition in an isolated synthetic database | Expected result | Security implication |
| --- | --- | --- |
| An old v1 connection stays open when another tab requests v2 | `blocked`; upgrade cannot complete | **NO_GO**. Old v1 code may still write. Never time out and activate encryption. |
| Old v1 handles are closed and the version-2 upgrade completes | Durable v2 schema; existing records survive if not touched | An older client explicitly calling `indexedDB.open(dbName, 1)` fails with `VersionError`. |
| An old client opens the database **without a version argument** | It can open v2, including readwrite transactions | Version bump does **not** fence this historical writer. |
| Rollback deploys a v1-only application after v2 | The old app fails to open the upgraded DB | A compatible, tested v2-aware rollback is mandatory; downgrade is not automatic. |

The test `tests/e2e/idb-version-barrier-candidate.spec.mjs` exercises only a unique throwaway `fh-e2e-idb-barrier-*` database with **synthetic** data in native Chromium and WebKit. It checks a blocked upgrade, an old writer still committing while blocked, preserved synthetic offline entries after release, a `VersionError` for explicit v1 reopen, and the **versionless bypass**. It deliberately does **not** claim that historical FH client bundles all used an explicit version.

Browser-spec behavior alone cannot establish safety of a production user migration. An app holding a v1 connection may block upgrade until the owner closes that tab; a newer worker, a third-party script or a historical bundle using a versionless open may remain writable. A version upgrade is **global to the database**, not per account, and therefore affects guests and all profiles sharing that legacy DB.

## Additional required contract before any implementation

1. Inventory authentic previously deployed JS/SW bundles and all writers, including versionless `indexedDB.open`, alternative database names, open handles and background tasks. Do not infer historical code from current `main`.
2. Preserve guest access and existing user records. Agree with #68/#69 whether a global version upgrade is acceptable, how to stop or recover on `blocked`, and how a v2-aware **rollback build** accesses legacy data without deleting or downgrading records.
3. Freeze *every* writer and reconcile the **final** source revision and every `pending/sending/conflict` entry **after** the native barrier is durable. A pre-barrier backup/candidate cannot substitute for this final comparison.
4. Pair native upgrade with crash-safe per-scope migration journal, verifiable commit marker, local fence epoch/CAS, outbox+cursor atomicity, server idempotency and 409/412 handling. DB version is not the server revision or encryption key.
5. Require approved visual unlock UX, per-scope explicit cutover consent, independently restored external encrypted backup, and separate consent for any future legacy plaintext cleanup.
6. Require archived-old-PWA Chromium/WebKit E2E, simulated old tab and BFCache, offline/restart, 2 users + guest, rollback with pending outbox, and independent security review; physical iPhone/Safari and exact deployed SHA remain separate gates.

No DB schema version, feature flag or financial data changes are authorized by this document or its synthetic experiment. A failing or blocked migration must leave plaintext source and pending commands intact, and must **not** select the encrypted source.

References: IndexedDB `versionchange`/`blocked` and stale `VersionError`: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB .
