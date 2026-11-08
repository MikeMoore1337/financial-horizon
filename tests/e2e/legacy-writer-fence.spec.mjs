import {test,expect} from '@playwright/test';

// Synthetic Chromium/WebKit check against NATIVE IndexedDB, not production.
test('native IndexedDB legacy fence denies both reads and updates until verified rollback',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/__e2e__/ready');
 const result=await page.evaluate(async()=>{
  const storage=await import('/storage.js?native-fence-stage9');
  const original=await storage.updateState(()=>{});
  const db=await new Promise((resolve,reject)=>{
   const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error);
  });
  const putMarker=()=>new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite');
   tx.objectStore('finance').put({version:1,format:'test-cutover-marker'},'encrypted-cutover-fence-v1:state');
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  const removeMarker=()=>new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite');
   tx.objectStore('finance').delete('encrypted-cutover-fence-v1:state');
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  const readRaw=()=>new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readonly'),request=tx.objectStore('finance').get('state');
   tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);
  });
  await putMarker();
  let readError='',writeError='';
  try{await storage.readState()}catch(error){readError=String(error.message)}
  try{await storage.updateState(()=>{})}catch(error){writeError=String(error.message)}
  const preserved=await readRaw();
  await removeMarker();
  const restored=await storage.readState();
  const next=await storage.updateState(()=>{});
  db.close();
  return {readBlocked:readError.includes('заблокирована для перехода'),
   writeBlocked:writeError.includes('заблокирована для перехода'),
   untouched:preserved.revision===original.revision,
   rollbackRestored:restored.revision===original.revision,
   afterRollback:next.revision===original.revision+1};
 });
 expect(result).toEqual({readBlocked:true,writeBlocked:true,untouched:true,
  rollbackRestored:true,afterRollback:true});
 expect(errors).toEqual([]);
});
