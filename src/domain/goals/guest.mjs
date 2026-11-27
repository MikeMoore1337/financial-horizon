/** Guest-only goals in the existing versioned local ledger, never in another database. */
import {validateGuestGoals,validateState,guestBankBalance} from '../../../finance.js';
import {readGuestBankLedger} from '../../importers/bank-statements/guest-ledger.js';
import {decodeGoalEntity,decodeGoalEntities,assertGoalSnapshotExtends} from './server-goals.ts';
import {validateGoalCommandPayload,verifyGoalDependencies} from './goal-command-candidate.mjs';
import {calculateGoal} from './engine.ts';

export function readGuestGoalStore(state){
 validateState(state);
 const store=structuredClone(state.guestGoals??{version:1,goals:[]});
 validateGuestGoals(store,state.bankStatements);
 decodeGoalEntities(projectGuestGoalEntities(state,store));
 return store;
}
function projectGuestGoalEntities(state,store){
 const bank=readGuestBankLedger(state);
 return [...bank.accounts.map(a=>{
   const balance=guestBankBalance(bank,a.id);
   const reserved=store.goals.filter(g=>g.data.account_id===a.id).reduce((v,g)=>v+g.data.saved_minor,0);
   return {id:a.id,kind:'account',entity_revision:(state.revision??0)+1,data:{name:a.name,
     balance_minor:balance,reserved_minor:reserved,available_minor:balance-reserved,
     currency:'RUB',type:'cash',opening_minor:a.openingMinor,archived_at:null}};
 }),...store.goals];
}
export function projectGuestGoals(state){
 const store=readGuestGoalStore(state),entities=projectGuestGoalEntities(state,store);
 return {goals:store.goals.map(decodeGoalEntity),entities,accounts:entities.filter(e=>e.kind==='account').map(e=>({
   id:e.id,name:e.data.name,available:e.data.available_minor,archived:false}))};
}
/** Caller runs inside storage.updateState CAS. Do not manufacture local bank facts. */
export function applyGuestGoalCommand(state,command){
 if(state.version!==2||state.revision!==command.base_revision||command.action!=='goal.append'||command.schema_version!==2)throw Error('Локальная база изменилась');
 const p=validateGoalCommandPayload(command),event=p.event;
 if(Object.hasOwn(p,'counterparty_account_id')||event.funding==='account-transfer'||event.usage==='expense'||event.usage==='account-transfer')throw Error('Гостевой режим поддерживает только виртуальные накопления');
 const store=readGuestGoalStore(state);
 verifyGoalDependencies(command,projectGuestGoalEntities(state,store));
 const previous=store.goals.find(g=>g.id===p.goal_id);
 const events=[...(previous?.data.event_log??[]),event];
 const saved=calculateGoal({version:1,id:p.goal_id,events},'2200-12-31').savedCents;
 const row={kind:'goal',id:p.goal_id,entity_revision:events.length,data:{account_id:p.account_id,event_log:events,saved_minor:saved}};
 store.goals=previous?store.goals.map(g=>g.id===row.id?row:g):[...store.goals,row];
 validateGuestGoals(store,state.bankStatements);
 decodeGoalEntities(projectGuestGoalEntities(state,store));
 state.guestGoals=store;
}
export function assertGuestGoalRestore(before,after){
 const old=readGuestGoalStore(before),next=readGuestGoalStore(after);
 assertGoalSnapshotExtends(old.goals,next.goals);
}
