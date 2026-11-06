import {emptyState, validateState} from './finance.js';
const DB='financial-horizon-browser-v1'; const STORE='finance'; const KEY='state';
const CLAIM_KEY='legacy-account-claim-v2', GUEST_KEY='guest-state-v2';
let dbPromise,activeKey=KEY;

/* Guest mode is deliberately separate once a legacy ledger has been claimed by an
   account. The original key is retained for rollback, never destroyed on logout. */
export async function selectStateScope(userId=null){
 const db=await openDb();
 if(userId===null){
  const owner=await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readonly');
   const req=tx.objectStore(STORE).get(CLAIM_KEY);
   req.onsuccess=()=>resolve(req.result);
   req.onerror=()=>reject(req.error||new Error('Не удалось проверить локальную бухгалтерию'));
  });
  activeKey=owner?GUEST_KEY:KEY;
  return activeKey;
 }
 if(typeof userId!=='string'||!/^[a-f0-9]{32}$/.test(userId)){
  throw Error('Невозможно определить подтверждённый аккаунт');
 }
 const key='account-state-v2:'+userId;
 await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');
  const object=tx.objectStore(STORE);
  let invalid=null;
  const fail=error=>{invalid=error;try{tx.abort();}catch{}};
  const claim=object.get(CLAIM_KEY);
  claim.onsuccess=()=>{
   const owner=claim.result;
   const existing=object.get(key);
   existing.onsuccess=()=>{
    if(existing.result!==undefined){
     try{validateState(existing.result);}catch(error){fail(error);return;}
     if(!owner)object.put(userId,CLAIM_KEY);
     return;
    }
    // Only the first verified account may copy the historical single-user data.
    // A second account always receives a new, empty ledger.
    if(owner&&owner!==userId)return;
    const legacy=object.get(KEY);
    legacy.onsuccess=()=>{
     try{
      if(legacy.result!==undefined)object.put(structuredClone(validateState(legacy.result)),key);
      if(!owner)object.put(userId,CLAIM_KEY);
     }catch(error){fail(error);}
    };
   };
  };
  tx.oncomplete=()=>resolve();
  tx.onerror=()=>reject(invalid||tx.error||new Error('Не удалось переключить аккаунт'));
  tx.onabort=()=>reject(invalid||tx.error||new Error('Не удалось перенести локальные данные'));
 });
 activeKey=key;
 return key;
}

function openDb(){
 if(!dbPromise){
  dbPromise=new Promise((resolve,reject)=>{
   if(!('indexedDB' in globalThis)){reject(new Error('В этом браузере недоступно локальное хранилище IndexedDB'));return;}
   const request=indexedDB.open(DB,1);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error||new Error('Не удалось открыть хранилище'));
   request.onblocked=()=>reject(new Error('Закройте другие вкладки приложения для обновления хранилища'));
  });
  dbPromise.catch(()=>{dbPromise=null;});
 }
 return dbPromise;
}
export async function readState(){const db=await openDb(); return new Promise((resolve,reject)=>{
 const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(activeKey);
 req.onsuccess=()=>{try{resolve(req.result===undefined?emptyState():validateState(req.result));}catch(e){reject(e);}};
 req.onerror=()=>reject(req.error);});}
export async function updateState(change){
 const db=await openDb();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');let updated;
  const obj=tx.objectStore(STORE),req=obj.get(activeKey);
  req.onsuccess=()=>{try{const state=req.result===undefined?emptyState():validateState(req.result);updated=structuredClone(state);change(updated);validateState(updated);obj.put(updated,activeKey);}catch(error){tx.abort();reject(error);}};
  req.onerror=()=>reject(req.error);
  tx.oncomplete=()=>resolve(updated);
  tx.onerror=()=>reject(tx.error||new Error('Ошибка записи'));
  tx.onabort=()=>reject(tx.error||new Error('Операция отменена'));
 });
}
export async function replaceState(state){validateState(state);return updateState(target=>{for(const key of Object.keys(target))delete target[key];Object.assign(target,structuredClone(state));});}
export async function askPersistentStorage(){
 if(!navigator.storage?.persist)return false;
 try{return await navigator.storage.persist();}catch{return false;}
}
export async function storageStatus(){
 try {return {persistent:await navigator.storage?.persisted?.(),estimate:await navigator.storage?.estimate?.()}}catch{return {persistent:false}};
}
