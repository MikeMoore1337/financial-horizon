import {test,expect} from '@playwright/test';

async function initialize(page){
 await page.goto('/__e2e__/ready');
 await page.evaluate(async()=>{
  window.fhStorage=await import('/storage.js?personal-import-lock');
  await window.fhStorage.selectStateScope('a'.repeat(32));
 });
}
async function startLock(page){
 await page.evaluate(async()=>{
  window.fhSnapshot=await window.fhStorage.readState();
  window.fhAbort=new AbortController();
  window.fhLockStarted=false;window.fhLockFinished=false;
  window.fhLockTask=window.fhStorage.withStableImportSnapshot(
   current=>JSON.stringify(current)===JSON.stringify(window.fhSnapshot),
   signal=>new Promise((resolve,reject)=>{
    window.fhLockStarted=true;window.fhRelease=()=>resolve('complete');
    signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
   }),{signal:window.fhAbort.signal},
  ).then(()=>{window.fhLockFinished=true},()=>{window.fhLockFinished=true});
 });
 await expect.poll(()=>page.evaluate(()=>window.fhLockStarted)).toBe(true);
}
async function startWrite(page){
 await page.evaluate(()=>{
  window.fhWriteTask=window.fhStorage.updateState(state=>{state.settings.syntheticFlag='preserved';});
 });
}
async function startLegacyWrite(page){
 await page.evaluate(()=>{
  window.fhWriteTask=new Promise((resolve,reject)=>{
   const open=indexedDB.open('financial-horizon-browser-v1',1);
   open.onerror=()=>reject(open.error);
   open.onsuccess=()=>{
    const db=open.result,tx=db.transaction('finance','readwrite');
    const store=tx.objectStore('finance'),key='account-state-v2:'+'a'.repeat(32),request=store.get(key);
    request.onsuccess=()=>{const value=request.result;value.settings.syntheticFlag='preserved';value.revision++;store.put(value,key);};
    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
   };
  });
 });
}
async function isBlocked(page){
 return page.evaluate(()=>Promise.race([
  window.fhWriteTask.then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),250)),
 ]));
}

test('import blocks even an old writer that does not inspect a fence marker',async({page,context})=>{
 const other=await context.newPage();
 await initialize(page);await initialize(other);
 await page.evaluate(()=>window.fhStorage.updateState(()=>{}));
 await startLock(page);await startLegacyWrite(other);
 expect(await isBlocked(other)).toBe(true);
 await page.evaluate(()=>window.fhRelease());
 await page.evaluate(()=>window.fhLockTask);
 await other.evaluate(()=>window.fhWriteTask);
 expect(await other.evaluate(async()=>(await window.fhStorage.readState()).settings.syntheticFlag)).toBe('preserved');
 await other.close();
});

test('closing the importing tab releases its lock without a persistent fence',async({page,context})=>{
 const importer=await context.newPage();
 await initialize(page);await initialize(importer);
 await startLock(importer);await startWrite(page);
 expect(await isBlocked(page)).toBe(true);
 await importer.close();
 await page.evaluate(()=>window.fhWriteTask);
 expect(await page.evaluate(async()=>(await window.fhStorage.readState()).settings.syntheticFlag)).toBe('preserved');
});

test('changed source and cancellation stop the import without modifying local data',async({page})=>{
 await initialize(page);
 const mismatch=await page.evaluate(async()=>{
  let called=false;
  try{await window.fhStorage.withStableImportSnapshot(()=>false,()=>{called=true},{signal:new AbortController().signal});}
  catch(error){return {called,message:error.message};}
 });
 expect(mismatch.called).toBe(false);
 expect(mismatch.message).toContain('Локальные данные изменились');
 await startLock(page);
 await page.evaluate(()=>window.fhAbort.abort());
 await page.evaluate(()=>window.fhLockTask);
 expect(await page.evaluate(async()=>(await window.fhStorage.readState()).revision)).toBe(0);
});

