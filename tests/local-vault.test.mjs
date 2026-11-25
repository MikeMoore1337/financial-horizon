import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalKeyset, unlockLocalKeyset, changeLocalPassphrase, rotateLocalRecoveryKey} from '../src/security/local-vault.ts';

const user1 = 'account:' + 'a'.repeat(32);
const user2 = 'account:' + 'b'.repeat(32);
const guest = 'guest:local';
const pass = 'local budget passphrase 2026';
const context = {kind: 'snapshot', recordId: 'state', schemaVersion: 2, revision: 7};
const finance = {version: 2, entries: [{id: 'id-1', title: 'СТРОГО_СЕКРЕТНО', amountCents: 1234567}], revision: 7};
const clone = v => JSON.parse(JSON.stringify(v));

// Each test uses a fresh randomly-generated keyset. No real finance or account data.
test('AES-256-GCM roundtrip and no financial plaintext in persisted envelopes', async () => {
  const {keyset, recoveryKey, vault} = await createLocalKeyset(user1, pass);
  const encrypted = await vault.encrypt(finance, context);
  assert.equal(encrypted.format, 'financial-horizon.local-record');
  assert.equal(encrypted.algorithm, 'AES-256-GCM');
  assert.equal(keyset.passphrase.kdf, 'PBKDF2-SHA256');
  assert.ok(keyset.passphrase.iterations >= 600_000);
  assert.equal(keyset.recovery.kdf, 'HKDF-SHA256');
  assert.deepEqual(await vault.decrypt(encrypted, context), finance);
  const persisted = JSON.stringify({keyset, encrypted});
  assert.ok(!persisted.includes('СТРОГО_СЕКРЕТНО'));
  assert.ok(!persisted.includes('1234567'));
  assert.ok(!persisted.includes(pass));
  assert.ok(!persisted.includes(recoveryKey));
  assert.equal(recoveryKey.length, 43);
  assert.deepEqual(await (await unlockLocalKeyset(keyset, {recoveryKey}, user1)).decrypt(encrypted, context), finance);
});

test('fresh nonce on every write and unique data encryption keys', async () => {
  const a = await createLocalKeyset(user1, pass);
  const b = await createLocalKeyset(user1, pass);
  const first = await a.vault.encrypt(finance, context);
  const second = await a.vault.encrypt(finance, context);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(a.keyset.keyId, b.keyset.keyId);
  await assert.rejects(() => b.vault.decrypt(first, context), /метаданные/);
});

test('incorrect passphrase, recovery key and missing key material fail closed', async () => {
  const created = await createLocalKeyset(user1, pass);
  await assert.rejects(() => unlockLocalKeyset(created.keyset, {passphrase: 'another wrong passphrase'}, user1), /Неверный ключ/);
  const other = await createLocalKeyset(user1, pass);
  await assert.rejects(() => unlockLocalKeyset(created.keyset, {recoveryKey: other.recoveryKey}, user1), /Неверный ключ/);
  await assert.rejects(() => unlockLocalKeyset(created.keyset, {recoveryKey: 'bad'}, user1));
  await assert.rejects(() => unlockLocalKeyset(undefined, {passphrase: pass}, user1));
});

test('ciphertext, tag and nonce integrity failure is not mistaken for success', async () => {
  const {vault} = await createLocalKeyset(user1, pass);
  const encrypted = await vault.encrypt(finance, context);
  for (const field of ['ciphertext', 'iv']) {
    const modified = clone(encrypted);
    modified[field] = (modified[field][0] === 'A' ? 'B' : 'A') + modified[field].slice(1);
    await assert.rejects(() => vault.decrypt(modified, context));
  }
  await assert.rejects(() => vault.decrypt({...encrypted, ciphertext: 'A'}, context));
});

test('all authenticated metadata binds to trusted expected record context', async () => {
  const {vault} = await createLocalKeyset(user1, pass);
  const encrypted = await vault.encrypt(finance, context);
  for (const [field, replacement] of [
    ['format', 'foreign'], ['version', 2], ['algorithm', 'AES-CBC'], ['scope', user2],
    ['keyId', 'AAAAAAAAAAAAAAAAAAAAAA'], ['kind', 'outbox'], ['recordId', 'other'],
    ['schemaVersion', 1], ['revision', 8]
  ]) await assert.rejects(() => vault.decrypt({...encrypted, [field]: replacement}, context), field);
  await assert.rejects(() => vault.decrypt(encrypted, {...context, revision: context.revision + 1}));
  await assert.rejects(() => vault.decrypt(encrypted, {...context, recordId: 'another'}));
});

