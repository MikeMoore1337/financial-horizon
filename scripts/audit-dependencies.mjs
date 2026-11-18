// #190: narrow, expiring owner-approved exception for one dev-only npm advisory.
// All other high/critical advisories still fail the dependency audit.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ADVISORY = 'GHSA-fc5q-39xc-vjpf';
export const EXPIRES_AT = '2026-11-25T23:59:59Z';
const ADVISORY_URL = 'https://github.com/advisories/' + ADVISORY;
const PINNED_VERSION = '4.0.7';
const ALLOWED_DEV_PACKAGES = new Set([
  'picomatch',
  'fdir',
  'tinyglobby',
  '@typescript-eslint/typescript-estree',
  '@typescript-eslint/parser',
  'vite',
  '@vitejs/plugin-react',
  'vitest',
]);

function deny(reason) {
  throw new Error('Dependency audit blocked: ' + reason);
}

// npm audit v2 lists one direct advisory object and propagates it through
// strings in the 'via' graph. Never waive a second advisory in that graph.
export function evaluateAuditReport(report, lock, now = Date.now()) {
  if (report?.auditReportVersion !== 2 || !report.vulnerabilities ||
      typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities) ||
      !report.metadata?.vulnerabilities || !lock?.packages) {
    deny('unrecognized npm audit / package-lock format');
  }
  const vulnerabilities = report.vulnerabilities;
  const counts = report.metadata.vulnerabilities;
  const elevated = Object.entries(vulnerabilities).filter(([, entry]) =>
    entry?.severity === 'high' || entry?.severity === 'critical',
  );
  if (counts.high !== elevated.filter(([, entry]) => entry.severity === 'high').length ||
      counts.critical !== elevated.filter(([, entry]) => entry.severity === 'critical').length) {
    deny('npm audit severity totals mismatch');
  }
  if (elevated.length === 0) return { status: 'clean', suppressed: 0 };

  if (Date.parse(EXPIRES_AT) < Number(now)) deny('temporary exception has expired');
  if (counts.critical > 0) deny('critical vulnerability is never exempted');
  const picomatch = lock.packages['node_modules/picomatch'];
  if (picomatch?.version !== PINNED_VERSION || picomatch.dev !== true ||
      Object.hasOwn(lock.packages[''].dependencies ?? {}, 'picomatch')) {
    deny('exception requires the exact dev-only picomatch version');
  }

  function matchesOnlyKnownCause(name, ancestors = new Set()) {
    if (ancestors.has(name)) return false;
    const entry = vulnerabilities[name];
    if (!entry || entry.severity !== 'high' || !ALLOWED_DEV_PACKAGES.has(name) ||
        !Array.isArray(entry.via) || entry.via.length === 0 ||
        !Array.isArray(entry.nodes) || entry.nodes.length === 0 ||
        entry.nodes.some((node) => lock.packages[node]?.dev !== true)) return false;
    if (name === 'picomatch') {
      return entry.nodes.every((node) => lock.packages[node]?.version === PINNED_VERSION) &&
        entry.via.length === 1 &&
        typeof entry.via[0] === 'object' && entry.via[0] !== null &&
        entry.via[0].name === 'picomatch' && entry.via[0].severity === 'high' &&
        entry.via[0].url === ADVISORY_URL;
    }
    const next = new Set(ancestors);
    next.add(name);
    return entry.via.every((cause) =>
      typeof cause === 'string' && matchesOnlyKnownCause(cause, next),
    );
  }

  if (!elevated.every(([name]) => matchesOnlyKnownCause(name))) {
    deny('unapproved high advisory, changed dependency path, or production dependency');
  }
  return { status: 'temporary-exception', suppressed: elevated.length };
}

export function validateAuditExit(report, lock, npmExit, now = Date.now()) {
  if (npmExit !== 0 && npmExit !== 1) deny('npm audit command failed unexpectedly');
  const result = evaluateAuditReport(report, lock, now);
  if (result.status === 'clean' && npmExit !== 0) {
    deny('npm audit returned failure without reportable high/critical advisory');
  }
  if (result.status !== 'clean' && npmExit !== 1) {
    deny('npm audit reported high vulnerabilities but exited successfully');
  }
  return result;
}

function main() {
  const audit = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['audit', '--audit-level=high', '--json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
  if (audit.error || audit.signal || (audit.status !== 0 && audit.status !== 1)) {
    deny('npm audit unavailable, timed out or returned an unexpected status');
  }
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    deny('npm audit returned invalid JSON');
  }
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const outcome = validateAuditExit(report, lock, audit.status);
  if (outcome.status === 'clean') {
    console.log('AUDIT_DEPS=PASS (no high/critical vulnerabilities)');
  } else {
    console.log('AUDIT_DEPS=PASS_WITH_SCOPED_EXCEPTION advisory=' + ADVISORY +
      ' dev_only=true affected=' + outcome.suppressed + ' expires=' + EXPIRES_AT);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
