/** Strict goal command projection and receipt proof, without network or storage writes. */
import {calculateGoal} from './engine.ts';
import {decodeGoalEntity,decodeGoalEntities,canonicalGoalValue,assertGoalHistoryExtends} from './server-goals.ts';
import {assertGoalDate} from './calendar.ts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=m=>{throw Error('SYNC_HOLD: '+m);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const uuid=x=>typeof x==='string'&&UUID.test(x);
const same=(a,b)=>canonicalGoalValue(a)===canonicalGoalValue(b);
const keys=(x,req,opt=[])=>{
  if(!plain(x)||req.some(k=>!Object.hasOwn(x,k))||Object.keys(x).some(k=>!req.includes(k)&&!opt.includes(k))) fail('Неизвестное поле цели');
};
export function validateGoalCommandPayload(command){
  const p=command.payload;
  keys(p,['goal_id','account_id','event'],['counterparty_account_id']);
  if(!uuid(p.goal_id)||!uuid(p.account_id)||p.goal_id===p.account_id||
      !plain(p.event)||!uuid(p.event.id)||p.event.id!==command.client_mutation_id) fail('Неверная идентификация цели');
  const e=p.event,b=['id','type','on'];
  assertGoalDate(e.on);
  if(e.type==='create') keys(e,[...b,'title','category','targetCents','targetDate','openingCents','monthlyCents','plannedFunding']);
  else if(e.type==='update') keys(e,[...b,'changes']);
  else if(e.type==='contribution') keys(e,[...b,'amountCents','funding'],['forDueOn']);
  else if(e.type==='use') keys(e,[...b,'amountCents','usage']);
  else if(e.type==='skip') keys(e,[...b,'dueOn'],['reason']);
  else if(e.type==='void') keys(e,[...b,'eventId','reason']);
  else if(['complete','reopen','archive','restore'].includes(e.type)) keys(e,b);
  else fail('Неизвестное событие цели');
  const transfer=e.funding==='account-transfer'||e.usage==='account-transfer';
  if(transfer!==Object.hasOwn(p,'counterparty_account_id')||
      transfer&&(!uuid(p.counterparty_account_id)||p.counterparty_account_id===p.account_id)) fail('Неверный второй счёт');
  if(e.type==='void'&&!uuid(e.eventId)) fail('Неверное отменяемое событие');
  return p;
}
function find(entities,kind,id){
  const rows=entities.filter(x=>x.kind===kind&&x.id===id);
  if(rows.length!==1) fail('Связанная запись недоступна');
  return rows[0];
}
function plan(command,entities,prior,ref){
  const p=validateGoalCommandPayload(command),e={...p.event},creating=e.type==='create';
  if(creating!==(prior===null)||prior&&prior.accountId!==p.account_id) fail('Цель или счёт изменились');
  const old=prior?.record.events??[];
  let kind=null,reversed=null,postings=[];
  if(e.type==='contribution'||e.type==='use'){
    const mode=e.funding??e.usage,signed=e.type==='contribution'?e.amountCents:-e.amountCents;
    if(mode==='account-transfer'){
      kind='transfer';postings=[{account_id:p.account_id,signed_minor:signed},{account_id:p.counterparty_account_id,signed_minor:-signed}];
    }else if(mode==='expense'){kind='expense';postings=[{account_id:p.account_id,signed_minor:signed}];}
  }else if(e.type==='void'){
    const original=old.find(x=>x.id===e.eventId);
    if(!original) fail('Отменяемое событие отсутствует');
    if(original.ledgerMovementId){
      kind='reversal';reversed=original.ledgerMovementId;
      const tx=find(entities,'transaction',reversed);
      if(!['transfer','expense'].includes(tx.data.kind)||!Array.isArray(tx.data.postings)||
          tx.data.occurred_on!==original.on||Object.hasOwn(tx.data,'payment_link')||Object.hasOwn(tx.data,'reserve_allocation')) fail('Исходная проводка недоступна');
      postings=tx.data.postings.map(x=>({account_id:x.account_id,signed_minor:-x.signed_minor}));
    }
  }
  if(kind){
    if(!uuid(ref)) fail('Нет идентификатора проводки цели');
    e[e.type==='void'?'ledgerReversalId':'ledgerMovementId']=ref;
  }
  const record={version:1,id:p.goal_id,events:[...old,e]};
  if(record.events.length>1000||new TextEncoder().encode(JSON.stringify(record.events)).length>256000) fail('Журнал цели переполнен');
  const saved=calculateGoal(record,'2200-12-31').savedCents,delta=saved-(prior?.savedMinor??0);
  const required=[...new Set([p.account_id,...postings.map(x=>x.account_id),...(creating?[]:[p.goal_id])])];
  if(!same(required.sort(),Object.keys(command.expected_entity_revisions).sort())) fail('Не совпадают ревизии связанных счетов и цели');
  return {p,e,record,saved,delta,kind,reversed,postings,required,revision:old.length+1};
}
function priorGoal(command,entities){
  const p=validateGoalCommandPayload(command);
  if(p.event.type==='create'){
    if(entities.some(x=>x.id===p.goal_id)) fail('Идентификатор цели уже используется');
    return null;
  }
  const g=decodeGoalEntity(find(entities,'goal',p.goal_id));
  if(g.entityRevision!==command.expected_entity_revisions[g.id]) fail('Ревизия цели изменилась');
  return g;
}
function expectedAccounts(command,entities,x){
  const accounts=[];
  for(const id of x.required.filter(id=>id!==x.p.goal_id)){
    const before=find(entities,'account',id),d=before.data;
    if(before.entity_revision!==command.expected_entity_revisions[id]||
        d.archived_at!==null&&x.e.type!=='void'&&(x.e.type==='create'||x.kind||x.delta>0)) fail('Счёт недоступен или изменился');
    const movement=x.postings.find(p=>p.account_id===id)?.signed_minor??0,allocation=id===x.p.account_id?x.delta:0;
    const balance=d.balance_minor+movement,reserved=d.reserved_minor+allocation;
    if(![balance,reserved,balance-reserved].every(Number.isSafeInteger)||reserved<0||reserved>0&&balance<reserved) fail('Недостаточно свободных средств');
    if(movement||allocation) accounts.push({...before,entity_revision:before.entity_revision+1,data:{...d,balance_minor:balance,reserved_minor:reserved,available_minor:balance-reserved}});
  }
  return accounts.sort((a,b)=>a.id.localeCompare(b.id));
}
export function verifyGoalDependencies(command,entities){
  if(command.action!=='goal.append')return;
  decodeGoalEntities(entities);
  expectedAccounts(command,entities,plan(command,entities,priorGoal(command,entities),command.client_mutation_id));
}
export function verifyGoalReceiptCandidate(command,changes,entities,previouslyApplied){
  if(command.action!=='goal.append')return;
  const payload=validateGoalCommandPayload(command),first=changes[0],row=first?.payload?.entity;
  if(first?.kind!=='upsert'||!row||row.id!==payload.goal_id||first.entity_id!==row.id||first.entity_revision!==row.entity_revision) fail('Нет квитанции цели');
  const after=decodeGoalEntity(row),last=after.record.events.at(-1);
  let prior;
  if(previouslyApplied){
    const current=decodeGoalEntity(find(entities,'goal',payload.goal_id));
    assertGoalHistoryExtends(after,current);
    const events=after.record.events.slice(0,-1);
    prior=events.length?{...after,entityRevision:events.length,record:{...after.record,events},savedMinor:calculateGoal({...after.record,events},'2200-12-31').savedCents}:null;
    if(prior&&command.expected_entity_revisions[prior.id]!==prior.entityRevision) fail('Неверная историческая ревизия цели');
  }else prior=priorGoal(command,entities);
  const projected=plan(command,entities,prior,last.ledgerMovementId??last.ledgerReversalId);
  if(after.accountId!==payload.account_id||after.entityRevision!==projected.revision||
      after.savedMinor!==projected.saved||!same(after.record,projected.record)) fail('Квитанция не соответствует событию цели');
  const expected=previouslyApplied?null:expectedAccounts(command,entities,projected);
  if(projected.kind){
    const second=changes[1],tx=second?.payload?.entity,d=tx?.data,ref=last.ledgerMovementId??last.ledgerReversalId;
    if(changes.length!==2||second?.kind!=='ledger_posted'||tx?.kind!=='transaction'||tx.id!==ref||
        second.entity_id!==ref||second.entity_revision!==1||tx.entity_revision!==1||
        d?.kind!==projected.kind||d.occurred_on!==last.on||d.reversed_transaction_id!==projected.reversed||
        d.note!==(last.type==='void'?last.reason:null)||Object.hasOwn(d,'payment_link')||Object.hasOwn(d,'reserve_allocation')||
        !Array.isArray(d.postings)||!same([...d.postings].sort((a,b)=>a.account_id.localeCompare(b.account_id)),[...projected.postings].sort((a,b)=>a.account_id.localeCompare(b.account_id)))||
        !Array.isArray(second.payload.accounts)) fail('Нет точной проводки цели');
    if(previouslyApplied){
      if(!same(find(entities,'transaction',ref),tx))fail('Историческая проводка цели не совпадает');
    }else if(entities.some(x=>x.id===ref))fail('Проводка цели уже использована');
    if(expected&&!same([...second.payload.accounts].sort((a,b)=>a.id.localeCompare(b.id)),expected))fail('Неверный итог счетов цели');
  }else if(projected.delta){
    const second=changes[1],account=second?.payload?.entity;
    if(changes.length!==2||second?.kind!=='upsert'||account?.kind!=='account'||account.id!==payload.account_id||
        second.entity_id!==account.id||second.entity_revision!==account.entity_revision||
        account.entity_revision!==command.expected_entity_revisions[account.id]+1||expected&&!same([account],expected))fail('Виртуальное распределение не подтверждено');
  }else if(changes.length!==1)fail('Изменение цели неожиданно изменило счета');
  // Only return a verified allocation for the exact linked ledger posting.
  // Recovery must distinguish this from a mandatory reserve allocation.
  if(projected.kind) return {accountId:payload.account_id,deltaMinor:projected.delta};
}