test('tampered passphrase and recovery slot metadata cannot unwrap DEK', async () => {
  const {keyset, recoveryKey} = await createLocalKeyset(user1, pass);
  const variations = [
    {passphrase: {...keyset.passphrase, iterations: 1}},
    {passphrase: {...keyset.passphrase, iterations: 600_001}},
    {passphrase: {...keyset.passphrase, salt: 'AAAAAAAAAAAAAAAAAAAAAA'}},
    {passphrase: {...keyset.passphrase, iv: 'AAAAAAAAAAAAAAAA'}},
    {passphrase: {...keyset.passphrase, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}},
    {format: 'another-format'}, {version: 2}, {scope: user2}
  ];
  for (const mutation of variations) {
    await assert.rejects(() => unlockLocalKeyset({...clone(keyset), ...mutation}, {passphrase: pass}, user1));
  }
  await assert.rejects(() => unlockLocalKeyset({...clone(keyset), recovery: {...keyset.recovery, salt: 'AAAAAAAAAAAAAAAAAAAAAA'}}, {recoveryKey}, user1));
});

test('account isolation: DEK and expected scope separate two users and guest', async () => {
  const a = await createLocalKeyset(user1, pass);
  const b = await createLocalKeyset(user2, pass);
  const g = await createLocalKeyset(guest, pass);
  const encrypted = await a.vault.encrypt(finance, context);
  await assert.rejects(() => unlockLocalKeyset(a.keyset, {passphrase: pass}, user2), /другого пользователя/);
  await assert.rejects(() => unlockLocalKeyset(a.keyset, {recoveryKey: a.recoveryKey}, guest), /другого пользователя/);
  await assert.rejects(() => b.vault.decrypt(encrypted, context));
  await assert.rejects(() => g.vault.decrypt(encrypted, context));
  assert.deepEqual(await a.vault.decrypt(encrypted, context), finance);
});

test('lock/logout destroys usable vault reference; fresh unlock after restart needs a credential', async () => {
  const {vault, keyset} = await createLocalKeyset(user1, pass);
  const encrypted = await vault.encrypt(finance, context);
  vault.lock();
  vault.lock();
  assert.equal(vault.unlocked, false);
  await assert.rejects(() => vault.decrypt(encrypted, context), /заблокирован/);
  await assert.rejects(() => vault.encrypt(finance, context), /заблокирован/);
  const afterRestart = await unlockLocalKeyset(clone(keyset), {passphrase: pass}, user1);
  assert.deepEqual(await afterRestart.decrypt(clone(encrypted), context), finance);
});

test('password reset via recovery changes only wrapped DEK, keeps records readable', async () => {
  const {vault, keyset, recoveryKey} = await createLocalKeyset(user1, pass);
  const encrypted = await vault.encrypt(finance, context);
  const changed = await changeLocalPassphrase(keyset, {recoveryKey}, 'a brand new long passphrase', user1);
  assert.deepEqual(changed.recovery, keyset.recovery);
  assert.equal(changed.keyId, keyset.keyId);
  await assert.rejects(() => unlockLocalKeyset(changed, {passphrase: pass}, user1), /Неверный ключ/);
  const unlocked = await unlockLocalKeyset(changed, {passphrase: 'a brand new long passphrase'}, user1);
  assert.deepEqual(await unlocked.decrypt(encrypted, context), finance);
  assert.deepEqual(await (await unlockLocalKeyset(changed, {recoveryKey}, user1)).decrypt(encrypted, context), finance);
});

test('reject malformed scopes, short passwords, malformed context and huge payloads', async () => {
  await assert.rejects(() => createLocalKeyset('account:123', pass));
  await assert.rejects(() => createLocalKeyset(user1, 'short'));
  const {vault} = await createLocalKeyset(user1, pass);
  await assert.rejects(() => vault.encrypt(finance, {...context, revision: -1}));
  await assert.rejects(() => vault.encrypt(finance, {...context, recordId: 'private record name with spaces'}));
  await assert.rejects(() => vault.encrypt({title: 'X'.repeat(4_000_100)}, context), /слишком большая/);
});

test('offline encryption has no network dependency', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('network unavailable'); };
  try {
    const {keyset, vault} = await createLocalKeyset(guest, pass);
    const encrypted = await vault.encrypt(finance, context);
    vault.lock();
    const offlineVault = await unlockLocalKeyset(keyset, {passphrase: pass}, guest);
    assert.deepEqual(await offlineVault.decrypt(encrypted, context), finance);
  } finally {globalThis.fetch = priorFetch;}
});

