import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeEncryptedCloudCacheCandidate,
  persistEncryptedCloudDeltaCandidate,
  refreshEncryptedCloudSnapshot,
} from '../src/cloud/encrypted-cloud-cache-candidate.mjs';
import {
  enqueueEncryptedFinanceCommandCandidate,
  classifyFinanceOutboxResponseCandidate,
  persistAuthenticatedFinanceReceiptCandidate,
  persistEncryptedFinanceHoldCandidate,
  recordManualFinanceConflictChoiceCandidate,
  recordVerifiedFinanceCancellation,
  resolveStaleFinanceConflict,
} from '../src/cloud/encrypted-command-outbox-candidate.mjs';
import {dispatchOneEncryptedFinanceCommandCandidate} from '../src/cloud/finance-offline-dispatch-candidate.mjs';
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
  let logoutAfterKeysetPut = null, logoutAfterBundlePut = null;
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
              if (name === 'keysets' && logoutAfterKeysetPut) {
                const selected = logoutAfterKeysetPut;
                logoutAfterKeysetPut = null;
                // Runs between the scheduled IDB put and the IDB oncomplete,
                // deterministically reproducing the reviewer-found race.
                queueMicrotask(() => selected.logout());
              }
              if (name === 'bundles' && logoutAfterBundlePut) {
                const selected = logoutAfterBundlePut;
                logoutAfterBundlePut = null;
                queueMicrotask(() => selected.logout());
              }
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
    set logoutAfterKeysetPut(value){logoutAfterKeysetPut=value;},
    set logoutAfterBundlePut(value){logoutAfterBundlePut=value;},
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

test('logout after bundle put aborts the pending transaction and preserves all prior data', async () => {
  const db = mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const previous = clone(db.tables.get('bundles').get(USER_A));
  const session = await unlock(USER_A);
  db.logoutAfterBundlePut = session;
  await assert.rejects(() => compareAndSwapAtomicEncryptedCandidate(USER_A, session, 0, 2,
    {...clone(SOURCE), outbox: [{id: 'MUST_NOT_COMMIT'}]}), /заблокирован|отменена/);
  assert.deepEqual(db.tables.get('bundles').get(USER_A), previous);
  const reopened = await unlock(USER_A);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, reopened),
    {...SOURCE, epoch: 0, schemaVersion: 2});
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


test('review P2: logout between keyset put and transaction commit aborts the recovery rotation', async () => {
  const db=mount();
  const created=await createAtomicEncryptedCandidate(USER_A,PASS,SOURCE);
  const previous=clone(db.tables.get('keysets').get(USER_A));
  const session=await unlock(USER_A);
  db.logoutAfterKeysetPut=session;
  await assert.rejects(() => rotateAtomicEncryptedRecoveryKey(USER_A,session,PASS),/заблокирован|отменена/);
  assert.equal(session.state,'unselected');
  assert.deepEqual(db.tables.get('keysets').get(USER_A),previous,
    'no recovery key may be revoked by a cancelled native transaction');
  const original=new LocalBudgetSession();original.selectScope(USER_A);
  await original.unlock(await getAtomicEncryptedKeyset(USER_A),{recoveryKey:created.recoveryKey});
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A,original)).outbox,SOURCE.outbox);
});


const CLOUD_PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLOUD_ACCOUNT = '10000000-0000-4000-8000-000000000001';
const CLOUD_TRANSACTION = '10000000-0000-4000-8000-000000000002';
const cloudAuth = session => ({
  scope: USER_A, profileId: CLOUD_PROFILE,
  generation: session.lifecycleVersion, epoch: 'e'.repeat(32),
  signal: session.lifecycleSignal,
});
const cloudAccount = (revision, balance) => ({
  id: CLOUD_ACCOUNT, kind: 'account', entity_revision: revision,
  data: {name: 'Synthetic bank', type: 'bank', currency: 'RUB',
    opening_minor: 10_000, balance_minor: balance,
    reserved_minor: 0, available_minor: balance, archived_at: null},
});
const cloudPages = () => [{
  cursorSent: null,
  body: {schema_version: 1, revision: 0, profile_id: CLOUD_PROFILE,
    currency: 'RUB', entities: [cloudAccount(1, 10_000)]},
}];
const verifiedChange = () => ({
  schema_version: 1, from_revision: 0, to_revision: 1,
  next_since_revision: 1, has_more: false,
  changes: [{
    revision: 1, ordinal: 0, kind: 'ledger_posted',
    entity_id: CLOUD_TRANSACTION, entity_revision: 1,
    payload: {
      entity: {
        id: CLOUD_TRANSACTION, entity_revision: 1, kind: 'transaction',
        data: {kind: 'expense', occurred_on: '2026-11-11',
          posted_at: '2026-11-11T12:00:00Z',
          note: null, reversed_transaction_id: null,
          postings: [{account_id: CLOUD_ACCOUNT, signed_minor: -500}]},
      },
      accounts: [cloudAccount(2, 9_500)],
    },
  }],
});

test('#68 encrypted cloud cache stores verified server image without overwriting legacy finance', async () => {
  const db = mount();
  const original = {...clone(SOURCE), outbox: [], conflicts: []};
  await createAtomicEncryptedCandidate(USER_A, PASS, original);
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  const init = await initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session, identity, pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  });
  assert.equal(init.status, 'ENCRYPTED_CACHE_ONLY');
  assert.equal(init.bundleEpoch, 1);
  let stored = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.snapshot.title, SOURCE.snapshot.title);
  assert.equal(stored.snapshot.amountCents, SOURCE.snapshot.amountCents);
  assert.equal(stored.snapshot.cloudFinance.revision, 0);
  assert.equal(stored.snapshot.cloudFinance.entities[0].data.balance_minor, 10_000);
  const ciphertext = JSON.stringify([...db.tables.get('bundles').values()]);
  for (const secret of [SOURCE.snapshot.title, 'Synthetic bank', CLOUD_PROFILE]) {
    assert.ok(!ciphertext.includes(secret), 'plaintext must not persist');
  }
  const receipt = await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session, identity, page: verifiedChange(), expectedEpoch: 1,
  });
  assert.equal(receipt.status, 'ENCRYPTED_DELTA_SAVED');
  assert.equal(receipt.bundleEpoch, 2);
  assert.equal(receipt.serverRevision, 1);
  stored = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(stored.epoch, 2);
  assert.equal(stored.snapshot.cloudFinance.revision, 1);
  assert.equal(stored.snapshot.cloudFinance.entities.find(x => x.id === CLOUD_ACCOUNT)
    .data.balance_minor, 9_500);
  assert.equal(stored.snapshot.title, SOURCE.snapshot.title);
  assert.deepEqual(stored.outbox, []);
  assert.deepEqual(stored.conflicts, []);
  const noChanges = await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    page: {schema_version: 1, from_revision: 1,
      to_revision: 1, next_since_revision: 1, has_more: false, changes: []},
  });
  assert.equal(noChanges.status, 'NO_NEW_REVISION');
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 2);
  session.logout();
});

test('#68 encrypted cache refuses overwriting pending outbox or existing image', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, SOURCE);
  const session = await unlock(USER_A);
  await assert.rejects(() => initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session, identity: cloudAuth(session), pages: cloudPages(),
    expectedEpoch: 0, confirmedAccountCacheInitialization: true,
  }), /SYNC_HOLD/);
  assert.deepEqual((await readAtomicEncryptedCandidate(USER_A, session)).outbox, SOURCE.outbox);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 0);
  session.logout();
});

test('#68 encrypted delta and stale writer failures preserve every committed byte', async () => {
  mount();
  const original = {...clone(SOURCE), outbox: [], conflicts: []};
  await createAtomicEncryptedCandidate(USER_A, PASS, original);
  const first = await unlock(USER_A);
  const second = await unlock(USER_A);
  await initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session: first, identity: cloudAuth(first),
    pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  });
  // Same account, different unlocked tab: stale epoch cannot write over
  // the first tab's encrypted cloud image.
  await assert.rejects(() => initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session: second, identity: cloudAuth(second),
    pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  }), /SYNC_HOLD/);
  const prior = await readAtomicEncryptedCandidate(USER_A, first);
  const corrupt = {...verifiedChange(), changes: [
    {...verifiedChange().changes[0], ordinal: 7},
  ]};
  await assert.rejects(() => persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session: first, identity: cloudAuth(first),
    expectedEpoch: 1, page: corrupt,
  }), /SYNC_HOLD/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, first), prior);
  await assert.rejects(() => persistEncryptedCloudDeltaCandidate({
    scope: USER_B, session: first, identity: cloudAuth(first),
    expectedEpoch: 1, page: verifiedChange(),
  }), /SYNC_HOLD/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, first), prior);
  first.logout();
  second.logout();
});


const PENDING_ID = 'd0000000-0000-4000-8000-000000000001';
const NEW_ACCOUNT_ID = 'b0000000-0000-4000-8000-000000000001';
const CLOUD_ETAG = '"fh-synthetic-revision-zero"';
const pendingCommand = (amount = 12_345, mutationId = PENDING_ID) => ({
  schema_version: 2,
  client_mutation_id: mutationId,
  base_revision: 0,
  action: 'account.create',
  expected_entity_revisions: {},
  payload: {
    id: NEW_ACCOUNT_ID,
    name: 'Synthetic cash to encrypt',
    kind: 'cash',
    currency: 'RUB',
    opening_minor: amount,
  },
});
async function preparedOfflineQueue() {
  const db = mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {
    ...clone(SOURCE), outbox: [], conflicts: [],
  });
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  await initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session, identity, pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  });
  return {db, session, identity};
}

async function heldOfflineCommand(status = 412, includeNegativeAck = true) {
  const state = await preparedOfflineQueue();
  const {session, identity} = state;
  await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
    command: pendingCommand(), ifMatch: CLOUD_ETAG, expectedEpoch: 1});
  await persistEncryptedFinanceHoldCandidate({scope: USER_A, session, identity,
    expectedEpoch: 2, mutationId: PENDING_ID, httpStatus: status,
    decision: status === 410 ? 'SNAPSHOT_REQUIRED_HOLD' : 'CONFLICT_HOLD',
    source: 'command', negativeAck: status === 412 && includeNegativeAck
      ? {code: 'stale_revision', server_revision: 1} : null});
  const pages = cloudPages();
  pages[0].body.revision = 1;
  await refreshEncryptedCloudSnapshot({scope: USER_A, session, identity,
    pages, etag: '"fh.1.1.0123456789abcdef"', expectedEpoch: 3});
  return state;
}

test('#68 accepting server after 412 archives the unmodified command atomically', async () => {
  const {db, session, identity} = await heldOfflineCommand();
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  const args = {scope: USER_A, session, identity, expectedEpoch: 4,
    mutationId: PENDING_ID, observedRevision: 1, choice: 'ACCEPT_SERVER',
    explicitUserChoice: true};
  db.failBundlePut = true;
  await assert.rejects(() => resolveStaleFinanceConflict(args));
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  db.failBundlePut = false;
  const result = await resolveStaleFinanceConflict(args);
  assert.equal(result.status, 'CONFLICT_RESOLVED');
  assert.equal(result.pending, 0);
  session.logout();
  const reopened = await unlock(USER_A);
  const after = await readAtomicEncryptedCandidate(USER_A, reopened);
  assert.deepEqual(after.outbox, []);
  assert.equal(after.conflicts[0].choice, 'ACCEPT_SERVER');
  assert.deepEqual(after.conflicts[0].original, before.outbox[0]);
  assert.equal(after.snapshot.cloudFinance.revision, 1);
  reopened.logout();
});

test('#68 reapply requires a new UUID and current preconditions; 409 and 410 remain held', async () => {
  const {session, identity} = await heldOfflineCommand();
  const nextId = 'd0000000-0000-4000-8000-000000000002';
  const replacement = {...pendingCommand(200, nextId), base_revision: 1};
  const args = {scope: USER_A, session, identity, expectedEpoch: 4,
    mutationId: PENDING_ID, observedRevision: 1, choice: 'REAPPLY',
    replacementCommand: replacement, explicitUserChoice: true};
  await assert.rejects(() => resolveStaleFinanceConflict({...args,
    replacementCommand: {...replacement, client_mutation_id: PENDING_ID}}), /SYNC_HOLD/);
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  const result = await resolveStaleFinanceConflict(args);
  assert.equal(result.pending, 1);
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(after.outbox[0].mutationId, nextId);
  assert.equal(after.outbox[0].ifMatch, '"fh.1.1.0123456789abcdef"');
  assert.deepEqual(after.conflicts[0].original, before.outbox[0]);
  assert.equal(after.conflicts[0].replacementMutationId, nextId);
  session.logout();
  for (const [status, includeNegativeAck] of [[409, true], [410, true], [412, false]]) {
    const held = await heldOfflineCommand(status, includeNegativeAck);
    const old = await readAtomicEncryptedCandidate(USER_A, held.session);
    await assert.rejects(() => resolveStaleFinanceConflict({...args,
      session: held.session, identity: held.identity}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, held.session), old);
    held.session.logout();
  }
});

for (const status of [409, 410]) {
  test('#68 a server cancellation proof permits explicit conflict choice for ' + status, async () => {
    const {db, session, identity} = await heldOfflineCommand(status);
    const before = await readAtomicEncryptedCandidate(USER_A, session);
    const base = {scope:USER_A, session, identity, expectedEpoch:4, mutationId:PENDING_ID};
    const ack = {code:'command_cancelled', schema_version:2,
      client_mutation_id:PENDING_ID, base_revision:0};
    await assert.rejects(() => recordVerifiedFinanceCancellation({...base,
      cancellationAck:{...ack, client_mutation_id:NEW_ACCOUNT_ID}}), /SYNC_HOLD/);
    db.failBundlePut = true;
    await assert.rejects(() => recordVerifiedFinanceCancellation({...base, cancellationAck:ack}));
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
    db.failBundlePut = false;
    const recorded = await recordVerifiedFinanceCancellation({...base, cancellationAck:ack});
    assert.equal(recorded.bundleEpoch, 5);
    const afterRecord = await readAtomicEncryptedCandidate(USER_A, session);
    assert.deepEqual(afterRecord.outbox, before.outbox);
    const resolved = await resolveStaleFinanceConflict({...base, expectedEpoch:5,
      observedRevision:1, choice:'ACCEPT_SERVER', explicitUserChoice:true});
    assert.equal(resolved.pending, 0);
    const after = await readAtomicEncryptedCandidate(USER_A, session);
    assert.deepEqual(after.conflicts[0].original, before.outbox[0]);
    session.logout();
  });
}

test('#68 snapshot recovery preserves the encrypted pending command and rejects stale images', async () => {
  const {db, session, identity} = await preparedOfflineQueue();
  await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session, identity, command: pendingCommand(),
    ifMatch: CLOUD_ETAG, expectedEpoch: 1,
  });
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  const newer = cloudPages();
  newer[0].body.revision = 1;
  newer[0].body.entities = [cloudAccount(2, 9_500)];
  const result = await refreshEncryptedCloudSnapshot({
    scope: USER_A, session, identity, pages: newer,
    etag: '"fh.1.1.0123456789abcdef"', expectedEpoch: 2,
  });
  assert.equal(result.serverRevision, 1);
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.deepEqual(after.outbox, before.outbox);
  assert.deepEqual(after.conflicts, before.conflicts);
  assert.equal(after.snapshot.cloudFinance.entities[0].data.balance_minor, 9_500);
  assert.equal(after.snapshot.cloudFinance.serverEtag, '"fh.1.1.0123456789abcdef"');
  assert.equal(after.snapshot.title, before.snapshot.title);
  const second = pendingCommand(22, 'd0000000-0000-4000-8000-000000000002');
  second.base_revision = 1;
  await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session, identity, command: second,
    ifMatch: '"fh.1.1.fedcba9876543210"', expectedEpoch: 3,
  }), /SYNC_HOLD/);
  await assert.rejects(() => refreshEncryptedCloudSnapshot({
    scope: USER_A, session, identity, pages: newer,
    etag: '"fh.1.2.0123456789abcdef"', expectedEpoch: 3,
  }), /SYNC_HOLD/);
  await assert.rejects(() => refreshEncryptedCloudSnapshot({
    scope: USER_A, session, identity, pages: newer,
    etag: '"fh.1.1.fedcba9876543210"', expectedEpoch: 3,
  }), /SYNC_HOLD/);
  await assert.rejects(() => refreshEncryptedCloudSnapshot({
    scope: USER_A, session, identity, pages: cloudPages(),
    etag: '"fh.1.0.0123456789abcdef"', expectedEpoch: 3,
  }), /SYNC_HOLD/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), after);
  db.failBundlePut = true;
  const latest = cloudPages();
  latest[0].body.revision = 2;
  await assert.rejects(() => refreshEncryptedCloudSnapshot({
    scope: USER_A, session, identity, pages: latest,
    etag: '"fh.1.2.0123456789abcdef"', expectedEpoch: 3,
  }));
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), after);
  session.logout();
});

