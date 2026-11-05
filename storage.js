import {emptyState, validateState} from './finance.js';
const DB='financial-horizon-browser-v1'; const STORE='finance'; const KEY='state';
let dbPromise;
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
 const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).get(KEY);
 req.onsuccess=()=>{try{resolve(req.result===undefined?emptyState():validateState(req.result));}catch(e){reject(e);}};
 req.onerror=()=>reject(req.error);});}
export async function updateState(change){
 const db=await openDb();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');let updated;
  const obj=tx.objectStore(STORE),req=obj.get(KEY);
  req.onsuccess=()=>{try{const state=req.result===undefined?emptyState():validateState(req.result);updated=structuredClone(state);change(updated);validateState(updated);obj.put(updated,KEY);}catch(error){tx.abort();reject(error);}};
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