test('staging and repeated migration never mutate original legacy state', async () => {
  const {vault} = await createLocalKeyset(user1, pass);
  const original = clone(finance);
  const oldStore = new Map([['state', clone(original)]]);
  // Simulate a crash BEFORE a separate, not-yet-implemented atomic IDB stage commit.
  const interrupted = await vault.encrypt(original, context);
  assert.ok(interrupted.ciphertext);
  assert.deepEqual(oldStore.get('state'), original);
  const retry = await vault.encrypt(original, context);
  assert.notEqual(retry.iv, interrupted.iv);
  assert.deepEqual(await vault.decrypt(retry, context), original);
  assert.deepEqual(oldStore.get('state'), original);
});

test('unexpected plaintext metadata fields are forbidden, not persisted by object spread', async () => {
  const {vault, keyset} = await createLocalKeyset(user1, pass);
  await assert.rejects(() => vault.encrypt(finance, {...context, title: 'UNENCRYPTED'}), /структура/);
  const protectedRecord = await vault.encrypt(finance, context);
  await assert.rejects(() => vault.decrypt({...protectedRecord, leakedTitle: 'UNENCRYPTED'}, context), /структура/);
  await assert.rejects(() => unlockLocalKeyset({...keyset, rawKey: 'UNENCRYPTED'}, {passphrase: pass}, user1), /структура/);
});

test('pending encryption and decryption reject results if lock occurs mid-operation', async () => {
  const {vault, keyset} = await createLocalKeyset(user1, pass);
  const encrypted = await vault.encrypt(finance, context);
  const inflightEncrypt = vault.encrypt(finance, context);
  vault.lock();
  await assert.rejects(inflightEncrypt, /заблокирован/);
  const other = await unlockLocalKeyset(keyset, {passphrase: pass}, user1);
  const inflightDecrypt = other.decrypt(encrypted, context);
  other.lock();
  await assert.rejects(inflightDecrypt, /заблокирован/);
});


test('vault scope and keyId are immutable in JavaScript but lock remains usable', async () => {
  const {vault, keyset} = await createLocalKeyset(user1, pass);
  assert.ok(Object.isFrozen(vault), 'runtime scope identity must not be reassigned');
  assert.throws(() => { vault.scope = user2; }, TypeError);
  assert.throws(() => { vault.keyId = keyset.keyId + 'A'; }, TypeError);
  assert.equal(vault.scope, user1);
  const record = await vault.encrypt(finance, context);
  assert.deepEqual(await vault.decrypt(record, context), finance);
  vault.lock();
  await assert.rejects(() => vault.decrypt(record, context), /заблокирован/);
});

test('unlock rejects oversize and too-short passphrases before KDF work', async () => {
  const {keyset} = await createLocalKeyset(user1, pass);
  await assert.rejects(() => unlockLocalKeyset(keyset, {passphrase: 'x'.repeat(1025)}, user1), /Неверный ключ/);
  await assert.rejects(() => unlockLocalKeyset(keyset, {passphrase: 'short'}, user1), /Неверный ключ/);
});


test('async unlock uses the original keyset scope and keyId despite concurrent mutation', async () => {
  const created = await createLocalKeyset(user1, pass);
  const replacement = await createLocalKeyset(user2, pass);
  const mutable = clone(created.keyset);
  const subtle = globalThis.crypto.subtle;
  const nativeDecrypt = subtle.decrypt;
  try {
    subtle.decrypt = async function(...args) {
      const result = await nativeDecrypt.apply(this, args);
      // The genuine GCM decrypt authenticated original AAD before this mutation.
      mutable.scope = user2;
      mutable.keyId = replacement.keyset.keyId;
      mutable.recovery.salt = 'AAAAAAAAAAAAAAAAAAAAAA';
      return result;
    };
    const unlocked = await unlockLocalKeyset(mutable, {passphrase: pass}, user1);
    assert.equal(unlocked.scope, user1);
    assert.equal(unlocked.keyId, created.keyset.keyId);
    const record = await unlocked.encrypt(finance, context);
    assert.equal(record.scope, user1);
  } finally { subtle.decrypt = nativeDecrypt; }
});

