import {validateState} from './finance.js';

// Application-state versions are independent of IndexedDB's structural version (1).
export const CURRENT_STATE_VERSION=2;
const steps=new Map([
 [1, state=>{
  state.version=2;
  state.revision=0; // Persistent optimistic-concurrency sequence, not a money field.
 }]
]);

export function migrateState(source){
 validateState(source);
 if(source.version===CURRENT_STATE_VERSION)return source;
 const result=structuredClone(source);
 while(result.version<CURRENT_STATE_VERSION){
  const step=steps.get(result.version);
  if(!step)throw Error('Для этой версии финансовой базы нет безопасной миграции');
  step(result);
  validateState(result);
 }
 return result;
}

// Only for a controlled production rollback, never during normal application startup.
export function downgradeStateForRollback(source){
 validateState(source);
 const previous=structuredClone(source);
 if(previous.version===2){
  delete previous.revision;
  previous.version=1;
 }
 return validateState(previous);
}
