/** #35 guest budgets use the existing atomic local state and imported bank facts.
 * No account session, new database, cash posting, or network request.
 */
import {validateGuestBudgets,validateState,getMonthEvents} from '../../../finance.js';
import {guestBankMovements,readGuestBankLedger} from '../../importers/bank-statements/guest-ledger.js';

const profileId='guest-budget-v1';
const nameKey=v=>v.toLocaleLowerCase('ru-RU');
const validName=v=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=40&&!/[\x00-\x1f\x7f]/.test(v);
const fail=(s='Недопустимая бюджетная операция')=>{throw Error(s);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const active=(r,m)=>m>=r.fromMonth&&(r.recurrence==='monthly'||m===r.fromMonth)&&
 (r.endsBeforeMonth===null||m<r.endsBeforeMonth)&&(r.archivedFromMonth===null||m<r.archivedFromMonth);

export function readGuestBudgetStore(state){
 validateState(state);
 const store=structuredClone(state.guestBudgets??{version:1,categories:[],rules:[],assignments:[]});
 const names=[...state.categories,...state.entries.map(e=>e.category),
  ...(state.bankStatements?.operations||[]).map(o=>o.category),'Кредиты'];
 for(const name of names){
  if(!validName(name))continue;
  const key=nameKey(name);
  if(!store.categories.some(c=>c.aliases.includes(key)))
   store.categories.push({id:'legacy:'+key,name,aliases:[key],archived:false,entityRevision:1});
 }
 return validateGuestBudgets(store,state.bankStatements);
}

/** @param {import('../../types/finance.ts').FinanceStateV2} state
 * @param {string} month
 * @returns {{profileId:string,categories:import('./server-snapshot.ts').ServerBudgetCategory[],
 * rules:import('./server-snapshot.ts').ServerBudgetRule[],
 * transactions:Array<{id:string,entityRevision:number,note:string|null}>,
 * operations:import('./index.ts').BudgetOperation[],loanPlanMissing:boolean}}
 */
export function projectGuestBudget(state,month){
 const store=readGuestBudgetStore(state);
 const categories=store.categories;
 const category=name=>validName(name)?categories.find(c=>c.aliases.includes(nameKey(name)))?.id??null:null;
 const assigned=new Map(store.assignments.map(a=>[a.transactionId,a.categoryId]));
 const transactions=[];
 const operations=[];
 for(const row of guestBankMovements(readGuestBankLedger(state))){
  // Only a posted bank expense is a confirmed budget expense. Legacy
  // planner settlements have no account posting, so are not counted again.
  if(row.kind!=='expense')continue;
  transactions.push({id:row.id,entityRevision:1,note:row.description});
  operations.push({id:row.id,profileId,occurredOn:row.date,kind:'expense',
   status:row.voidedAt===null?'confirmed':'voided',signedMinor:-row.amountCents,
   categoryId:assigned.has(row.id)?assigned.get(row.id):category(row.category)});
 }
 for(const row of getMonthEvents(state,month)){
  if(row.kind!=='expense'||row.plannedCents<=0)continue;
  operations.push({id:'plan:'+row.source+':'+row.id,profileId,occurredOn:row.date,
   kind:'expense',status:'planned',signedMinor:-row.plannedCents,categoryId:category(row.category)});
 }
 const rules=store.rules.map(r=>({id:r.id,profileId,scope:r.categoryId===null?{kind:'total'}:
  {kind:'category',categoryId:r.categoryId},limitMinor:r.limitMinor,recurrence:r.recurrence,
  fromMonth:r.fromMonth,endsBeforeMonth:r.endsBeforeMonth,archivedFromMonth:r.archivedFromMonth,
  entityRevision:r.entityRevision}));
 return {profileId,categories,rules,transactions,operations,loanPlanMissing:false};
}

/** Apply synchronously inside storage.updateState with expected global revision.
 * Input and bank journal are untouched until the validated sidecar is assigned.
 */
export function applyGuestBudgetCommand(state,action,p,versions,expectedRevision){
 if(state.version!==2||state.revision!==expectedRevision)fail('Локальная база изменилась');
 const store=readGuestBudgetStore(state);
 const shape=(keys,optional=[])=>{
  if(!p||Object.keys(p).some(k=>!keys.includes(k)&&!optional.includes(k))||
     keys.some(k=>!Object.hasOwn(p,k)))fail();
 };
 const revision=(id,row)=>{
  if(!row||Object.keys(versions).length!==1||versions[id]!==row.entityRevision)fail('Запись изменилась');
 };
 const newId=id=>{
  if(!uuid(id)||store.categories.some(c=>c.id===id)||store.rules.some(r=>r.id===id))fail('Идентификатор уже используется');
 };
 const category=id=>{
  if(id!==null&&!store.categories.some(c=>c.id===id&&!c.archived))fail('Категория недоступна');
 };
 const checkName=(name,id)=>{
  if(!validName(name)||store.categories.some(c=>c.id!==id&&c.aliases.includes(nameKey(name))))fail('Недопустимое или занятое название категории');
 };
 const empty=()=>{if(Object.keys(versions).length)fail();};
 if(action==='budget.category.create'){
  shape(['id','name']);empty();newId(p.id);checkName(p.name,p.id);
  store.categories.push({id:p.id,name:p.name,aliases:[nameKey(p.name)],archived:false,entityRevision:1});
 }else if(action==='budget.category.rename'||action==='budget.category.archive'){
  shape(action.endsWith('rename')?['id','name']:['id']);
  const row=store.categories.find(c=>c.id===p.id);revision(p.id,row);
  if(row.archived)fail('Категория архивирована');
  if(action.endsWith('rename')){
   checkName(p.name,row.id);row.name=p.name;
   if(!row.aliases.includes(nameKey(p.name)))row.aliases.push(nameKey(p.name));
  }else row.archived=true;
  row.entityRevision++;
 }else if(action==='budget.create'){
  shape(['id','category_id','limit_minor','recurrence','from_month'],['ends_before_month']);
  empty();newId(p.id);category(p.category_id);
  store.rules.push({id:p.id,categoryId:p.category_id,limitMinor:p.limit_minor,
   recurrence:p.recurrence,fromMonth:p.from_month,endsBeforeMonth:p.ends_before_month??null,
   archivedFromMonth:null,entityRevision:1});
 }else if(action==='budget.amend'||action==='budget.archive'){
  shape(action.endsWith('amend')?['rule_id','effective_from_month','replacement_id','limit_minor']:['rule_id','archived_from_month']);
  const row=store.rules.find(r=>r.id===p.rule_id);revision(p.rule_id,row);
  const m=action.endsWith('amend')?p.effective_from_month:p.archived_from_month;
  if(!active(row,m))fail('Лимит не действует в выбранном месяце');
  if(action.endsWith('archive')){
   if(row.archivedFromMonth!==null)fail('Лимит уже архивирован');
   row.archivedFromMonth=m;row.entityRevision++;
  }else if(m===row.fromMonth){
   if(p.replacement_id!==row.id)fail();row.limitMinor=p.limit_minor;row.entityRevision++;
  }else{
   newId(p.replacement_id);
   const replacement={...row,id:p.replacement_id,fromMonth:m,limitMinor:p.limit_minor,entityRevision:1};
   row.endsBeforeMonth=m;row.entityRevision++;store.rules.push(replacement);
  }
 }else if(action==='budget.category.assign'){
  shape(['transaction_id','category_id']);
  const tx=guestBankMovements(readGuestBankLedger(state)).find(o=>o.id===p.transaction_id);
  if(!tx||tx.kind!=='expense'||tx.voidedAt!==null)fail('Операция не является подтверждённым расходом');
  revision(p.transaction_id,{entityRevision:1});category(p.category_id);
  const row=store.assignments.find(a=>a.transactionId===tx.id);
  if(row)row.categoryId=p.category_id;
  else store.assignments.push({transactionId:tx.id,categoryId:p.category_id});
 }else fail();
 state.guestBudgets=validateGuestBudgets(store,state.bankStatements);
}
