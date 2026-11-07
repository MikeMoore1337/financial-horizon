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

## Verifying an exact production release

The historical production smoke script previously compared pre-Vite JavaScript sources with published bytes. That is invalid once Vite bundles and hashes the entry points. The updated smoke verifies **every file** in the built `dist/`, the immutable checkout SHA, and read-only HTTPS/CSP/auth/manifest responses. From a **clean checkout of the exact deployed merge SHA**, run:

```sh
npm ci
npm run build
npm run test:build
node tests/e2e/production-smoke.mjs https://fin-horizon.mikemoore.top <40-character-merge-SHA>
```

The smoke performs only public GET requests and does not read financial records or credentials. It must not be treated as a replacement for real browser/IndexedDB/PWA E2E. The deployed release directory or signed deployment receipt must independently identify the same commit.

**HTML cache-control is a release safety condition:** both `/index.html` and `/account.html` must be served with `Cache-Control: no-store` or `no-cache` so an outdated account page cannot reference JavaScript hashes removed in the next release. `/sw.js` and `/manifest.webmanifest` must also be revalidated. The production Caddy site uses a static-shell matcher containing all four routes; any alternative Nginx deployment must preserve equivalent policies and existing CSP. Never cache `/api/` or session cookies.
