import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyState,createSampleState,validateState,getMonthEvents,monthTotals} from '../finance.js';
import {migrateState,downgradeStateForRollback,CURRENT_STATE_VERSION} from '../state-migrations.js';
import {encryptBackup,decryptBackup} from '../backup.js';
import {applyEntry,applyLoan,applyLoanPayment,applySettlement} from '../ledger-operations.js';

const v1=()=>{
 const state=createSampleState();
 state.version=1;delete state.revision;
 return state;
};
const legacyMoney=state=>({
 entries:state.entries.map(({id,amountCents})=>[id,amountCents]),
 loans:state.loans.map(({id,openingCents,paymentCents,schedule})=>[id,openingCents,paymentCents,schedule]),
 settlements:state.settlements,
 loanPayments:state.loanPayments
});

test('v1 -> v2 is pure, sequential, idempotent and does not change any financial amount',()=>{
 const source=v1(),before=structuredClone(source);
 const migrated=migrateState(source);
 assert.equal(CURRENT_STATE_VERSION,2);
 assert.equal(migrated.version,2);assert.equal(migrated.revision,0);
 assert.deepEqual(source,before);
 assert.deepEqual(legacyMoney(migrated),legacyMoney(before));
 assert.strictEqual(migrateState(migrated),migrated);
 assert.deepEqual(downgradeStateForRollback(migrated),before);
 assert.deepEqual(migrateState(downgradeStateForRollback(migrated)),migrated);
});
test('unknown future schema, damaged version, money and revision are rejected without changing input',()=>{
 for(const corrupt of [
  {...v1(),version:3},{...v1(),version:0},
  {...emptyState(),revision:-1},{...emptyState(),revision:1.25},
  {...v1(),entries:[{id:'bad',amountCents:1.1}]},
  {...v1(),loans:[{id:'bad',openingCents:-1}]}
 ])assert.throws(()=>migrateState(corrupt));
});
test('legacy encrypted backup remains restorable and is migrated only on storage commit',async()=>{
 const source=v1(),password='a-long-legacy-password';
 const file=await encryptBackup(source,password);
 assert.equal(JSON.parse(file).version,1);
 const decrypted=await decryptBackup(file,password);
 assert.deepEqual(decrypted,source);
 const upgraded=migrateState(decrypted);
 assert.deepEqual(legacyMoney(upgraded),legacyMoney(source));
 assert.deepEqual(monthTotals(getMonthEvents(upgraded,'2026-11')),monthTotals(getMonthEvents(source,'2026-11')));
});

