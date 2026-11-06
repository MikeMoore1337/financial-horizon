import {emptyState,validateState} from './finance.js';
import {migrateState,downgradeStateForRollback} from './state-migrations.js';
const DB='financial-horizon-browser-v1', STORE='finance', KEY='state';
const CLAIM_KEY='legacy-account-claim-v2', GUEST_KEY='guest-state-v2';
let dbPromise,activeKey=KEY;

function openDb(){
 if(!dbPromise){
  dbPromise=new Promise((resolve,reject)=>{
   if(!('indexedDB' in globalThis)){
    reject(new Error('В этом браузере недоступно локальное хранилище IndexedDB'));return;
   }
   // Keep the IndexedDB structure at 1: only the stored financial state evolves.
   const request=indexedDB.open(DB,1);
   request.onupgradeneeded=()=>{
    if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);
   };
   request.onsuccess=()=>{
    const db=request.result;
    db.onversionchange=()=>{db.close();dbPromise=null;};
    resolve(db);
   };
   request.onerror=()=>reject(request.error||new Error('Не удалось открыть хранилище'));
   request.onblocked=()=>reject(new Error('Закройте другие вкладки приложения для обновления хранилища'));
  });
  dbPromise.catch(()=>{dbPromise=null;});
 }
 return dbPromise;
}

/* The first verified account alone may claim a copy of the original local ledger.
   The legacy key is not deleted or rewritten during the claim. */
export async function selectStateScope(userId=null){
 const db=await openDb();
 if(userId===null){
  const owner=await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(CLAIM_KEY);
   req.onsuccess=()=>resolve(req.result);
   req.onerror=()=>reject(req.error||new Error('Не удалось проверить локальную бухгалтерию'));
  });
  activeKey=owner?GUEST_KEY:KEY;
  return activeKey;
 }
 if(typeof userId!=='string'||!/^[a-f0-9]{32}$/.test(userId))
  throw Error('Невозможно определить подтверждённый аккаунт');
 const key='account-state-v2:'+userId;
 await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE);
  let invalid=null;
  const fail=error=>{invalid=error;try{tx.abort();}catch{}};
  const claim=object.get(CLAIM_KEY);
  claim.onsuccess=()=>{
   const owner=claim.result,existing=object.get(key);
   existing.onsuccess=()=>{
    if(existing.result!==undefined){
     try{
      const migrated=migrateState(existing.result);
      if(migrated!==existing.result)object.put(migrated,key);
      if(!owner)object.put(userId,CLAIM_KEY);
     }catch(error){fail(error);}
     return;
    }
    if(owner&&owner!==userId)return;
    const legacy=object.get(KEY);
    legacy.onsuccess=()=>{
     try{
      if(legacy.result!==undefined)object.put(migrateState(legacy.result),key);
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

// Every migration and its version marker commit in ONE IndexedDB transaction.
// Never resolve a migration before the transaction has actually committed.
export async function readState(){
 const db=await openDb(),key=activeKey;
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE),req=object.get(key);
  let migrated=null,needsCommit=false,failure=null;
  req.onsuccess=()=>{
   try{
    if(req.result===undefined){resolve(emptyState());return;}
    migrated=migrateState(req.result);
    if(migrated===req.result){resolve(migrated);return;}
    needsCommit=true;
    object.put(migrated,key);
   }catch(error){failure=error;try{tx.abort();}catch{}}
  };
  tx.oncomplete=()=>{if(needsCommit)resolve(migrated);};
  tx.onerror=()=>reject(failure||tx.error||new Error('Ошибка чтения финансовой базы'));
  tx.onabort=()=>reject(failure||tx.error||new Error('Миграция отменена: исходные данные сохранены'));
 });
}

// Serial read-modify-write + optional compare-and-swap prevent silent lost updates.
export async function updateState(change,{expectedRevision}={}){
 const db=await openDb(),key=activeKey;
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE),req=object.get(key);
  let updated=null,failure=null;
  req.onsuccess=()=>{
   try{
    const base=req.result===undefined?emptyState():migrateState(req.result);
    if(expectedRevision!==undefined&&expectedRevision!==base.revision)
     throw Error('Данные изменились в другой вкладке. Обновите страницу и повторите действие.');
    if(base.revision===Number.MAX_SAFE_INTEGER)
     throw Error('Исчерпан счётчик изменений финансовой базы');
    updated=structuredClone(base);
    const outcome=change(updated);
    if(outcome&&typeof outcome.then==='function')
     throw Error('Асинхронные операции внутри транзакции IndexedDB запрещены');
    updated=migrateState(updated); // Restored v1 backup is upgraded BEFORE writing.
    updated.revision=base.revision+1;
    validateState(updated);
    object.put(updated,key);
   }catch(error){failure=error;try{tx.abort();}catch{}}
  };
  tx.oncomplete=()=>resolve(updated);
  tx.onerror=()=>reject(failure||tx.error||new Error('Ошибка записи'));
  tx.onabort=()=>reject(failure||tx.error||new Error('Операция отменена'));
 });
}
export async function replaceState(state,{expectedRevision}={}){
 const incoming=migrateState(state);
 return updateState(target=>{
  for(const key of Object.keys(target))delete target[key];
  Object.assign(target,structuredClone(incoming));
 },{expectedRevision});
}

// An explicit maintenance operation, not called by the app. Run only after
// quiescing all tabs and BEFORE deploying a v1-only rollback build.
export async function rollbackAllScopesToV1(){
 const db=await openDb();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE);
  const req=object.openCursor();
  let changed=0,failure=null;
  req.onsuccess=()=>{
   const cursor=req.result;
   if(!cursor)return;
   const key=cursor.key;
   if(key===KEY||key===GUEST_KEY||(typeof key==='string'&&key.startsWith('account-state-v2:'))){
    try{
     const value=validateState(cursor.value);
     if(value.version===2){
      cursor.update(downgradeStateForRollback(value));
      changed++;
     }
    }catch(error){failure=error;try{tx.abort();}catch{};return;}
   }
   cursor.continue();
  };
  tx.oncomplete=()=>resolve(changed);
  tx.onerror=()=>reject(failure||tx.error||new Error('Ошибка подготовки отката'));
  tx.onabort=()=>reject(failure||tx.error||new Error('Подготовка отката отменена'));
 });
}
export async function askPersistentStorage(){
 if(!navigator.storage?.persist)return false;
 try{return await navigator.storage.persist();}catch{return false;}
}
export async function storageStatus(){
 try{return {persistent:await navigator.storage?.persisted?.(),estimate:await navigator.storage?.estimate?.()};}
 catch{return {persistent:false};}
}
