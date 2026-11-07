# Frontend build, validation and rollback

Financial Horizon builds two production entry points with Vite: `index.html` and `account.html`. The repository still contains the original JavaScript modules; React is deliberately outside Issue #71.

## Supported toolchain

- Node.js 24 and the committed `package-lock.json`.
- `npm ci` to restore exactly pinned dependencies (do not use `npm install` during production deployment).
- `npm run lint && npm run typecheck && npm run format:check`.
- `npm test && npm run build && npm run test:build && npm run audit:deps`.
- `npm run test:e2e` for real Chromium and WebKit, FastAPI, SQLite, IndexedDB and Service Worker. Only the synthetic Turnstile challenge is substituted.
- `npm run dev` for local preview and `npm run preview` to serve the Vite production artifacts. The actual auth API is a separate FastAPI service.

TypeScript strict mode covers the initial finance state and API type contracts and the state migration implementation. The existing financial operations remain JavaScript. Money in storage is represented by integer minor currency units (kopecks), and the IndexedDB schema remains unchanged. Do not treat these TypeScript types as server-side validation or as a new cloud-sync contract.

## Production artifact

Publish **only the contents of `dist/`**, never the repository root, `backend/`, local configuration, `.env` files, `node_modules/` or test files. The two HTML files load Vite-hashed JS and CSS from `/assets/built/`. The prepaint theme bootstrap stays as an unchanged classic script to preserve the iOS status-bar behavior without CSP relaxation. Static branding and the manifest remain locally served.

Vite generates the release Service Worker at `dist/sw.js` using the reviewed original `sw.js` fetch/cache policy, a content-addressed shell name and the actual emitted asset list. Copies of the old nonhashed public modules remain inside `dist/` intentionally: browsers with an already installed legacy Service Worker can still finish installation and load old tabs while upgrading. The legacy copies are **not** the new HTML entry points.

The Service Worker does not intercept `/api/` and never precaches credentials, tokens or private financial responses. An offline guest can reopen the cached shell. Authenticated offline account behavior is limited by the existing auth session policy; this release does not implement cloud sync.

## Atomic static deployment

On the authorized static-host VPS, identify the exact CI-passing merge SHA and the previous `current` symlink target. Build in a clean temporary checkout of that SHA using `npm ci`, `npm run build` and `npm run test:build`. Stage `dist/` in a **new** immutable release directory. Validate file counts and local asset references before changing `current`.

Use a temporary symlink plus atomic rename to switch `current` to the new release, without changing the Caddy auth reverse proxy, certificates or independent FastAPI/SQLite service. Retain the prior release. Verify HTTPS status, CSP, hashed JS/CSS URLs, both HTML routes, `/sw.js` content and the published commit receipt. Real browser smoke (guest CRUD, account flow, offline/upgrade) is required before declaring the release accepted. Never test destructive operations with real user accounts.

## Rollback without financial data loss

If postdeployment smoke fails, atomically restore the **previous** static symlink target, and confirm both pages, HTTPS and auth API. Do not delete or rewrite IndexedDB, CacheStorage broadly, auth SQLite or user financial records. The unchanged version-2 finance payload is supported by both builds. As with any Service Worker update, allow the browser to fetch and activate the previous `/sw.js` on its next online visit. Confirm both upgrade and rollback paths against synthetic browser profiles before releasing.

The old release must stay on disk until the rollback window is closed. A clean Git checkout and green CI alone do not prove production rollout.
