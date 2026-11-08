import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareLocalBankCsv } from '../scripts/compare-bank-loan.mjs';

const script = resolve('scripts/compare-bank-loan.mjs');
const terms = {
  principalCents: 1_000_000,
  startDate: '2026-01-01',
  firstDueDate: '2026-02-01',
  termMonths: 2,
  annualRateMicroPercent: 12_000_000,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  maxExtensionMonths: 0,
};
const reference = [
  'Дата;Платёж;Проценты;Основной долг;Остаток',
  '01.02.2026;5074,10;101,92;4972,18;5027,82',
  '01.03.2026;5074,10;46,28;5027,82;0,00',
].join('\n');

function contract(extra = {}) {
  return { schemaVersion: 1, terms, events: [], options: { mode: 'plan' }, ...extra };
}
async function withLocalFiles(t, manifest, csv) {
  const dir = await mkdtemp(join(tmpdir(), 'fh39-synthetic-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const jsonPath = join(dir, 'contract.json');
  const csvPath = join(dir, 'bank.csv');
  await writeFile(jsonPath, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(csvPath, csv, { mode: 0o600 });
  return [jsonPath, csvPath];
}

test('local CLI: fully specified two-payment synthetic bank reference matches to the cent', async t => {
  const args = await withLocalFiles(t, contract(), reference);
  const processResult = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' });
  assert.equal(processResult.status, 0, processResult.stderr);
  const data = JSON.parse(processResult.stdout);
  assert.deepEqual({
    calculatedRows: data.calculatedRows,
    importedRows: data.importedRows,
    mismatchedRows: data.mismatchedRows,
    comparisonComplete: data.comparisonComplete,
    arithmeticExactMatch: data.arithmeticExactMatch,
    bankParityVerified: data.bankParityVerified,
  }, {
    calculatedRows: 2, importedRows: 2, mismatchedRows: 0,
    comparisonComplete: true, arithmeticExactMatch: true,
    bankParityVerified: false,
  });
  assert.doesNotMatch(processResult.stdout, /5074[,.]10|5027[,.]82|MikeMoore/i);
});

test('local CLI: missing bank interest and principal must not claim exact parity', async t => {
  const partial = 'Date;Payment;Balance\n2026-02-01;5074,10;5027,82\n2026-03-01;5074,10;0\n';
  const args = await withLocalFiles(t, contract(), partial);
  const result = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const data = JSON.parse(result.stdout);
  assert.equal(data.matchingKnownFields, true);
  assert.equal(data.comparisonComplete, false);
  assert.equal(data.arithmeticExactMatch, false);
  assert.equal(data.missingBreakdownRows, 2);
  assert.equal(data.bankParityVerified, false);
});

test('local CLI: detects one-kopeck difference without echoing raw bank data', async t => {
  const wrong = reference.replace('5074,10;46,28', '5074,11;46,28');
  const args = await withLocalFiles(t, contract(), wrong);
  const result = spawnSync(process.execPath, [script, ...args, '--json', '--details'],
    { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const data = JSON.parse(result.stdout);
  assert.equal(data.mismatchedRows, 1);
  assert.equal(data.differences.length, 1);
  assert.equal(data.differences[0].period, 2);
  assert.equal(data.differences[0].amountDeltaCents, -1);
  assert.equal(data.arithmeticExactMatch, false);
  assert.doesNotMatch(result.stdout, /5074,11|01\.03\.2026|bank\.csv/);
});

test('local CLI: reports fees as unallocated without inventing principal', () => {
  const csv = reference.replace('5074,10;101,92', '5074,60;101,92');
  const result = compareLocalBankCsv(contract(), csv, true);
  assert.equal(result.unallocatedBankRows, 1);
  assert.equal(result.mismatchedRows, 1);
  assert.equal(result.differences[0].bankUnallocatedCents, 50);
  assert.equal(result.arithmeticExactMatch, false);
});

test('local CLI: actual payments never become part of plan cash movements', () => {
  const withEvent = contract({
    events: [{ type: 'payment', paymentKind: 'regular',
      date: '2026-02-01', id: 'test-payment', amountCents: 507_410 }],
  });
  const result = compareLocalBankCsv(withEvent, reference);
  assert.equal(result.factualPaymentsIgnored, 1);
  assert.equal(result.arithmeticExactMatch, true);
});

test('local CLI: rejects unsafe input or malformed rows without leaking source text', async t => {
  const secret = 'PRIVATE_SYNTHETIC_SECRET';
  const badCsv = 'Date;Payment;Balance\n' + secret + ';100,00;0\n';
  const args = await withLocalFiles(t, contract(), badCsv);
  const run = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Ошибка:/);
  assert.doesNotMatch(run.stderr + run.stdout, new RegExp(secret));
  const unexpected = spawnSync(process.execPath, [script, ...args, '--remote-upload'],
    { encoding: 'utf8' });
  assert.equal(unexpected.status, 1);
  assert.doesNotMatch(unexpected.stderr + unexpected.stdout, new RegExp(secret));
});

test('local CLI: rejects unknown schema and oversized CSV', async t => {
  assert.throws(() => compareLocalBankCsv({ ...contract(), schemaVersion: 2 }, reference),
    /versioned loan contract/);
  assert.throws(() => compareLocalBankCsv(contract({ events: {} }), reference),
    /events must be an array/);
  const args = await withLocalFiles(t, contract(), reference + '\n'.repeat(1024 * 1024 + 1));
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Ошибка:/);
});


test('local CLI: rejects an unwritten FIFO promptly rather than blocking on open', async t => {
  if (process.platform === 'win32') return t.skip('POSIX FIFO test only');
  const dir = await mkdtemp(join(tmpdir(), 'fh39-fifo-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'terms.json');
  const pipe = join(dir, 'bank.csv');
  await writeFile(manifest, JSON.stringify(contract()), { mode: 0o600 });
  const mk = spawnSync('mkfifo', [pipe], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);
  const call = spawnSync(process.execPath, [script, manifest, pipe, '--json'],
    { encoding: 'utf8', timeout: 3_000 });
  assert.equal(call.error, undefined, String(call.error));
  assert.equal(call.status, 1);
  assert.match(call.stderr, /Ошибка:/);
});
