import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalKeyset} from '../src/security/local-vault.ts';
import {LocalBudgetSession} from '../src/security/local-budget-session.ts';

const USER_A = 'account:' + 'a'.repeat(32);
const USER_B = 'account:' + 'b'.repeat(32);
const GUEST = 'guest:local-qa';
const PASSWORD = 'separate local passphrase 2026';
const CONTEXT = {kind: 'snapshot', recordId: 'state', schemaVersion: 2, revision: 8};
const FINANCE = {title: 'PRIVATE_LEDGER_TITLE', amountCents: 987654321, revision: 8};

const make = scope => createLocalKeyset(scope, PASSWORD);

test('requires explicit valid scope and stays locked until credentials provided', async () => {
  const session = new LocalBudgetSession();
  assert.equal(session.state, 'unselected');
  await assert.rejects(() => session.unlock({}, {passphrase: PASSWORD}), /заблокирован/);
  assert.throws(() => session.selectScope('account:wrong'), /область/);
  assert.throws(() => session.selectScope('guest:x'), /область/);
  assert.equal(session.state, 'unselected');
  session.selectScope(GUEST);
  assert.equal(session.state, 'locked');
  assert.equal(session.selectedScope, GUEST);
  await assert.rejects(() => session.encrypt(FINANCE, CONTEXT), /заблокирован/);
});

test('AES-GCM roundtrip only when unlocked; manual lock is fail closed', async () => {
  const {keyset, vault} = await make(USER_A);
  vault.lock();
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  await session.unlock(keyset, {passphrase: PASSWORD});
  assert.equal(session.state, 'unlocked');
  const encrypted = await session.encrypt(FINANCE, CONTEXT);
  assert.deepEqual(await session.decrypt(encrypted, CONTEXT), FINANCE);
  assert.ok(!JSON.stringify(session).includes(FINANCE.title));
  assert.ok(!JSON.stringify(session).includes(PASSWORD));
  session.lock();
  assert.equal(session.state, 'locked');
  await assert.rejects(() => session.decrypt(encrypted, CONTEXT), /заблокирован/);
  await assert.rejects(() => session.encrypt(FINANCE, CONTEXT), /заблокирован/);
});

test('wrong local credential fails closed and cancels an earlier unlocked vault', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  await session.unlock(keyset, {passphrase: PASSWORD});
  assert.equal(session.state, 'unlocked');
  await assert.rejects(() => session.unlock(keyset, {passphrase: 'incorrect local passphrase 2026'}), /Неверный ключ/);
  assert.equal(session.state, 'locked');
});

test('different account cannot unlock a prior account keyset', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_B);
  await assert.rejects(() => session.unlock(keyset, {passphrase: PASSWORD}), /другого пользователя/);
  assert.equal(session.state, 'locked');
});

test('same and different account re-selection always blocks until new unlock', async () => {
  const {keyset: a} = await make(USER_A);
  const {keyset: b} = await make(USER_B);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  await session.unlock(a, {passphrase: PASSWORD});
  session.selectScope(USER_A);
  assert.equal(session.state, 'locked');
  await session.unlock(a, {passphrase: PASSWORD});
  session.selectScope(USER_B);
  assert.equal(session.state, 'locked');
  await assert.rejects(() => session.unlock(a, {passphrase: PASSWORD}), /другого пользователя/);
  await session.unlock(b, {passphrase: PASSWORD});
  assert.equal(session.state, 'unlocked');
  assert.equal(session.selectedScope, USER_B);
});

test('logout forgets account selection and keys, without deleting persisted data', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  await session.unlock(keyset, {passphrase: PASSWORD});
  session.logout();
  assert.equal(session.selectedScope, null);
  assert.equal(session.state, 'unselected');
  await assert.rejects(() => session.unlock(keyset, {passphrase: PASSWORD}), /заблокирован/);
  session.selectScope(USER_A);
  await session.unlock(keyset, {passphrase: PASSWORD});
  assert.equal(session.state, 'unlocked');
});

test('fresh session after restart unlocks offline with recovery key', async () => {
  const {keyset, recoveryKey} = await make(GUEST);
  const persistedKeyset = structuredClone(keyset);
  const fresh = new LocalBudgetSession();
  assert.equal(fresh.state, 'unselected');
  fresh.selectScope(GUEST);
  await fresh.unlock(persistedKeyset, {recoveryKey});
  const record = await fresh.encrypt(FINANCE, CONTEXT);
  const anotherFreshSession = new LocalBudgetSession();
  anotherFreshSession.selectScope(GUEST);
  await anotherFreshSession.unlock(persistedKeyset, {passphrase: PASSWORD});
  assert.deepEqual(await anotherFreshSession.decrypt(record, CONTEXT), FINANCE);
  fresh.logout();
  anotherFreshSession.logout();
});

test('logout rejects in-flight unlock and cannot restore previous account', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  const inFlight = session.unlock(keyset, {passphrase: PASSWORD});
  session.logout();
  await assert.rejects(inFlight, /заблокирован/);
  assert.equal(session.state, 'unselected');
});

test('account switch rejects in-flight unlock even if KDF completes successfully', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  const inFlight = session.unlock(keyset, {passphrase: PASSWORD});
  session.selectScope(USER_B);
  await assert.rejects(inFlight, /заблокирован/);
  assert.equal(session.selectedScope, USER_B);
  assert.equal(session.state, 'locked');
});

test('latest overlapping unlock wins and stale first result is never active', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  const obsolete = session.unlock(keyset, {passphrase: PASSWORD});
  const current = session.unlock(keyset, {passphrase: PASSWORD});
  await assert.rejects(obsolete, /заблокирован/);
  await current;
  assert.equal(session.state, 'unlocked');
});

test('in-flight read cannot publish plaintext after logout', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  await session.unlock(keyset, {passphrase: PASSWORD});
  const sealed = await session.encrypt(FINANCE, CONTEXT);
  const inFlight = session.decrypt(sealed, CONTEXT);
  session.logout();
  await assert.rejects(inFlight, /заблокирован/);
});

test('in-flight encryption cannot publish ciphertext after lock', async () => {
  const {keyset} = await make(USER_A);
  const session = new LocalBudgetSession();
  session.selectScope(USER_A);
  await session.unlock(keyset, {passphrase: PASSWORD});
  const inFlight = session.encrypt(FINANCE, CONTEXT);
  session.lock();
  await assert.rejects(inFlight, /заблокирован/);
});