test('#68 snapshot recovery keeps receipts and conflict history across a fresh unlock', async () => {
  const {session, identity} = await preparedOfflineQueue();
  const state = await readAtomicEncryptedCandidate(USER_A, session);
  const proof = {mutationId: PENDING_ID, fingerprint: 'a'.repeat(64), revision: 1};
  state.snapshot.cloudFinance.revision = 1;
  state.snapshot.cloudFinance.appliedReceipts = [proof];
  const conflicts = [{kind: 'synthetic-conflict', mutationId: PENDING_ID}];
  await compareAndSwapAtomicEncryptedCandidate(USER_A, session, 1, 2, {
    snapshot: state.snapshot, outbox: state.outbox, conflicts,
  });
  session.logout();
  const reopened = await unlock(USER_A);
  const newer = cloudPages();
  newer[0].body.revision = 2;
  await refreshEncryptedCloudSnapshot({
    scope: USER_A, session: reopened, identity: cloudAuth(reopened), pages: newer,
    etag: '"fh.1.2.0123456789abcdef"', expectedEpoch: 2,
  });
  const saved = await readAtomicEncryptedCandidate(USER_A, reopened);
  assert.deepEqual(saved.snapshot.cloudFinance.appliedReceipts, [proof]);
  assert.deepEqual(saved.conflicts, conflicts);
  await assert.rejects(() => refreshEncryptedCloudSnapshot({
    scope: USER_A, session, identity, pages: newer,
    etag: '"fh.1.2.0123456789abcdef"', expectedEpoch: 3,
  }), /SYNC_HOLD/);
  reopened.logout();
});

test('#68 offline v2 command is encrypted and never changes confirmed account balance', async () => {
  const {db, session, identity} = await preparedOfflineQueue();
  const previousFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = () => { sends++; throw Error('Network use forbidden'); };
  try {
    const queued = await enqueueEncryptedFinanceCommandCandidate({
      scope: USER_A, session, identity, command: pendingCommand(),
      ifMatch: CLOUD_ETAG, expectedEpoch: 1,
    });
    assert.equal(queued.status, 'QUEUED_ENCRYPTED');
    assert.equal(queued.bundleEpoch, 2);
    assert.equal(queued.pending, 1);
    assert.equal(queued.serverBalanceChanged, false);
    assert.equal(queued.sent, false);
    const state = await readAtomicEncryptedCandidate(USER_A, session);
    assert.equal(state.epoch, 2);
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0].status, 'pending');
    assert.equal(state.outbox[0].mutationId, PENDING_ID);
    assert.equal(state.outbox[0].command.payload.opening_minor, 12_345);
    assert.match(state.outbox[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(state.snapshot.title, SOURCE.snapshot.title);
    assert.equal(state.snapshot.cloudFinance.entities[0].data.balance_minor, 10_000);
    assert.deepEqual(state.conflicts, []);
    const saved = JSON.stringify([...db.tables.get('bundles').values()]);
    for (const privateField of [PENDING_ID, NEW_ACCOUNT_ID,
      'Synthetic cash to encrypt', '12345', CLOUD_ETAG]) {
      assert.equal(saved.includes(privateField), false, 'Outbox plaintext in IndexedDB');
    }
    assert.equal(sends, 0);
  } finally {
    session.logout();
    globalThis.fetch = previousFetch;
  }
});

test('#68 idempotent local retries neither duplicate nor change money', async () => {
  const {session, identity} = await preparedOfflineQueue();
  const args = {
    scope: USER_A, session, identity, command: pendingCommand(),
    ifMatch: CLOUD_ETAG, expectedEpoch: 1,
  };
  const first = await enqueueEncryptedFinanceCommandCandidate(args);
  assert.equal(first.bundleEpoch, 2);
  // Identical JSON with re-ordered fields must produce same local fingerprint.
  const equivalent = structuredClone(args.command);
  equivalent.payload = Object.fromEntries(Object.entries(equivalent.payload).reverse());
  const repeat = await enqueueEncryptedFinanceCommandCandidate({
    ...args, command: equivalent, expectedEpoch: 2,
  });
  assert.equal(repeat.status, 'ALREADY_QUEUED');
  assert.equal(repeat.bundleEpoch, 2);
  const conflicting = {...args, command: pendingCommand(12_346), expectedEpoch: 2};
  await assert.rejects(
    () => enqueueEncryptedFinanceCommandCandidate(conflicting), /SYNC_HOLD/,
  );
  await assert.rejects(
    () => enqueueEncryptedFinanceCommandCandidate({
      ...args, ifMatch: '"a-different-etag"', expectedEpoch: 2,
    }), /SYNC_HOLD/,
  );
  const state = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(state.epoch, 2);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].command.payload.opening_minor, 12_345);
  session.logout();
});

test('#68 stale tab, other account and revoked session cannot enqueue financial writes', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {
    ...clone(SOURCE), outbox: [], conflicts: [],
  });
  const first = await unlock(USER_A);
  const second = await unlock(USER_A);
  await initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session: first, identity: cloudAuth(first),
    pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  });
  const args = {scope: USER_A, session: first,
    identity: cloudAuth(first), command: pendingCommand(),
    ifMatch: CLOUD_ETAG, expectedEpoch: 1};
  assert.equal((await enqueueEncryptedFinanceCommandCandidate(args)).bundleEpoch, 2);
  await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({
    ...args, session: second, identity: cloudAuth(second),
  }), /SYNC_HOLD|другой вкладке/);
  await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({
    ...args, scope: USER_B, expectedEpoch: 2,
  }), /SYNC_HOLD/);
  first.logout();
  await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({
    ...args, expectedEpoch: 2,
  }), /SYNC_HOLD/);
  const latest = await readAtomicEncryptedCandidate(USER_A, second);
  assert.equal(latest.epoch, 2);
  assert.equal(latest.outbox.length, 1);
  assert.equal(latest.snapshot.cloudFinance.entities[0].data.balance_minor, 10_000);
  second.logout();
});

test('#68 malformed command/getter is rejected before crypto or IDB mutation', async () => {
  const {session, identity} = await preparedOfflineQueue();
  const args = {scope: USER_A, session, identity,
    ifMatch: CLOUD_ETAG, expectedEpoch: 1};
  for (const cmd of [
    {...pendingCommand(), schema_version: 1},
    {...pendingCommand(), base_revision: 1},
    pendingCommand(1.5),
    pendingCommand(0, 'not-a-uuid'),
    {...pendingCommand(), action: 'reserve.allocate'},
    {...pendingCommand(), profile_id: CLOUD_PROFILE},
  ]) await assert.rejects(
    () => enqueueEncryptedFinanceCommandCandidate({...args, command: cmd}), /SYNC_HOLD/,
  );
  let getterInvocations = 0;
  const accessors = pendingCommand();
  Object.defineProperty(accessors.payload, 'name', {
    enumerable: true,
    get() { getterInvocations++; return 'attacker-controlled'; },
  });
  await assert.rejects(
    () => enqueueEncryptedFinanceCommandCandidate({
      ...args, command: accessors,
    }), /SYNC_HOLD/,
  );
  assert.equal(getterInvocations, 0);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 1);
  session.logout();
});

test('#68 network ACK cannot silently settle the queue; backoff retains mutation UUID', () => {
  for (const code of [200, 201]) {
    assert.deepEqual(classifyFinanceOutboxResponseCandidate(code), {
      decision: 'VERIFY_DURABLE_RECEIPT_AND_DELTA', retryDelayMs: null,
    });
  }
  for (const code of [401, 403]) {
    assert.equal(classifyFinanceOutboxResponseCandidate(code).decision, 'AUTH_HOLD');
  }
  for (const code of [409, 412]) {
    assert.equal(classifyFinanceOutboxResponseCandidate(code).decision, 'CONFLICT_HOLD');
  }
  assert.equal(classifyFinanceOutboxResponseCandidate(410).decision,
    'SNAPSHOT_REQUIRED_HOLD');
  assert.deepEqual(classifyFinanceOutboxResponseCandidate(null, 0), {
    decision: 'RETRY_SAME_UUID', retryDelayMs: 1000,
  });
  assert.deepEqual(classifyFinanceOutboxResponseCandidate(503, 31), {
    decision: 'RETRY_SAME_UUID', retryDelayMs: 60_000,
  });
  assert.equal(classifyFinanceOutboxResponseCandidate(422).decision, 'RECOVERY_HOLD');
  assert.throws(() => classifyFinanceOutboxResponseCandidate(503, -1), /SYNC_HOLD/);
});


test('#68 encrypted queue survives logout, browser restart and a new unlock generation', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {
    ...clone(SOURCE), outbox: [], conflicts: [],
  });
  const oldSession = await unlock(USER_A);
  const oldIdentity = cloudAuth(oldSession);
  await initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session: oldSession, identity: oldIdentity,
    pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  });
  const first = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: oldSession, identity: oldIdentity,
    command: pendingCommand(), ifMatch: CLOUD_ETAG, expectedEpoch: 1,
  });
  assert.equal(first.bundleEpoch, 2);
  const oldGeneration = oldSession.lifecycleVersion;
  oldSession.logout();

  const restored = new LocalBudgetSession();
  restored.selectScope(USER_A);
  const keyset = await getAtomicEncryptedKeyset(USER_A);
  await restored.unlock(keyset, {passphrase: PASS});
  restored.lock();
  await restored.unlock(keyset, {passphrase: PASS});
  const freshIdentity = cloudAuth(restored);
  assert.notEqual(freshIdentity.generation, oldGeneration);
  assert.equal(restored.state, 'unlocked');
  const current = await readAtomicEncryptedCandidate(USER_A, restored);
  assert.equal(current.epoch, 2);
  assert.equal(current.outbox.length, 1);
  assert.equal(current.outbox[0].generation, oldGeneration);

  const duplicate = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: restored, identity: freshIdentity,
    command: pendingCommand(), ifMatch: CLOUD_ETAG, expectedEpoch: 2,
  });
  assert.equal(duplicate.status, 'ALREADY_QUEUED');
  assert.equal(duplicate.bundleEpoch, 2);
  const newCommand = {
    schema_version: 2,
    client_mutation_id: 'f0000000-0000-4000-8000-000000000002',
    base_revision: 0, action: 'account.update',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 1},
    payload: {account_id: CLOUD_ACCOUNT, name: 'Offline update after restart',
      kind: 'cash'},
  };
  const next = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: restored, identity: freshIdentity,
    command: newCommand, ifMatch: CLOUD_ETAG, expectedEpoch: 2,
  });
  assert.equal(next.pending, 2);
  assert.equal(next.bundleEpoch, 3);

  const synced = await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session: restored, identity: freshIdentity,
    page: verifiedChange(), expectedEpoch: 3,
  });
  assert.equal(synced.status, 'ENCRYPTED_DELTA_SAVED');
  assert.equal(synced.bundleEpoch, 4);
  const after = await readAtomicEncryptedCandidate(USER_A, restored);
  assert.equal(after.snapshot.cloudFinance.revision, 1);
  assert.equal(after.snapshot.cloudFinance.generation, freshIdentity.generation);
  assert.equal(after.snapshot.cloudFinance.entities.find(e => e.id === CLOUD_ACCOUNT)
    .data.balance_minor, 9_500);
  assert.equal(after.outbox.length, 2);
  assert.deepEqual(after.outbox.map(x => x.mutationId),
    [PENDING_ID, newCommand.client_mutation_id]);
  assert.equal(after.outbox[0].status, 'pending');
  assert.equal(after.outbox[1].status, 'pending');
  // An already-persisted UUID survives a newer server cursor unchanged.
  const sameAfterDelta = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: restored, identity: freshIdentity,
    command: pendingCommand(), ifMatch: CLOUD_ETAG, expectedEpoch: 4,
  });
  assert.equal(sameAfterDelta.status, 'ALREADY_QUEUED');
  assert.equal(sameAfterDelta.bundleEpoch, 4);
  // A brand new stale command must never be enqueued at the older revision.
  await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: restored, identity: freshIdentity,
    command: {...newCommand,
      client_mutation_id: 'f0000000-0000-4000-8000-000000000003'},
    ifMatch: CLOUD_ETAG, expectedEpoch: 4,
  }), /SYNC_HOLD/);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, restored)).outbox.length, 2);
  restored.logout();
});


test('#68 v2 offline queue refuses invalid dates, signs, account revisions and RUB changes', async () => {
  const {session, identity} = await preparedOfflineQueue();
  const args = {
    scope: USER_A, session, identity, ifMatch: CLOUD_ETAG, expectedEpoch: 1,
  };
  const original = pendingCommand();
  const bad = [
    {...original, expected_entity_revisions: {[CLOUD_ACCOUNT]: 1}},
    {...original, payload: {...original.payload, name: '  '}},
    {...original, payload: {...original.payload, kind: 'crypto'}},
    {...original, payload: {...original.payload, currency: 'EUR'}},
    {...original, payload: {...original.payload, opening_minor: true}},
  ];
  const income = {
    schema_version: 2,
    client_mutation_id: 'c0000000-0000-4000-8000-000000000001',
    base_revision: 0,
    action: 'transaction.record',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 1},
    payload: {id: 'c0000000-0000-4000-8000-000000000002',
      account_id: CLOUD_ACCOUNT, kind: 'income',
      signed_minor: 500, occurred_on: '2026-11-11'},
  };
  bad.push(
    {...income, payload: {...income.payload, signed_minor: -100}},
    {...income, payload: {...income.payload, occurred_on: '2026-02-30'}},
    {...income, expected_entity_revisions: {}},
    {...income, expected_entity_revisions: {[CLOUD_ACCOUNT]: 1,
      [NEW_ACCOUNT_ID]: 1}},
  );
  const pay = {
    schema_version: 2,
    client_mutation_id: 'c0000000-0000-4000-8000-000000000003',
    base_revision: 0,
    action: 'loan.payment.record',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 1},
    payload: {loan_id: 'c0000000-0000-4000-8000-000000000004',
      account_id: CLOUD_ACCOUNT, amount_minor: 1_000,
      paid_on: '2026-11-11', strategy: 'term'},
  };
  bad.push(pay, {...pay, expected_entity_revisions:
    {[CLOUD_ACCOUNT]: 1, [pay.payload.loan_id]: 1},
    payload: {...pay.payload, paid_on: '2026-13-01'}});
  // Even structurally valid credit commands are not queued until their
  // receipt verifier can prove both the financial posting and payment fact.
  bad.push({...pay, expected_entity_revisions:
    {[CLOUD_ACCOUNT]: 1, [pay.payload.loan_id]: 1}});
  for (const command of bad) {
    await assert.rejects(
      () => enqueueEncryptedFinanceCommandCandidate({...args, command}),
      /SYNC_HOLD/, 'invalid financial command must not be queued',
    );
  }
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(after.epoch, 1);
  assert.deepEqual(after.outbox, []);
  assert.equal(after.snapshot.cloudFinance.entities[0].data.balance_minor, 10_000);
  session.logout();
});


const confirmedAccountEvent = (balance = 12_345) => {
  const entity = {
    ...cloudAccount(1, balance),
    id: NEW_ACCOUNT_ID,
    data: {...cloudAccount(1, balance).data,
      name: 'Synthetic cash to encrypt', type: 'cash',
      opening_minor: balance, balance_minor: balance,
      available_minor: balance},
  };
  return {
    revision: 1, ordinal: 0, kind: 'upsert', entity_id: NEW_ACCOUNT_ID,
    entity_revision: 1, payload: {entity},
  };
};
function confirmedReceiptData(change = confirmedAccountEvent(), overrides = {}) {
  const receipt = {
    schema_version: 2,
    client_mutation_id: PENDING_ID,
    revision: 1,
    replayed: false,
    changes: [change],
  };
  const deltaPage = {
    schema_version: 1, from_revision: 0, to_revision: 1,
    next_since_revision: 1, has_more: false, changes: [change],
  };
  return {receipt, deltaPage, commandHttpStatus: 201, deltaHttpStatus: 200,
    ...overrides};
}
async function pendingAccountCreate() {
  const prepared = await preparedOfflineQueue();
  const first = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: prepared.session,
    identity: prepared.identity, command: pendingCommand(),
    ifMatch: CLOUD_ETAG, expectedEpoch: 1,
  });
  assert.equal(first.bundleEpoch, 2);
  return prepared;
}

test('#68 matching receipt and delta cannot confirm a different account creation', async () => {
  const {session, identity} = await pendingAccountCreate();
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  const wrong = confirmedReceiptData();
  // Both authenticated responses agree with each other but not with the
  // queued intention. Agreement alone must never remove the mutation.
  wrong.receipt.changes[0].payload.entity.data.opening_minor = 99999;
  wrong.receipt.changes[0].payload.entity.data.balance_minor = 99999;
  wrong.receipt.changes[0].payload.entity.data.available_minor = 99999;
  await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, ...wrong,
  }), /SYNC_HOLD/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  session.logout();
});

