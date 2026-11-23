import {entryDueDate,isActive,previewLoanPayment,rubles} from './finance.js';
const defaultId=()=>crypto.randomUUID();
const defaultNow=()=>new Date().toISOString();

export function audit(state,action,description,{id=defaultId,now=defaultNow}={}){
 state.audit.push({id:id(),action,description:String(description).slice(0,160),date:now()});
}
export function applyEntry(state,{id='',title,amountCents,kind,date,recurrence,category},{idFactory=defaultId,now=defaultNow}={}){
 if(!state.categories.includes(category))throw Error('Категория не найдена');
 if(id){
  const current=state.entries.find(item=>item.id===id);
  if(!current)throw Error('Запись не найдена');
  Object.assign(current,{title,amountCents,kind,date,recurrence,category,updatedAt:now()});
  audit(state,'update',`Изменено: ${title}`,{id:idFactory,now});
  return id;
 }
 const newId=idFactory();
 state.entries.push({id:newId,title,amountCents,kind,date,recurrence,category,createdAt:now()});
 audit(state,'create',`Добавлено: ${title}`,{id:idFactory,now});
 return newId;
}
export function applyLoan(state,{id='',title,openingCents,paymentCents,apr,termMonths,dueDay,asOfDate},{idFactory=defaultId,now=defaultNow}={}){
 const fields={title,openingCents,paymentCents,apr,termMonths,dueDay,asOfDate};
 if(id){
  const current=state.loans.find(item=>item.id===id);
  if(!current)throw Error('Кредит не найден');
  Object.assign(current,fields,{updatedAt:now()});
  audit(state,'loan-update',`Изменён кредит: ${title}`,{id:idFactory,now});
  return id;
 }
 const newId=idFactory();
 state.loans.push({id:newId,...fields,schedule:[],createdAt:now()});
 audit(state,'loan-create',`Добавлен кредит: ${title}`,{id:idFactory,now});
 return newId;
}
export function applyLoanPayment(state,{loanId,paymentId='',amountCents,date,strategy},{idFactory=defaultId,now=defaultNow}={}){
 const loan=state.loans.find(item=>item.id===loanId&&isActive(item));
 if(!loan)throw Error('Кредит недоступен');
 const previous=paymentId?state.loanPayments.find(item=>item.id===paymentId):null;
 if(paymentId&&(!previous||previous.voidedAt))throw Error('Исходный платёж недоступен');
 const withoutOld=state.loanPayments.map(item=>item.id===paymentId?{...item,voidedAt:'EDIT_PREVIEW'}:item);
 if(!previewLoanPayment(loan,withoutOld,amountCents,date,strategy).canApply)
  throw Error('Сумма выше долга с процентами в расчётной модели');
 if(paymentId){
  const before=`${rubles(previous.amountCents)}, ${previous.date}`;
  Object.assign(previous,{loanId,amountCents,date,strategy,updatedAt:now()});
  audit(state,'payment-update',`Исправлена оплата ${loan.title}: ${before} → ${rubles(amountCents)}, ${date}`,{id:idFactory,now});
  return paymentId;
 }
 const id=idFactory();
 state.loanPayments.push({id,loanId,amountCents,date,strategy,createdAt:now()});
 audit(state,'payment',`Оплата «${loan.title}» ${rubles(amountCents)}; перерасчёт: ${strategy==='term'?'срок':'платёж'}`,{id:idFactory,now});
 return id;
}
export function applySettlement(state,{id='',entryId,occurrence,date,amountCents},{idFactory=defaultId,now=defaultNow}={}){
 const entry=state.entries.find(item=>item.id===entryId&&isActive(item));
 if(!entry)throw Error('Запись недоступна');
 const validMonth=typeof occurrence==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(occurrence);
 const parsedDate=typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)?new Date(`${date}T00:00:00.000Z`):null;
 if(!validMonth||!parsedDate||!Number.isFinite(parsedDate.getTime())||parsedDate.toISOString().slice(0,10)!==date||
    !Number.isSafeInteger(amountCents)||amountCents<=0||amountCents>1_000_000_000_000)
  throw Error('Укажите корректные период, дату и положительную сумму');
 const existing=id?state.settlements.find(item=>item.id===id):null;
 if(id&&(!existing||existing.voidedAt||existing.entryId!==entryId||existing.occurrence!==occurrence))
  throw Error('Исходная операция или её период недоступны');
 // Historical facts remain editable after a schedule change; new facts must target a real occurrence.
 if(!id&&!entryDueDate(entry,occurrence))throw Error('В выбранном периоде нет этого обязательства');
 if(!Number.isSafeInteger(entry.amountCents)||entry.amountCents<0)throw Error('Некорректная плановая сумма');
 let paid=0;
 for(const item of state.settlements){
  if(item.entryId!==entryId||item.occurrence!==occurrence||item.voidedAt||item.id===id)continue;
  if(!Number.isSafeInteger(item.amountCents)||item.amountCents<=0||!Number.isSafeInteger(paid+item.amountCents))
   throw Error('Не удалось проверить ранее внесённые суммы');
  paid+=item.amountCents;
 }
 if(amountCents>entry.amountCents-paid)throw Error('Сумма превышает остаток обязательства');
 if(id){
  const replacementId=idFactory();
  if(state.settlements.some(item=>item.id===replacementId))throw Error('Повторный идентификатор операции');
  const changedAt=now();
  existing.voidedAt=changedAt;
  state.settlements.push({id:replacementId,entryId,occurrence,date,amountCents,createdAt:changedAt});
  audit(state,'fact-update','Исправлена фактическая сумма; исходная операция сохранена', {id:idFactory,now});
  Object.assign(state.audit[state.audit.length-1],{originalSettlementId:id,replacementSettlementId:replacementId});
  return replacementId;
 }
 const newId=idFactory();
 state.settlements.push({id:newId,entryId,occurrence,date,amountCents,createdAt:now()});
 audit(state,'fact-create',`Отмечено фактически: ${rubles(amountCents)}`,{id:idFactory,now});
 return newId;
}
