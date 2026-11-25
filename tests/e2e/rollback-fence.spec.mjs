import {test,expect} from '@playwright/test';

// Real Chromium/WebKit IndexedDB: a manual downgrade must NOT bypass even one
// protected cutover fence, or silently rewrite unrelated v2 scopes.
test('legacy downgrade aborts for every scope if a protected fence exists',async({page})=>{
 const pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto('/__e2e__/ready');
 const result=await page.evaluate(async()=>{
  const storage=await import('/storage.js?native-rollback-fence-stage11');
  const id='a'.repeat(32);
  const sample=title=>({
   id:'synthetic-'+title,kind:'expense',title,amountCents:12999,
   date:'2026-11-08',recurrence:'once',category:'Другое',
  });
  await storage.selectStateScope(null);
  await storage.updateState(state=>state.entries.push(sample('legacy')));
  await storage.selectStateScope(id);
  await storage.updateState(state=>state.entries.push(sample('account')));
  await storage.selectStateScope(null);
  await storage.updateState(state=>state.entries.push(sample('guest')));
  const db=await new Promise((resolve,reject)=>{
   const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error);
  });
  const dataKeys=['state','account-state-v2:'+id,'guest-state-v2'];
  const readAll=()=>new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readonly'),store=tx.objectStore('finance');
   const results=dataKeys.map(key=>store.get(key));
   tx.oncomplete=()=>resolve(results.map(req=>req.result));
   tx.onerror=()=>reject(tx.error);
  });
  const writeMarker=remove=>new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite'),store=tx.objectStore('finance');
   const key='encrypted-cutover-fence-v1:account-state-v2:'+id;
   if(remove)store.delete(key);
   else store.put({format:'synthetic-cutover-marker',version:1},key);
   tx.oncomplete=resolve;
   tx.onerror=()=>reject(tx.error);
  });
  const before=await readAll();
  await writeMarker(false);
  let refused=false;
  try{await storage.rollbackAllScopesToV1()}
  catch(error){refused=error.message.includes('Откат запрещён')}
  const retained=await readAll();
  // The synthetic test fixture explicitly removes its own marker; production
  // rollback MUST NOT do this without independent restore and scope consent.
  await writeMarker(true);
  const downgraded=await storage.rollbackAllScopesToV1();
  const after=await readAll();
  db.close();
  return {
   refused,
   unchanged:JSON.stringify(before)===JSON.stringify(retained),
   versionsBefore:before.map(item=>item?.version),
   downgraded,
   versionsAfter:after.map(item=>item?.version),
   preservedCents:after.every((value,i)=>value.entries.length===before[i].entries.length&&
    value.entries.every((entry,j)=>entry.amountCents===before[i].entries[j].amountCents)),
  };
 });
 expect(result).toEqual({refused:true,unchanged:true,versionsBefore:[2,2,2],
  downgraded:3,versionsAfter:[1,1,1],preservedCents:true});
 expect(pageErrors).toEqual([]);
});
