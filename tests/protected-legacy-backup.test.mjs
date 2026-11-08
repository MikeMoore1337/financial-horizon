import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptBackup} from '../backup.js';
import {createSampleState} from '../finance.js';
import {stageVerifiedLegacyBackup} from '../src/security/verified-legacy-staging.ts';
import {readStagedSnapshot} from '../src/security/protected-staging.ts';

const scope='guest:verified-staging';
const passphrase='synthetic independent vault password 2026';
const backupPassword='synthetic independent backup password 2026';
const consent={savedEncryptedBackupOutsideThisBrowser:true,confirmedSeparateStaging:true};

function mockDb(){
 const tables=new Map([['keysets',new Map()],['records',new Map()]]);
 const db={close(){},onversionchange:null,objectStoreNames:{contains:x=>tables.has(x)},createObjectStore:x=>tables.set(x,new Map()),transaction(_names,mode){
  const staged=new Map([...tables].map(([name,items])=>[name,new Map([...items])]))
  let pending=0,aborted=false,done=false;
  const tx={error:null,oncomplete:null,onerror:null,onabort:null,
   abort(){aborted=true;queueMicrotask(()=>tx.onabort?.())},
   objectStore(name){return {
    get(key){const req={onsuccess:null,result:null};push(()=>{req.result=structuredClone(staged.get(name).get(key));req.onsuccess?.({target:req})});return req},
    put(value,key){assert.equal(mode,'readwrite');push(()=>staged.get(name).set(key,structuredClone(value)))}
   }}
  };
  function push(fn){pending++;queueMicrotask(()=>{if(aborted)return;try{fn()}finally{pending--;if(!pending)queueMicrotask(()=>{if(done||aborted||pending)return;done=true;if(mode==='readwrite')for(const [n,m]of staged)tables.set(n,m);tx.oncomplete?.()})}})}
  return tx;
 }};
 return {tables,indexedDB:{open(){const req={onsuccess:null,onupgradeneeded:null,result:db};queueMicrotask(()=>req.onsuccess?.());return req}}};
}

test('legacy encrypted backup v1 -> v2 protected staging; original remains unchanged',async()=>{
 const db=mockDb();globalThis.indexedDB=db.indexedDB;
 const legacy=createSampleState();legacy.version=1;delete legacy.revision;
 const sourceCopy=structuredClone(legacy);
 const backupText=await encryptBackup(legacy,backupPassword);
 const base={scope,source:legacy,backupText,backupPassword,localPassphrase:passphrase};
 await assert.rejects(()=>stageVerifiedLegacyBackup({...base,consent:{...consent,confirmedSeparateStaging:false}}),/Не подтверждены/);
 assert.equal(db.tables.get('records').size,0);
 await assert.rejects(()=>stageVerifiedLegacyBackup({...base,consent,backupPassword:'an incorrect long password'}),/Неверный пароль/);
 assert.equal(db.tables.get('records').size,0);
 const different=structuredClone(legacy);different.entries[0].title='DIVERGENT';
 await assert.rejects(()=>stageVerifiedLegacyBackup({...base,consent,source:different}),/не совпадает/);
 assert.equal(db.tables.get('records').size,0);
 const result=await stageVerifiedLegacyBackup({...base,consent});
 assert.equal(result.status,'created');
 const restored=await readStagedSnapshot(scope,{passphrase});
 assert.equal(restored.state.version,2); assert.equal(restored.context.schemaVersion,2);
 assert.equal(restored.context.revision,0);
 assert.deepEqual(restored.state.entries,legacy.entries);
 assert.deepEqual(legacy,sourceCopy,'old financial state must remain unchanged');
 const again=await stageVerifiedLegacyBackup({...base,consent});
 assert.deepEqual(again,{status:'already-staged',recoveryKey:null});
 const persisted=JSON.stringify([...db.tables.values()].map(items=>[...items.values()]));
 for(const entry of legacy.entries){assert.equal(persisted.includes(entry.title),false)}
});

test('review P1 regression: changing input during asynchronous backup check cannot redirect the account scope',async()=>{
 const db=mockDb();globalThis.indexedDB=db.indexedDB;
 const legacy=createSampleState();legacy.version=1;delete legacy.revision;
 const backupText=await encryptBackup(legacy,backupPassword);
 const accountA='account:'+'a'.repeat(32),accountB='account:'+'b'.repeat(32);
 const changing={scope:accountA,source:legacy,backupText,backupPassword,localPassphrase:passphrase,consent};
 const inflight=stageVerifiedLegacyBackup(changing);
 changing.scope=accountB;
 changing.localPassphrase='attacker changed password 2026';
 changing.backupText='invalid';
 const result=await inflight;
 assert.equal(result.status,'created');
 assert.equal(await readStagedSnapshot(accountB,{passphrase:changing.localPassphrase}),null);
 assert.equal((await readStagedSnapshot(accountA,{passphrase})).state.version,2);
 await assert.rejects(()=>readStagedSnapshot(accountA,{passphrase:changing.localPassphrase}),/Неверный ключ/);
});

test('review P2 regression: equivalent v1 encrypted backup and reordered v2 source match by values',async()=>{
 const db=mockDb();globalThis.indexedDB=db.indexedDB;
 const legacy=createSampleState();legacy.version=1;delete legacy.revision;
 const backupText=await encryptBackup(legacy,backupPassword);
 // Existing v2 payload can put revision directly after version. The v1 upgrader
 // appends revision last; object key order must never decide financial equality.
 const sourceV2={version:2,revision:0,...Object.fromEntries(Object.entries(legacy).filter(([key])=>key!=='version'&&key!=='revision'))};
 const target='guest:equivalent-v2';
 const result=await stageVerifiedLegacyBackup({scope:target,source:sourceV2,backupText,backupPassword,localPassphrase:passphrase,consent});
 assert.equal(result.status,'created');
 assert.deepEqual((await readStagedSnapshot(target,{passphrase})).state,sourceV2);
});
