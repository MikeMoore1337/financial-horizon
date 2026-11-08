import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {LocalBudgetSession} from '../src/security/local-budget-session.ts';
import {
  createAtomicEncryptedCandidate,getAtomicEncryptedKeyset,
  readAtomicEncryptedCandidate,ATOMIC_ENCRYPTED_DB,
} from '../src/security/protected-atomic-candidate.ts';
import {
  readProtectedFinance,updateProtectedFinance,
} from '../src/security/protected-finance-adapter.ts';

const PASS='different dedicated local passphrase 2026';
const A='account:'+'a'.repeat(32), B='account:'+'b'.repeat(32);
const clone=value=>structuredClone(value);

function fakeNativeIdb() {
  const tables=new Map([['keysets',new Map()],['bundles',new Map()]]);
  let failBundleWrite=false;
  const db={onversionchange:null,close(){},objectStoreNames:{contains:name=>tables.has(name)},
    createObjectStore:name=>tables.set(name,new Map()),
    transaction(_names,mode){
      const pendingTables=new Map([...tables].map(([name,map])=>
        [name,new Map([...map].map(([key,value])=>[key,clone(value)]))]));
      let pending=0,finished=false,aborted=false;
      const tx={oncomplete:null,onerror:null,onabort:null,error:null,
        abort(){if(aborted||finished)return;aborted=true;queueMicrotask(()=>tx.onabort?.())},
        objectStore(name){
          const rows=pendingTables.get(name);
          if(!rows)throw Error('unknown IDB store '+name);
          return {
            get(key){
              const req={result:undefined,onsuccess:null,onerror:null};
              schedule(()=>{req.result=clone(rows.get(key));req.onsuccess?.({target:req})});
              return req;
            },
            put(value,key){
              if(mode!=='readwrite')throw Error('readonly');
              if(name==='bundles'&&failBundleWrite)throw Error('injected atomic put failure');
              const pinned=clone(value);
              schedule(()=>rows.set(key,pinned));
            }
          };
        },
      };
      function schedule(action){
        pending++;
        queueMicrotask(()=>{
          if(aborted){pending--;return;}
          try{action()}catch(e){tx.error=e;tx.abort()}
          finally{
            pending--;
            if(pending===0&&!aborted)queueMicrotask(()=>{
              if(finished||aborted||pending)return;
              finished=true;
              if(mode==='readwrite')for(const [name,map]of pendingTables)tables.set(name,map);
              tx.oncomplete?.();
            });
          }
        });
      }
      return tx;
    }
  };
  globalThis.indexedDB={open(name,version){
    assert.equal(name,ATOMIC_ENCRYPTED_DB);
    assert.equal(version,1);
    const req={onsuccess:null,onerror:null,onupgradeneeded:null,onblocked:null,
      result:db,error:null};
    queueMicrotask(()=>req.onsuccess?.());
    return req;
  }};
  return {tables,set failBundleWrite(x){failBundleWrite=x}};
}
async function setup(scope=A,initialOutbox=[{id:'pending-1',amountCents:123}]) {
  const db=fakeNativeIdb();
  const financial=createSampleState();
  financial.revision=12;
  const {recoveryKey}=await createAtomicEncryptedCandidate(scope,PASS,{
    snapshot:financial,outbox:initialOutbox,conflicts:[],
  },2);
  const session=new LocalBudgetSession();
  session.selectScope(scope);
  await session.unlock(await getAtomicEncryptedKeyset(scope),{passphrase:PASS});
  return {db,session,financial,recoveryKey};
}

test('protected read shows v2 state, epoch, durable outbox and no plaintext in IndexedDB',async()=>{
  const {db,session,financial}=await setup();
  const r=await readProtectedFinance(A,session);
  assert.equal(r.state.revision,12);assert.equal(r.epoch,0);
  assert.deepEqual(r.state,financial);
  assert.deepEqual(r.outbox,[{id:'pending-1',amountCents:123}]);
  const stored=JSON.stringify([...db.tables.values()].map(x=>[...x.values()]));
  for(const secret of [financial.entries[0].title,'pending-1',String(financial.entries[0].amountCents)])
    assert.ok(!stored.includes(secret),'plaintext must not be stored');
});

test('mutating finance and outbox commits as one encrypted bundle; revision and epoch advance',async()=>{
  const {db,session}=await setup();
  const result=await updateProtectedFinance(A,session,(state,outbox)=>{
    state.entries[0].amountCents+=100;
    outbox.push({id:'unique-payment-2',amountCents:100});
  },{expectedRevision:12,expectedEpoch:0});
  assert.equal(result.state.revision,13);
  assert.equal(result.epoch,1);
  assert.equal(result.outbox.length,2);
  const restored=await readProtectedFinance(A,session);
  assert.equal(restored.state.entries[0].amountCents,result.state.entries[0].amountCents);
  assert.equal(restored.state.revision,13);
  assert.deepEqual(restored.outbox,result.outbox);
  assert.equal(db.tables.get('bundles').size,1);
});

test('ordinary finance edits do not remove or replay existing queued outbox operations',async()=>{
  const {session}=await setup();
  await updateProtectedFinance(A,session,state=>{state.entries[0].title='SAFE_LOCAL_TITLE'});
  const data=await readProtectedFinance(A,session);
  assert.deepEqual(data.outbox,[{id:'pending-1',amountCents:123}]);
  assert.equal(data.state.entries[0].title,'SAFE_LOCAL_TITLE');
});