test('#68 matching receipt and delta must preserve the queued cash movement', async () => {
  const {session, identity} = await preparedOfflineQueue();
  const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 0,
    action: 'transaction.record', expected_entity_revisions: {[CLOUD_ACCOUNT]: 1},
    payload: {id: CLOUD_TRANSACTION, account_id: CLOUD_ACCOUNT, kind: 'expense',
      signed_minor: -1200, occurred_on: '2026-11-11', note: 'Synthetic expense'}};
  await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
    command, ifMatch: CLOUD_ETAG, expectedEpoch: 1});
  const event = {revision: 1, ordinal: 0, kind: 'ledger_posted', entity_id: CLOUD_TRANSACTION,
    entity_revision: 1, payload: {account_id: CLOUD_ACCOUNT, signed_minor: -1200,
      transaction_kind: 'expense', entity: {id: CLOUD_TRANSACTION, kind: 'transaction',
        entity_revision: 1, data: {kind: 'expense', occurred_on: '2026-11-11',
          note: 'Synthetic expense', posted_at: '2026-11-11T12:00:00Z',
          reversed_transaction_id: null, postings: [{account_id: CLOUD_ACCOUNT, signed_minor: -1200}]}},
      accounts: [cloudAccount(2, 8800)]}};
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => { e.payload.entity.data.note = 'Different intention'; },
    e => { e.payload.entity.data.occurred_on = '2026-11-12'; },
    e => { e.payload.entity.data.postings[0].signed_minor = -1300;
      e.payload.signed_minor = -1300; e.payload.accounts[0].data.balance_minor = 8700;
      e.payload.accounts[0].data.available_minor = 8700; },
    e => { e.payload.entity.data.postings[0].account_id = NEW_ACCOUNT_ID; },
    e => { e.payload.accounts[0].data.name = 'Changed account'; },
  ]) {
    const wrong = structuredClone(event); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2, ...confirmedReceiptData(wrong),
    }), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const accepted = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, ...confirmedReceiptData(event),
  });
  assert.equal(accepted.status, 'DURABLY_CONFIRMED');
  session.logout();
});

for (const action of ['account.update', 'account.archive', 'account.unarchive']) {
  test('#68 receipt confirms exact account intent for ' + action, async () => {
    const {session, identity} = await preparedOfflineQueue();
    if (action === 'account.unarchive') {
      // A prior authenticated snapshot can contain an archived account.
      const original = await readAtomicEncryptedCandidate(USER_A, session);
      original.snapshot.cloudFinance.entities[0].data.archived_at = '2026-11-10T00:00:00Z';
      await compareAndSwapAtomicEncryptedCandidate(USER_A, session, 1, 2, {
        snapshot: original.snapshot, outbox: original.outbox, conflicts: original.conflicts,
      });
    }
    const startEpoch = action === 'account.unarchive' ? 2 : 1;
    const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 0,
      action, expected_entity_revisions: {[CLOUD_ACCOUNT]: 1},
      payload: action === 'account.update'
        ? {account_id: CLOUD_ACCOUNT, name: 'Updated cash', kind: 'cash'}
        : {account_id: CLOUD_ACCOUNT}};
    await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
      command, ifMatch: CLOUD_ETAG, expectedEpoch: startEpoch});
    const entity = cloudAccount(2, 10000);
    if (action === 'account.update') {entity.data.name = 'Updated cash'; entity.data.type = 'cash';}
    if (action === 'account.archive') entity.data.archived_at = '2026-11-11T12:00:00Z';
    const event = {revision: 1, ordinal: 0, kind: 'upsert', entity_id: CLOUD_ACCOUNT,
      entity_revision: 2, payload: {entity}};
    const before = await readAtomicEncryptedCandidate(USER_A, session);
    for (const alter of [
      e => {e.payload.entity.data.balance_minor = 9999; e.payload.entity.data.available_minor = 9999;},
      e => {e.payload.entity.data.name = 'Different account';},
      e => {e.payload.entity.data.archived_at = action === 'account.archive' ? null : '2026-11-11T12:00:00Z';},
    ]) {
      const wrong = structuredClone(event); alter(wrong);
      await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope: USER_A, session,
        identity, expectedEpoch: startEpoch + 1, ...confirmedReceiptData(wrong)}), /SYNC_HOLD/);
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
    }
    const accepted = await persistAuthenticatedFinanceReceiptCandidate({scope: USER_A, session,
      identity, expectedEpoch: startEpoch + 1, ...confirmedReceiptData(event)});
    assert.equal(accepted.status, 'DURABLY_CONFIRMED');
    session.logout();
  });
}

test('#68 queued reversal confirms the exact original posting before removing it', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A), identity = cloudAuth(session), pages = cloudPages();
  pages[0].body.entities.push({id:CLOUD_TRANSACTION, kind:'transaction', entity_revision:1,
    data:{kind:'income', occurred_on:'2026-11-11', note:null, posted_at:'2026-11-11T12:00:00Z',
      reversed_transaction_id:null, postings:[{account_id:CLOUD_ACCOUNT, signed_minor:1200}]}});
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command = {schema_version:1, client_mutation_id:PENDING_ID, base_revision:0,
    action:'transaction.reverse', expected_entity_revisions:{[CLOUD_TRANSACTION]:1, [CLOUD_ACCOUNT]:1},
    payload:{transaction_id:CLOUD_TRANSACTION, reason:'Synthetic correction'}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity,
    command, ifMatch:CLOUD_ETAG, expectedEpoch:1});
  const reversalId = '10000000-0000-4000-8000-000000000005';
  const event = {revision:1, ordinal:0, kind:'ledger_posted', entity_id:reversalId, entity_revision:1,
    payload:{transaction_kind:'reversal', reversed_transaction_id:CLOUD_TRANSACTION,
      entity:{id:reversalId, kind:'transaction', entity_revision:1,
        data:{kind:'reversal', occurred_on:'2026-11-12', note:'Synthetic correction',
          posted_at:'2026-11-12T12:00:00Z', reversed_transaction_id:CLOUD_TRANSACTION,
          postings:[{account_id:CLOUD_ACCOUNT, signed_minor:-1200}]}}, accounts:[cloudAccount(2, 8800)]}};
  const evidence = change => {
    const value = confirmedReceiptData(change);
    value.receipt.schema_version = 1;
    return value;
  };
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => {e.payload.entity.data.reversed_transaction_id = NEW_ACCOUNT_ID;},
    e => {e.payload.entity.data.postings[0].signed_minor = -1300;
      e.payload.accounts[0].data.balance_minor = 8700; e.payload.accounts[0].data.available_minor = 8700;},
    e => {e.payload.entity.data.note = 'Different reason';},
  ]) {
    const wrong = structuredClone(event); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
      expectedEpoch:2, ...evidence(wrong)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const result = await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:2, ...evidence(event)});
  assert.equal(result.status, 'DURABLY_CONFIRMED');
  session.logout();
});

for (const opening of [0,1200]) test(`#68 reserve creation confirms its exact plan and opening ${opening}`, async () => {
  const obligationId = '10000000-0000-4000-8000-000000000003';
  const reserveId = '10000000-0000-4000-8000-000000000004';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
  const session = await unlock(USER_A), identity = cloudAuth(session), pages = cloudPages();
  pages[0].body.entities.push({id:obligationId, kind:'obligation', entity_revision:1,
    data:{title:'Synthetic bill', direction:'expense', deleted_at:null}});
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command = {schema_version:2, client_mutation_id:PENDING_ID, base_revision:0,
    action:'reserve.create', expected_entity_revisions:{[CLOUD_ACCOUNT]:1, [obligationId]:1},
    payload:{id:reserveId, account_id:CLOUD_ACCOUNT, obligation_id:obligationId,
      title:'Synthetic reserve', target_minor:5000, opened_on:'2026-10-12', first_due_on:'2026-11-12',
      period_months:1, due_day:12, contribution_mode:'auto', opening_reserved_minor:opening}};
  const args = {scope:USER_A, session, identity, ifMatch:CLOUD_ETAG, expectedEpoch:1};
  for (const payload of [{...command.payload, first_due_on:'2027-11-12'},
    {...command.payload, due_day:13}, {...command.payload, opening_reserved_minor:-1},
    {...command.payload, fixed_monthly_minor:100}]) {
    await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({...args, command:{...command,payload}}), /SYNC_HOLD/);
  }
  await enqueueEncryptedFinanceCommandCandidate({...args,command});
  const reserve = {id:reserveId, kind:'reserve', entity_revision:1, data:{title:'Synthetic reserve',
    account_id:CLOUD_ACCOUNT, obligation_id:obligationId, target_minor:5000, opening_target_minor:5000,
    opening_reserved_minor:opening, allocated_minor:opening, opened_on:'2026-10-12',
    first_due_on:'2026-11-12', target_on:'2026-11-12', period_months:1, due_day:12,
    contribution_mode:'auto', fixed_monthly_minor:null, cycle_number:1, archived_at:null,
    allocations_by_account:opening ? [{account_id:CLOUD_ACCOUNT,allocated_minor:opening}] : [], event_log:[]}};
  const changes = [{revision:1, ordinal:0, kind:'upsert', entity_id:reserveId,
    entity_revision:1, payload:{entity:reserve}}];
  if (opening) {
    const account=cloudAccount(2,10000); account.data.reserved_minor=opening; account.data.available_minor=10000-opening;
    changes.push({revision:1, ordinal:1, kind:'upsert', entity_id:CLOUD_ACCOUNT, entity_revision:2, payload:{entity:account}});
  }
  const evidence = events => ({receipt:{schema_version:2, client_mutation_id:PENDING_ID,
    revision:1, replayed:false, changes:events}, deltaPage:{schema_version:1, from_revision:0,
    to_revision:1, next_since_revision:1, has_more:false, changes:events}, commandHttpStatus:201, deltaHttpStatus:200});
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [e => {e[0].payload.entity.data.target_minor=6000;},
    e => {e[0].payload.entity.data.account_id=NEW_ACCOUNT_ID;},
    e => {e[0].payload.entity.data.due_day=13;},
    ...(opening ? [e => {e[1].payload.entity.data.balance_minor=9000;}] : [])]) {
    const wrong=structuredClone(changes); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
      identity, expectedEpoch:2, ...evidence(wrong)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const proof=evidence(changes);
  await persistEncryptedCloudDeltaCandidate({scope:USER_A, session, identity,
    page:proof.deltaPage, expectedEpoch:2});
  const result = await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:3, ...proof, receipt:{...proof.receipt,replayed:true}, commandHttpStatus:200});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  assert.equal(result.serverBalanceChanged,false);
  session.logout();
});

test('#68 cycle close and undo keep the original month-end anchor and exact history', async () => {
  const reserveId='10000000-0000-4000-8000-000000000003';
  const closeId='10000000-0000-4000-8000-000000000004';
  const voidId='10000000-0000-4000-8000-000000000005';
  const voidMutation='10000000-0000-4000-8000-000000000006';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
  const session=await unlock(USER_A), identity=cloudAuth(session), pages=cloudPages();
  pages[0].body.revision=1;
  const reserve={id:reserveId,kind:'reserve',entity_revision:1,data:{title:'Synthetic',archived_at:null,
    first_due_on:'2026-01-31',target_on:'2026-01-31',period_months:1,due_day:31,cycle_number:1,
    allocated_minor:0,event_log:[]}};
  pages[0].body.entities.push(reserve);
  await initializeEncryptedCloudCacheCandidate({scope:USER_A,session,identity,pages,
    expectedEpoch:0,confirmedAccountCacheInitialization:true});
  const close={schema_version:2,client_mutation_id:PENDING_ID,base_revision:1,action:'reserve.cycle.close',
    expected_entity_revisions:{[reserveId]:1},payload:{reserve_id:reserveId,occurred_on:'2026-01-31'}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A,session,identity,command:close,
    ifMatch:CLOUD_ETAG,expectedEpoch:1});
  const closeEvent={id:closeId,reserve_id:reserveId,kind:'cycle_close',revision:2,cycle_number:1,
    occurred_on:'2026-01-31',target_event_id:null};
  const closed={...reserve,entity_revision:2,data:{...reserve.data,cycle_number:2,
    target_on:'2026-02-28',event_log:[closeEvent]}};
  const closeChange={revision:2,ordinal:0,kind:'upsert',entity_id:reserveId,entity_revision:2,
    payload:{entity:closed,event_id:closeId,next_due_on:'2026-02-28'}};
  const proof=(change,id,revision)=>({receipt:{schema_version:2,client_mutation_id:id,revision,replayed:false,changes:[change]},
    deltaPage:{schema_version:1,from_revision:revision-1,to_revision:revision,next_since_revision:revision,
      has_more:false,changes:[change]},commandHttpStatus:201,deltaHttpStatus:200});
  const before=await readAtomicEncryptedCandidate(USER_A,session);
  for(const alter of [e=>{e.payload.entity.data.target_on='2026-03-03';e.payload.next_due_on='2026-03-03';},
    e=>{e.payload.entity.data.allocated_minor=10;},e=>{e.payload.entity.data.event_log[0].cycle_number=2;}]) {
    const wrong=structuredClone(closeChange);alter(wrong);
    await assert.rejects(()=>persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
      expectedEpoch:2,...proof(wrong,PENDING_ID,2)}),/SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A,session),before);
  }
  await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
    expectedEpoch:2,...proof(closeChange,PENDING_ID,2)});
  const undo={schema_version:2,client_mutation_id:voidMutation,base_revision:2,action:'reserve.cycle.void',
    expected_entity_revisions:{[reserveId]:2},payload:{reserve_id:reserveId,occurred_on:'2026-01-31',reason:'Correction'}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A,session,identity,command:undo,
    ifMatch:CLOUD_ETAG,expectedEpoch:3});
  const voidEvent={id:voidId,reserve_id:reserveId,kind:'void',revision:3,cycle_number:1,
    occurred_on:'2026-01-31',target_event_id:closeId,note:'Correction'};
  const restored={...reserve,entity_revision:3,data:{...reserve.data,event_log:[closeEvent,voidEvent]}};
  const voidChange={revision:3,ordinal:0,kind:'upsert',entity_id:reserveId,entity_revision:3,
    payload:{entity:restored,event_id:voidId,voided_event_id:closeId,restored_due_on:'2026-01-31'}};
  const queued=await readAtomicEncryptedCandidate(USER_A,session);
  for(const alter of [e=>{e.payload.entity.data.event_log[1].target_event_id=NEW_ACCOUNT_ID;},
    e=>{e.payload.entity.data.event_log[1].note='Wrong';},e=>{e.payload.entity.data.target_on='2026-02-28';}]) {
    const wrong=structuredClone(voidChange);alter(wrong);
    await assert.rejects(()=>persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
      expectedEpoch:4,...proof(wrong,voidMutation,3)}),/SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A,session),queued);
  }
  const result=await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
    expectedEpoch:4,...proof(voidChange,voidMutation,3)});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  session.logout();
});

for (const kind of ['skip','contribution']) test(`#68 voiding ${kind} verifies event and compensation`, async () => {
  const reserveId='10000000-0000-4000-8000-000000000003';
  const originalId='10000000-0000-4000-8000-000000000004';
  const voidId='10000000-0000-4000-8000-000000000005';
  const allocationId='10000000-0000-4000-8000-000000000006';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
  const session=await unlock(USER_A), identity=cloudAuth(session), pages=cloudPages();
  pages[0].body.revision=1;
  const money=kind==='contribution', priorAmount=money?1200:0;
  pages[0].body.entities[0].data.reserved_minor=priorAmount;
  pages[0].body.entities[0].data.available_minor=10000-priorAmount;
  const original={id:originalId, reserve_id:reserveId, kind, cycle_number:1, revision:1,
    amount_minor:money?1200:null};
  const reserve={id:reserveId,kind:'reserve',entity_revision:1,data:{title:'Synthetic reserve',
    account_id:CLOUD_ACCOUNT,archived_at:null,period_months:1,cycle_number:1,allocated_minor:priorAmount,
    allocations_by_account:money?[{account_id:CLOUD_ACCOUNT,allocated_minor:1200}]:[],event_log:[original]}};
  pages[0].body.entities.push(reserve);
  await initializeEncryptedCloudCacheCandidate({scope:USER_A,session,identity,pages,
    expectedEpoch:0,confirmedAccountCacheInitialization:true});
  const command={schema_version:2,client_mutation_id:PENDING_ID,base_revision:1,action:'reserve.event.void',
    expected_entity_revisions:{[reserveId]:1,[CLOUD_ACCOUNT]:1},payload:{reserve_id:reserveId,
      account_id:CLOUD_ACCOUNT,target_event_id:originalId,occurred_on:'2026-11-12',reason:'Correction'}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A,session,identity,command,
    ifMatch:CLOUD_ETAG,expectedEpoch:1});
  const voidEvent={id:voidId,reserve_id:reserveId,kind:'void',revision:2,cycle_number:1,
    target_event_id:originalId,occurred_on:'2026-11-12',note:'Correction',allocation_id:money?allocationId:null};
  const updated={...reserve,entity_revision:2,data:{...reserve.data,allocated_minor:0,
    allocations_by_account:[],event_log:[original,voidEvent]}};
  const events=[{revision:2,ordinal:0,kind:'upsert',entity_id:reserveId,entity_revision:2,
    payload:{entity:updated,event_id:voidId,voided_event_id:originalId}}];
  if(money) events.push({revision:2,ordinal:1,kind:'upsert',entity_id:CLOUD_ACCOUNT,entity_revision:2,
    payload:{entity:cloudAccount(2,10000)}});
  const evidence=changes=>({receipt:{schema_version:2,client_mutation_id:PENDING_ID,revision:2,replayed:false,changes},
    deltaPage:{schema_version:1,from_revision:1,to_revision:2,next_since_revision:2,has_more:false,changes},
    commandHttpStatus:201,deltaHttpStatus:200});
  const before=await readAtomicEncryptedCandidate(USER_A,session);
  for(const alter of [e=>{e[0].payload.entity.data.event_log[1].target_event_id=NEW_ACCOUNT_ID;},
    e=>{e[0].payload.entity.data.event_log[1].note='Wrong';},
    e=>{e[0].payload.entity.data.allocated_minor=1;},
    ...(money?[e=>{e[1].payload.entity.data.balance_minor=9000;}]:[])]) {
    const wrong=structuredClone(events);alter(wrong);
    await assert.rejects(()=>persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
      expectedEpoch:2,...evidence(wrong)}),/SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A,session),before);
  }
  const proof=evidence(events);
  await persistEncryptedCloudDeltaCandidate({scope:USER_A,session,identity,page:proof.deltaPage,expectedEpoch:2});
  const result=await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
    expectedEpoch:3,...proof,receipt:{...proof.receipt,replayed:true},commandHttpStatus:200});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  session.logout();
});

