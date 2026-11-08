import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalBudgetSession} from '../src/security/local-budget-session.ts';
import {
  ATOMIC_ENCRYPTED_DB, createAtomicEncryptedCandidate, getAtomicEncryptedKeyset,
  readAtomicEncryptedCandidate, compareAndSwapAtomicEncryptedCandidate,
  rotateAtomicEncryptedRecoveryKey,
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
  let failBundlePut = false, failKeysetPut = false;
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
              if (name === 'keysets' && failKeysetPut) throw Error('injected keyset write failure');
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
    set failKeysetPut(value){failKeysetPut=value;},
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
  const keyset = await getAtomicEncryptedKeyset(USER_A);
  await assert.rejects(() => failed.unlock(keyset,
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


test('nested values that would silently disappear during JSON serialization are rejected', async () => {
  const db = mount();
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS,
    {...clone(SOURCE), snapshot:{title:'ok', ignored:undefined}}), /JSON/);
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS,
    {...clone(SOURCE), snapshot:{title:'ok', value:Infinity}}), /JSON/);
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS,
    {...clone(SOURCE), snapshot:new Map([['title','lost']])}), /JSON-объектом/);
  assert.equal(db.tables.get('bundles').size,0);
});


test('review P2: non-enumerable, symbol and class fields cannot be silently cloned away', async () => {
  const db = mount();
  const hidden = clone(SOURCE);
  Object.defineProperty(hidden.snapshot, 'secretAmountCents', {
    value:12345, enumerable:false, configurable:true,
  });
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, hidden), /JSON-объектом/);

  const symbolic = clone(SOURCE);
  symbolic.snapshot[Symbol('hiddenMoney')] = 12345;
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, symbolic), /JSON-объектом/);

  class LegacyLedger {
    constructor(){this.amountCents=12345;}
  }
  const custom = {...clone(SOURCE), snapshot:new LegacyLedger()};
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, custom), /JSON-объектом/);
  assert.equal(db.tables.get('keysets').size, 0);
  assert.equal(db.tables.get('bundles').size, 0);
});


test('financial arrays with hidden fields and accessor properties reject without loss', async () => {
  const db = mount();
  const hidden = clone(SOURCE);
  Object.defineProperty(hidden.outbox, 'hiddenPayment', {value:9001, enumerable:false});
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, hidden), /финансовый массив/);

  const getter = clone(SOURCE);
  Object.defineProperty(getter.snapshot, 'interestCents', {
    enumerable:true, get(){return 5000;},
  });
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, getter), /финансового JSON/);
  assert.equal(db.tables.get('bundles').size,0);
  assert.equal(db.tables.get('keysets').size,0);
});


test('review P2: Array subclasses and custom prototypes are rejected before clone and CAS', async () => {
  const db = mount();
  class PaymentQueue extends Array {
    get inheritedAmountCents(){return 12345;}
  }
  const custom = clone(SOURCE);
  const queue = new PaymentQueue();
  queue.push(...custom.outbox);
  custom.outbox = queue;
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, custom), /финансовый массив/);
  assert.equal(db.tables.get('bundles').size, 0);

  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2, custom),
    /финансовый массив/);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 0);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).outbox, SOURCE.outbox);
});

test('review P2: top-level accessor is rejected without executing its mutation', async () => {
  const db = mount();
  const malicious = clone(SOURCE);
  let getters = 0;
  Object.defineProperty(malicious, 'snapshot', {
    enumerable:true, configurable:true,
    get(){
      getters++;
      this.outbox = [];
      Object.defineProperty(this, 'snapshot', {
        value:clone(SOURCE.snapshot), enumerable:true, configurable:true, writable:true,
      });
      return this.snapshot;
    },
  });
  await assert.rejects(() => createAtomicEncryptedCandidate(USER_A, PASS, malicious), /финансового JSON/);
  assert.equal(getters, 0, 'validation must not invoke a hostile accessor');
  assert.equal(db.tables.get('bundles').size, 0);

  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2, malicious),
    /финансового JSON/);
  assert.equal(getters, 0);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).outbox, SOURCE.outbox);
});


