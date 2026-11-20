import {test,expect} from '@playwright/test';

// Design-gate experiment for #34/#68, never a live storage migration.
// Each run uses its OWN throwaway database name, not financial-horizon-browser-v1.
// It demonstrates the useful v1 -> v2 native barrier and its critical limits.
test('synthetic IndexedDB version barrier blocks old v1 opens only after all v1 connections close',async({page,context})=>{
 const old=await context.newPage();
 const database='fh-e2e-idb-barrier-'+test.info().project.name+'-'+Date.now();
 await page.goto('/__e2e__/ready');
 await old.goto('/__e2e__/ready');
 try{
  const initial=await old.evaluate(async name=>{
   const request=indexedDB.open(name,1);
   request.onupgradeneeded=()=>request.result.createObjectStore('records');
   const db=await new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
   });
   window.__fhOldVersionDb=db;
   await new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite');
    tx.objectStore('records').put({items:['synthetic-a'],outbox:[{id:'synthetic-pending-a'}]},'scope');
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||Error('initial transaction aborted'));
   });
   // Represents a cached client that does NOT cooperate with versionchange.
   db.onversionchange=()=>{window.__fhOldVersionNotified=true;};
   return db.version;
  },database);
  expect(initial).toBe(1);

  await page.evaluate(name=>{
   window.__fhUpgrade={blocked:false,upgraded:false,done:false,error:null};
   const request=indexedDB.open(name,2);
   request.onblocked=()=>{window.__fhUpgrade.blocked=true;};
   request.onupgradeneeded=()=>{window.__fhUpgrade.upgraded=true;};
   request.onerror=()=>{
    window.__fhUpgrade.error=request.error?.name||'unknown';
    window.__fhUpgrade.done=true;
   };
   request.onsuccess=()=>{
    window.__fhNewVersionDb=request.result;
    window.__fhUpgrade.done=true;
   };
  },database);
  await expect.poll(()=>page.evaluate(()=>window.__fhUpgrade?.blocked)).toBe(true);
  expect(await old.evaluate(()=>window.__fhOldVersionNotified)).toBe(true);
  expect(await page.evaluate(()=>window.__fhUpgrade.upgraded)).toBe(false);

  // A cached v1 connection can STILL write while the upgrade is blocked.
  // A cutover MUST treat this as NO_GO, never force the activation marker.
  await old.evaluate(async()=>{
   const db=window.__fhOldVersionDb;
   await new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite');
    tx.objectStore('records').put({
     items:['synthetic-a','synthetic-b'],
     outbox:[{id:'synthetic-pending-a'},{id:'synthetic-pending-b'}],
    },'scope');
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||Error('old writer aborted'));
   });
   db.close();
  });
  await expect.poll(()=>page.evaluate(()=>window.__fhUpgrade?.done)).toBe(true);
  const upgrade=await page.evaluate(()=>({
   upgraded:window.__fhUpgrade.upgraded,
   error:window.__fhUpgrade.error,
   version:window.__fhNewVersionDb?.version,
  }));
  expect(upgrade).toEqual({upgraded:true,error:null,version:2});

  const after=await page.evaluate(async()=>new Promise((resolve,reject)=>{
   const tx=window.__fhNewVersionDb.transaction('records','readonly');
   const request=tx.objectStore('records').get('scope');
   let payload;
   request.onsuccess=()=>{payload=request.result;};
   tx.oncomplete=()=>resolve(payload);
   tx.onerror=()=>reject(tx.error);
  }));
  expect(after.items).toEqual(['synthetic-a','synthetic-b']);
  expect(after.outbox.map(item=>item.id)).toEqual(['synthetic-pending-a','synthetic-pending-b']);

  const reopens=await old.evaluate(async name=>{
   const explicitOld=await new Promise(resolve=>{
    const request=indexedDB.open(name,1);
    request.onerror=()=>resolve(request.error?.name||'UnknownError');
    request.onsuccess=()=>{request.result.close();resolve('UNEXPECTED_SUCCESS');};
   });
   // IMPORTANT LIMIT: callers omitting the version are NOT fenced by v2.
   const versionless=await new Promise((resolve,reject)=>{
    const request=indexedDB.open(name);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
     const db=request.result;
     const tx=db.transaction('records','readwrite');
     tx.objectStore('records').put({
      items:['synthetic-a','synthetic-b','versionless-writer'],
      outbox:[{id:'synthetic-pending-a'},{id:'synthetic-pending-b'}],
     },'scope');
     tx.oncomplete=()=>{const version=db.version;db.close();resolve(version);};
     tx.onerror=()=>{db.close();reject(tx.error);};
    };
   });
   return {explicitOld,versionless};
  },database);
  expect(reopens).toEqual({explicitOld:'VersionError',versionless:2});
  const postVersionless=await page.evaluate(async()=>new Promise((resolve,reject)=>{
   const tx=window.__fhNewVersionDb.transaction('records','readonly');
   const request=tx.objectStore('records').get('scope');
   let payload;
   request.onsuccess=()=>{payload=request.result;};
   tx.oncomplete=()=>resolve(payload);
   tx.onerror=()=>reject(tx.error);
  }));
  expect(postVersionless.items.at(-1)).toBe('versionless-writer');
  expect(postVersionless.outbox).toEqual(after.outbox);
 }finally{
  await old.evaluate(()=>window.__fhOldVersionDb?.close()).catch(()=>{});
  await page.evaluate(()=>window.__fhNewVersionDb?.close()).catch(()=>{});
  await page.evaluate(name=>new Promise(resolve=>{
   const request=indexedDB.deleteDatabase(name);
   request.onsuccess=()=>resolve('ok');
   request.onerror=()=>resolve('error');
   request.onblocked=()=>resolve('blocked');
  }),database).catch(()=>{});
  await old.close().catch(()=>{});
 }
});
