import test from 'node:test';
import assert from 'node:assert/strict';
import { ADVISORY, EXPIRES_AT, evaluateAuditReport, validateAuditExit } from '../scripts/audit-dependencies.mjs';

const AFFECTED = [
  'picomatch', 'fdir', 'tinyglobby', '@typescript-eslint/typescript-estree',
  '@typescript-eslint/parser', 'vite', '@vitejs/plugin-react', 'vitest',
];
const PARENT = {
  fdir: 'picomatch',
  tinyglobby: 'fdir',
  '@typescript-eslint/typescript-estree': 'tinyglobby',
  '@typescript-eslint/parser': '@typescript-eslint/typescript-estree',
  vite: 'picomatch',
  '@vitejs/plugin-react': 'vite',
  vitest: 'vite',
};
function fixture() {
  const vulnerabilities = Object.fromEntries(AFFECTED.map((name) => [name, {
    name,
    severity: 'high',
    via: name === 'picomatch' ? [{ name, severity: 'high',
      url: 'https://github.com/advisories/' + ADVISORY }] : [PARENT[name]],
    nodes: ['node_modules/' + name],
  }]));
  const packages = Object.fromEntries(AFFECTED.map((name) =>
    ['node_modules/' + name, { dev: true, version: name === 'picomatch' ? '4.0.7' : '1.0.0' }],
  ));
  packages[''] = { dependencies: { react: '19.3.1' } };
  return {
    report: { auditReportVersion: 2, vulnerabilities,
      metadata: { vulnerabilities: { high: AFFECTED.length, critical: 0 } } },
    lock: { packages },
  };
}
const BEFORE_EXPIRY = Date.parse('2026-11-18T12:00:00Z');

test('clean audit passes even after exception expiry', () => {
  const { report, lock } = fixture();
  report.vulnerabilities = {};
  report.metadata.vulnerabilities.high = 0;
  assert.deepEqual(validateAuditExit(report, lock, 0, Date.parse(EXPIRES_AT) + 1),
    { status: 'clean', suppressed: 0 });
});

test('only the exact dev-only GHSA propagation is temporarily exempted', () => {
  const { report, lock } = fixture();
  assert.deepEqual(validateAuditExit(report, lock, 1, BEFORE_EXPIRY),
    { status: 'temporary-exception', suppressed: 8 });
});

test('exception fails closed after its deadline', () => {
  const { report, lock } = fixture();
  assert.throws(() => evaluateAuditReport(report, lock, Date.parse(EXPIRES_AT) + 1), /expired/);
});

test('a second advisory at the root never inherits the exception', () => {
  const { report, lock } = fixture();
  report.vulnerabilities.picomatch.via.push({ name: 'picomatch', severity: 'high',
    url: 'https://github.com/advisories/GHSA-other' });
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /unapproved/);
});

test('critical advisory is never exempted', () => {
  const { report, lock } = fixture();
  report.vulnerabilities.picomatch.severity = 'critical';
  report.metadata.vulnerabilities.high--;
  report.metadata.vulnerabilities.critical++;
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /critical/);
});

test('new unrelated high advisory fails closed', () => {
  const { report, lock } = fixture();
  report.vulnerabilities['malicious-new-dep'] = {
    name: 'malicious-new-dep', severity: 'high', via: ['picomatch'],
    nodes: ['node_modules/malicious-new-dep'],
  };
  lock.packages['node_modules/malicious-new-dep'] = { dev: true };
  report.metadata.vulnerabilities.high++;
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /unapproved/);
});

test('production dependency cannot be excepted', () => {
  const { report, lock } = fixture();
  lock.packages['node_modules/vite'].dev = false;
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /production dependency/);
});

test('changed picomatch version cannot retain the exception', () => {
  const { report, lock } = fixture();
  lock.packages['node_modules/picomatch'].version = '4.0.8';
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /exact dev-only/);
});

test('missing or mismatched npm audit metadata blocks release', () => {
  const { report, lock } = fixture();
  report.metadata.vulnerabilities.high = 0;
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /severity totals mismatch/);
});

test('failed npm audit without high advisory is not silently ignored', () => {
  const { report, lock } = fixture();
  report.vulnerabilities = {};
  report.metadata.vulnerabilities.high = 0;
  assert.throws(() => validateAuditExit(report, lock, 1, BEFORE_EXPIRY), /without reportable/);
});

test('unknown npm exit and malformed advisory graph are rejected', () => {
  const { report, lock } = fixture();
  assert.throws(() => validateAuditExit(report, lock, 2, BEFORE_EXPIRY), /unexpectedly/);
  report.vulnerabilities.vitest.via = ['vitest'];
  assert.throws(() => evaluateAuditReport(report, lock, BEFORE_EXPIRY), /unapproved/);
});
