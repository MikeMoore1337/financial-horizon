import {emptyState,validateState} from './finance.js';
import {migrateState,downgradeStateForRollback} from './state-migrations.js';
const DB='financial-horizon-browser-v1', STORE='finance', KEY='state';
const CLAIM_KEY='legacy-account-claim-v2', GUEST_KEY='guest-state-v2';
// Passive marker. The running app NEVER writes it: an approved migration must
// quiesce old tabs and establish rollback before activating a protected scope.
const FENCE_PREFIX='encrypted-cutover-fence-v1:';
const FENCED_MESSAGE='Локальная база заблокирована для перехода на защищённое хранение. Перезагрузите приложение.';
const REVOKED_MESSAGE='Локальный финансовый профиль изменён. Обновите страницу и повторите вход.';
let dbPromise,activeKey=KEY,scopeEpoch=0,scopeController=new AbortController();

// Revoke a previous account synchronously before any async validation/open.
function beginScopeSelection(){
 scopeEpoch++;
 scopeController.abort();
 scopeController=new AbortController();
 activeKey=null;
 return {epoch:scopeEpoch,signal:scopeController.signal};
}
/** Explicit logout/session-revocation hook: drop the legacy scope immediately. */
export function revokeStateScope(){
 beginScopeSelection();
}
function assertScope(epoch,key){
 if(key===null||epoch!==scopeEpoch||key!==activeKey)
  throw Error(REVOKED_MESSAGE);
}
function currentScope(){
 const key=activeKey,epoch=scopeEpoch,signal=scopeController.signal;
 assertScope(epoch,key);
 return {key,epoch,signal};
}
function abortOnScopeChange(tx,signal){
 const stop=()=>{try{tx.abort();}catch{}};
 signal.addEventListener('abort',stop,{once:true});
 if(signal.aborted)stop();
 return ()=>signal.removeEventListener('abort',stop);
}


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
 const {epoch,signal}=beginScopeSelection();
 if(userId!==null&&(typeof userId!=='string'||!/^[a-f0-9]{32}$/.test(userId)))
  throw Error('Невозможно определить подтверждённый аккаунт');
 const db=await openDb();
 if(epoch!==scopeEpoch)throw Error(REVOKED_MESSAGE);
 if(userId===null){
  const owner=await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(CLAIM_KEY);
   const cleanup=abortOnScopeChange(tx,signal);
   let result=null;
   req.onsuccess=()=>{result=req.result;};
   tx.oncomplete=()=>{
    cleanup();
    epoch===scopeEpoch?resolve(result):reject(Error(REVOKED_MESSAGE));
   };
   tx.onerror=()=>{cleanup();reject(tx.error||Error('Не удалось проверить локальную бухгалтерию'));};
   tx.onabort=()=>{cleanup();reject(Error(REVOKED_MESSAGE));};
  });
  if(epoch!==scopeEpoch)throw Error(REVOKED_MESSAGE);
  activeKey=owner?GUEST_KEY:KEY;
  return activeKey;
 }
 const key='account-state-v2:'+userId;
 await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE);
  const cleanup=abortOnScopeChange(tx,signal);
  let invalid=null;
  const fail=error=>{invalid=error;try{tx.abort();}catch{}};
  const claim=object.get(CLAIM_KEY),accountFence=object.get(FENCE_PREFIX+key);
  claim.onsuccess=()=>{
   if(epoch!==scopeEpoch){fail(Error(REVOKED_MESSAGE));return;}
   const owner=claim.result,existing=object.get(key);
   existing.onsuccess=()=>{
    if(epoch!==scopeEpoch){fail(Error(REVOKED_MESSAGE));return;}
    if(accountFence.result!==undefined){fail(Error(FENCED_MESSAGE));return;}
    if(existing.result!==undefined){
     try{
      const migrated=migrateState(existing.result);
      if(migrated!==existing.result)object.put(migrated,key);
      if(!owner)object.put(userId,CLAIM_KEY);
     }catch(error){fail(error);}
     return;
    }
    if(owner&&owner!==userId)return;
    const legacyFence=object.get(FENCE_PREFIX+KEY),legacy=object.get(KEY);
    legacy.onsuccess=()=>{
     try{
      if(epoch!==scopeEpoch)throw Error(REVOKED_MESSAGE);
      if(legacyFence.result!==undefined)throw Error(FENCED_MESSAGE);
      if(legacy.result!==undefined)object.put(migrateState(legacy.result),key);
      if(!owner)object.put(userId,CLAIM_KEY);
     }catch(error){fail(error);}
    };
   };
  };
  tx.oncomplete=()=>{
   cleanup();
   epoch===scopeEpoch?resolve():reject(Error(REVOKED_MESSAGE));
  };
  tx.onerror=()=>{cleanup();reject(invalid||tx.error||Error('Не удалось переключить аккаунт'));};
  tx.onabort=()=>{cleanup();reject(invalid||tx.error||Error(REVOKED_MESSAGE));};
 });
 if(epoch!==scopeEpoch)throw Error(REVOKED_MESSAGE);
 activeKey=key;
 return key;
}

