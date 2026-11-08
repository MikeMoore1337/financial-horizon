import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalBudgetSession} from '../src/security/local-budget-session.ts';
import {
  ATOMIC_ENCRYPTED_DB, createAtomicEncryptedCandidate, getAtomicEncryptedKeyset,
  readAtomicEncryptedCandidate, compareAndSwapAtomicEncryptedCandidate,
} from '../src/security/protected-atomic-candidate.ts';

const PASS = 'secure local phrase test 2026';
const USER_A = 'account:' + 'a'.repeat(32);
const USER_B = 'account:' + 'b'.repeat(32);
const SOURCE = {
  snapshot: {version: 2, revision: 17, title: 'PRIVATE_FINANCE_TITLE_2026', amountCents: 91357246},
  outbox: [{id: 'SECRET_OPERATION_ID', amountCents: 410000}],
  conflicts: [{id: 'private-conflict', reason: 'local-only'}],
};
const clone = value => structuredClone(value);

function fakeIndexedDb() {
  const tables = new Map([['keysets', new Map()], ['bundles', new Map()]]);
  let failBundlePut = false;
  const db = {
    close(){},
    onversionchange: null,
    objectStoreNames: {contains: name => tables.has(name)},
    createObjectStore(name){tables.set(name, new Map());},
    transaction(_stores, mode){
      const working = new Map([...tables].map(([name, values]) =>
        [name, new Map([...values].map(([key, value]) => [key, clone(value)]))]));
      let pending = 0, aborted = false, completed = false;
      const tx = {
        oncomplete:null, onerror:null, onabort:null, error:null,
        abort(){
          if (aborted || completed) return;
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name){
          const table = working.get(name);
          if (!table) throw Error('missing store ' + name);
          return {
            get(key){
              const req = {result:undefined, onsuccess:null, onerror:null};
              schedule(() => {
                req.result = clone(table.get(key));
                req.onsuccess?.({target:req});
              });
              return req;
            },
            put(value, key){
              if (mode !== 'readwrite') throw Error('readonly');
              if (name === 'bundles' && failBundlePut) throw Error('injected bundle write failure');
              const pinned = clone(value);
              schedule(() => table.set(key, pinned));
              return {};
            },
          };
        },
      };
      function schedule(op){
        pending++;
        queueMicrotask(() => {
          if (aborted) {pending--; return;}
          try {op();} catch (error) {tx.error = error; tx.abort();}
          finally {
            pending--;
            if (!pending && !aborted) queueMicrotask(() => {
              if (pending || aborted || completed) return;
              completed = true;
              if (mode === 'readwrite') for (const [name, values] of working) tables.set(name, values);
              tx.oncomplete?.();
            });
          }
        });
      }
      return tx;
    },
  };
  return {tables, set failBundlePut(value){failBundlePut=value;},
    open(name, version){
      assert.equal(name, ATOMIC_ENCRYPTED_DB);
      assert.equal(version, 1);
      const req = {onsuccess:null, onerror:null, onblocked:null,
        onupgradeneeded:null, result:db};
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }};
}
function mount(){
  const idb = fakeIndexedDb();
  globalThis.indexedDB = {open: idb.open};
  return idb;
}
async function unlock(scope, credential = {passphrase:PASS}) {
  const session = new LocalBudgetSession();
  session.selectScope(scope);
  const keyset = await getAtomicEncryptedKeyset(scope);
  assert.ok(keyset);
  await session.unlock(keyset, credential);
  return session;
}

test('atomic initial snapshot+outbox+conflicts is encrypted with no persisted secrets', async () => {
  const db = mount();
  const receipt = await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  assert.equal(receipt.epoch, 0);
  assert.equal(receipt.recoveryKey.length, 43);
  assert.equal(db.tables.get('keysets').size, 1);
  assert.equal(db.tables.get('bundles').size, 1);
  const stored = JSON.stringify([...db.tables.values()].map(table => [...table.values()]));
  for (const secret of [PASS, receipt.recoveryKey, 'PRIVATE_FINANCE_TITLE_2026',
    '91357246', 'SECRET_OPERATION_ID', '410000', 'private-conflict']) {
    assert.ok(!stored.includes(secret), 'persisted plaintext: ' + secret.slice(0, 6));
  }
  const session = await unlock(USER_A);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session),
    {...SOURCE, epoch:0, schemaVersion:2});
  session.logout();
  await assert.rejects(() => readAtomicEncryptedCandidate(USER_A, session), /заблокирован/);
});

test('one readwrite transaction commits both stores or neither after interruption', async () => {
  const db = mount();
  db.failBundlePut = true;
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, SOURCE),
    /injected bundle write failure/);
  assert.equal(db.tables.get('keysets').size, 0);
  assert.equal(db.tables.get('bundles').size, 0);
  db.failBundlePut = false;
  assert.equal((await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE)).epoch, 0);
});

