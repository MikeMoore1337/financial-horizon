import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {planVerifiedLegacyImportCandidate} from '../src/cloud/legacy-import-manifest-candidate.mjs';

const USER = 'a'.repeat(32);
const ACCOUNT = 'account:' + USER;
const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const consent = () => ({
  externalEncryptedBackupVerified: true,
  confirmedTargetAccount: true,
  previewRequested: true,
});
const target = (changes = {}) => ({
  accountScope: ACCOUNT, profileId: PROFILE,
  serverRevision: 0, hasRemoteRecords: false, ...changes,
});
const verified = (snapshot, changes = {}) => ({
  scope: ACCOUNT,
  sourceKey: 'account-state-v2:' + USER,
  sourceRevision: snapshot.version === 2 ? snapshot.revision : 0,
  snapshot, backupVersion: 1, ...changes,
});
const plan = (input = {}) => planVerifiedLegacyImportCandidate({
  verified: verified(createSampleState()),
  target: target(), consent: consent(),
  signal: new AbortController().signal,
  ...input,
});
const expectHold = (result) => assert.rejects(result, /IMPORT_HOLD:/);

test('v2 preview enumerates actual source without changing or posting money', async () => {
  const source = createSampleState();
  const original = structuredClone(source);
  const result = await plan({verified: verified(source)});
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'PREVIEW_ONLY');
  assert.equal(result.sourceScope, ACCOUNT);
  assert.equal(result.targetScope, ACCOUNT);
  assert.equal(result.targetProfileId, PROFILE);
  assert.equal(result.sourceVersion, 2);
  assert.equal(result.sourceRevision, 0);
  assert.equal(result.expectedServerRevision, 0);
  assert.equal(result.counts.entries, source.entries.length);
  assert.equal(result.counts.loans, source.loans.length);
  assert.equal(result.counts.settlements, 0);
  assert.equal(result.counts.loanPayments, 0);
  assert.equal(result.recordCount, source.entries.length + source.loans.length);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.plannedAccounts, []);
  assert.deepEqual(result.plannedLedgerPostings, []);
  assert.equal(result.requiresExplicitOpeningBalances, true);
  assert.equal(result.sendAllowed, false);
  assert.equal(result.originalPreserved, true);
  assert.deepEqual(source, original);
  assert.equal(Object.isFrozen(result), true);
});

test('v1 compatible backup requires no invented revision or opening balance', async () => {
  const source = createSampleState();
  source.version = 1;
  delete source.revision;
  const before = structuredClone(source);
  const result = await plan({verified: verified(source)});
  assert.equal(result.sourceVersion, 1);
  assert.equal(result.sourceRevision, 0);
  assert.equal(result.recordCount, source.entries.length + source.loans.length);
  assert.deepEqual(result.plannedLedgerPostings, []);
  assert.deepEqual(result.plannedAccounts, []);
  assert.deepEqual(source, before);
});

test('canonical fingerprint stable across object key order, changes with finance amount', async () => {
  const source = createSampleState();
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  const a = await plan({verified: verified(source)});
  const b = await plan({verified: verified(reordered)});
  assert.equal(a.sourceSha256, b.sourceSha256);
  const changed = structuredClone(source);
  changed.entries[0].amountCents += 1;
  const c = await plan({verified: verified(changed)});
  assert.notEqual(a.sourceSha256, c.sourceSha256);
});

test('existing server records force explicit conflict decision and no automatic merge', async () => {
  const preview = await plan({target: target({serverRevision: 4, hasRemoteRecords: true})});
  assert.equal(preview.status, 'NEEDS_CONFLICT_DECISION');
  assert.equal(preview.expectedServerRevision, 4);
  assert.equal(preview.sendAllowed, false);
  assert.deepEqual(preview.plannedLedgerPostings, []);
});

test('guest transfer requires separate explicit opt-in, keeps old guest scope', async () => {
  const source = createSampleState();
  const selected = verified(source, {scope: 'guest:synthetic-guest-77', sourceKey: 'state'});
  await expectHold(plan({verified: selected}));
  const result = await plan({verified: selected, consent: {...consent(), explicitGuestTransfer: true}});
  assert.equal(result.sourceScope, selected.scope);
  assert.equal(result.targetScope, ACCOUNT);
  assert.equal(result.sendAllowed, false);
});

test('account data never cross-copies to another authenticated user', async () => {
  const other = 'account:' + 'b'.repeat(32);
  const original = createSampleState();
  await expectHold(plan({verified: verified(original), target: target({accountScope: other})}));
  await expectHold(plan({verified: verified(original),
    target: target({profileId: 'broken'})}));
  await expectHold(plan({verified: verified(original),
    target: target({serverRevision: -1})}));
});

test('missing consent, backup, wrong revision and inactive session fail closed', async () => {
  const source = createSampleState();
  for (const changed of [
    {consent: {...consent(), externalEncryptedBackupVerified: false}},
    {consent: {...consent(), confirmedTargetAccount: false}},
    {consent: {...consent(), previewRequested: false}},
    {verified: verified(source, {backupVersion: 2})},
    {verified: verified(source, {sourceRevision: 99})},
  ]) await expectHold(plan(changed));
  const controller = new AbortController();
  controller.abort();
  await expectHold(plan({signal: controller.signal}));
});

test('rejects duplicate source IDs, corrupted money and unsafe extra properties', async () => {
  const duplicate = createSampleState();
  duplicate.entries.push(structuredClone(duplicate.entries[0]));
  await expectHold(plan({verified: verified(duplicate)}));
  const malformed = createSampleState();
  malformed.entries[0].amountCents = 1.5;
  await expectHold(plan({verified: verified(malformed)}));
  const poisoned = createSampleState();
  poisoned.settings = JSON.parse('{"currency":"RUB","__proto__":{"admin":true}}');
  await expectHold(plan({verified: verified(poisoned)}));
});

test('rejected previews do not cause network requests or browser storage writes', async () => {
  const source = createSampleState();
  const originalFetch = globalThis.fetch;
  const originalIndexedDB = globalThis.indexedDB;
  let networkCalled = 0;
  let storageCalled = 0;
  globalThis.fetch = () => {networkCalled++; throw Error('Unexpected network');};
  globalThis.indexedDB = {open() {storageCalled++; throw Error('Unexpected IDB');}};
  try {
    await plan({verified: verified(source)});
    await expectHold(plan({target: target({accountScope: 'account:' + 'b'.repeat(32)})}));
    assert.equal(networkCalled, 0);
    assert.equal(storageCalled, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIndexedDB;
  }
});
