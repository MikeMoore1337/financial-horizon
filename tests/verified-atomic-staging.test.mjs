import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {encryptBackup} from '../backup.js';
import {prepareVerifiedAtomicCandidate} from '../src/security/verified-atomic-staging.ts';
import {getAtomicEncryptedKeyset,readAtomicEncryptedCandidate}
  from '../src/security/protected-atomic-candidate.ts';
import {LocalBudgetSession} from '../src/security/local-budget-session.ts';

const PASSWORD='independent backup passphrase 2026';
const LOCAL_PASSWORD='different local unlock passphrase 2026';
const USER_A='a'.repeat(32);
const USER_B='b'.repeat(32);
const selection={kind:'account',verifiedUserId:USER_A};
const consent={
  savedEncryptedBackupOutsideThisBrowser:true,
  confirmedReadOnlyPreflight:true,
  confirmedSeparateEncryptedCandidate:true,
  acknowledgedOneTimeRecovery:true,
};
const clone=value=>structuredClone(value);
const legacy=()=>{const s=createSampleState();s.version=1;delete s.revision;return s};

function mount(rows,options={}) {
  const old=new Map(Object.entries(rows).map(([k,v])=>[k,clone(v)]));
  const protectedStores=new Map([['keysets',new Map()],['bundles',new Map()]]);
  let legacyOpens=0, atomicOpens=0, legacyWrites=0;
  function db(kind) {
    const storeMap=kind==='legacy'?new Map([['finance',old]]):protectedStores;
    return {
      version:1,close(){},onversionchange:null,
      objectStoreNames:{contains:n=>storeMap.has(n)},
      transaction(names,mode){
        if(kind==='legacy'&&mode!=='readonly') {
          legacyWrites++;
          throw Error('legacy must never be written');
        }
        const working=new Map([...storeMap].map(([name,items])=>
          [name,new Map([...items].map(([key,value])=>[key,clone(value)]))]));
        let pending=0,done=false,aborted=false;
        const tx={
          oncomplete:null,onabort:null,onerror:null,error:null,
          abort(){if(done||aborted)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
          objectStore(name){
            if(!working.has(name))throw Error('Missing store: '+name);
            const values=working.get(name);
            return {
              get(key){
                const req={result:undefined,onsuccess:null,onerror:null};
                schedule(()=>{req.result=clone(values.get(key));req.onsuccess?.({target:req});});
                return req;
              },
              put(value,key){
                if(mode!=='readwrite')throw Error('readonly');
                const copy=clone(value);
                schedule(()=>{values.set(key,copy)});
              },
            };
          },
        };
        function schedule(op){
          pending++;
          queueMicrotask(()=>{
            if(aborted){pending--;return;}
            try{op()}catch(e){tx.error=e;tx.abort();}
            finally{
              pending--;
              if(pending===0&&!aborted)queueMicrotask(()=>{
                if(done||aborted||pending)return;
                done=true;
                if(mode==='readwrite')for(const [name,items]of working)storeMap.set(name,items);
                if(kind==='atomic'&&mode==='readwrite')
                  for(const [name,items]of working)protectedStores.set(name,items);
                tx.oncomplete?.();
              });
            }
          });
        }
        return tx;
      },
    };
  }
  const oldDb=db('legacy');
  const atomicDb=db('atomic');
  globalThis.indexedDB={open(name,version){
    let result;
    if(name==='financial-horizon-browser-v1'){
      assert.equal(version,undefined);
      legacyOpens++;
      if(legacyOpens===3&&options.mutateAfterCommit)options.mutateAfterCommit(old);
      result=oldDb;
    } else if(name==='financial-horizon-encrypted-atomic-candidate-v1'){
      assert.equal(version,1);
      atomicOpens++;
      if(atomicOpens===2&&options.tamperReadback){
        const row=clone(protectedStores.get('bundles').get('account:'+USER_A));
        if(row){row.snapshot.revision++;protectedStores.get('bundles').set('account:'+USER_A,row);}
      }
      result=atomicDb;
    }else throw Error('Unexpected IndexedDB: '+name);
    const req={onsuccess:null,onerror:null,onupgradeneeded:null,onblocked:null,
      result,error:null,transaction:null};
    queueMicrotask(()=>req.onsuccess?.());
    return req;
  }};
  return {old,protectedStores,
    get legacyOpens(){return legacyOpens},
    get atomicOpens(){return atomicOpens},
    get legacyWrites(){return legacyWrites},
  };
}
async function setup(rows, options={}) {
  const state=legacy();
  const backupText=await encryptBackup(state,PASSWORD);
  const db=mount(rows||{['account-state-v2:'+USER_A]:state},options);
  return {db,state,backupText};
}
const invoke=(backupText,extra={})=>prepareVerifiedAtomicCandidate({
  selection,backupText,backupPassword:PASSWORD,
  localPassphrase:LOCAL_PASSWORD,consent,...extra,
});

test('verified v1 backup makes an inactive atomic candidate; existing ledger intact',async()=>{
  const {db,state,backupText}=await setup();
  const result=await invoke(backupText);
  assert.equal(result.status,'prepared');
  assert.equal(result.active,false);
  assert.equal(result.scope,'account:'+USER_A);
  assert.equal(result.sourceKey,'account-state-v2:'+USER_A);
  assert.equal(result.sourceRevision,0);
  assert.equal(result.recoveryKey.length,43);
  assert.equal(db.legacyWrites,0);
  assert.deepEqual(db.old.get('account-state-v2:'+USER_A),state);
  const persisted=JSON.stringify([...db.protectedStores.values()].map(s=>[...s.values()]));
  for(const secret of [PASSWORD,LOCAL_PASSWORD,result.recoveryKey,
    state.entries[0].title,String(state.entries[0].amountCents)]){
    assert.ok(!persisted.includes(secret),'plaintext leaked: '+secret.slice(0,6));
  }
  const session=new LocalBudgetSession();
  session.selectScope(result.scope);
  await session.unlock(await getAtomicEncryptedKeyset(result.scope),{passphrase:LOCAL_PASSWORD});
  const copy=await readAtomicEncryptedCandidate(result.scope,session);
  assert.equal(copy.snapshot.version,2);
  assert.deepEqual(copy.snapshot.entries,state.entries);
  assert.deepEqual(copy.outbox,[]);
  assert.deepEqual(copy.conflicts,[]);
  session.logout();
});

test('bad backup cannot create any encrypted keyset or candidate',async()=>{
  const {db,backupText}=await setup();
  await assert.rejects(()=>invoke(backupText,{backupPassword:'invalid long backup password 2026'}),/Неверный пароль/);
  assert.equal(db.protectedStores.get('keysets').size,0);
  assert.equal(db.protectedStores.get('bundles').size,0);
});

test('independent staging requires all explicit confirmations before DB access',async()=>{
  const {db,backupText}=await setup();
  await assert.rejects(()=>invoke(backupText,{consent:{...consent,confirmedSeparateEncryptedCandidate:false}}),/Нет подтверждения/);
  await assert.rejects(()=>invoke(backupText,{consent:{...consent,acknowledgedOneTimeRecovery:false}}),/Нет подтверждения/);
  assert.equal(db.legacyOpens,0);
  assert.equal(db.atomicOpens,0);
});

test('pre-existing candidate cannot be overwritten or silently rotate its keys',async()=>{
  const {db,backupText}=await setup();
  const first=await invoke(backupText);
  const before=clone(db.protectedStores.get('keysets').get('account:'+USER_A));
  await assert.rejects(()=>invoke(backupText),/уже существует/);
  assert.deepEqual(db.protectedStores.get('keysets').get('account:'+USER_A),before);
  assert.equal(first.recoveryKey.length,43);
});

test('source change after candidate commit returns stale-source with recovery receipt',async()=>{
  const source=legacy();
  const backupText=await encryptBackup(source,PASSWORD);
  const db=mount({['account-state-v2:'+USER_A]:source},{
    mutateAfterCommit(values){
      const changed=clone(values.get('account-state-v2:'+USER_A));
      changed.entries[0].amountCents+=200;
      values.set('account-state-v2:'+USER_A,changed);
    },
  });
  const result=await invoke(backupText);
  assert.equal(result.status,'stale-source');
  assert.equal(result.active,false);
  assert.equal(result.recoveryKey.length,43);
  assert.equal(db.protectedStores.get('keysets').size,1);
  assert.equal(db.old.get('account-state-v2:'+USER_A).entries[0].amountCents,
    source.entries[0].amountCents+200);
  assert.equal(db.legacyWrites,0);
});

test('corrupted postcommit readback returns unverified but preserves recovery key',async()=>{
  const {db,backupText}=await setup(null,{tamperReadback:true});
  const result=await invoke(backupText);
  assert.equal(result.status,'unverified');
  assert.equal(result.recoveryKey.length,43);
  assert.equal(result.active,false);
  assert.equal(db.protectedStores.get('keysets').size,1);
  assert.equal(db.legacyWrites,0);
});

test('input scope, credentials and consent cannot redirect account during KDF',async()=>{
  const {db,backupText}=await setup();
  const input={selection:{...selection},backupText,backupPassword:PASSWORD,
    localPassphrase:LOCAL_PASSWORD,consent:{...consent}};
  const inflight=prepareVerifiedAtomicCandidate(input);
  input.selection.verifiedUserId=USER_B;
  input.localPassphrase='tampered local password 2026';
  input.backupPassword='tampered backup password 2026';
  input.backupText='invalid';
  const result=await inflight;
  assert.equal(result.status,'prepared');
  assert.equal(result.scope,'account:'+USER_A);
  assert.equal(db.protectedStores.get('keysets').has('account:'+USER_B),false);
});

test('verification and preparation do not require a network',async()=>{
  const {backupText}=await setup();
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('offline')};
  try{assert.equal((await invoke(backupText)).status,'prepared')}
  finally{globalThis.fetch=original}
});