test('#68 skipped contribution is acknowledged only for its exact slot and event', async () => {
  const reserveId='10000000-0000-4000-8000-000000000003';
  const eventId='10000000-0000-4000-8000-000000000004';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
  const session=await unlock(USER_A), identity=cloudAuth(session), pages=cloudPages();
  const reserve={id:reserveId, kind:'reserve', entity_revision:1, data:{title:'Synthetic reserve',
    archived_at:null, allocated_minor:0, period_months:1, cycle_number:1, event_log:[]}};
  pages[0].body.entities.push(reserve);
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command={schema_version:2, client_mutation_id:PENDING_ID, base_revision:0, action:'reserve.skip',
    expected_entity_revisions:{[reserveId]:1}, payload:{reserve_id:reserveId,
      slot_on:'2026-11-12', occurred_on:'2026-11-12'}};
  const args={scope:USER_A, session, identity, ifMatch:CLOUD_ETAG, expectedEpoch:1};
  await assert.rejects(()=>enqueueEncryptedFinanceCommandCandidate({...args,command:{...command,
    payload:{...command.payload, occurred_on:'2026-11-11'}}}), /SYNC_HOLD/);
  await enqueueEncryptedFinanceCommandCandidate({...args,command});
  const event={id:eventId, reserve_id:reserveId, kind:'skip', occurred_on:'2026-11-12',
    cycle_number:1, revision:1, slot_on:'2026-11-12'};
  const updated={...reserve, entity_revision:2, data:{...reserve.data,event_log:[event]}};
  const change={revision:1, ordinal:0, kind:'upsert', entity_id:reserveId, entity_revision:2,
    payload:{entity:updated,event_id:eventId}};
  const before=await readAtomicEncryptedCandidate(USER_A,session);
  for(const alter of [e=>{e.payload.entity.data.event_log[0].slot_on='2026-12-12';},
    e=>{e.payload.entity.data.allocated_minor=10;},e=>{e.payload.event_id=NEW_ACCOUNT_ID;}]) {
    const wrong=structuredClone(change); alter(wrong);
    await assert.rejects(()=>persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
      expectedEpoch:2,...confirmedReceiptData(wrong)}),/SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A,session),before);
  }
  const result=await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A,session,identity,
    expectedEpoch:2,...confirmedReceiptData(change)});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  session.logout();
});

test('#68 reserve plan change checks the title, target, history and untouched allocations', async () => {
  const reserveId='10000000-0000-4000-8000-000000000003';
  const eventId='10000000-0000-4000-8000-000000000004';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
  const session=await unlock(USER_A), identity=cloudAuth(session), pages=cloudPages();
  pages[0].body.entities[0].data.reserved_minor=1200;
  pages[0].body.entities[0].data.available_minor=8800;
  const reserve={id:reserveId, kind:'reserve', entity_revision:1, data:{title:'Old', target_minor:5000,
    target_on:'2026-11-12', first_due_on:'2026-11-12', opened_on:'2026-10-12',
    period_months:1, due_day:12, contribution_mode:'auto', fixed_monthly_minor:null,
    cycle_number:1, archived_at:null, allocated_minor:1200,
    allocations_by_account:[{account_id:CLOUD_ACCOUNT, allocated_minor:1200}], event_log:[]}};
  pages[0].body.entities.push(reserve);
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command={schema_version:2, client_mutation_id:PENDING_ID, base_revision:0, action:'reserve.update',
    expected_entity_revisions:{[reserveId]:1}, payload:{reserve_id:reserveId, title:'New', target_minor:6000,
      first_due_on:'2026-11-12', period_months:1, due_day:12, contribution_mode:'auto', occurred_on:'2026-11-12'}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity, command,
    ifMatch:CLOUD_ETAG, expectedEpoch:1});
  const event={id:eventId, reserve_id:reserveId, kind:'target_change', occurred_on:'2026-11-12',
    cycle_number:1, revision:1, target_minor:6000};
  const updated={...reserve, entity_revision:2, data:{...reserve.data, title:'New', target_minor:6000, event_log:[event]}};
  const change={revision:1, ordinal:0, kind:'upsert', entity_id:reserveId, entity_revision:2, payload:{entity:updated}};
  const before=await readAtomicEncryptedCandidate(USER_A,session);
  for (const alter of [e=>{e.payload.entity.data.title='Wrong';},
    e=>{e.payload.entity.data.allocated_minor=0;},
    e=>{e.payload.entity.data.event_log[0].target_minor=7000;},
    e=>{e.payload.entity.data.event_log[0].occurred_on='2026-11-13';}]) {
    const wrong=structuredClone(change); alter(wrong);
    await assert.rejects(()=>persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
      expectedEpoch:2, ...confirmedReceiptData(wrong)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A,session),before);
  }
  const proof=confirmedReceiptData(change);
  await persistEncryptedCloudDeltaCandidate({scope:USER_A, session, identity, page:proof.deltaPage, expectedEpoch:2});
  const result=await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:3, ...proof, receipt:{...proof.receipt,replayed:true}, commandHttpStatus:200});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  session.logout();
});

test('#68 reserve allocation requires exact event, account and allocation balances', async () => {
  const reserveId = '10000000-0000-4000-8000-000000000003';
  const allocationId = '10000000-0000-4000-8000-000000000004';
  const eventId = '10000000-0000-4000-8000-000000000005';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A), identity = cloudAuth(session), pages = cloudPages();
  const reserve = {id:reserveId, kind:'reserve', entity_revision:1, data:{title:'Synthetic reserve',
    account_id:CLOUD_ACCOUNT, archived_at:null, allocated_minor:0, period_months:1, cycle_number:1,
    allocations_by_account:[], event_log:[]}};
  pages[0].body.entities.push(reserve);
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command = {schema_version:2, client_mutation_id:PENDING_ID, base_revision:0,
    action:'reserve.allocate', expected_entity_revisions:{[CLOUD_ACCOUNT]:1, [reserveId]:1},
    payload:{reserve_id:reserveId, account_id:CLOUD_ACCOUNT, delta_minor:1200, occurred_on:'2026-11-11'}};
  const args = {scope:USER_A, session, identity, ifMatch:CLOUD_ETAG, expectedEpoch:1};
  for (const invalid of [
    {...command, payload:{...command.payload, delta_minor:0}},
    {...command, payload:{...command.payload, occurred_on:'2026-02-30'}},
    {...command, expected_entity_revisions:{[CLOUD_ACCOUNT]:1, [reserveId]:2}},
  ]) await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({...args, command:invalid}), /SYNC_HOLD/);
  await enqueueEncryptedFinanceCommandCandidate({...args, command});
  const event = {id:eventId, reserve_id:reserveId, kind:'contribution', occurred_on:'2026-11-11',
    cycle_number:1, revision:1, amount_minor:1200, allocation_id:allocationId};
  const updated = {...reserve, entity_revision:2, data:{...reserve.data, allocated_minor:1200,
    allocations_by_account:[{account_id:CLOUD_ACCOUNT, allocated_minor:1200}], event_log:[event]}};
  const account = cloudAccount(2,10000);
  account.data.reserved_minor = 1200;
  account.data.available_minor = 8800;
  const changes = [
    {revision:1, ordinal:0, kind:'upsert', entity_id:reserveId, entity_revision:2,
      payload:{entity:updated, account_id:CLOUD_ACCOUNT, delta_minor:1200, allocation_id:allocationId}},
    {revision:1, ordinal:1, kind:'upsert', entity_id:CLOUD_ACCOUNT, entity_revision:2, payload:{entity:account}},
  ];
  const evidence = events => ({receipt:{schema_version:2, client_mutation_id:PENDING_ID,
    revision:1, replayed:false, changes:events}, deltaPage:{schema_version:1, from_revision:0,
    to_revision:1, next_since_revision:1, has_more:false, changes:events},
    commandHttpStatus:201, deltaHttpStatus:200});
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => {e[0].payload.delta_minor = 1300;},
    e => {e[0].payload.entity.data.event_log[0].allocation_id = NEW_ACCOUNT_ID;},
    e => {e[0].payload.entity.data.event_log[0].occurred_on = '2026-11-12';},
    e => {e[0].payload.entity.data.allocations_by_account[0].allocated_minor = 1300;},
    e => {e[1].payload.entity.data.balance_minor = 9000;},
    e => {e[1].payload.entity.data.reserved_minor = 1300;},
  ]) {
    const wrong = structuredClone(changes); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
      identity, expectedEpoch:2, ...evidence(wrong)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  // A crash after writing the independent delta must still permit a replay
  // without adding the allocation or moving the account balance twice.
  const proof = evidence(changes);
  await persistEncryptedCloudDeltaCandidate({scope:USER_A, session, identity,
    page:proof.deltaPage, expectedEpoch:2});
  const result = await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:3, ...proof, receipt:{...proof.receipt, replayed:true}, commandHttpStatus:200});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  assert.equal(result.serverBalanceChanged,false);
  session.logout();
});

test('#68 archive keeps zero reserve intact and verifies the exact server transition', async () => {
  const reserveId = '10000000-0000-4000-8000-000000000003';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
  const session = await unlock(USER_A), identity = cloudAuth(session), pages = cloudPages();
  const reserve = {id:reserveId, kind:'reserve', entity_revision:1,
    data:{title:'Synthetic reserve', archived_at:null, allocated_minor:0, event_log:[]}};
  pages[0].body.entities.push(reserve);
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command = {schema_version:2, client_mutation_id:PENDING_ID, base_revision:0,
    action:'reserve.archive', expected_entity_revisions:{[reserveId]:1}, payload:{reserve_id:reserveId}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity,
    command, ifMatch:CLOUD_ETAG, expectedEpoch:1});
  const archived = {...reserve, entity_revision:2,
    data:{...reserve.data, archived_at:'2026-11-12T12:00:00Z'}};
  const change = {revision:1, ordinal:0, kind:'upsert', entity_id:reserveId,
    entity_revision:2, payload:{entity:archived}};
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => {e.payload.entity.data.archived_at = null;},
    e => {e.payload.entity.data.title = 'Wrong';},
    e => {e.payload.entity.data.allocated_minor = 10;},
  ]) {
    const wrong = structuredClone(change); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
      identity, expectedEpoch:2, ...confirmedReceiptData(wrong)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const result = await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:2, ...confirmedReceiptData(change)});
  assert.equal(result.status,'DURABLY_CONFIRMED');
  session.logout();
});

test('#68 obligation creation is confirmed only against its exact queued intent', async () => {
  const {session, identity} = await preparedOfflineQueue();
  const command = {schema_version:1, client_mutation_id:PENDING_ID, base_revision:0,
    action:'obligation.create', expected_entity_revisions:{}, payload:{title:'Synthetic obligation',
      direction:'expense', amount_minor:1200, starts_on:'2026-11-11', timezone:'UTC',
      recurrence_unit:'month', recurrence_every:1}};
  const args = {scope:USER_A, session, identity, ifMatch:CLOUD_ETAG, expectedEpoch:1};
  for (const payload of [
    {...command.payload, starts_on:'2026-02-30'}, {...command.payload, timezone:'Not/A_Timezone'},
    {...command.payload, recurrence_every:0}, {...command.payload, amount_minor:-1},
  ]) await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({...args, command:{...command,payload}}), /SYNC_HOLD/);
  await enqueueEncryptedFinanceCommandCandidate({...args, command});
  const event = {revision:1, ordinal:0, kind:'upsert', entity_id:NEW_ACCOUNT_ID, entity_revision:1,
    payload:{entity:{id:NEW_ACCOUNT_ID, kind:'obligation', entity_revision:1,
      data:{...command.payload, category:null, deleted_at:null}}}};
  const evidence = change => {
    const proof = confirmedReceiptData(change);
    proof.receipt.schema_version = 1;
    return proof;
  };
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => {e.payload.entity.data.amount_minor = 1300;},
    e => {e.payload.entity.data.title = 'Other';},
    e => {e.payload.entity.data.recurrence_unit = 'year';},
    e => {e.payload.entity.data.timezone = 'Europe/Moscow';},
  ]) {
    const wrong = structuredClone(event); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
      identity, expectedEpoch:2, ...evidence(wrong)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const result = await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
    identity, expectedEpoch:2, ...evidence(event)});
  assert.equal(result.status, 'DURABLY_CONFIRMED');
  session.logout();
});

test('#68 credit payment and reversal require their exact linked fact and postings', async () => {
  const loanId = '10000000-0000-4000-8000-000000000003';
  const factId = '10000000-0000-4000-8000-000000000004';
  const reversalId = '10000000-0000-4000-8000-000000000005';
  const reverseMutation = '10000000-0000-4000-8000-000000000006';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A), identity = cloudAuth(session), pages = cloudPages();
  pages[0].body.entities.push({id:loanId, kind:'loan', entity_revision:1,
    data:{title:'Synthetic loan', deleted_at:null}});
  await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
    expectedEpoch:0, confirmedAccountCacheInitialization:true});
  const command = {schema_version:2, client_mutation_id:PENDING_ID, base_revision:0,
    action:'loan.payment.record', expected_entity_revisions:{[CLOUD_ACCOUNT]:1, [loanId]:1},
    payload:{loan_id:loanId, account_id:CLOUD_ACCOUNT, amount_minor:1200,
      paid_on:'2026-11-11', strategy:'term'}};
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity,
    command, ifMatch:CLOUD_ETAG, expectedEpoch:1});
  const tx = {id:CLOUD_TRANSACTION, entity_revision:1, kind:'transaction', data:{kind:'payment',
    occurred_on:'2026-11-11', posted_at:'2026-11-11T12:00:00Z', note:null,
    reversed_transaction_id:null, postings:[{account_id:CLOUD_ACCOUNT, signed_minor:-1200}],
    payment_link:{settlement_id:null, loan_payment_id:factId}}};
  const fact = {id:factId, entity_revision:1, kind:'loan_payment', data:{loan_id:loanId,
    paid_on:'2026-11-11', amount_minor:1200, strategy:'term', voided_at:null}};
  const record = [
    {revision:1, ordinal:0, kind:'ledger_posted', entity_id:tx.id, entity_revision:1,
      payload:{entity:tx, accounts:[cloudAccount(2,8800)]}},
    {revision:1, ordinal:1, kind:'upsert', entity_id:fact.id, entity_revision:1, payload:{entity:fact}},
  ];
  const evidence = (events, id, revision) => ({
    receipt:{schema_version:2, client_mutation_id:id, revision, replayed:false, changes:events},
    deltaPage:{schema_version:1, from_revision:revision-1, to_revision:revision,
      next_since_revision:revision, has_more:false, changes:events},
    commandHttpStatus:201, deltaHttpStatus:200,
  });
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => {e[1].payload.entity.data.loan_id = NEW_ACCOUNT_ID;},
    e => {e[1].payload.entity.data.strategy = 'amount';},
    e => {e[1].payload.entity.data.paid_on = '2026-11-12';},
    e => {e[0].payload.entity.data.payment_link.loan_payment_id = NEW_ACCOUNT_ID;},
    e => {e[0].payload.entity.data.postings[0].signed_minor = -1300;},
  ]) {
    const wrong = structuredClone(record); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
      identity, expectedEpoch:2, ...evidence(wrong, PENDING_ID, 1)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:2, ...evidence(record, PENDING_ID, 1)});
  const undo = {schema_version:2, client_mutation_id:reverseMutation, base_revision:1,
    action:'loan.payment.void', expected_entity_revisions:{[CLOUD_ACCOUNT]:2, [tx.id]:1, [factId]:1},
    payload:{transaction_id:tx.id, fact_id:factId, account_id:CLOUD_ACCOUNT, reason:'Correction'}};
  const current = await readAtomicEncryptedCandidate(USER_A, session);
  await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity, command:undo,
    ifMatch:current.snapshot.cloudFinance.serverEtag || CLOUD_ETAG, expectedEpoch:3});
  const reverseTx = {id:reversalId, entity_revision:1, kind:'transaction', data:{kind:'reversal',
    occurred_on:'2026-11-12', posted_at:'2026-11-12T12:00:00Z', note:'Correction',
    reversed_transaction_id:tx.id, postings:[{account_id:CLOUD_ACCOUNT, signed_minor:1200}]}};
  const voidFact = {...fact, entity_revision:2, data:{...fact.data, voided_at:'2026-11-12T12:00:00Z'}};
  const cancelled = [
    {revision:2, ordinal:0, kind:'ledger_posted', entity_id:reversalId, entity_revision:1,
      payload:{entity:reverseTx, accounts:[cloudAccount(3,10000)]}},
    {revision:2, ordinal:1, kind:'upsert', entity_id:factId, entity_revision:2, payload:{entity:voidFact}},
  ];
  const queued = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    e => {e[0].payload.entity.data.note = 'Other';},
    e => {e[0].payload.entity.data.reversed_transaction_id = NEW_ACCOUNT_ID;},
    e => {e[1].payload.entity.data.strategy = 'amount';},
    e => {e[1].payload.entity.data.voided_at = null;},
    e => {e[0].payload.entity.data.postings[0].signed_minor = 1300;},
  ]) {
    const wrong = structuredClone(cancelled); alter(wrong);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session,
      identity, expectedEpoch:4, ...evidence(wrong, reverseMutation, 2)}), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), queued);
  }
  await persistAuthenticatedFinanceReceiptCandidate({scope:USER_A, session, identity,
    expectedEpoch:4, ...evidence(cancelled, reverseMutation, 2)});
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length, 0);
  session.logout();
});

