import test from 'node:test';
import assert from 'node:assert/strict';
import {readStagedSnapshot,stageProtectedSnapshot,PROTECTED_STAGING_DB} from '../src/security/protected-staging.ts';

const pass = 'synthetic protected staging passphrase';
const userA = 'account:'+'a'.repeat(32), userB = 'account:'+'b'.repeat(32);
const context = {kind:'snapshot',recordId:'state',schemaVersion:2,revision:9};
const source = {version:2,revision:9,entries:[{title:'PRIVATE_TITLE_STAGING_TEST',amountCents:9571327}]};
const clone = v => structuredClone(v);

function fakeIndexedDb(){
 const tables = new Map([['keysets',new Map()],['records',new Map()]]);
 let breakAfterKeyset = false;
 const database = {
  objectStoreNames: {contains:name=>tables.has(name)},
  createObjectStore(name){tables.set(name,new Map())},
  close(){},
  onversionchange:null,
  transaction(_stores,mode){
   const staged = new Map([...tables].map(([store,items])=>[store,new Map([...items].map(([k,v])=>[k,clone(v)]))]));
   let pending = 0, aborted = false, completed = false;
   const tx = {
    error:null,oncomplete:null,onerror:null,onabort:null,
    abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.())},
    objectStore(name){
     if(!staged.has(name))throw Error('missing store '+name);
     return {
      get(key){const req={onsuccess:null,onerror:null,result:undefined};schedule(()=>{req.result=clone(staged.get(name).get(key));req.onsuccess?.({target:req})});return req},
      put(value,key){
       if(mode!=='readwrite')throw Error('readonly');
       if(name==='records'&&breakAfterKeyset)throw Error('injected second put failure');
       schedule(()=>{staged.get(name).set(key,clone(value))});
      }
     }
    },
   };
   function schedule(op){
    pending++;
    queueMicrotask(()=>{
     if(aborted)return;
     try{op()}catch(e){tx.error=e;tx.abort()}
     finally{
      pending--;
      if(!pending&&!aborted)queueMicrotask(()=>{
       if(completed||aborted||pending)return;
       completed=true;
       if(mode==='readwrite')for(const [name,map] of staged)tables.set(name,map);
       tx.oncomplete?.();
      });
     }
    });
   }
   return tx;
  },
 };
 const global = {open(name,version){
   assert.equal(name,PROTECTED_STAGING_DB);
   assert.equal(version,1);
   const request={onsuccess:null,onerror:null,onblocked:null,onupgradeneeded:null,result:database,error:null};
   queueMicrotask(()=>request.onsuccess?.());
   return request;
 }};
 return {global,tables,set failSecondPut(v){breakAfterKeyset=v}};
}

test('encrypted staging: new, exact idempotent retry, recovery, wrong pass and isolation',async()=>{
 const db=fakeIndexedDb(); globalThis.indexedDB=db.global;
 const result=await stageProtectedSnapshot(userA,source,context,pass);
 assert.equal(result.status,'created');assert.equal(typeof result.recoveryKey,'string');
 const persisted=JSON.stringify([...db.tables.values()].map(v=>[...v.values()]));
 for(const secret of [pass,result.recoveryKey,'PRIVATE_TITLE_STAGING_TEST','9571327']){
  assert.equal(persisted.includes(secret),false,`stored plaintext: ${secret.slice(0,7)}`);
 }
 const restored=await readStagedSnapshot(userA,{passphrase:pass},9);
 assert.deepEqual(restored.state,source);
 assert.deepEqual((await readStagedSnapshot(userA,{recoveryKey:result.recoveryKey})).state,source);
 await assert.rejects(()=>readStagedSnapshot(userA,{passphrase:'incorrect test passphrase'}),/Неверный ключ/);
 await assert.rejects(()=>readStagedSnapshot(userA,{recoveryKey:'a'.repeat(43)}),/Неверный ключ|кодирование|длина защищённых данных/);
 assert.equal(await readStagedSnapshot(userB,{passphrase:pass}),null);
 assert.deepEqual(await stageProtectedSnapshot(userA,source,context,pass),{status:'already-staged',recoveryKey:null});
 await assert.rejects(()=>stageProtectedSnapshot(userA,{...source,revision:99},context,pass),/Изменились данные/);
 await assert.rejects(()=>stageProtectedSnapshot(userA,source,{...context,revision:10},pass),/другой снимок/);
 await assert.rejects(()=>readStagedSnapshot(userA,{passphrase:pass},10),/ревизия/);
});

