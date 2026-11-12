import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {encryptBackup, decryptBackup} from '../backup.js';
import {migrateState} from '../state-migrations.js';
import {createLocalKeyset} from '../src/security/local-vault.ts';

test('legacy encrypted backup v1 restores before independent local encryption', async () => {
  const state = createSampleState();
  const legacy = structuredClone(state);
  legacy.version = 1;
  delete legacy.revision;
  const backup = await encryptBackup(legacy, 'legacy backup password for test');
  assert.equal(JSON.parse(backup).version, 1);
  const restored = await decryptBackup(backup, 'legacy backup password for test');
  const migrated = migrateState(restored);
  const scope = 'account:' + 'a'.repeat(32);
  const {vault} = await createLocalKeyset(scope, 'separate local passphrase for test');
  const expected = {kind: 'snapshot', recordId: 'state', schemaVersion: 2, revision: migrated.revision};
  const encrypted = await vault.encrypt(migrated, expected);
  assert.deepEqual(await vault.decrypt(encrypted, expected), migrated);
  assert.deepEqual(legacy, restored, 'legacy backup must remain untouched');
  assert.equal(JSON.stringify(encrypted).includes(legacy.entries[0].title), false);
});
