# Issue #190: temporary dev-only npm audit exception

**Status: removed.** GitHub withdrew [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) on 18 November 2026. On 20 November 2026 a clean installation and the native `npm audit --audit-level=high` reported zero vulnerabilities. `audit:deps` again runs that command directly; the exception and its dedicated tests have been removed. This is an advisory withdrawal, not a patched picomatch release.

## Historical record

**Approval:** repository owner, 18 November 2026. **Expires:** 25 November 2026 23:59:59 UTC.
This is not a security fix. See [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366.

A high-severity ReDoS vulnerability is reported in `picomatch <=4.0.7` when matching attacker-controlled extended glob patterns. The locked package `picomatch@4.0.7` is dev-only in the Vite/Vitest/ESLint toolchain. No patched npm release was available on the approval date. The production backend does not install npm dependencies. This exception does **not** assert the vulnerability is harmless.

The former `npm run audit:deps` wrapper ran a real `npm audit --audit-level=high --json` and only exempted the advisory when every elevated finding propagated through the eight explicitly listed dev-only packages. It checked the full parent `via` graph, exact advisory URL, version, lockfile dev-only markers, severity totals and npm exit status. Other high or critical findings, registry errors, changed dependency paths and expiry blocked CI.

No other lint, test, CodeQL, dependency, PostgreSQL or production-deploy gates are changed. This is scoped to the short-lived release of [#6](https://github.com/MikeMoore1337/financial-horizon/issues/6).

The original exit strategy was to remove the wrapper and restore the standard audit when a verified fix became available. The advisory withdrawal instead enabled that restoration without a dependency update.