test('stale revision and epoch are rejected before committing financial changes',async()=>{
  const {session}=await setup();
  await assert.rejects(()=>updateProtectedFinance(A,session,
    state=>{state.entries[0].amountCents+=900;},{expectedRevision:11}),/изменились/);
  await assert.rejects(()=>updateProtectedFinance(A,session,
    state=>{state.entries[0].amountCents+=900;},{expectedEpoch:3}),/другой вкладке/);
  const got=await readProtectedFinance(A,session);
  assert.equal(got.state.revision,12);assert.equal(got.epoch,0);
});

test('invalid financial amount or unsupported replacement fails before encryption',async()=>{
  const {session}=await setup();
  await assert.rejects(()=>updateProtectedFinance(A,session,
    state=>{state.entries[0].amountCents=-4}),/Неверные суммы/);
  await assert.rejects(()=>updateProtectedFinance(A,session,
    state=>{state.entries[0].amountCents=Infinity}),/Неверные суммы/);
  assert.equal((await readProtectedFinance(A,session)).epoch,0);
});

test('a throwing or async mutation never commits a half-updated financial bundle',async()=>{
  const {session}=await setup();
  await assert.rejects(()=>updateProtectedFinance(A,session,
    (state,outbox)=>{outbox.push({id:'MUST_NOT_WRITE'});throw Error('injected callback error')}),
    /injected callback error/);
  await assert.rejects(()=>updateProtectedFinance(A,session,
    async()=>{}),/Асинхронные операции/);
  const data=await readProtectedFinance(A,session);
  assert.equal(data.epoch,0);
  assert.deepEqual(data.outbox,[{id:'pending-1',amountCents:123}]);
});

test('an aborted IndexedDB CAS update preserves previous state and queue',async()=>{
  const {db,session}=await setup();
  db.failBundleWrite=true;
  await assert.rejects(()=>updateProtectedFinance(A,session,(state,outbox)=>{
    state.entries[0].amountCents+=100;
    outbox.push({id:'NOT_WRITTEN'});
  }),/injected atomic put failure/);
  db.failBundleWrite=false;
  const restored=await readProtectedFinance(A,session);
  assert.equal(restored.epoch,0);assert.equal(restored.state.revision,12);
  assert.deepEqual(restored.outbox,[{id:'pending-1',amountCents:123}]);
});

test('logout invalidates pending update and prevents plaintext publication',async()=>{
  const {session}=await setup();
  const writing=updateProtectedFinance(A,session,state=>{state.entries[0].amountCents+=1});
  session.logout();
  await assert.rejects(writing,/заблокирован/);
  assert.equal(session.state,'unselected');
  const recovered=new LocalBudgetSession();recovered.selectScope(A);
  await recovered.unlock(await getAtomicEncryptedKeyset(A),{passphrase:PASS});
  const r=await readProtectedFinance(A,recovered);
  assert.equal(r.epoch,0);
});

test('protected adapter cannot read another account even if it has its own ciphertext',async()=>{
  const {session}=await setup();
  await assert.rejects(()=>readProtectedFinance(B,session),/заблокирован/);
  await assert.rejects(()=>updateProtectedFinance(B,session,()=>{}),/заблокирован/);
  assert.equal((await readProtectedFinance(A,session)).epoch,0);
});

test('recovery key works after restart and does not imply server session',async()=>{
  const {session,recoveryKey}=await setup();
  session.logout();
  const fresh=new LocalBudgetSession();fresh.selectScope(A);
  await fresh.unlock(await getAtomicEncryptedKeyset(A),{recoveryKey});
  const result=await readProtectedFinance(A,fresh);
  assert.equal(result.state.revision,12);
  fresh.logout();
});

test('no plaintext fallback when encrypted candidate is missing, unsupported or corrupted',async()=>{
  const {db,session}=await setup();
  const row=clone(db.tables.get('bundles').get(A));
  db.tables.get('bundles').delete(A);
  await assert.rejects(()=>readProtectedFinance(A,session),/отсутствует|Повреждён/);
  db.tables.get('bundles').set(A,row);
  const corrupt=clone(row);
  corrupt.snapshot.schemaVersion=3;
  db.tables.get('bundles').set(A,corrupt);
  await assert.rejects(()=>readProtectedFinance(A,session),/Повреждён/);
});

test('no network needed to update an offline encrypted budget and preserve its queue',async()=>{
  const {session}=await setup();
  const prior=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('network unavailable')};
  try{
    const result=await updateProtectedFinance(A,session,(state,outbox)=>{
      state.entries[0].amountCents+=23;
      outbox.push({id:'offline-23',amountCents:23});
    });
    assert.equal(result.epoch,1);
    assert.equal((await readProtectedFinance(A,session)).outbox.length,2);
  }finally{globalThis.fetch=prior}
});


test('review P2: rejecting async financial mutation leaves no orphaned rejection',async()=>{
  const {session}=await setup();
  let unhandled=0;
  const observe=()=>{unhandled++};
  process.on('unhandledRejection',observe);
  try{
    await assert.rejects(()=>updateProtectedFinance(A,session,
      async()=>{await Promise.resolve();throw Error('mutator rejected unexpectedly')}),/Асинхронные операции/);
    // Give Node a full turn in which any unhandled rejection would be emitted.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(unhandled,0);
    const stored=await readProtectedFinance(A,session);
    assert.equal(stored.epoch,0);
    assert.deepEqual(stored.outbox,[{id:'pending-1',amountCents:123}]);
  }finally{process.off('unhandledRejection',observe)}
});