test('async passphrase rewrap pins the original keyset when caller mutates it', async () => {
  const created = await createLocalKeyset(user1, pass);
  const replacement = await createLocalKeyset(user2, pass);
  const mutable = clone(created.keyset);
  const subtle = globalThis.crypto.subtle;
  const nativeDecrypt = subtle.decrypt;
  try {
    subtle.decrypt = async function(...args) {
      const result = await nativeDecrypt.apply(this, args);
      mutable.scope = user2;
      mutable.keyId = replacement.keyset.keyId;
      mutable.recovery.iv = 'AAAAAAAAAAAAAAAA';
      return result;
    };
    const updated = await changeLocalPassphrase(mutable, {passphrase: pass}, 'rotated local passphrase 2026', user1);
    assert.equal(updated.scope, user1);
    assert.equal(updated.keyId, created.keyset.keyId);
    assert.deepEqual(updated.recovery, created.keyset.recovery);
    assert.equal((await unlockLocalKeyset(updated, {passphrase: 'rotated local passphrase 2026'}, user1)).scope, user1);
  } finally { subtle.decrypt = nativeDecrypt; }
});


test('reissue recovery key with local passphrase; DEK, ciphertext and passphrase wrapper remain unchanged', async () => {
  const {keyset, recoveryKey, vault} = await createLocalKeyset(user1, pass);
  const record = await vault.encrypt(finance, context);
  const prior = clone(keyset);
  const rotated = await rotateLocalRecoveryKey(keyset, pass, user1);
  assert.notEqual(rotated.recoveryKey, recoveryKey);
  assert.equal(rotated.recoveryKey.length, 43);
  assert.deepEqual(rotated.keyset.passphrase, prior.passphrase);
  assert.equal(rotated.keyset.scope, prior.scope);
  assert.equal(rotated.keyset.keyId, prior.keyId);
  assert.notDeepEqual(rotated.keyset.recovery, prior.recovery);
  assert.deepEqual(keyset, prior, 'pure rotation must not write to the caller keyset');
  const persisted = JSON.stringify({keyset:rotated.keyset,record});
  assert.ok(!persisted.includes(rotated.recoveryKey));
  assert.ok(!persisted.includes(pass));
  await assert.rejects(() => unlockLocalKeyset(rotated.keyset, {recoveryKey}, user1), /Неверный ключ/);
  assert.deepEqual(await (await unlockLocalKeyset(rotated.keyset, {recoveryKey:rotated.recoveryKey}, user1)).decrypt(record,context),finance);
  assert.deepEqual(await (await unlockLocalKeyset(rotated.keyset, {passphrase:pass}, user1)).decrypt(record,context),finance);
});

test('failed recovery reissue preserves the existing keyset and old recovery secret', async () => {
  const created = await createLocalKeyset(user1, pass);
  const old = clone(created.keyset);
  await assert.rejects(() => rotateLocalRecoveryKey(created.keyset, 'incorrect local password 2026', user1), /Неверный ключ/);
  await assert.rejects(() => rotateLocalRecoveryKey(created.keyset, pass, user2), /другого пользователя/);
  await assert.rejects(() => rotateLocalRecoveryKey(created.keyset, 'short', user1), /Неверный ключ/);
  assert.deepEqual(created.keyset, old);
  assert.equal((await unlockLocalKeyset(created.keyset,{recoveryKey:created.recoveryKey},user1)).scope,user1);
});

test('a second recovery reissue invalidates the previous secret without losing the passphrase', async () => {
  const created = await createLocalKeyset(user1, pass);
  const one = await rotateLocalRecoveryKey(created.keyset,pass,user1);
  const two = await rotateLocalRecoveryKey(one.keyset,pass,user1);
  assert.notEqual(one.recoveryKey,two.recoveryKey);
  await assert.rejects(() => unlockLocalKeyset(two.keyset,{recoveryKey:one.recoveryKey},user1),/Неверный ключ/);
  assert.equal((await unlockLocalKeyset(two.keyset,{recoveryKey:two.recoveryKey},user1)).scope,user1);
  assert.equal((await unlockLocalKeyset(two.keyset,{passphrase:pass},user1)).scope,user1);
});

test('recovery key reissue is offline and independent of the login/session cookie', async () => {
  const created=await createLocalKeyset(guest,pass);
  const before=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('Network disabled')};
  try {
    const rotated=await rotateLocalRecoveryKey(created.keyset,pass,guest);
    assert.equal((await unlockLocalKeyset(rotated.keyset,{recoveryKey:rotated.recoveryKey},guest)).scope,guest);
  }finally{globalThis.fetch=before}
});
