import {isActive,previewLoanPayment,rubles} from './finance.js';
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
 if(!state.entries.some(entry=>entry.id===entryId&&isActive(entry)))throw Error('Запись недоступна');
 if(id){
  const existing=state.settlements.find(item=>item.id===id);
  if(!existing||existing.voidedAt)throw Error('Операция не найдена');
  Object.assign(existing,{amountCents,date,updatedAt:now()});
  audit(state,'fact-update',`Исправлена фактическая сумма: ${rubles(amountCents)}`,{id:idFactory,now});
  return id;
 }
 const newId=idFactory();
 state.settlements.push({id:newId,entryId,occurrence,date,amountCents,createdAt:now()});
 audit(state,'fact-create',`Отмечено фактически: ${rubles(amountCents)}`,{id:idFactory,now});
 return newId;
}
