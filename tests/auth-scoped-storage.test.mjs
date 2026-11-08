import test from 'node:test';
import assert from 'node:assert/strict';

function browserDatabase(){
 const table=new Map();
 const db={
  objectStoreNames:{contains:()=>true},
  createObjectStore:()=>{},
  transaction(){
   let pending=0,aborted=false;
   const tx={oncomplete:null,onerror:null,onabort:null,error:null,
    abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},
    objectStore:()=>({
     get(key){
      const req={onsuccess:null,onerror:null,result:undefined,error:null};
      schedule(()=>{req.result=structuredClone(table.get(key));req.onsuccess?.();});
      return req;
     },
     put(value,key){
      const snapshot=structuredClone(value);
      schedule(()=>table.set(key,snapshot));
     }
    })
   };
   function schedule(callback){
    pending++;
    queueMicrotask(()=>{
     if(aborted)return;
     try{callback();}
     catch(error){aborted=true;tx.error=error;tx.onerror?.();}
     finally{
      pending--;
      if(pending===0&&!aborted)queueMicrotask(()=>{if(pending===0&&!aborted)tx.oncomplete?.();});
     }
    });
   }
   return tx;
  }
 };
 return {table,open(){
  const req={onsuccess:null,onerror:null};
  queueMicrotask(()=>{req.result=db;req.onsuccess?.();});
  return req;
 }};
}

const accountA='a'.repeat(32),accountB='b'.repeat(32);
const entry=title=>({
 id:'entry-'+title,kind:'expense',title,amountCents:12345,
 date:'2026-11-06',recurrence:'once',category:'Другое'
});

test('guest legacy ledger is migrated once to the verified account, without deleting original',async()=>{
 const mock=browserDatabase();
 globalThis.indexedDB=mock;
 const s=await import('../storage.js?auth-scope-suite');

 assert.equal((await s.selectStateScope(null)),'state');
 await s.updateState(value=>value.entries.push(entry('existing')));
 assert.equal((await s.readState()).entries[0].title,'existing');

 assert.equal(await s.selectStateScope(accountA),'account-state-v2:'+accountA);
 assert.equal((await s.readState()).entries[0].title,'existing');
 assert.equal(mock.table.get('state').entries[0].title,'existing');
 assert.equal(mock.table.get('legacy-account-claim-v2'),accountA);

 // Guest mode must not reveal the claimed account records.
 assert.equal(await s.selectStateScope(null),'guest-state-v2');
 assert.equal((await s.readState()).entries.length,0);
 await s.updateState(value=>value.entries.push(entry('guest-only')));
 assert.equal((await s.readState()).entries[0].title,'guest-only');

 assert.equal(await s.selectStateScope(accountA),'account-state-v2:'+accountA);
 assert.equal((await s.readState()).entries[0].title,'existing');
 assert.equal((await s.readState()).entries.length,1);

 // A second account cannot claim A's historical data.
 await s.selectStateScope(accountB);
 assert.equal((await s.readState()).entries.length,0);
 await s.updateState(value=>value.entries.push(entry('other-user')));
 assert.equal((await s.readState()).entries[0].title,'other-user');

 await s.selectStateScope(accountA);
 assert.equal((await s.readState()).entries[0].title,'existing');
 await s.selectStateScope(null);
 assert.equal((await s.readState()).entries[0].title,'guest-only');

 // Re-running migration and switching accounts cannot alter the original.
 assert.equal(mock.table.get('state').entries[0].title,'existing');
 assert.equal(mock.table.get('legacy-account-claim-v2'),accountA);
});

test('invalid, missing or unverified user identity is not accepted as an account scope',async()=>{
 const s=await import('../storage.js?auth-scope-suite');
 await assert.rejects(()=>s.selectStateScope('attacker@example.com'),/подтверждённый аккаунт/);
 await assert.rejects(()=>s.selectStateScope('123'),/подтверждённый аккаунт/);
});