// Every migration and its version marker commit in ONE IndexedDB transaction.
// Never resolve a migration before the transaction has actually committed.
export async function readState(){
 const {key,epoch,signal}=currentScope();
 const db=await openDb();
 assertScope(epoch,key);
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE);
  const cleanup=abortOnScopeChange(tx,signal);
  // Ordered requests in ONE IndexedDB transaction: a marker cannot slip
  // between the guard and a legacy read or automatic schema rewrite.
  const fence=object.get(FENCE_PREFIX+key),req=object.get(key);
  let value=null,failure=null;
  req.onsuccess=()=>{
   try{
    assertScope(epoch,key);
    if(fence.result!==undefined)throw Error(FENCED_MESSAGE);
    if(req.result===undefined){value=emptyState();return;}
    value=migrateState(req.result);
    if(value!==req.result)object.put(value,key);
   }catch(error){failure=error;try{tx.abort();}catch{}}
  };
  // A read must not return plaintext before its native transaction commits.
  tx.oncomplete=()=>{
   cleanup();
   try{assertScope(epoch,key);resolve(value);}catch(error){reject(error);}
  };
  tx.onerror=()=>{cleanup();reject(failure||tx.error||new Error('Ошибка чтения финансовой базы'));};
  tx.onabort=()=>{cleanup();reject(failure||(signal.aborted?Error(REVOKED_MESSAGE):null)||
   tx.error||new Error('Миграция отменена: исходные данные сохранены'));};
 });
}

// Serial read-modify-write + optional compare-and-swap prevent silent lost updates.
export async function updateState(change,{expectedRevision}={}){
 const {key,epoch,signal}=currentScope();
 const db=await openDb();
 assertScope(epoch,key);
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),object=tx.objectStore(STORE);
  const cleanup=abortOnScopeChange(tx,signal);
  const fence=object.get(FENCE_PREFIX+key),req=object.get(key);
  let updated=null,failure=null;
  req.onsuccess=()=>{
   try{
    assertScope(epoch,key);
    if(fence.result!==undefined)throw Error(FENCED_MESSAGE);
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
  tx.oncomplete=()=>{
   cleanup();
   try{assertScope(epoch,key);resolve(updated);}catch(error){reject(error);}
  };
  tx.onerror=()=>{cleanup();reject(failure||tx.error||new Error('Ошибка записи'));};
  tx.onabort=()=>{cleanup();reject(failure||(signal.aborted?Error(REVOKED_MESSAGE):null)||
   tx.error||new Error('Операция отменена'));};
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
   // A protected cutover marker forbids ANY downgrade of the legacy database.
   // A global rollback must fail atomically even when only one scope is fenced:
   // otherwise its former plaintext snapshot could silently become active.
   // Abort reverts cursor updates that may have been staged earlier in this tx.
   if(typeof key==='string'&&key.startsWith(FENCE_PREFIX)){
    failure=Error('Откат запрещён: найден защищённый финансовый профиль. Используйте проверенное восстановление.');
    try{tx.abort();}catch{}
    return;
   }
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