test('two users cannot unlock each other even with identical passphrases',async()=>{
 const db=fakeIndexedDb();globalThis.indexedDB=db.global;
 const a=await stageProtectedSnapshot(userA,source,context,pass);
 const b=await stageProtectedSnapshot(userB,{...source,entries:[{title:'OTHER_ACCOUNT',amountCents:345}]},context,pass);
 assert.notEqual(a.recoveryKey,b.recoveryKey);
 assert.notEqual(db.tables.get('keysets').get(userA).keyId,db.tables.get('keysets').get(userB).keyId);
 await assert.rejects(()=>readStagedSnapshot(userA,{recoveryKey:b.recoveryKey}),/Неверный ключ/);
 assert.equal((await readStagedSnapshot(userB,{passphrase:pass})).state.entries[0].title,'OTHER_ACCOUNT');
});

test('interrupted migration rollback: neither keyset nor record commit before retry',async()=>{
 const db=fakeIndexedDb();globalThis.indexedDB=db.global;
 db.failSecondPut=true;
 await assert.rejects(()=>stageProtectedSnapshot(userA,source,context,pass),/injected second put failure/);
 assert.equal(db.tables.get('keysets').size,0);
 assert.equal(db.tables.get('records').size,0);
 db.failSecondPut=false;
 const created=await stageProtectedSnapshot(userA,source,context,pass);
 assert.equal(created.status,'created');
 assert.deepEqual((await readStagedSnapshot(userA,{passphrase:pass})).state,source);
});

test('missing keyset, tampering with ciphertext, and metadata changes reject',async()=>{
 const db=fakeIndexedDb();globalThis.indexedDB=db.global;
 await stageProtectedSnapshot(userA,source,context,pass);
 const items=db.tables.get('records');
 const original=clone(items.get(userA));
 const row=clone(original);row.record.revision=10;items.set(userA,row);
 await assert.rejects(()=>readStagedSnapshot(userA,{passphrase:pass}),/повреждённые данные/);
 const corrupted=clone(original);corrupted.record.ciphertext='AAAA'+corrupted.record.ciphertext.slice(4);items.set(userA,corrupted);
 await assert.rejects(()=>readStagedSnapshot(userA,{passphrase:pass}),/повреждённые данные/);
 items.set(userA,original);
 db.tables.get('keysets').delete(userA);
 await assert.rejects(()=>readStagedSnapshot(userA,{passphrase:pass}),/Повреждено защищённое хранилище/);
});

test('no network dependency: offline prepare and recovery',async()=>{
 const db=fakeIndexedDb();globalThis.indexedDB=db.global;
 const fetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('network unavailable')};
 try{
  const result=await stageProtectedSnapshot(userA,source,context,pass);
  assert.deepEqual((await readStagedSnapshot(userA,{recoveryKey:result.recoveryKey})).state,source);
 }finally{globalThis.fetch=fetch}
});

test('idempotent retry accepts equivalent data when JSON object keys are reordered',async()=>{
 const db=fakeIndexedDb();globalThis.indexedDB=db.global;
 const created=await stageProtectedSnapshot(userA,source,context,pass);
 assert.equal(created.status,'created');
 const reordered={entries:source.entries.map(e=>({amountCents:e.amountCents,title:e.title})),revision:source.revision,version:source.version};
 assert.deepEqual(await stageProtectedSnapshot(userA,reordered,context,pass),{status:'already-staged',recoveryKey:null});
});