test('#138 a matching receipt and delta must also match the queued settlement', async () => {
  const obligationId = '10000000-0000-4000-8000-000000000003';
  const factId = '10000000-0000-4000-8000-000000000004';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  const pages = cloudPages();
  pages[0].body.entities.push({id: obligationId, kind: 'obligation', entity_revision: 1,
    data: {title: 'Synthetic obligation', direction: 'expense', amount_minor: 5000}});
  await initializeEncryptedCloudCacheCandidate({scope: USER_A, session, identity, pages,
    expectedEpoch: 0, confirmedAccountCacheInitialization: true});
  const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 0,
    action: 'settlement.payment.record',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 1, [obligationId]: 1},
    payload: {obligation_id: obligationId, account_id: CLOUD_ACCOUNT, amount_minor: 1200,
      paid_on: '2026-11-11', occurrence_on: '2026-11-08'}};
  await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
    command, ifMatch: CLOUD_ETAG, expectedEpoch: 1});
  function evidence(amount) {
    const transaction = {id: CLOUD_TRANSACTION, entity_revision: 1, kind: 'transaction', data: {
      kind: 'payment', occurred_on: '2026-11-11', posted_at: '2026-11-11T12:00:00Z',
      note: null, reversed_transaction_id: null,
      postings: [{account_id: CLOUD_ACCOUNT, signed_minor: -amount}],
      payment_link: {settlement_id: factId, loan_payment_id: null},
    }};
    const fact = {id: factId, entity_revision: 1, kind: 'settlement', data: {
      obligation_id: obligationId, amount_minor: amount, paid_on: '2026-11-11',
      occurrence_on: '2026-11-08', voided_at: null,
    }};
    const events = [
      {revision: 1, ordinal: 0, kind: 'ledger_posted', entity_id: transaction.id,
        entity_revision: 1, payload: {entity: transaction, accounts: [cloudAccount(2, 10000-amount)]}},
      {revision: 1, ordinal: 1, kind: 'upsert', entity_id: fact.id,
        entity_revision: 1, payload: {entity: fact}},
    ];
    return {receipt: {schema_version: 2, client_mutation_id: PENDING_ID, revision: 1,
      replayed: false, changes: events},
      deltaPage: {schema_version: 1, from_revision: 0, to_revision: 1,
        next_since_revision: 1, has_more: false, changes: events},
      commandHttpStatus: 201, deltaHttpStatus: 200};
  }
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, ...evidence(1300),
  }), /SYNC_HOLD/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  for (const alter of [
    events => { events[1].payload.entity.data.obligation_id = NEW_ACCOUNT_ID; },
    events => { events[1].payload.entity.data.occurrence_on = '2026-12-08'; },
    events => { events[1].payload.entity.data.paid_on = '2026-11-12'; },
    events => { events[1].payload.entity.data.voided_at = '2026-11-12T00:00:00Z'; },
    events => { events[0].payload.entity.data.postings[0].account_id = NEW_ACCOUNT_ID; },
    events => { events[0].payload.entity.data.postings[0].signed_minor = 1200; },
    events => { events[0].payload.entity.data.payment_link.settlement_id = NEW_ACCOUNT_ID; },
    events => { events[0].payload.entity.data.payment_link.loan_payment_id = NEW_ACCOUNT_ID; },
    events => { events[1].entity_id = NEW_ACCOUNT_ID; },
    events => { events[0].payload.accounts[0].data.balance_minor = 8000;
      events[0].payload.accounts[0].data.available_minor = 8000; },
  ]) {
    const invalid = evidence(1200);
    alter(invalid.receipt.changes); // The independent delta carries the same wrong event image.
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2, ...invalid,
    }), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  // Crash/restart window: the real delta was persisted before its receipt.
  const valid = evidence(1200);
  await persistEncryptedCloudDeltaCandidate({scope: USER_A, session, identity,
    page: valid.deltaPage, expectedEpoch: 2});
  const accepted = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 3, ...valid,
    receipt: {...valid.receipt, replayed: true}, commandHttpStatus: 200,
  });
  assert.equal(accepted.status, 'DURABLY_CONFIRMED');
  assert.equal(accepted.serverBalanceChanged, false);
  session.logout();
});

test('#138 reserve settlement outbox pins allocation and all server revisions', async () => {
  const obligationId = '10000000-0000-4000-8000-000000000003';
  const reserveId = '10000000-0000-4000-8000-000000000004';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  const pages = cloudPages();
  pages[0].body.entities.push(
    {id: obligationId, kind: 'obligation', entity_revision: 1,
      data: {title: 'Synthetic obligation', direction: 'expense', amount_minor: 5000}},
    {id: reserveId, kind: 'reserve', entity_revision: 1,
      data: {account_id: CLOUD_ACCOUNT, obligation_id: obligationId, allocated_minor: 3000,
        target_on: '2026-11-08', cycle_number: 1, event_log: []}},
  );
  await initializeEncryptedCloudCacheCandidate({scope: USER_A, session, identity, pages,
    expectedEpoch: 0, confirmedAccountCacheInitialization: true});
  const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 0,
    action: 'settlement.payment.record',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 1, [obligationId]: 1, [reserveId]: 1},
    payload: {obligation_id: obligationId, account_id: CLOUD_ACCOUNT, amount_minor: 1200,
      paid_on: '2026-11-11', occurrence_on: '2026-11-08', reserve_id: reserveId,
      reserved_used_minor: 1000}};
  const args = {scope: USER_A, session, identity, ifMatch: CLOUD_ETAG, expectedEpoch: 1};
  for (const invalid of [
    {...command, expected_entity_revisions: {[CLOUD_ACCOUNT]: 1, [obligationId]: 1}},
    {...command, payload: {...command.payload, reserved_used_minor: 1201}},
    {...command, payload: {...command.payload, reserve_id: 'not-a-uuid'}},
    {...command, expected_entity_revisions: {[CLOUD_ACCOUNT]: 1, [obligationId]: 2, [reserveId]: 1}},
    {...command, payload: {...command.payload, obligation_id: NEW_ACCOUNT_ID},
      expected_entity_revisions: {[CLOUD_ACCOUNT]: 1, [NEW_ACCOUNT_ID]: 1, [reserveId]: 1}},
    {...command, payload: Object.fromEntries(Object.entries(command.payload)
      .filter(([key]) => key !== 'reserved_used_minor'))},
  ]) await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({...args, command: invalid}), /SYNC_HOLD/);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 1);
  const result = await enqueueEncryptedFinanceCommandCandidate({...args, command});
  assert.equal(result.status, 'QUEUED_ENCRYPTED');
  const queued = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(queued.outbox[0].command.payload.reserve_id, reserveId);
  assert.equal(queued.outbox[0].command.payload.reserved_used_minor, 1000);
  assert.equal(queued.snapshot.cloudFinance.entities[0].data.balance_minor, 10000);
  const repeated = await enqueueEncryptedFinanceCommandCandidate({...args, command, expectedEpoch: 2});
  assert.equal(repeated.status, 'ALREADY_QUEUED');
  session.logout();
});

test('#138 reserve receipt must prove payment, account and reserved allocation together', async () => {
  const obligationId = '10000000-0000-4000-8000-000000000003';
  const reserveId = '10000000-0000-4000-8000-000000000004';
  const factId = '10000000-0000-4000-8000-000000000005';
  const allocationId = '10000000-0000-4000-8000-000000000006';
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  const pages = cloudPages();
  Object.assign(pages[0].body.entities[0].data, {reserved_minor: 3000, available_minor: 7000});
  pages[0].body.entities.push(
    {id: obligationId, kind: 'obligation', entity_revision: 1,
      data: {title: 'Synthetic obligation', direction: 'expense', amount_minor: 5000}},
    {id: reserveId, kind: 'reserve', entity_revision: 1,
      data: {account_id: CLOUD_ACCOUNT, obligation_id: obligationId, allocated_minor: 3000,
        target_on: '2026-11-08', cycle_number: 1, event_log: []}},
  );
  await initializeEncryptedCloudCacheCandidate({scope: USER_A, session, identity, pages,
    expectedEpoch: 0, confirmedAccountCacheInitialization: true});
  const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 0,
    action: 'settlement.payment.record',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 1, [obligationId]: 1, [reserveId]: 1},
    payload: {obligation_id: obligationId, account_id: CLOUD_ACCOUNT, amount_minor: 1200,
      paid_on: '2026-11-11', occurrence_on: '2026-11-08', reserve_id: reserveId,
      reserved_used_minor: 1000}};
  await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
    command, ifMatch: CLOUD_ETAG, expectedEpoch: 1});
  function evidence() {
    const transaction = {id: CLOUD_TRANSACTION, entity_revision: 1, kind: 'transaction', data: {
      kind: 'payment', occurred_on: '2026-11-11', posted_at: '2026-11-11T12:00:00Z',
      note: null, reversed_transaction_id: null,
      postings: [{account_id: CLOUD_ACCOUNT, signed_minor: -1200}],
      payment_link: {settlement_id: factId, loan_payment_id: null},
      reserve_allocation: {id: allocationId, reserve_id: reserveId, account_id: CLOUD_ACCOUNT,
        delta_minor: -1000, reverses_allocation_id: null},
    }};
    const fact = {id: factId, entity_revision: 1, kind: 'settlement', data: {
      obligation_id: obligationId, amount_minor: 1200, paid_on: '2026-11-11',
      occurrence_on: '2026-11-08', voided_at: null,
    }};
    const account = cloudAccount(2, 8800);
    Object.assign(account.data, {reserved_minor: 2000, available_minor: 6800});
    const reserve = {id: reserveId, entity_revision: 2, kind: 'reserve', data: {
      account_id: CLOUD_ACCOUNT, obligation_id: obligationId, allocated_minor: 2000,
      target_on: '2026-11-08', cycle_number: 1, event_log: [{id: '10000000-0000-4000-8000-000000000007', kind: 'payment', revision: 1,
        reserve_id: reserveId, occurred_on: '2026-11-11', cycle_number: 1,
        transaction_id: CLOUD_TRANSACTION, amount_minor: 1200, reserved_used_minor: 1000}],
    }};
    const events = [
      {revision: 1, ordinal: 0, kind: 'ledger_posted', entity_id: transaction.id,
        entity_revision: 1, payload: {entity: transaction, accounts: [account]}},
      {revision: 1, ordinal: 1, kind: 'upsert', entity_id: fact.id,
        entity_revision: 1, payload: {entity: fact}},
      {revision: 1, ordinal: 2, kind: 'upsert', entity_id: reserve.id,
        entity_revision: 2, payload: {entity: reserve}},
    ];
    return {receipt: {schema_version: 2, client_mutation_id: PENDING_ID, revision: 1,
      replayed: false, changes: events},
      deltaPage: {schema_version: 1, from_revision: 0, to_revision: 1,
        next_since_revision: 1, has_more: false, changes: events},
      commandHttpStatus: 201, deltaHttpStatus: 200};
  }
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    events => { events[0].payload.entity.data.reserve_allocation.delta_minor = -999; },
    events => { events[2].payload.entity.data.allocated_minor = 2001; },
    events => { events[2].payload.entity.data.event_log[0].transaction_id = NEW_ACCOUNT_ID; },
    events => { events[0].payload.accounts[0].data.reserved_minor = 1999;
      events[0].payload.accounts[0].data.available_minor = 6801; },
  ]) {
    const invalid = evidence(); alter(invalid.receipt.changes);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2, ...invalid,
    }), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const accepted = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, ...evidence(),
  });
  assert.equal(accepted.status, 'DURABLY_CONFIRMED');
  session.logout();
});

test('#138 reversal receipt must cancel the exact queued payment and compensate its posting', async () => {
  const obligationId = '10000000-0000-4000-8000-000000000003';
  const factId = '10000000-0000-4000-8000-000000000004';
  const reversalId = '10000000-0000-4000-8000-000000000005';
  const original = {id: CLOUD_TRANSACTION, entity_revision: 1, kind: 'transaction', data: {
    kind: 'payment', occurred_on: '2026-11-11', posted_at: '2026-11-11T12:00:00Z',
    note: null, reversed_transaction_id: null,
    postings: [{account_id: CLOUD_ACCOUNT, signed_minor: -1200}],
    payment_link: {settlement_id: factId, loan_payment_id: null},
  }};
  const fact = {id: factId, entity_revision: 1, kind: 'settlement', data: {
    obligation_id: obligationId, amount_minor: 1200, paid_on: '2026-11-11',
    occurrence_on: '2026-11-08', voided_at: null,
  }};
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  const pages = cloudPages();
  pages[0].body.entities[0] = cloudAccount(2, 8800);
  pages[0].body.entities.push({id: obligationId, kind: 'obligation', entity_revision: 1,
    data: {title: 'Synthetic obligation', direction: 'expense', amount_minor: 5000}}, original, fact);
  await initializeEncryptedCloudCacheCandidate({scope: USER_A, session, identity, pages,
    expectedEpoch: 0, confirmedAccountCacheInitialization: true});
  const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 0,
    action: 'settlement.payment.void',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 2, [CLOUD_TRANSACTION]: 1, [factId]: 1},
    payload: {account_id: CLOUD_ACCOUNT, transaction_id: CLOUD_TRANSACTION,
      fact_id: factId, reason: 'Synthetic correction'}};
  await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
    command, ifMatch: CLOUD_ETAG, expectedEpoch: 1});
  function evidence() {
    const reversal = {id: reversalId, entity_revision: 1, kind: 'transaction', data: {
      kind: 'reversal', occurred_on: '2026-11-12', posted_at: '2026-11-12T12:00:00Z',
      note: 'Synthetic correction', reversed_transaction_id: CLOUD_TRANSACTION,
      postings: [{account_id: CLOUD_ACCOUNT, signed_minor: 1200}],
    }};
    const voided = structuredClone(fact);
    voided.entity_revision = 2; voided.data.voided_at = '2026-11-12T12:00:00Z';
    const events = [
      {revision: 1, ordinal: 0, kind: 'ledger_posted', entity_id: reversalId,
        entity_revision: 1, payload: {entity: reversal, accounts: [cloudAccount(3, 10000)]}},
      {revision: 1, ordinal: 1, kind: 'upsert', entity_id: factId,
        entity_revision: 2, payload: {entity: voided}},
    ];
    return {receipt: {schema_version: 2, client_mutation_id: PENDING_ID, revision: 1,
      replayed: false, changes: events},
      deltaPage: {schema_version: 1, from_revision: 0, to_revision: 1,
        next_since_revision: 1, has_more: false, changes: events},
      commandHttpStatus: 201, deltaHttpStatus: 200};
  }
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    events => { events[0].payload.entity.data.postings[0].signed_minor = 1500; },
    events => { events[0].payload.entity.data.reversed_transaction_id = NEW_ACCOUNT_ID; },
    events => { events[1].payload.entity.data.amount_minor = 1400; },
    events => { events[1].payload.entity.data.voided_at = null; },
    events => { events[1].entity_revision = 3; },
    events => { events[0].payload.accounts[0].data.balance_minor = 11000;
      events[0].payload.accounts[0].data.available_minor = 11000; },
  ]) {
    const invalid = evidence(); alter(invalid.receipt.changes);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2, ...invalid,
    }), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const accepted = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, ...evidence(),
  });
  assert.equal(accepted.status, 'DURABLY_CONFIRMED');
  session.logout();
});

