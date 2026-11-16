import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {encryptBackup} from '../backup.js';
import {verifySavedFinancialBackupReadOnly} from '../src/cloud/read-only-backup-verification.mjs';

const password = 'synthetic-backup-password-2026';

test('saved AES-GCM file authenticates and matches local scope with zero network/storage effects', async () => {
  const current = createSampleState();
  const original = structuredClone(current);
  const backupText = await encryptBackup(current, password);
  const oldFetch = globalThis.fetch;
  const oldDb = globalThis.indexedDB;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw Error('Forbidden network'); };
  globalThis.indexedDB = {open() { calls++; throw Error('Forbidden IndexedDB'); }};
  try {
    const result = await verifySavedFinancialBackupReadOnly({
      backupText, password, currentSnapshot: current,
    });
    assert.equal(result.status, 'BACKUP_MATCHES_CURRENT');
    assert.equal(result.authenticatedDecryption, true);
    assert.equal(result.validFinancialSchema, true);
    assert.equal(result.matchesCurrent, true);
    assert.equal(result.noWritePerformed, true);
    assert.equal(result.recordCounts.entries, current.entries.length);
    assert.equal(result.recordCounts.loans, current.loans.length);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.recordCounts), true);
    assert.deepEqual(current, original);
    assert.equal(calls, 0);
    const publicReceipt = JSON.stringify(result);
    assert(!publicReceipt.includes(password));
    assert(!publicReceipt.includes(current.entries[0].title));
    assert(!publicReceipt.includes(String(current.entries[0].amountCents)));
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.indexedDB = oldDb;
  }
});

test('valid older encrypted file is reported as different, never silently merged', async () => {
  const archived = createSampleState();
  const backupText = await encryptBackup(archived, password);
  const current = structuredClone(archived);
  current.entries[0].amountCents += 100;
  const before = structuredClone(current);
  const result = await verifySavedFinancialBackupReadOnly({
    backupText, password, currentSnapshot: current,
  });
  assert.equal(result.status, 'BACKUP_VALID_BUT_DIFFERENT');
  assert.equal(result.authenticatedDecryption, true);
  assert.equal(result.matchesCurrent, false);
  assert.deepEqual(current, before);
});

test('v1 encrypted backup can be checked with unchanged legacy state', async () => {
  const legacy = createSampleState();
  legacy.version = 1;
  delete legacy.revision;
  const backupText = await encryptBackup(legacy, password);
  const result = await verifySavedFinancialBackupReadOnly({
    backupText, password, currentSnapshot: structuredClone(legacy),
  });
  assert.equal(result.status, 'BACKUP_MATCHES_CURRENT');
});

test('wrong password, corrupt authentication tag, invalid format and oversized file fail closed', async () => {
  const current = createSampleState();
  const text = await encryptBackup(current, password);
  const tampered = JSON.parse(text);
  tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') +
    tampered.ciphertext.slice(1);
  const invalid = [
    {backupText:text, password:'incorrect-password-2026'},
    {backupText:JSON.stringify(tampered), password},
    {backupText:'{"format":"plain"}',password},
    {backupText:'x'.repeat(8_000_001),password},
    {backupText:text,password:'short'},
  ];
  for (const change of invalid) {
    await assert.rejects(verifySavedFinancialBackupReadOnly({
      backupText:text,password,currentSnapshot:current,...change,
    }));
  }
});
