import {test,expect} from '@playwright/test';

// Synthetic values, native IndexedDB and real WebKit/Chromium transaction abort.
test('account switch during an in-flight write aborts old scope without exposing it to the next account',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/__e2e__/ready');
 const observed=await page.evaluate(async()=>{
  const s=await import('/storage.js?scope-revocation-native-1');
  const a='a'.repeat(32),b='b'.repeat(32);
  await s.selectStateScope(a);
  await s.updateState(value=>value.entries.push({
   id:'synthetic-finance-1',kind:'expense',title:'PRIVATE_SCOPE_A',
   amountCents:12345,date:'2026-11-08',recurrence:'once',category:'Другое',
  }));
  const original=await s.readState();
  let switching=null,writeRejected=false;
  try{
   await s.updateState(value=>{
    value.entries[0].amountCents=987654321;
    switching=s.selectStateScope(b);
   });
  }catch{writeRejected=true;}
  const secondScope=await switching;
  const second=await s.readState();
  await s.selectStateScope(a);
  const restored=await s.readState();
  // Invalid identity should revoke the first account synchronously, too.
  let invalidRejected=false,readRejected=false;
  try{await s.selectStateScope('unverified') }catch{invalidRejected=true;}
  try{await s.readState()}catch{readRejected=true;}
  return {
   writeRejected,secondScope,secondEntries:second.entries.length,
   originalAmount:original.entries[0].amountCents,
   restoredAmount:restored.entries[0].amountCents,
   restoredTitle:restored.entries[0].title,
   invalidRejected,readRejected,
  };
 });
 expect(observed).toEqual({
  writeRejected:true,secondScope:'account-state-v2:'+'b'.repeat(32),
  secondEntries:0,originalAmount:12345,restoredAmount:12345,
  restoredTitle:'PRIVATE_SCOPE_A',invalidRejected:true,readRejected:true,
 });
 expect(errors).toEqual([]);
});

test('fenced target account selection does not retain access to prior account',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/__e2e__/ready');
 const observed=await page.evaluate(async()=>{
  const s=await import('/storage.js?scope-revocation-native-2');
  const a='a'.repeat(32),b='b'.repeat(32),target='account-state-v2:'+b;
  await s.selectStateScope(a);
  const source=await s.updateState(value=>value.entries.push({
   id:'synthetic-finance-2',kind:'expense',title:'ONLY_ACCOUNT_A',
   amountCents:999,date:'2026-11-08',recurrence:'once',category:'Другое',
  }));
  const db=await new Promise((resolve,reject)=>{
   const request=indexedDB.open('financial-horizon-browser-v1',1);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite');
   tx.objectStore('finance').put({format:'test-fence',version:1},'encrypted-cutover-fence-v1:'+target);
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  let fenced=false,locked=false;
  try{await s.selectStateScope(b)}catch(error){fenced=error.message.includes('заблокирована')}
  try{await s.readState()}catch(error){locked=error.message.includes('профиль изменён')}
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('finance','readwrite');
   tx.objectStore('finance').delete('encrypted-cutover-fence-v1:'+target);
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  db.close();
  const selected=await s.selectStateScope(b);
  const empty=await s.readState();
  await s.selectStateScope(a);
  const intact=await s.readState();
  s.revokeStateScope(); // models confirmed logout and session revocation
  let revokedRead=false,revokedWrite=false;
  try{await s.readState()}catch{revokedRead=true}
  try{await s.updateState(()=>{})}catch{revokedWrite=true}
  return {fenced,locked,selected,other:empty.entries.length,intact:intact.entries[0].amountCents,
   revision:intact.revision,originalRevision:source.revision,revokedRead,revokedWrite};
 });
 expect(observed).toEqual({fenced:true,locked:true,selected:'account-state-v2:'+'b'.repeat(32),
  other:0,intact:999,revision:1,originalRevision:1,revokedRead:true,revokedWrite:true});
 expect(errors).toEqual([]);
});
