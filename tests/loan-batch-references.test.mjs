import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyBankLoanReferences } from '../scripts/verify-bank-loan-references.mjs';

const cli = resolve('scripts/verify-bank-loan-references.mjs');
const first = {
  principalCents: 1_000_000, startDate: '2026-01-01',
  firstDueDate: '2026-02-01', termMonths: 2,
  annualRateMicroPercent: 12_000_000, dayCount: 'ACT/365F',
  rounding: 'HALF_UP', scheduleType: 'annuity', maxExtensionMonths: 0,
};
const second = {
  principalCents: 90_000, startDate: '2026-01-01',
  firstDueDate: '2026-02-01', termMonths: 3,
  annualRateMicroPercent: 0, dayCount: 'ACT/365F',
  rounding: 'HALF_UP', scheduleType: 'annuity', maxExtensionMonths: 0,
};
const firstBank = [
  'Дата;Платёж;Проценты;Основной долг;Остаток',
  '01.02.2026;5074,10;101,92;4972,18;5027,82',
  '01.03.2026;5074,10;46,28;5027,82;0,00',
].join('\n');
const secondBank = [
  'Date;Payment;Interest;Principal;Balance',
  '2026-02-01;300,00;0,00;300,00;600,00',
  '2026-03-01;300,00;0,00;300,00;300,00',
  '2026-04-01;300,00;0,00;300,00;0,00',
].join('\n');

async function workspace(t, bankCsvs = [firstBank, secondBank]) {
  const dir = await mkdtemp(join(tmpdir(), 'fh39-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [];
  for (const [index, terms] of [first, second].entries()) {
    const folder = 'reference-' + (index + 1);
    await mkdir(join(dir, folder));
    await writeFile(join(dir, folder, 'contract.json'),
      JSON.stringify({schemaVersion: 1, terms, options: { mode: 'plan' }}), { mode: 0o600 });
    await writeFile(join(dir, folder, 'bank.csv'), bankCsvs[index], { mode: 0o600 });
    cases.push({
      approvedForLocalAcceptance: true,
      contractFile: folder + '/contract.json',
      bankCsvFile: folder + '/bank.csv',
    });
  }
  return { dir, cases, manifestPath: join(dir, 'approved.json') };
}

async function save(data, entries = data.cases) {
  await writeFile(data.manifestPath, JSON.stringify({schemaVersion: 1, cases: entries}),
    { mode: 0o600 });
  return data.manifestPath;
}

function invoke(path) {
  return spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 10_000 });
}

test('two independent synthetic references have complete cent-level matches, not bank parity', async t => {
  const data = await workspace(t);
  const path = await save(data);
  const run = invoke(path);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    schemaVersion: 1, referencesChecked: 2, arithmeticMatches: 2,
    notExactReferences: 0, incompleteReferences: 0,
    allArithmeticExact: true, ownerAttestationOnly: true, bankParityVerified: false,
  });
  assert.doesNotMatch(run.stdout, /5074|5027|300,00|reference-|contract\.json/i);
});

test('one-kopeck bank mismatch prevents batch acceptance and reveals no bank values', async t => {
  const wrong = secondBank.replace('2026-04-01;300,00;0,00',
    '2026-04-01;300,01;0,00');
  const data = await workspace(t, [firstBank, wrong]);
  const run = invoke(await save(data));
  assert.equal(run.status, 2);
  const result = JSON.parse(run.stdout);
  assert.equal(result.arithmeticMatches, 1);
  assert.equal(result.notExactReferences, 1);
  assert.equal(result.allArithmeticExact, false);
  assert.equal(result.bankParityVerified, false);
  assert.doesNotMatch(run.stdout, /300,01|reference-/);
});

test('missing interest and principal columns never count as verified complete', async t => {
  const sparse = 'Date;Payment;Balance\n2026-02-01;300,00;600,00\n' +
    '2026-03-01;300,00;300,00\n2026-04-01;300,00;0,00\n';
  const data = await workspace(t, [firstBank, sparse]);
  const run = invoke(await save(data));
  assert.equal(run.status, 2);
  const result = JSON.parse(run.stdout);
  assert.equal(result.arithmeticMatches, 1);
  assert.equal(result.incompleteReferences, 1);
  assert.equal(result.bankParityVerified, false);
});

test('one reference, absent attestation and repeated reference are rejected', async t => {
  const data = await workspace(t);
  assert.equal(invoke(await save(data, [data.cases[0]])).status, 1);
  assert.equal(invoke(await save(data, [
    {...data.cases[0], approvedForLocalAcceptance: false}, data.cases[1],
  ])).status, 1);
  assert.equal(invoke(await save(data, [data.cases[0], data.cases[0]])).status, 1);
  await writeFile(join(data.dir, 'reference-2', 'bank.csv'), firstBank);
  assert.equal(invoke(await save(data)).status, 1);
  // Different bytes / trailing newline, but canonical bank rows are identical.
  await writeFile(join(data.dir, 'reference-2', 'bank.csv'), firstBank + '\n');
  assert.equal(invoke(await save(data)).status, 1);
});


test('symlinked parent directory outside the manifest root cannot load bank CSV', async t => {
  if (process.platform === 'win32') return t.skip('POSIX symlink regression');
  const data = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), 'fh39-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'bank.csv'), secondBank, { mode: 0o600 });
  await symlink(outside, join(data.dir, 'linked'), 'dir');
  const entries = [data.cases[0], {...data.cases[1], bankCsvFile: 'linked/bank.csv'}];
  const run = invoke(await save(data, entries));
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr + run.stdout, /linked|fh39-outside-|bank\.csv/);
});

test('traversal and malformed sensitive inputs fail closed without source leakage', async t => {
  const data = await workspace(t);
  const entries = [{...data.cases[0], bankCsvFile: '../private-bank.csv'}, data.cases[1]];
  let run = invoke(await save(data, entries));
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr + run.stdout, /private-bank/);
  const secret = 'SENSITIVE_SYNTHETIC_REFERENCE';
  await writeFile(join(data.dir, 'reference-2', 'bank.csv'),
    'Date;Payment;Balance\n' + secret + ';100,00;0,00\n');
  const path = await save(data);
  run = invoke(path);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr + run.stdout, new RegExp(secret));
  await assert.rejects(() => verifyBankLoanReferences(path));
});
