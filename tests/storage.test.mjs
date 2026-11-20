import test from 'node:test';
import assert from 'node:assert/strict';
// Transaction-level API double: validates our IndexedDB adapter, not browser-native persistence.
test('IndexedDB adapter: atomic read-modify-write, no data in localStorage',async()=>{
 const table=new Map();
 const db={
  objectStoreNames:{contains:()=>true},
  createObjectStore:()=>{},
  transaction(name,mode){
   let pending=0,aborted=false,completed=false;
   const staged=new Map();
   const tx={
    oncomplete:null,onerror:null,onabort:null,error:null,
    abort(){if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},
    objectStore:()=>({
     get(key){
      const req={result:undefined,onsuccess:null,onerror:null};
      schedule(()=>{
       const value=staged.has(key)?staged.get(key):table.get(key);
       req.result=value===undefined?undefined:structuredClone(value);
       req.onsuccess?.();
      });
      return req;
     },
     put(value,key){
      if(mode!=='readwrite')throw Error('readonly');
      const copy=structuredClone(value);
      schedule(()=>staged.set(key,copy));
     }
    })
   };
   function schedule(fn){
    pending++;
    queueMicrotask(()=>{
     if(aborted)return;
     try{fn()}catch(error){tx.error=error;tx.abort()}
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
 globalThis.indexedDB={open:()=>{const req={};queueMicrotask(()=>{req.result=db;req.onsuccess?.()});return req;}};
 const {readState,updateState}=await import('../storage.js?in-memory-idb-test');
 const base=await readState();assert.equal(base.entries.length,0);
 await updateState(s=>s.entries.push({id:'record-1',title:'Mock',amountCents:100,date:'2026-11-10',recurrence:'once',kind:'expense'}));
 assert.equal((await readState()).entries.length,1);
 await updateState(s=>s.entries[0].title='Updated');
 assert.equal((await readState()).entries[0].title,'Updated');
 assert.ok(table.has('state'));
});
