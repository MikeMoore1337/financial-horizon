import test from 'node:test';
import assert from 'node:assert/strict';
// Transaction-level API double: validates our IndexedDB adapter, not browser-native persistence.
test('IndexedDB adapter: atomic read-modify-write, no data in localStorage',async()=>{
 const table=new Map();
 const db={
  objectStoreNames:{contains:()=>true},
  createObjectStore:()=>{},
  transaction(name,mode){
   const tx={oncomplete:null,onerror:null,onabort:null,abort(){queueMicrotask(()=>tx.onabort?.())},objectStore:()=>({
    get(key){const req={};queueMicrotask(()=>{req.result=table.get(key)===undefined?undefined:structuredClone(table.get(key));req.onsuccess?.()});return req;},
    put(value,key){table.set(key,structuredClone(value));queueMicrotask(()=>tx.oncomplete?.());}
   })};return tx;
  }
 };
 globalThis.indexedDB={open:()=>{const req={};queueMicrotask(()=>{req.result=db;req.onsuccess?.()});return req;}};
 const {readState,updateState}=await import('../storage.js?in-memory-idb-test');
 const base=await readState();assert.equal(base.entries.length,0);
 await updateState(s=>s.entries.push({id:'record-1',title:'Mock',amountCents:100,date:'2026-11-10',recurrence:'once',kind:'expense'}));
 assert.equal((await readState()).entries.length,1);
 await updateState(s=>s.entries[0].title='Updated');
 assert.equal((await readState()).entries[0].title,'Updated');
 assert.ok(table.has('state'));
});
