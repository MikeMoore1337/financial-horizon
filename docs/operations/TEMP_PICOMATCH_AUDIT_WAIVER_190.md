# Issue #190: temporary dev-only npm audit exception

**Approval:** repository owner, 18 November 2026. **Expires:** 25 November 2026 23:59:59 UTC.
This is not a security fix. See [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366.

A high-severity ReDoS vulnerability is reported in `picomatch <=4.0.7` when matching attacker-controlled extended glob patterns. The locked package `picomatch@4.0.7` is dev-only in the Vite/Vitest/ESLint toolchain. No patched npm release was available on the approval date. The production backend does not install npm dependencies. This exception does **not** assert the vulnerability is harmless.

`npm run audit:deps` still runs a real `npm audit --audit-level=high --json`, parses the complete report and fails closed unless **every** elevated finding is the same advisory propagated through the eight explicitly listed dev-only packages. It checks the full parent `via` graph, exact advisory URL, version, lockfile dev-only markers, severity totals and npm exit status. A new advisory, critical issue, production dependency, unexpected report format, npm outage, modified graph or expired waiver fails CI. A clean audit succeeds after expiry, so upgrading to a fixed package naturally removes the exception.

No other lint, test, CodeQL, dependency, PostgreSQL or production-deploy gates are changed. This is scoped to the short-lived release of [#6](https://github.com/MikeMoore1337/financial-horizon/issues/6).

**Exit strategy:** replace the vulnerable dependency with the first verified fixed release, remove `scripts/audit-dependencies.mjs`, restore the original `npm audit --audit-level=high` command and close #190. If upstream has not patched the issue by expiry, CI intentionally blocks again; require a new explicit review and approval before any extension.