test('stale writer cannot overwrite newer encrypted offline payment', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  const first = {...clone(SOURCE), outbox:[...clone(SOURCE.outbox),
    {id:'PAYMENT_ONCE', amountCents:100} ]};
  assert.equal(await compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2, first), 1);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2,
    {...clone(SOURCE), outbox:[{id:'STALE_PAYMENT', amountCents:9999}]}), /другой вкладке/);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).outbox, first.outbox);
});

test('keyset is not implicitly rotated; duplicate initialization fails closed', async () => {
  const db = mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const keyId = db.tables.get('keysets').get(USER_A).keyId;
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, SOURCE), /уже существует/);
  assert.equal(db.tables.get('keysets').get(USER_A).keyId, keyId);
});

test('user A cannot read or update user B, even with identical passphrases', async () => {
  mount();
  const receipt = await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  await createAtomicEncryptedCandidate(USER_B, PASS,
    {...clone(SOURCE), snapshot:{title:'OTHER_ACCOUNT', amountCents:11}});
  const a = await unlock(USER_A);
  await assert.rejects(() => readAtomicEncryptedCandidate(USER_B, a), /заблокирован/);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_B, a, 0, 2, SOURCE), /заблокирован/);
  const b = await unlock(USER_B);
  const otherKeyset = await getAtomicEncryptedKeyset(USER_A);
  await assert.rejects(() => b.unlock(otherKeyset,
    {recoveryKey:receipt.recoveryKey}), /другого пользователя/);
  assert.equal(b.state, 'locked');
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, a)).snapshot, SOURCE.snapshot);
});

test('metadata and ciphertext tampering are rejected, no plaintext fallback', async () => {
  const db = mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  const original = clone(db.tables.get('bundles').get(USER_A));
  const changed = clone(original);
  changed.outbox.revision = 99;
  db.tables.get('bundles').set(USER_A, changed);
  await assert.rejects(() => readAtomicEncryptedCandidate(USER_A, session), /Повреждён/);
  const corrupt = clone(original);
  corrupt.snapshot.ciphertext = 'AAAA' + corrupt.snapshot.ciphertext.slice(4);
  db.tables.get('bundles').set(USER_A, corrupt);
  await assert.rejects(() => readAtomicEncryptedCandidate(USER_A, session), /повреждённые данные/);
  db.tables.get('bundles').set(USER_A, original);
  db.tables.get('keysets').delete(USER_A);
  await assert.rejects(() => readAtomicEncryptedCandidate(USER_A, session), /Повреждён/);
});

test('recovery key after a new instance; wrong password remains locked', async () => {
  mount();
  const receipt = await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const failed = new LocalBudgetSession();
  failed.selectScope(USER_A);
  await assert.rejects(() => failed.unlock(await getAtomicEncryptedKeyset(USER_A),
    {passphrase:'incorrect local phrase 2026'}), /Неверный ключ/);
  assert.equal(failed.state, 'locked');
  const recovered = await unlock(USER_A, {recoveryKey:receipt.recoveryKey});
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, recovered)).snapshot, SOURCE.snapshot);
});

test('logout invalidates a crypto write still in flight, preserves prior epoch', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  const inFlight = compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2,
    {...clone(SOURCE), snapshot:{title:'AFTER_LOGOUT', amountCents:12}});
  session.logout();
  await assert.rejects(inFlight, /заблокирован/);
  const reopened = await unlock(USER_A);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, reopened)).epoch, 0);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, reopened)).snapshot, SOURCE.snapshot);
});

test('failed update transaction preserves old snapshot and pending operations', async () => {
  const db = mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  db.failBundlePut = true;
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2,
    {...clone(SOURCE), snapshot:{title:'SHOULD_NOT_COMMIT'}}), /injected bundle write failure/);
  db.failBundlePut = false;
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).snapshot, SOURCE.snapshot);
});

test('source is pinned before slow KDF and extra fields cannot disappear silently', async () => {
  const db = mount();
  const mutable = clone(SOURCE);
  const created = createAtomicEncryptedCandidate(USER_A, PASS, mutable);
  mutable.snapshot.title = 'ATTACKER_CHANGED_AFTER_CALL';
  mutable.outbox[0].id = 'ATTACKER_QUEUE';
  await created;
  const session = await unlock(USER_A);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).snapshot, SOURCE.snapshot);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).outbox, SOURCE.outbox);
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_B, PASS,
    {...SOURCE, droppedFinancialRecords:[{amountCents:3}]}), /Некорректное содержимое/);
  assert.equal(db.tables.get('keysets').has(USER_B), false);
});

test('schema mismatch, invalid epoch and missing existing state reject before mutation', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 3, SOURCE), /другой вкладке/);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, -1, 2, SOURCE), /expectedEpoch/);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_B, session, 0, 2, SOURCE), /заблокирован/);
});

test('no fetch/network for offline read and updates', async () => {
  mount();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {throw Error('network unavailable');};
  try {
    await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
    const session = await unlock(USER_A);
    const got = await readAtomicEncryptedCandidate(USER_A, session);
    assert.equal(got.snapshot.amountCents, 91357246);
    await compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2, SOURCE);
    assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 1);
  } finally {globalThis.fetch = priorFetch;}
});