test('#138 reserve reversal verifies restored allocation and void event before clearing outbox', async () => {
  const obligationId = '10000000-0000-4000-8000-000000000003';
  const factId = '10000000-0000-4000-8000-000000000004';
  const reversalId = '10000000-0000-4000-8000-000000000005';
  const reserveId = '10000000-0000-4000-8000-000000000006';
  const allocationId = '10000000-0000-4000-8000-000000000007';
  const returnId = '10000000-0000-4000-8000-000000000008';
  const eventId = '10000000-0000-4000-8000-000000000009';
  const original = {id: CLOUD_TRANSACTION, entity_revision: 1, kind: 'transaction', data: {
    kind: 'payment', occurred_on: '2026-11-11', posted_at: '2026-11-11T12:00:00Z',
    note: null, reversed_transaction_id: null,
    postings: [{account_id: CLOUD_ACCOUNT, signed_minor: -1200}],
    payment_link: {settlement_id: factId, loan_payment_id: null},
    reserve_allocation: {id: allocationId, reserve_id: reserveId, account_id: CLOUD_ACCOUNT,
      delta_minor: -1000, reverses_allocation_id: null},
  }};
  const fact = {id: factId, entity_revision: 1, kind: 'settlement', data: {
    obligation_id: obligationId, amount_minor: 1200, paid_on: '2026-11-11',
    occurrence_on: '2026-11-08', voided_at: null,
  }};
  const paidEvent = {id: eventId, reserve_id: reserveId, kind: 'payment',
    occurred_on: '2026-11-11', cycle_number: 1, revision: 1, amount_minor: 1200,
    reserved_used_minor: 1000, transaction_id: CLOUD_TRANSACTION};
  const reserve = {id: reserveId, kind: 'reserve', entity_revision: 2,
    data: {account_id: CLOUD_ACCOUNT, obligation_id: obligationId, allocated_minor: 2000,
      target_on: '2026-11-08', cycle_number: 1, event_log: [paidEvent]}};
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox: [], conflicts: []});
  const session = await unlock(USER_A);
  const identity = cloudAuth(session);
  const pages = cloudPages();
  pages[0].body.revision = 1;
  pages[0].body.entities[0] = cloudAccount(2, 8800);
  Object.assign(pages[0].body.entities[0].data, {reserved_minor: 2000, available_minor: 6800});
  pages[0].body.entities.push({id: obligationId, kind: 'obligation', entity_revision: 1,
    data: {title: 'Synthetic obligation', direction: 'expense', amount_minor: 5000}}, reserve, original, fact);
  await initializeEncryptedCloudCacheCandidate({scope: USER_A, session, identity, pages,
    expectedEpoch: 0, confirmedAccountCacheInitialization: true});
  const command = {schema_version: 2, client_mutation_id: PENDING_ID, base_revision: 1,
    action: 'settlement.payment.void',
    expected_entity_revisions: {[CLOUD_ACCOUNT]: 2, [CLOUD_TRANSACTION]: 1, [factId]: 1, [reserveId]: 2},
    payload: {account_id: CLOUD_ACCOUNT, transaction_id: CLOUD_TRANSACTION,
      fact_id: factId, reserve_id: reserveId, reason: 'Synthetic correction'}};
  await enqueueEncryptedFinanceCommandCandidate({scope: USER_A, session, identity,
    command, ifMatch: CLOUD_ETAG, expectedEpoch: 1});
  function evidence() {
    const reversal = {id: reversalId, entity_revision: 1, kind: 'transaction', data: {
      kind: 'reversal', occurred_on: '2026-11-12', posted_at: '2026-11-12T12:00:00Z',
      note: 'Synthetic correction', reversed_transaction_id: CLOUD_TRANSACTION,
      postings: [{account_id: CLOUD_ACCOUNT, signed_minor: 1200}],
      reserve_allocation: {id: returnId, reserve_id: reserveId, account_id: CLOUD_ACCOUNT,
        delta_minor: 1000, reverses_allocation_id: allocationId},
    }};
    const voided = structuredClone(fact);
    voided.entity_revision = 2; voided.data.voided_at = '2026-11-12T12:00:00Z';
    const account = cloudAccount(3, 10000);
    Object.assign(account.data, {reserved_minor: 3000, available_minor: 7000});
    const updated = structuredClone(reserve);
    updated.entity_revision = 3; updated.data.allocated_minor = 3000;
    updated.data.event_log.push({id: returnId, reserve_id: reserveId, kind: 'void', revision: 2,
      cycle_number: 1, target_event_id: eventId, transaction_id: reversalId,
      note: 'Synthetic correction'});
    const events = [
      {revision: 2, ordinal: 0, kind: 'ledger_posted', entity_id: reversalId,
        entity_revision: 1, payload: {entity: reversal, accounts: [account]}},
      {revision: 2, ordinal: 1, kind: 'upsert', entity_id: factId,
        entity_revision: 2, payload: {entity: voided}},
      {revision: 2, ordinal: 2, kind: 'upsert', entity_id: reserveId,
        entity_revision: 3, payload: {entity: updated}},
    ];
    return {receipt: {schema_version: 2, client_mutation_id: PENDING_ID, revision: 2,
      replayed: false, changes: events},
      deltaPage: {schema_version: 1, from_revision: 1, to_revision: 2,
        next_since_revision: 2, has_more: false, changes: events},
      commandHttpStatus: 201, deltaHttpStatus: 200};
  }
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  for (const alter of [
    events => { events[0].payload.entity.data.reserve_allocation.delta_minor = 999; },
    events => { events[0].payload.entity.data.reserve_allocation.reverses_allocation_id = NEW_ACCOUNT_ID; },
    events => { events[2].payload.entity.data.event_log[1].target_event_id = NEW_ACCOUNT_ID; },
    events => { events[2].payload.entity.data.allocated_minor = 2999; },
  ]) {
    const invalid = evidence(); alter(invalid.receipt.changes);
    await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2, ...invalid,
    }), /SYNC_HOLD/);
    assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  }
  const accepted = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, ...evidence(),
  });
  assert.equal(accepted.status, 'DURABLY_CONFIRMED');
  session.logout();
});

test('#68 verified receipt + independent server delta + encrypted queue clearance are one CAS', async () => {
  const {db, session, identity} = await pendingAccountCreate();
  const confirmed = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    ...confirmedReceiptData(),
  });
  assert.equal(confirmed.status, 'DURABLY_CONFIRMED');
  assert.equal(confirmed.bundleEpoch, 3);
  assert.equal(confirmed.serverRevision, 1);
  assert.equal(confirmed.pending, 0);
  assert.equal(confirmed.sentByThisFunction, false);
  const stored = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(stored.epoch, 3);
  assert.equal(stored.snapshot.cloudFinance.revision, 1);
  assert.equal(stored.outbox.length, 0);
  assert.equal(stored.snapshot.cloudFinance.appliedReceipts.length, 1);
  assert.equal(stored.snapshot.cloudFinance.appliedReceipts[0].mutationId, PENDING_ID);
  assert.equal(stored.snapshot.cloudFinance.entities.find(e=>e.id===NEW_ACCOUNT_ID)
    .data.balance_minor, 12_345);
  assert.equal(stored.snapshot.cloudFinance.entities.find(e=>e.id===CLOUD_ACCOUNT)
    .data.balance_minor, 10_000);
  assert.equal(stored.snapshot.title, SOURCE.snapshot.title);
  const storedCiphertext = JSON.stringify([...db.tables.get('bundles').values()]);
  assert.equal(storedCiphertext.includes(PENDING_ID), false);
  assert.equal(storedCiphertext.includes(NEW_ACCOUNT_ID), false);
  assert.equal(storedCiphertext.includes('12345'), false);
  const duplicate = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session, identity, command: pendingCommand(),
    ifMatch: CLOUD_ETAG, expectedEpoch: 3,
  });
  assert.equal(duplicate.status, 'ALREADY_CONFIRMED');
  await assert.rejects(() => enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session, identity, command: pendingCommand(99_999),
    ifMatch: CLOUD_ETAG, expectedEpoch: 3,
  }), /SYNC_HOLD/);
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.epoch, 3);
  session.logout();
});

test('#68 network ACK alone cannot delete or mutate an encrypted offline payment', async () => {
  const {session, identity} = await pendingAccountCreate();
  const original = await readAtomicEncryptedCandidate(USER_A, session);
  const valid = confirmedReceiptData();
  const badReceipts = [
    {receipt: null},
    {receipt: {...valid.receipt, revision: 2}},
    {receipt: {...valid.receipt, client_mutation_id: CLOUD_TRANSACTION}},
    {receipt: {...valid.receipt, changes: [
      {...valid.receipt.changes[0],
        payload: {entity: confirmedAccountEvent(99_999).payload.entity}},
    ]}},
    {deltaPage: {...valid.deltaPage, changes: []}},
    {deltaPage: {...valid.deltaPage, next_since_revision: 0}},
    {deltaPage: {...valid.deltaPage,
      changes: [{...valid.deltaPage.changes[0], ordinal: 1}]}},
    {commandHttpStatus: 503},
    {deltaHttpStatus: 401},
  ];
  for (const replacement of badReceipts) {
    await assert.rejects(
      () => persistAuthenticatedFinanceReceiptCandidate({
        scope: USER_A, session, identity, expectedEpoch: 2,
        ...valid, ...replacement,
      }), /SYNC_HOLD/,
    );
    const unchanged = await readAtomicEncryptedCandidate(USER_A, session);
    assert.deepEqual(unchanged, original);
  }
  session.logout();
});

test('#68 replayed server 200 requires matching delta, not a second cash posting', async () => {
  const {session, identity} = await pendingAccountCreate();
  const valid = confirmedReceiptData();
  const applied = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    ...valid, receipt: {...valid.receipt, replayed: true},
    commandHttpStatus: 200,
  });
  assert.equal(applied.status, 'DURABLY_CONFIRMED');
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length, 0);
  await assert.rejects(
    () => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 3,
      ...valid, receipt: {...valid.receipt, replayed: true},
      commandHttpStatus: 200,
    }), /SYNC_HOLD/,
  );
  session.logout();
});

test('#68 subsequent server delta preserves encrypted applied receipt proofs', async () => {
  const {session, identity} = await pendingAccountCreate();
  await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    ...confirmedReceiptData(),
  });
  const other = verifiedChange();
  const nextPage = {
    schema_version: 1, from_revision: 1, to_revision: 2,
    next_since_revision: 2, has_more: false,
    changes: other.changes.map(change => ({...change, revision: 2})),
  };
  const next = await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session, identity, expectedEpoch: 3, page: nextPage,
  });
  assert.equal(next.bundleEpoch, 4);
  const saved = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(saved.snapshot.cloudFinance.revision, 2);
  assert.equal(saved.snapshot.cloudFinance.appliedReceipts.length, 1);
  assert.equal(saved.snapshot.cloudFinance.appliedReceipts[0].mutationId, PENDING_ID);
  assert.equal(saved.outbox.length, 0);
  assert.equal(saved.snapshot.cloudFinance.entities.find(e => e.id === CLOUD_ACCOUNT)
    .data.balance_minor, 9_500);
  session.logout();
});

test('#68 fresh encrypted account unlock retains original verified receipt', async () => {
  const {session, identity} = await pendingAccountCreate();
  await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    ...confirmedReceiptData(),
  });
  session.logout();
  const restored = new LocalBudgetSession();
  restored.selectScope(USER_A);
  await restored.unlock(await getAtomicEncryptedKeyset(USER_A), {passphrase: PASS});
  const freshIdentity = cloudAuth(restored);
  const replay = await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: restored, identity: freshIdentity,
    command: pendingCommand(), ifMatch: CLOUD_ETAG, expectedEpoch: 3,
  });
  assert.equal(replay.status, 'ALREADY_CONFIRMED');
  assert.equal((await readAtomicEncryptedCandidate(USER_A, restored)).outbox.length, 0);
  restored.logout();
});


const TEST_ORIGIN = 'https://synthetic-finance.invalid';
function syntheticWebLocks() {
  let held = false;
  return {
    async request(name, options, callback) {
      assert.equal(name, 'financial-horizon-finance-v2-network-dispatch');
      assert.deepEqual(options, {mode: 'exclusive', ifAvailable: true});
      if (held) return callback(null);
      held = true;
      try { return await callback({name, mode: 'exclusive'}); }
      finally { held = false; }
    },
  };
}
const TEST_LOCKS = syntheticWebLocks();
function mockFinanceJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: {'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'},
  });
}
test('#68 only a parsed stale-revision server response can authorize 412 resolution', async () => {
  for (const [body, canResolve] of [
    [{code: 'stale_revision', server_revision: 1}, true],
    [{code: 'stale_revision'}, false],
    [{code: 'other', server_revision: 1}, false],
  ]) {
    const {session, identity} = await pendingAccountCreate();
    await dispatchOneEncryptedFinanceCommandCandidate({
      lockManager: TEST_LOCKS, scope: USER_A, session, identity, expectedEpoch: 2,
      origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
      fetchImpl: async () => mockFinanceJson(body, 412),
    });
    const pages = cloudPages(); pages[0].body.revision = 1;
    await refreshEncryptedCloudSnapshot({scope: USER_A, session, identity, pages,
      etag: '"fh.1.1.0123456789abcdef"', expectedEpoch: 3});
    const args = {scope: USER_A, session, identity, expectedEpoch: 4,
      mutationId: PENDING_ID, observedRevision: 1, choice: 'ACCEPT_SERVER',
      explicitUserChoice: true};
    if (canResolve) assert.equal((await resolveStaleFinanceConflict(args)).status, 'CONFLICT_RESOLVED');
    else {
      const before = await readAtomicEncryptedCandidate(USER_A, session);
      await assert.rejects(() => resolveStaleFinanceConflict(args), /SYNC_HOLD/);
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
    }
    session.logout();
  }
});
test('#68 dispatcher is inert without separate explicit network candidate consent', async () => {
  const {session, identity} = await pendingAccountCreate();
  let networkCalls = 0;
  const request = {
    scope: USER_A, session, identity, expectedEpoch: 2,
    origin: TEST_ORIGIN, fetchImpl: async () => {
      networkCalls++; throw Error('Should never send');
    },
  };
  await assert.rejects(
    () => dispatchOneEncryptedFinanceCommandCandidate(request), /SYNC_HOLD/,
  );
  assert.equal(networkCalls, 0);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length, 1);
  session.logout();
});

test('#68 explicit same-origin one-shot sends pinned UUID and reconciles independent delta', async () => {
  const {session, identity} = await pendingAccountCreate();
  const calls = [];
  const {receipt, deltaPage} = confirmedReceiptData();
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (calls.length === 1) return mockFinanceJson(receipt, 201);
    if (calls.length === 2) return mockFinanceJson(deltaPage);
    throw Error('Multiple unexpected financial sends');
  };
  const outcome = await dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
    scope: USER_A, session, identity, expectedEpoch: 2,
    origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
    fetchImpl,
  });
  assert.equal(outcome.status, 'DURABLY_CONFIRMED');
  assert.equal(outcome.bundleEpoch, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, TEST_ORIGIN + '/api/finance/v2/commands');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.mode, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.referrerPolicy, 'same-origin');
  assert.equal(calls[0].options.headers['If-Match'], CLOUD_ETAG);
  assert.equal(calls[0].options.headers['Idempotency-Key'], PENDING_ID);
  assert.equal(JSON.parse(calls[0].options.body).payload.opening_minor, 12_345);
  assert.equal(calls[1].url, TEST_ORIGIN +
    '/api/finance/v1/changes?since_revision=0&limit_revisions=1');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.credentials, 'same-origin');
  const persisted = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(persisted.outbox.length, 0);
  assert.equal(persisted.snapshot.cloudFinance.revision, 1);
  assert.equal(persisted.snapshot.cloudFinance.appliedReceipts.length, 1);
  session.logout();
});

