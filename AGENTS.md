# Financial Horizon - repository agent instructions

## Scope and source of truth

Financial Horizon is a browser-based personal finance PWA with a JavaScript frontend, IndexedDB-based local financial records, and a separate FastAPI email-auth service under `backend/fh_email_auth/`.

For each task, follow the current user request, linked GitHub Issue and accepted design, actual source and tests, then these instructions. Inspect the latest `main` before starting; do not assume a feature described in a proposal is already deployed. Keep changes minimal, task-scoped and compatible with the existing architecture. Do not introduce a new framework or paid service without explicit approval.

## Language and user-facing content

- Keep agent instructions, reusable skills and machine-directed prompts in English.
- Preserve the language of existing human-facing documentation; do not translate README, guides, help text or user content as part of an agent-instruction task.
- The application UI, including navigation, errors, accessibility text, empty states and notifications, is Russian-language. Preserve exact technical identifiers, API fields, commands and file paths.
- Communicate with the repository owner in Russian unless explicitly requested otherwise.

## Financial data and storage safety

- Treat financial records, imported spreadsheets, backups, account identities and authentication secrets as sensitive. Never commit real user data, credentials, production configuration, database files or private screenshots.
- Financial records currently live in browser IndexedDB. Email login is **not** cross-device financial-data synchronization; do not imply that it is.
- Preserve account-scoped and guest-scoped storage boundaries, logout behavior, and explicit account migration. Never silently delete, overwrite, merge or upload financial records.
- Make schema/data migrations backward-compatible, versioned where required and tested for existing IndexedDB data. Preserve encrypted export/import and explicit destructive-action confirmation.
- Keep the Service Worker and offline cache from storing private financial responses or secrets. Treat browser storage isolation as different from at-rest encryption; do not claim otherwise.

## Authentication and security

- The email-auth backend is an independent service, not Your Fitness Coach SSO. Keep its users, secrets and database separate.
- Public registration must remain disabled until the production prerequisites and security review in `docs/EMAIL_AUTH_OPERATIONS.md` are actually satisfied. Do not flip a feature flag as a shortcut.
- Preserve server-side Turnstile verification, rate limiting, host/origin validation, secure cookies, password hashing, one-time verification/recovery flows and session revocation.
- Do not expose secrets in JavaScript, logs, tests, issues, PR descriptions or agent reports. Follow `deploy/.env.example` for variable names only; never copy production values.
- Fail closed on authentication and authorization errors. Never weaken CSP, TLS, origin checks or filesystem/database permissions merely to make tests pass.

## Development and verification

- Frontend modules and tests are at the repository root and in `tests/`. The Python auth service and tests live under `backend/`.
- Run relevant checks for affected code. The repository's existing CI workflow is `.github/workflows/tests.yml`:
  - `npm test` for Node.js unit tests;
  - `node --check app.js && node --check account.js && node --check sw.js` for JavaScript syntax;
  - `python -m pytest -q backend/tests/` and `python -m compileall -q backend/fh_email_auth` for backend changes;
  - `python -m bandit -q -r backend/fh_email_auth` for backend security checks when available;
  - `npm run test:e2e` for real-browser Playwright tests after preparing documented dependencies.
- Do not replace real browser/IndexedDB/Service Worker E2E coverage with mocked tests while claiming equivalent evidence.
- Record what actually ran, the exact ref/SHA and outcomes. Distinguish local checks, GitHub CI, browser acceptance and production behavior; never claim a PASS for unexecuted checks.
- Protect existing accessibility, mobile PWA safe areas, both approved color themes and desktop layout. For UX changes, capture real before/after evidence and respect owner visual approval.

## GitHub delivery and production

- Implement each task on a dedicated branch from current `main`; avoid modifying unrelated work or open PRs. Open a focused PR against `main`.
- Do not bypass required CI, independent review, security gates or owner approvals. An agent instruction is not deployment authorization.
- When changes affect production, validate the exact commit actually deployed and confirm rollback readiness before reporting production success.
- Do not create or alter external integration credentials, deploy services or change user financial data as part of documentation maintenance.