test('no legacy data means a fresh account ledger with a committed owner marker',async()=>{
 const mock=browserDatabase();
 // Fresh module instance is required because storage.js caches the database object.
 globalThis.indexedDB=mock;
 const s=await import('../storage.js?auth-scope-empty');
 await s.selectStateScope(accountA);
 assert.equal((await s.readState()).entries.length,0);
 assert.equal(mock.table.get('legacy-account-claim-v2'),accountA);
 await s.selectStateScope(accountB);
 assert.equal((await s.readState()).entries.length,0);
 await s.selectStateScope(null);
 assert.equal((await s.readState()).entries.length,0);
});

test('failed account selection irrevocably drops the previously selected account',async()=>{
 const mock=browserDatabase();
 globalThis.indexedDB=mock;
 const s=await import('../storage.js?scope-revocation-invalid');
 await s.selectStateScope(accountA);
 await s.updateState(value=>value.entries.push(entry('account-A-private')));
 assert.equal((await s.readState()).entries[0].title,'account-A-private');
 await assert.rejects(()=>s.selectStateScope('not-a-verified-id'),/подтверждённый аккаунт/);
 await assert.rejects(()=>s.readState(),/профиль изменён/);
 await assert.rejects(()=>s.updateState(()=>{}),/профиль изменён/);
 await s.selectStateScope(accountB);
 assert.equal((await s.readState()).entries.length,0);
 await s.selectStateScope(accountA);
 assert.equal((await s.readState()).entries[0].title,'account-A-private');
});

test('fenced target account cannot leave the previously viewed ledger accessible',async()=>{
 const mock=browserDatabase();
 globalThis.indexedDB=mock;
 const s=await import('../storage.js?scope-revocation-fenced');
 await s.selectStateScope(accountA);
 await s.updateState(value=>value.entries.push(entry('private-A')));
 const keyB='account-state-v2:'+accountB;
 mock.table.set('encrypted-cutover-fence-v1:'+keyB,{version:1,format:'test-marker'});
 await assert.rejects(()=>s.selectStateScope(accountB),/заблокирована для перехода/);
 await assert.rejects(()=>s.readState(),/профиль изменён/);
 await assert.rejects(()=>s.updateState(()=>{}),/профиль изменён/);
 mock.table.delete('encrypted-cutover-fence-v1:'+keyB);
 await s.selectStateScope(accountB);
 assert.equal((await s.readState()).entries.length,0);
 await s.selectStateScope(accountA);
 assert.equal((await s.readState()).entries[0].title,'private-A');
});

test('two overlapping account selections cannot install a stale identity',async()=>{
 const mock=browserDatabase();
 globalThis.indexedDB=mock;
 const s=await import('../storage.js?scope-revocation-overlap');
 const slow=s.selectStateScope(accountA);
 const winner=s.selectStateScope(accountB);
 await assert.rejects(slow,/профиль изменён/);
 assert.equal(await winner,'account-state-v2:'+accountB);
 await s.updateState(value=>value.entries.push(entry('B-only')));
 assert.equal((await s.readState()).entries[0].title,'B-only');
 assert.equal(mock.table.has('account-state-v2:'+accountA),false);
});

test('scope revocation during a synchronous finance mutation aborts its transaction',async()=>{
 const mock=browserDatabase();
 globalThis.indexedDB=mock;
 const s=await import('../storage.js?scope-revocation-atomic');
 await s.selectStateScope(accountA);
 await s.updateState(value=>value.entries.push(entry('original')));
 const source=structuredClone(mock.table.get('account-state-v2:'+accountA));
 let switchToB=null;
 await assert.rejects(()=>s.updateState(value=>{
  value.entries[0].title='FORBIDDEN_PENDING_PAYMENT';
  switchToB=s.selectStateScope(accountB);
 }),/профиль изменён|Операция отменена|transaction|aborted/i);
 assert.equal(await switchToB,'account-state-v2:'+accountB);
 assert.deepEqual(mock.table.get('account-state-v2:'+accountA),source);
 assert.equal((await s.readState()).entries.length,0);
});