test('#68 failures, server conflicts and ambiguous POST response retain queued money', async () => {
  for (const [stage,expected] of [
    [401, 'AUTH_HOLD'], [412, 'CONFLICT_HOLD'],
    [503, 'RETRY_SAME_UUID'], [410, 'SNAPSHOT_REQUIRED_HOLD'],
    ['network', 'RETRY_SAME_UUID'], ['delta-missing', 'RECOVERY_HOLD'],
  ]) {
    const {session, identity} = await pendingAccountCreate();
    const prior = await readAtomicEncryptedCandidate(USER_A, session);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url);
      if (stage === 'network') throw Error('Synthetic network interrupted');
      if (calls.length === 1) {
        if (stage === 'delta-missing') return mockFinanceJson(
          confirmedReceiptData().receipt, 201,
        );
        return mockFinanceJson({code: 'synthetic-failure'}, stage);
      }
      if (stage === 'delta-missing') return mockFinanceJson(
        {code: 'synthetic-no-journal'}, 503,
      );
      throw Error('Unexpected network request');
    };
    const result = await dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
      scope: USER_A, session, identity, expectedEpoch: 2,
      origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true, fetchImpl,
    });
    assert.equal(result.status, expected, String(stage));
    assert.equal(result.queuePreserved, true);
    const current = await readAtomicEncryptedCandidate(USER_A, session);
    if (stage === 503 || stage === 'network') {
      assert.equal(current.epoch, prior.epoch + 1);
      assert.equal(current.outbox[0].attempts, prior.outbox[0].attempts + 1);
      assert.equal(current.outbox[0].mutationId, PENDING_ID);
      assert.deepEqual(current.outbox[0].command, prior.outbox[0].command);
      assert.deepEqual(current.snapshot, prior.snapshot);
      assert.equal(result.bundleEpoch, current.epoch);
    } else if (stage === 412 || stage === 410) {
      assert.equal(current.epoch, prior.epoch + 1);
      assert.deepEqual(current.snapshot, prior.snapshot);
      assert.deepEqual(current.outbox, prior.outbox);
      assert.equal(current.conflicts.length, prior.conflicts.length + 1);
      const stop = current.conflicts.at(-1);
      assert.equal(stop.kind, 'finance_sync_hold');
      assert.equal(stop.mutationId, PENDING_ID);
      assert.equal(stop.httpStatus, stage);
      assert.equal(stop.source, 'command');
      assert.equal(stop.decision, expected);
      assert.equal(result.bundleEpoch, current.epoch);
    } else {
      assert.deepEqual(current, prior);
    }
    assert.equal(calls.length, stage === 'delta-missing' ? 2 : 1);
    session.logout();
  }
});

test('#68 never uploads plaintext to a different-origin endpoint or on revoked session', async () => {
  const {session, identity} = await pendingAccountCreate();
  let calls = 0;
  const fetchImpl = async () => {calls++; throw Error('Do not run');};
  for (const origin of ['http://synthetic-finance.invalid',
    'https://synthetic-finance.invalid/finance',
    'https://example.invalid@synthetic-finance.invalid',
    'https://synthetic-finance.invalid/path?source=private']) {
    await assert.rejects(
      () => dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
        scope: USER_A, session, identity, expectedEpoch: 2, origin,
        explicitNetworkCandidateConsent: true, fetchImpl,
      }), /SYNC_HOLD/,
    );
  }
  assert.equal(calls, 0);
  session.logout();
  await assert.rejects(
    () => dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
      scope: USER_A, session, identity, expectedEpoch: 2, origin: TEST_ORIGIN,
      explicitNetworkCandidateConsent: true, fetchImpl,
    }), /SYNC_HOLD/,
  );
  assert.equal(calls, 0);
});


test('#68 transient retries retain encrypted identity and exponential backoff across restart', async () => {
  const {session, identity} = await pendingAccountCreate();
  let calls = 0;
  const offline = async () => {
    calls++;
    throw Error('Synthetic transport interruption');
  };
  const first = await dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
    scope: USER_A, session, identity, expectedEpoch: 2,
    origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
    fetchImpl: offline,
  });
  assert.equal(first.status, 'RETRY_SAME_UUID');
  assert.ok(first.retryDelayMs >= 500 && first.retryDelayMs <= 1000);
  assert.equal(first.bundleEpoch, 3);
  const stored = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(stored.outbox[0].attempts, 1);
  assert.equal(stored.outbox[0].mutationId, PENDING_ID);
  session.logout();
  const recovered = new LocalBudgetSession();
  recovered.selectScope(USER_A);
  await recovered.unlock(await getAtomicEncryptedKeyset(USER_A), {passphrase: PASS});
  const fresh = cloudAuth(recovered);
  const next = await dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
    scope: USER_A, session: recovered, identity: fresh,
    expectedEpoch: 3, origin: TEST_ORIGIN,
    explicitNetworkCandidateConsent: true, fetchImpl: offline,
  });
  assert.equal(next.status, 'RETRY_SAME_UUID');
  assert.ok(next.retryDelayMs >= 1000 && next.retryDelayMs <= 2000);
  assert.equal(next.bundleEpoch, 4);
  assert.equal(calls, 2);
  const after = await readAtomicEncryptedCandidate(USER_A, recovered);
  assert.equal(after.outbox.length, 1);
  assert.equal(after.outbox[0].attempts, 2);
  assert.equal(after.outbox[0].mutationId, PENDING_ID);
  assert.equal(after.outbox[0].ifMatch, CLOUD_ETAG);
  assert.deepEqual(after.outbox[0].command, stored.outbox[0].command);
  assert.deepEqual(after.snapshot, stored.snapshot);
  recovered.logout();
});

test('#68 invalid jitter preserves a bounded retry and the original command', async () => {
  const {session, identity} = await pendingAccountCreate();
  const originalRandom = Math.random;
  Math.random = () => Number.NaN;
  try {
    const result = await dispatchOneEncryptedFinanceCommandCandidate({
      lockManager: TEST_LOCKS, scope: USER_A, session, identity, expectedEpoch: 2,
      origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
      fetchImpl: async () => { throw Error('synthetic network failure'); },
    });
    assert.equal(result.retryDelayMs, 1000);
    const saved = await readAtomicEncryptedCandidate(USER_A, session);
    assert.equal(saved.outbox[0].mutationId, PENDING_ID);
    assert.equal(saved.outbox[0].ifMatch, CLOUD_ETAG);
  } finally {
    Math.random = originalRandom;
    session.logout();
  }
});


test('#68 failed encrypted ACK commit retains pending money for unchanged server replay', async () => {
  const {db, session, identity} = await pendingAccountCreate();
  const prior = await readAtomicEncryptedCandidate(USER_A, session);
  db.failBundlePut = true;
  await assert.rejects(
    () => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2,
      ...confirmedReceiptData(),
    }),
    /injected bundle write failure/,
  );
  db.failBundlePut = false;
  const afterFailure = await readAtomicEncryptedCandidate(USER_A, session);
  assert.deepEqual(afterFailure, prior);
  assert.equal(afterFailure.outbox.length, 1);
  assert.equal(afterFailure.snapshot.cloudFinance.revision, 0);
  const replay = confirmedReceiptData();
  const restored = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    ...replay, receipt: {...replay.receipt, replayed: true},
    commandHttpStatus: 200,
  });
  assert.equal(restored.status, 'DURABLY_CONFIRMED');
  const done = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(done.outbox.length, 0);
  assert.equal(done.snapshot.cloudFinance.revision, 1);
  assert.equal(done.snapshot.cloudFinance.appliedReceipts.length, 1);
  session.logout();
});

test('#68 competing tabs cannot clear the same encrypted ACK twice', async () => {
  mount();
  await createAtomicEncryptedCandidate(USER_A, PASS, {
    ...clone(SOURCE), outbox: [], conflicts: [],
  });
  const first = await unlock(USER_A);
  const second = await unlock(USER_A);
  const one = cloudAuth(first);
  const two = cloudAuth(second);
  await initializeEncryptedCloudCacheCandidate({
    scope: USER_A, session: first, identity: one,
    pages: cloudPages(), expectedEpoch: 0,
    confirmedAccountCacheInitialization: true,
  });
  await enqueueEncryptedFinanceCommandCandidate({
    scope: USER_A, session: first, identity: one,
    command: pendingCommand(), ifMatch: CLOUD_ETAG, expectedEpoch: 1,
  });
  const a = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session: first, identity: one,
    expectedEpoch: 2, ...confirmedReceiptData(),
  });
  assert.equal(a.bundleEpoch, 3);
  await assert.rejects(
    () => persistAuthenticatedFinanceReceiptCandidate({
      scope: USER_A, session: second, identity: two,
      expectedEpoch: 2, ...confirmedReceiptData(),
    }), /SYNC_HOLD/,
  );
  const state = await readAtomicEncryptedCandidate(USER_A, second);
  assert.equal(state.epoch, 3);
  assert.equal(state.outbox.length, 0);
  assert.equal(state.snapshot.cloudFinance.appliedReceipts.length, 1);
  first.logout();
  second.logout();
});


test('#68 historical ACK after encrypted delta recovers pending UUID without double posting', async () => {
  const {session, identity} = await pendingAccountCreate();
  const {receipt, deltaPage} = confirmedReceiptData();
  // Simulate network loss after verified /changes was already stored but
  // before the immutable receipt was reconciled and removed from outbox.
  const applied = await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, page: deltaPage,
  });
  assert.equal(applied.bundleEpoch, 3);
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(before.snapshot.cloudFinance.revision, 1);
  assert.equal(before.outbox.length, 1);
  const restored = await persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 3,
    receipt: {...receipt, replayed: true}, deltaPage,
    commandHttpStatus: 200, deltaHttpStatus: 200,
  });
  assert.equal(restored.status, 'DURABLY_CONFIRMED');
  assert.equal(restored.serverBalanceChanged, false);
  assert.equal(restored.bundleEpoch, 4);
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(after.snapshot.cloudFinance.revision, 1);
  assert.deepEqual(after.snapshot.cloudFinance.entities,
    before.snapshot.cloudFinance.entities);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.snapshot.cloudFinance.appliedReceipts.length, 1);
  assert.equal(after.snapshot.cloudFinance.entities.find(e => e.id === NEW_ACCOUNT_ID)
    .data.balance_minor, 12_345);
  session.logout();
});

test('#68 historical server receipt recovery re-fetches the original committed revision', async () => {
  const {session, identity} = await pendingAccountCreate();
  const {receipt, deltaPage} = confirmedReceiptData();
  await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, page: deltaPage,
  });
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (urls.length === 1) return mockFinanceJson(
      {...receipt, replayed: true}, 200,
    );
    if (urls.length === 2) return mockFinanceJson(deltaPage, 200);
    throw Error('Unexpected third financial request');
  };
  const confirmed = await dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS,
    scope: USER_A, session, identity, expectedEpoch: 3,
    origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true, fetchImpl,
  });
  assert.equal(confirmed.status, 'DURABLY_CONFIRMED');
  assert.equal(confirmed.serverBalanceChanged, false);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], TEST_ORIGIN +
    '/api/finance/v1/changes?since_revision=0&limit_revisions=1');
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length, 0);
  session.logout();
});

test('#68 historical ACK fails closed when original server event cannot be recovered', async () => {
  const {session, identity} = await pendingAccountCreate();
  const {receipt, deltaPage} = confirmedReceiptData();
  await persistEncryptedCloudDeltaCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2, page: deltaPage,
  });
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  const corrupt = {...deltaPage, changes: [{...deltaPage.changes[0],
    payload: {entity: confirmedAccountEvent(12_346).payload.entity}}]};
  await assert.rejects(() => persistAuthenticatedFinanceReceiptCandidate({
    scope: USER_A, session, identity, expectedEpoch: 3,
    receipt, deltaPage: corrupt,
    commandHttpStatus: 201, deltaHttpStatus: 200,
  }), /SYNC_HOLD/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
  session.logout();
});


test('#68 one-shot finance dispatcher holds exclusive Web Lock throughout POST and durable ACK', async () => {
  const {session, identity} = await pendingAccountCreate();
  const locks = syntheticWebLocks();
  let begin, release;
  const sent = new Promise(resolve => {begin = resolve;});
  const unblock = new Promise(resolve => {release = resolve;});
  let sends = 0;
  const valid = confirmedReceiptData();
  const fetchImpl = async () => {
    sends += 1;
    if (sends === 1) {
      begin();
      await unblock;
      return mockFinanceJson(valid.receipt, 201);
    }
    if (sends === 2) return mockFinanceJson(valid.deltaPage, 200);
    throw Error('duplicate financial request');
  };
  const args = {scope: USER_A, session, identity, expectedEpoch: 2,
    origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
    lockManager: locks, fetchImpl};
  const first = dispatchOneEncryptedFinanceCommandCandidate(args);
  try {
    await sent;
    // The losing tab must fail closed before issuing another POST.
    const denied = await dispatchOneEncryptedFinanceCommandCandidate(args);
    assert.equal(denied.status, 'LEASE_BUSY');
    assert.equal(denied.sentByThisCall, false);
    assert.equal(denied.queuePreserved, true);
    assert.equal(sends, 1);
    const before = await readAtomicEncryptedCandidate(USER_A, session);
    assert.equal(before.epoch, 2);
    assert.equal(before.outbox.length, 1);
  } finally {release();}
  const accepted = await first;
  assert.equal(accepted.status, 'DURABLY_CONFIRMED');
  assert.equal(accepted.sentByThisCall, true);
  assert.equal(sends, 2);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length, 0);
  session.logout();
});

test('#68 missing browser Web Locks refuses network rather than sending without leader', async () => {
  const {session, identity} = await pendingAccountCreate();
  let networkCalls = 0;
  await assert.rejects(
    () => dispatchOneEncryptedFinanceCommandCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2,
      origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
      lockManager: null,
      fetchImpl: async () => {networkCalls++; throw Error('Never send');},
    }), /SYNC_HOLD/,
  );
  assert.equal(networkCalls, 0);
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length, 1);
  session.logout();
});


test('#68 persisted financial 409/412 holds survive browser restart and block automatic resends', async () => {
  for (const status of [409, 412]) {
    const {session, identity} = await pendingAccountCreate();
    let requests = 0;
    const first = await dispatchOneEncryptedFinanceCommandCandidate({
      lockManager: TEST_LOCKS, scope: USER_A, session, identity,
      origin: TEST_ORIGIN, expectedEpoch: 2,
      explicitNetworkCandidateConsent: true,
      fetchImpl: async () => {requests++; return mockFinanceJson({code:'stale_revision'},status);},
    });
    assert.equal(first.status, 'CONFLICT_HOLD');
    assert.equal(requests, 1);
    const current = await readAtomicEncryptedCandidate(USER_A, session);
    assert.equal(current.epoch, 3);
    assert.equal(current.conflicts.length, 1);
    assert.equal(current.conflicts[0].mutationId, PENDING_ID);
    assert.equal(current.conflicts[0].httpStatus, status);
    assert.equal(current.outbox[0].status, 'pending');
    session.logout();

    const restored = new LocalBudgetSession();
    restored.selectScope(USER_A);
    await restored.unlock(await getAtomicEncryptedKeyset(USER_A), {passphrase: PASS});
    const fresh = cloudAuth(restored);
    const second = await dispatchOneEncryptedFinanceCommandCandidate({
      lockManager: TEST_LOCKS, scope: USER_A, session: restored,
      identity: fresh, origin: TEST_ORIGIN, expectedEpoch: 3,
      explicitNetworkCandidateConsent: true,
      fetchImpl: async () => {requests++; throw Error('Never retry a held payment');},
    });
    assert.equal(second.status, 'CONFLICT_HOLD');
    assert.equal(second.sentByThisCall, false);
    assert.equal(requests, 1);
    const unchanged = await readAtomicEncryptedCandidate(USER_A, restored);
    assert.deepEqual(unchanged.outbox, current.outbox);
    assert.deepEqual(unchanged.conflicts, current.conflicts);
    assert.deepEqual(unchanged.snapshot, current.snapshot);
    restored.logout();
  }
});

test('#68 a watermark 410 recovers only from matching retained independent events', async () => {
  for (const corrupt of [false,true]) {
    const {session,identity}=await pendingAccountCreate();
    const proof=confirmedReceiptData(), urls=[];
    if(corrupt) proof.deltaPage.changes[0].payload.entity.data.name='Wrong account';
    const args={lockManager:TEST_LOCKS,scope:USER_A,session,identity,origin:TEST_ORIGIN,
      expectedEpoch:2,explicitNetworkCandidateConsent:true,fetchImpl:async url=>{
        urls.push(url);
        if(url.endsWith('/commands')) return mockFinanceJson(proof.receipt,201);
        if(url.includes('/changes?')) return mockFinanceJson({code:'snapshot_required'},410);
        return mockFinanceJson(proof.deltaPage,200);
      }};
    const before=await readAtomicEncryptedCandidate(USER_A,session);
    if(corrupt){
      await assert.rejects(()=>dispatchOneEncryptedFinanceCommandCandidate(args),/SYNC_HOLD/);
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A,session),before);
    }else{
      const result=await dispatchOneEncryptedFinanceCommandCandidate(args);
      assert.equal(result.status,'DURABLY_CONFIRMED');
      assert.equal((await readAtomicEncryptedCandidate(USER_A,session)).outbox.length,0);
    }
    assert.equal(urls[2],TEST_ORIGIN+'/api/finance/v1/commands/'+PENDING_ID+'/changes');
    session.logout();
  }
});