function browserDatabase(initial={}){
 const table=new Map(Object.entries(initial).map(([k,v])=>[k,structuredClone(v)]));
 let failWrite=false;
 const db={
  objectStoreNames:{contains:()=>true},
  createObjectStore(){},
  close(){},
  transaction(_store,_mode){
   let aborted=false,completed=false,pending=0;
   const staged=new Map(),tx={
    error:null,oncomplete:null,onerror:null,onabort:null,
    abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
    objectStore:()=>({
     get(key){const req={result:undefined,onsuccess:null,onerror:null};
      schedule(()=>{req.result=structuredClone(staged.has(key)?staged.get(key):table.get(key));req.onsuccess?.();});
      return req;
     },
     put(value,key){
      const copy=structuredClone(value);
      schedule(()=>{if(failWrite){tx.error=Error('injected interruption');tx.abort();return;}staged.set(key,copy);});
     }
    })
   };
   function schedule(fn){
    pending++;
    queueMicrotask(()=>{
     if(aborted)return;
     try{fn();}catch(error){tx.error=error;tx.abort();}
     finally{
      pending--;
      if(!pending&&!aborted)queueMicrotask(()=>{
       if(pending||aborted||completed)return;
       completed=true;
       for(const [key,value] of staged)table.set(key,value);
       tx.oncomplete?.();
      });
     }
    });
   }
   return tx;
  }
 };
 return {table,set failWrite(v){failWrite=v;},open(){
  const req={result:null,onsuccess:null,onerror:null};
  queueMicrotask(()=>{req.result=db;req.onsuccess?.();});
  return req;
 }};
}
let counter=0;
async function scopedStorage(database){
 globalThis.indexedDB=database;
 return import('../storage.js?migrations-suite-'+(++counter));
}
test('native transaction semantics: one migration write, idempotent second read',async()=>{
 const legacy=v1(),db=browserDatabase({state:legacy}),s=await scopedStorage(db);
 const first=await s.readState();
 assert.equal(first.version,2);assert.equal(first.revision,0);
 assert.deepEqual(legacyMoney(db.table.get('state')),legacyMoney(legacy));
 assert.equal(db.table.get('state').version,2);
 assert.deepEqual(await s.readState(),first);
 assert.equal(db.table.get('state').revision,0);
});
test('interrupted migration leaves the full original v1 record intact',async()=>{
 const legacy=v1(),db=browserDatabase({state:legacy}),s=await scopedStorage(db);
 db.failWrite=true;
 await assert.rejects(()=>s.readState(),/injected interruption/);
 assert.deepEqual(db.table.get('state'),legacy);
 db.failWrite=false;
 assert.equal((await s.readState()).version,2);
});
test('application callback error aborts all writes and preserves the prior revision',async()=>{
 const db=browserDatabase({state:emptyState()}),s=await scopedStorage(db);
 await assert.rejects(()=>s.updateState(state=>{
  state.entries.push({id:'temp',amountCents:42});
  throw Error('injected crash');
 }),/injected crash/);
 assert.deepEqual(db.table.get('state'),emptyState());
});
test('two tabs reject a stale expectedRevision instead of silently losing a payment',async()=>{
 const db=browserDatabase({state:emptyState()}),a=await scopedStorage(db),b=await scopedStorage(db);
 const left=await a.readState(),right=await b.readState();
 assert.equal(left.revision,0);assert.equal(right.revision,0);
 const value=await a.updateState(s=>s.entries.push({id:'a',amountCents:200,date:'2026-11-06'}),{expectedRevision:left.revision});
 assert.equal(value.revision,1);
 await assert.rejects(()=>b.updateState(s=>s.entries.push({id:'b',amountCents:300,date:'2026-11-06'}),{expectedRevision:right.revision}),/другой вкладке/);
 assert.equal(db.table.get('state').entries.length,1);
 assert.equal(db.table.get('state').entries[0].amountCents,200);
});
test('restoring a v1 backup is committed as v2 without downgrading active state',async()=>{
 const db=browserDatabase({state:emptyState()}),s=await scopedStorage(db);
 const latest=await s.replaceState(v1(),{expectedRevision:0});
 assert.equal(latest.version,2);assert.equal(latest.revision,1);
 assert.deepEqual(legacyMoney(latest),legacyMoney(v1()));
});
test('operations service preserves cents, records and audit history across create/update',()=>{
 const state=emptyState();
 let sequence=0;
 const options={idFactory:()=>String(++sequence),now:()=> '2026-11-06T12:00:00.000Z'};
 const id=applyEntry(state,{title:'Тест',amountCents:12345,kind:'expense',date:'2026-11-06',recurrence:'once',category:'Другое'},options);
 applyEntry(state,{id,title:'Тест 2',amountCents:12345,kind:'expense',date:'2026-11-06',recurrence:'once',category:'Другое'},options);
 assert.equal(state.entries.length,1);assert.equal(state.entries[0].amountCents,12345);
 const loanId=applyLoan(state,{title:'Кредит',openingCents:100000,paymentCents:10000,apr:0,termMonths:10,dueDay:6,asOfDate:'2026-11-01'},options);
 const pid=applyLoanPayment(state,{loanId,amountCents:10000,date:'2026-11-06',strategy:'term'},options);
 assert.ok(state.loanPayments.find(x=>x.id===pid));
 applySettlement(state,{entryId:id,occurrence:'2026-11',date:'2026-11-06',amountCents:500},options);
 assert.equal(state.settlements[0].amountCents,500);
 assert.equal(state.audit.length,5);
 assert.doesNotThrow(()=>validateState(state));
});

test('entry, loan and settlement forms keep proper date expressions after splitting operations',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const begin=app.indexOf('async function saveEntry(form){');
 const end=app.indexOf('async function performBackup(password){',begin);
 assert.ok(begin>=0&&end>begin);
 const handlers=app.slice(begin,end);
 assert.equal(handlers.split(String.raw`/^\d{4}-\d{2}-\d{2}$/`).length-1,3);
 assert.equal(handlers.includes(String.raw`\\d`),false,'form validators must not match a literal backslash');
});
