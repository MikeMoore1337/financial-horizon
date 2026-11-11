import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeEncryptedCloudCacheCandidate,
  persistEncryptedCloudDeltaCandidate,
} from '../src/cloud/encrypted-cloud-cache-candidate.mjs';
import {
  enqueueEncryptedFinanceCommandCandidate,
  classifyFinanceOutboxResponseCandidate,
  persistAuthenticatedFinanceReceiptCandidate,
} from '../src/cloud/encrypted-command-outbox-candidate.mjs';
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
  let logoutAfterKeysetPut = null;
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