test('#68 HTTP 410 after successful POST preserves encrypted queue as snapshot-required', async () => {
  const {session, identity} = await pendingAccountCreate();
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  let requested = 0;
  const outcome = await dispatchOneEncryptedFinanceCommandCandidate({
    lockManager: TEST_LOCKS, scope: USER_A, session, identity,
    origin: TEST_ORIGIN, expectedEpoch: 2,
    explicitNetworkCandidateConsent: true,
    fetchImpl: async () => {
      requested++;
      return requested === 1
        ? mockFinanceJson(confirmedReceiptData().receipt, 201)
        : mockFinanceJson({code:'snapshot_required'}, 410);
    },
  });
  assert.equal(outcome.status, 'SNAPSHOT_REQUIRED_HOLD');
  assert.equal(outcome.bundleEpoch, 3);
  assert.equal(requested, 3);
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(after.outbox, before.outbox);
  assert.equal(after.conflicts.length, 1);
  assert.equal(after.conflicts[0].source, 'delta');
  assert.equal(after.conflicts[0].decision, 'SNAPSHOT_REQUIRED_HOLD');
  assert.equal(after.conflicts[0].httpStatus, 410);
  assert.equal(after.conflicts[0].mutationId, PENDING_ID);
  assert.equal(after.snapshot.cloudFinance.revision, 0);
  session.logout();
});

test('#68 a stored delta hold survives restart until independently verified recovery commits atomically', async () => {
  const {db, session, identity} = await pendingAccountCreate();
  await persistEncryptedFinanceHoldCandidate({scope:USER_A, session, identity, expectedEpoch:2,
    mutationId:PENDING_ID, httpStatus:410, decision:'SNAPSHOT_REQUIRED_HOLD', source:'delta'});
  const before = await readAtomicEncryptedCandidate(USER_A, session);
  session.logout();
  const restored = new LocalBudgetSession();
  restored.selectScope(USER_A);
  await restored.unlock(await getAtomicEncryptedKeyset(USER_A), {passphrase:PASS});
  const fresh = cloudAuth(restored), proof = confirmedReceiptData();
  const args = {lockManager:TEST_LOCKS, scope:USER_A, session:restored, identity:fresh,
    origin:TEST_ORIGIN, expectedEpoch:3, explicitNetworkCandidateConsent:true,
    fetchImpl:async url => url.endsWith('/commands') ? mockFinanceJson(proof.receipt,200) :
      url.includes('/changes?') ? mockFinanceJson({code:'snapshot_required'},410) :
        mockFinanceJson(proof.deltaPage,200)};
  db.failBundlePut = true;
  await assert.rejects(() => dispatchOneEncryptedFinanceCommandCandidate(args), /injected bundle write failure/);
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, restored), before);
  db.failBundlePut = false;
  assert.equal((await dispatchOneEncryptedFinanceCommandCandidate(args)).status, 'DURABLY_CONFIRMED');
  const after = await readAtomicEncryptedCandidate(USER_A, restored);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.conflicts.length, 0);
  assert.equal(after.snapshot.cloudFinance.revision, 1);
  restored.logout();
});

test('#68 missing journal can use a complete exact-revision snapshot without replaying money', async () => {
  for (const scenario of ['matching', 'changed', 'extra', 'later', 'wrong_receipt']) {
    const {db, session, identity} = await preparedOfflineQueue();
    const initial = cloudPages();
    await refreshEncryptedCloudSnapshot({scope:USER_A, session, identity, pages:initial,
      etag:'"fh.1.0.0123456789abcdef"', expectedEpoch:1});
    await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity,
      command:pendingCommand(), ifMatch:'"fh.1.0.0123456789abcdef"', expectedEpoch:2});
    await persistEncryptedFinanceHoldCandidate({scope:USER_A, session, identity, expectedEpoch:3,
      mutationId:PENDING_ID, httpStatus:410, decision:'SNAPSHOT_REQUIRED_HOLD', source:'delta'});
    const proof = confirmedReceiptData();
    const pages = cloudPages();
    pages[0].body.revision = scenario === 'later' ? 2 : 1;
    const entity = structuredClone(proof.deltaPage.changes[0].payload.entity);
    if (scenario === 'changed') entity.data.opening_minor++;
    pages[0].body.entities.push(entity);
    if (scenario === 'extra') pages[0].body.entities.push({...structuredClone(entity),
      id:'c0000000-0000-4000-8000-000000000003'});
    if (scenario === 'wrong_receipt') proof.receipt.changes[0].payload.entity.data.name = 'Different';
    await refreshEncryptedCloudSnapshot({scope:USER_A, session, identity, pages,
      etag:`"fh.1.${pages[0].body.revision}.0123456789abcdef"`, expectedEpoch:4});
    const before = await readAtomicEncryptedCandidate(USER_A, session);
    assert.equal(before.outbox[0].recoveryBase?.revision, scenario === 'later' ? undefined : 0);
    session.logout();
    const restored = new LocalBudgetSession(); restored.selectScope(USER_A);
    await restored.unlock(await getAtomicEncryptedKeyset(USER_A), {passphrase:PASS});
    const fresh = cloudAuth(restored), args = {lockManager:TEST_LOCKS, scope:USER_A,
      session:restored, identity:fresh, expectedEpoch:5, origin:TEST_ORIGIN,
      explicitNetworkCandidateConsent:true, fetchImpl:async url => url.endsWith('/commands')
        ? mockFinanceJson({...proof.receipt, replayed:true},200)
        : mockFinanceJson({code:'snapshot_required'},410)};
    if (scenario === 'matching') {
      for (const status of [401, 403, 503]) {
        const guarded = {...args, fetchImpl:async url => url.endsWith('/commands')
          ? mockFinanceJson({...proof.receipt, replayed:true},200)
          : url.includes('/changes?') ? mockFinanceJson({code:'snapshot_required'},410)
            : mockFinanceJson({code:'unavailable'},status)};
        const result = await dispatchOneEncryptedFinanceCommandCandidate(guarded);
        assert.equal(result.status, status === 503 ? 'SNAPSHOT_REQUIRED_HOLD' : 'AUTH_HOLD');
        assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, restored), before);
      }
      db.failBundlePut = true;
      await assert.rejects(() => dispatchOneEncryptedFinanceCommandCandidate(args), /injected bundle write failure/);
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, restored), before);
      db.failBundlePut = false;
      const result = await dispatchOneEncryptedFinanceCommandCandidate(args);
      assert.equal(result.status,'DURABLY_CONFIRMED');
      assert.equal(result.proof,'exact_snapshot');
      const after = await readAtomicEncryptedCandidate(USER_A, restored);
      assert.equal(after.outbox.length,0);
      assert.equal(after.conflicts.length,0);
      assert.deepEqual(after.snapshot.cloudFinance.entities,before.snapshot.cloudFinance.entities);
    } else if (scenario === 'later') {
      assert.equal((await dispatchOneEncryptedFinanceCommandCandidate(args)).status,'SNAPSHOT_REQUIRED_HOLD');
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, restored), before);
    } else {
      await assert.rejects(() => dispatchOneEncryptedFinanceCommandCandidate(args), /SYNC_HOLD/);
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, restored), before);
    }
    restored.logout();
  }
});

test('#68 snapshot recovery rejects a transfer with matching but unintended account changes', async () => {
  for (const tamper of [false, true]) {
    mount();
    await createAtomicEncryptedCandidate(USER_A, PASS, {...clone(SOURCE), outbox:[], conflicts:[]});
    const session = await unlock(USER_A), identity = cloudAuth(session);
    const secondId = '20000000-0000-4000-8000-000000000002';
    const second = {...cloudAccount(1,2000), id:secondId,
      data:{...cloudAccount(1,2000).data, name:'Synthetic destination', opening_minor:2000}};
    const pages = cloudPages(); pages[0].body.entities.push(second);
    await initializeEncryptedCloudCacheCandidate({scope:USER_A, session, identity, pages,
      etag:'"fh.1.0.0123456789abcdef"', expectedEpoch:0, confirmedAccountCacheInitialization:true});
    const command = {schema_version:1, client_mutation_id:PENDING_ID, base_revision:0,
      action:'account.transfer', expected_entity_revisions:{[CLOUD_ACCOUNT]:1,[secondId]:1},
      payload:{from_account_id:CLOUD_ACCOUNT, to_account_id:secondId, amount_minor:500, occurred_on:'2026-11-11'}};
    await enqueueEncryptedFinanceCommandCandidate({scope:USER_A, session, identity, command,
      ifMatch:'"fh.1.0.0123456789abcdef"', expectedEpoch:1});
    await persistEncryptedFinanceHoldCandidate({scope:USER_A, session, identity, expectedEpoch:2,
      mutationId:PENDING_ID, httpStatus:410, decision:'SNAPSHOT_REQUIRED_HOLD', source:'delta'});
    const debit = cloudAccount(2,9500), credit = {...second, entity_revision:2,
      data:{...second.data, balance_minor:2500, available_minor:2500}};
    if (tamper) debit.data.name = 'Unexpected rename';
    const tx = {id:CLOUD_TRANSACTION, kind:'transaction', entity_revision:1,
      data:{kind:'transfer', occurred_on:'2026-11-11', note:null,
        posted_at:'2026-11-11T12:00:00Z', reversed_transaction_id:null,
        postings:[{account_id:CLOUD_ACCOUNT, signed_minor:-500}, {account_id:secondId, signed_minor:500}]}};
    const event = {revision:1, ordinal:0, kind:'ledger_posted', entity_id:CLOUD_TRANSACTION,
      entity_revision:1, payload:{from_account_id:CLOUD_ACCOUNT, to_account_id:secondId,
        amount_minor:500, transaction_kind:'transfer', entity:tx, accounts:[debit,credit]}};
    const newer = cloudPages(); newer[0].body.revision = 1; newer[0].body.entities = [debit,credit,tx];
    await refreshEncryptedCloudSnapshot({scope:USER_A, session, identity, pages:newer,
      etag:'"fh.1.1.0123456789abcdef"', expectedEpoch:3});
    const before = await readAtomicEncryptedCandidate(USER_A, session);
    const receipt = {...confirmedReceiptData(event).receipt, schema_version:1, replayed:true};
    const args = {lockManager:TEST_LOCKS, scope:USER_A, session, identity, expectedEpoch:4,
      origin:TEST_ORIGIN, explicitNetworkCandidateConsent:true,
      fetchImpl:async url => url.endsWith('/commands') ? mockFinanceJson(receipt,200)
        : mockFinanceJson({code:'snapshot_required'},410)};
    if (tamper) {
      await assert.rejects(() => dispatchOneEncryptedFinanceCommandCandidate(args), /SYNC_HOLD/);
      assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), before);
    } else {
      assert.equal((await dispatchOneEncryptedFinanceCommandCandidate(args)).proof,'exact_snapshot');
      assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).outbox.length,0);
    }
    session.logout();
  }
});

test('#68 conflict-persistence failure cannot lose a queued financial command', async () => {
  const {db, session, identity} = await pendingAccountCreate();
  const old = await readAtomicEncryptedCandidate(USER_A, session);
  db.failBundlePut = true;
  await assert.rejects(
    () => dispatchOneEncryptedFinanceCommandCandidate({
      lockManager: TEST_LOCKS, scope: USER_A, session, identity,
      origin: TEST_ORIGIN, expectedEpoch: 2,
      explicitNetworkCandidateConsent: true,
      fetchImpl: async () => mockFinanceJson({code:'stale_revision'}, 412),
    }),
    /injected bundle write failure/,
  );
  db.failBundlePut = false;
  const after = await readAtomicEncryptedCandidate(USER_A, session);
  assert.deepEqual(after, old);
  assert.equal(after.outbox.length, 1);
  assert.equal(after.snapshot.cloudFinance.revision, 0);
  session.logout();
});


test('#68 explicit manual conflict choice survives restart but cannot unblock held money', async () => {
  for (const [status, decision, choice] of [
    [409, 'CONFLICT_HOLD', 'KEEP_ORIGINAL_FOR_REVIEW'],
    [410, 'SNAPSHOT_REQUIRED_HOLD', 'PREFER_SERVER_FOR_REVIEW'],
  ]) {
    const {db, session, identity} = await pendingAccountCreate();
    const first = await persistEncryptedFinanceHoldCandidate({
      scope: USER_A, session, identity, expectedEpoch: 2,
      mutationId: PENDING_ID, httpStatus: status, decision,
      source: status === 410 ? 'delta' : 'command',
    });
    assert.equal(first.bundleEpoch, 3);
    const before = await readAtomicEncryptedCandidate(USER_A, session);
    const saved = await recordManualFinanceConflictChoiceCandidate({
      scope: USER_A, session, identity, expectedEpoch: 3,
      mutationId: PENDING_ID, choice, observedCachedRevision: 0,
      explicitUserChoice: true,
    });
    assert.equal(saved.status, 'MANUAL_CHOICE_STAGED');
    assert.equal(saved.bundleEpoch, 4);
    assert.equal(saved.queuePreserved, true);
    assert.equal(saved.conflictStillHeld, true);
    assert.equal(saved.sent, false);
    const after = await readAtomicEncryptedCandidate(USER_A, session);
    assert.deepEqual(after.outbox, before.outbox);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.equal(after.conflicts[0].decision, decision);
    assert.equal(after.conflicts[0].manualChoice.choice, choice);
    assert.equal(after.conflicts[0].manualChoice.observedCachedRevision, 0);
    assert.equal(after.conflicts[0].manualChoice.originalFingerprint,
      after.outbox[0].fingerprint);
    const raw = JSON.stringify([...db.tables.get('bundles').values()]);
    for (const privateValue of [PENDING_ID, NEW_ACCOUNT_ID, CLOUD_ETAG]) {
      assert.equal(raw.includes(privateValue), false);
    }
    session.logout();
    const freshSession = new LocalBudgetSession();
    freshSession.selectScope(USER_A);
    await freshSession.unlock(await getAtomicEncryptedKeyset(USER_A), {passphrase: PASS});
    const fresh = cloudAuth(freshSession);
    let requests = 0;
    const result = await dispatchOneEncryptedFinanceCommandCandidate({
      scope: USER_A, session: freshSession, identity: fresh, expectedEpoch: 4,
      origin: TEST_ORIGIN, explicitNetworkCandidateConsent: true,
      lockManager: TEST_LOCKS,
      fetchImpl: async () => { requests++; throw Error('Must not send held money'); },
    });
    assert.equal(result.status, decision);
    assert.equal(requests, 0);
    const persisted = await readAtomicEncryptedCandidate(USER_A, freshSession);
    assert.equal(persisted.outbox.length, 1);
    assert.equal(persisted.conflicts[0].manualChoice.choice, choice);
    freshSession.logout();
  }
});

test('#68 manual choice is explicit, immutable and fenced by the encrypted CAS', async () => {
  const {db, session, identity} = await pendingAccountCreate();
  await persistEncryptedFinanceHoldCandidate({
    scope: USER_A, session, identity, expectedEpoch: 2,
    mutationId: PENDING_ID, httpStatus: 412, decision: 'CONFLICT_HOLD',
    source: 'command',
  });
  const base = {
    scope: USER_A, session, identity, expectedEpoch: 3,
    mutationId: PENDING_ID, choice: 'KEEP_ORIGINAL_FOR_REVIEW',
    observedCachedRevision: 0, explicitUserChoice: true,
  };
  for (const patch of [
    {explicitUserChoice: false}, {choice: 'AUTO_MERGE'},
    {observedCachedRevision: 1}, {expectedEpoch: 2},
    {mutationId: NEW_ACCOUNT_ID},
    {identity: {...identity, profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
  ]) {
    await assert.rejects(
      () => recordManualFinanceConflictChoiceCandidate({...base, ...patch}),
      /SYNC_HOLD/,
    );
  }
  const previous = await readAtomicEncryptedCandidate(USER_A, session);
  assert.equal(previous.epoch, 3);
  db.failBundlePut = true;
  await assert.rejects(
    () => recordManualFinanceConflictChoiceCandidate(base),
    /injected bundle write failure/,
  );
  db.failBundlePut = false;
  assert.deepEqual(await readAtomicEncryptedCandidate(USER_A, session), previous);
  const recorded = await recordManualFinanceConflictChoiceCandidate(base);
  assert.equal(recorded.bundleEpoch, 4);
  const replay = await recordManualFinanceConflictChoiceCandidate({
    ...base, expectedEpoch: 4,
  });
  assert.equal(replay.status, 'MANUAL_CHOICE_ALREADY_STAGED');
  assert.equal(replay.bundleEpoch, 4);
  await assert.rejects(
    () => recordManualFinanceConflictChoiceCandidate({
      ...base, expectedEpoch: 4, choice: 'PREFER_SERVER_FOR_REVIEW',
    }), /SYNC_HOLD/,
  );
  assert.equal((await readAtomicEncryptedCandidate(USER_A, session)).epoch, 4);
  session.logout();
});