test('atomic recovery reissue invalidates old recovery while preserving ciphertext, epoch and outbox', async () => {
  const db = mount();
  const created = await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const oldKeyset = clone(db.tables.get('keysets').get(USER_A));
  const oldBundle = clone(db.tables.get('bundles').get(USER_A));
  const session = await unlock(USER_A);
  const result = await rotateAtomicEncryptedRecoveryKey(USER_A, session, PASS);
  assert.equal(result.recoveryKey.length, 43);
  assert.notEqual(result.recoveryKey, created.recoveryKey);
  const afterKeyset = await getAtomicEncryptedKeyset(USER_A);
  assert.equal(afterKeyset.keyId, oldKeyset.keyId);
  assert.deepEqual(afterKeyset.passphrase, oldKeyset.passphrase);
  assert.notDeepEqual(afterKeyset.recovery, oldKeyset.recovery);
  assert.deepEqual(db.tables.get('bundles').get(USER_A), oldBundle, 'rotation cannot rewrite finance or outbox');
  const oldSession = new LocalBudgetSession();oldSession.selectScope(USER_A);
  await assert.rejects(() => oldSession.unlock(afterKeyset,{recoveryKey:created.recoveryKey}),/Неверный ключ/);
  const recovered = new LocalBudgetSession();recovered.selectScope(USER_A);
  await recovered.unlock(afterKeyset,{recoveryKey:result.recoveryKey});
  const data = await readAtomicEncryptedCandidate(USER_A,recovered);
  assert.deepEqual(data.outbox,SOURCE.outbox);
  assert.deepEqual(data.conflicts,SOURCE.conflicts);
  assert.deepEqual(data.snapshot,SOURCE.snapshot);
  assert.equal(data.epoch,0);
});

test('invalid recovery reissue password or cross-account scope does not alter stored keys', async () => {
  const db = mount();
  const created = await createAtomicEncryptedCandidate(USER_A,PASS,SOURCE);
  const old = clone(db.tables.get('keysets').get(USER_A));
  const session = await unlock(USER_A);
  await assert.rejects(() => rotateAtomicEncryptedRecoveryKey(USER_A,session,'incorrect local phrase 2026'),/Неверный ключ/);
  await assert.rejects(() => rotateAtomicEncryptedRecoveryKey(USER_B,session,PASS),/заблокирован/);
  assert.deepEqual(db.tables.get('keysets').get(USER_A),old);
  const fresh=new LocalBudgetSession();fresh.selectScope(USER_A);
  await fresh.unlock(await getAtomicEncryptedKeyset(USER_A),{recoveryKey:created.recoveryKey});
  assert.equal(fresh.state,'unlocked');
});

test('aborted recovery keyset write keeps the previous recovery credential usable', async () => {
  const db=mount();
  const created=await createAtomicEncryptedCandidate(USER_A,PASS,SOURCE);
  const before=clone(db.tables.get('keysets').get(USER_A));
  const session=await unlock(USER_A);
  db.failKeysetPut=true;
  await assert.rejects(() => rotateAtomicEncryptedRecoveryKey(USER_A,session,PASS),/injected keyset write failure/);
  db.failKeysetPut=false;
  assert.deepEqual(db.tables.get('keysets').get(USER_A),before);
  const fresh=new LocalBudgetSession();fresh.selectScope(USER_A);
  await fresh.unlock(await getAtomicEncryptedKeyset(USER_A),{recoveryKey:created.recoveryKey});
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A,fresh)).outbox,SOURCE.outbox);
});

test('logout during recovery KDF rejects and retains the last committed keyset', async () => {
  const db=mount();
  const created=await createAtomicEncryptedCandidate(USER_A,PASS,SOURCE);
  const before=clone(db.tables.get('keysets').get(USER_A));
  const session=await unlock(USER_A);
  const inflight=rotateAtomicEncryptedRecoveryKey(USER_A,session,PASS);
  session.logout();
  await assert.rejects(inflight,/заблокирован/);
  assert.deepEqual(db.tables.get('keysets').get(USER_A),before);
  const fresh=new LocalBudgetSession();fresh.selectScope(USER_A);
  await fresh.unlock(await getAtomicEncryptedKeyset(USER_A),{recoveryKey:created.recoveryKey});
  assert.equal(fresh.state,'unlocked');
});

test('offline recovery rotation never sends financial data or local credentials to a server', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A,PASS,SOURCE);
  const session=await unlock(USER_A);
  const prior=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('network must not be used')};
  try {
    const result=await rotateAtomicEncryptedRecoveryKey(USER_A,session,PASS);
    assert.equal(result.recoveryKey.length,43);
  } finally {globalThis.fetch=prior;}
});