test('protected cutover fence is never removed or bypassed by import',async({page})=>{
 await initialize(page);
 const outcome=await page.evaluate(async()=>{
  const key='encrypted-cutover-fence-v1:account-state-v2:'+'a'.repeat(32);
  const db=await new Promise((resolve,reject)=>{
   const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite');
   tx.objectStore('finance').put({version:1,format:'synthetic-protected-marker'},key);
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  let called=false,error='';
  try{await window.fhStorage.withStableImportSnapshot(()=>true,()=>{called=true},{signal:new AbortController().signal});}
  catch(caught){error=caught.message;}
  const stored=await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readonly'),request=tx.objectStore('finance').get(key);
   tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);
  });
  db.close();return {called,error,stored};
 });
 expect(outcome.called).toBe(false);
 expect(outcome.error).toContain('заблокирована');
 expect(outcome.stored).toEqual({version:1,format:'synthetic-protected-marker'});
});

test('account revocation cancels the lock and never copies into another account',async({page})=>{
 await initialize(page);
 await page.evaluate(()=>window.fhStorage.updateState(state=>{
  state.entries.push({id:'synthetic-private',title:'Synthetic private',kind:'expense',
   amountCents:100,date:'2026-11-01',recurrence:'once'});
 }));
 await startLock(page);
 await page.evaluate(()=>window.fhStorage.revokeStateScope());
 await page.evaluate(()=>window.fhLockTask);
 const other=await page.evaluate(async()=>{
  await window.fhStorage.selectStateScope('b'.repeat(32));
  return window.fhStorage.readState();
 });
 expect(other.entries).toEqual([]);
});

test('guest source stays locked during transfer while the account scope remains active',async({page,context})=>{
 const guest=await context.newPage();
 await initialize(page);await initialize(guest);
 await guest.evaluate(async()=>{
  await window.fhStorage.selectStateScope(null);
  await window.fhStorage.updateState(state=>{state.settings.syntheticGuest='before';});
 });
 await page.evaluate(async()=>{
  window.fhAbort=new AbortController();window.fhLockStarted=false;
  window.fhLockTask=window.fhStorage.withStableImportSnapshot(
   state=>state.settings.syntheticGuest==='before',
   ()=>new Promise(resolve=>{window.fhLockStarted=true;window.fhRelease=resolve;}),
   {signal:window.fhAbort.signal,guestSource:{sourceKey:'guest-state-v2',claim:'a'.repeat(32)}},
  );
 });
 await expect.poll(()=>page.evaluate(()=>window.fhLockStarted)).toBe(true);
 await guest.evaluate(()=>{window.fhWriteTask=window.fhStorage.updateState(state=>{state.settings.syntheticGuest='after';});});
 expect(await isBlocked(guest)).toBe(true);
 await page.evaluate(()=>window.fhRelease('ok'));
 expect(await page.evaluate(()=>window.fhLockTask)).toBe('ok');
 await guest.evaluate(()=>window.fhWriteTask);
 expect(await guest.evaluate(async()=>(await window.fhStorage.readState()).settings.syntheticGuest)).toBe('after');
 expect(await page.evaluate(async()=>(await window.fhStorage.readState()).settings.syntheticGuest)).toBeUndefined();
 await guest.close();
});

test('guest transfer rejects a changed claim and never reads the former account',async({page})=>{
 await initialize(page);
 const result=await page.evaluate(async()=>{
  let called=false;
  try{
   await window.fhStorage.withStableImportSnapshot(()=>true,()=>{called=true;},
    {signal:new AbortController().signal,guestSource:{sourceKey:'guest-state-v2',claim:'b'.repeat(32)}});
  }catch(error){return {called,message:error.message};}
 });
 expect(result.called).toBe(false);
 expect(result.message).toContain('Гостевой профиль изменился');
});

test('guest transfer rejects a malformed null claim instead of treating it as unclaimed',async({page})=>{
 await initialize(page);
 const result=await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('finance','readwrite');
   tx.objectStore('finance').put(null,'legacy-account-claim-v2');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  db.close();let called=false;
  try{await window.fhStorage.withStableImportSnapshot(()=>true,()=>{called=true;},
   {signal:new AbortController().signal,guestSource:{sourceKey:'state',claim:null}});}
  catch(error){return {called,message:error.message};}
 });
 expect(result.called).toBe(false);
 expect(result.message).toContain('Гостевой профиль изменился');
});
