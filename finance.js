// Inline guest-bank validation keeps the legacy standalone finance.js module
// available to cached PWA shells and old browser tabs (no new imports).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINOR = 1_000_000_000_000;
const MAX_ACCOUNTS = 100;
const MAX_OPERATIONS = 5000;
const MAX_BATCHES = 5000;
const MAX_BATCH_OPERATIONS = 1000;
const fail = (message = 'Повреждён локальный журнал банковских операций') => { throw Error(message); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeDate = value => typeof value === 'string' && DATE.test(value) &&
  Number.isFinite(new Date(value + 'T00:00:00.000Z').getTime()) &&
  new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;

/** Validate restored/legacy guest backups BEFORE any local state is accepted. */
export function validateGuestBankLedger(value) {
  if (!plain(value) || value.version !== 1 ||
      !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS ||
      !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS ||
      !Array.isArray(value.batches) || value.batches.length > MAX_BATCHES) fail();
  const ids = new Set(), batches = new Map(), rows = new Set(), external = new Set();
  for (const account of value.accounts) {
    if (!plain(account) || !UUID.test(account.id) || ids.has(account.id) ||
        typeof account.name !== 'string' || !account.name.trim() || account.name.length > 160 ||
        !integer(account.openingMinor, -MAX_MINOR, MAX_MINOR) || account.currency !== 'RUB') fail();
    ids.add(account.id);
  }
  for (const batch of value.batches) {
    if (!plain(batch) || !HASH.test(batch.batchKey) || !HASH.test(batch.fileDigest) ||
        batches.has(batch.batchKey) ||
        !integer(batch.committedStateRevision, 1, Number.MAX_SAFE_INTEGER) ||
        (batch.cancelledStateRevision !== null &&
         (!integer(batch.cancelledStateRevision, batch.committedStateRevision + 1, Number.MAX_SAFE_INTEGER))) ||
        !integer(batch.operationCount, 1, MAX_BATCH_OPERATIONS)) fail();
    batches.set(batch.batchKey, batch);
  }
  const counts = new Map();
  for (const op of value.operations) {
    if (!plain(op) || !HASH.test(op.sourceKey) || rows.has(op.sourceKey) ||
        !HASH.test(op.fingerprint) || !HASH.test(op.batchKey) ||
        !batches.has(op.batchKey) || !ids.has(op.accountId) ||
        !safeDate(op.date) || !integer(op.amountCents, 1, MAX_MINOR) ||
        !['income','expense','transfer'].includes(op.kind) ||
        typeof op.description !== 'string' || op.description.length > 500 ||
        (op.category !== null && (typeof op.category !== 'string' || op.category.length > 160)) ||
        (op.externalId !== null && (typeof op.externalId !== 'string' ||
         op.externalId.length < 1 || op.externalId.length > 150)) ||
        (op.targetAccountId !== null && !ids.has(op.targetAccountId)) ||
        (op.kind === 'transfer') !== (op.targetAccountId !== null) ||
        op.targetAccountId === op.accountId) fail();
    rows.add(op.sourceKey);
    if (op.externalId !== null) {
      const bankId = JSON.stringify([op.accountId,op.externalId]);
      if (external.has(bankId)) fail();
      external.add(bankId);
    }
    counts.set(op.batchKey, (counts.get(op.batchKey) || 0) + 1);
  }
  for (const [id,batch] of batches) if (counts.get(id) !== batch.operationCount) fail();
  // Validate every actual cash position: rejected imported/rollback histories
  // cannot silently create an unsafe Number or an unlimited balance.
  for (const account of value.accounts) guestBankBalance(value, account.id);
  return value;
}

export function guestBankBalance(data, accountId) {
  const account = data.accounts.find(item => item.id === accountId);
  if (!account) fail('Счёт не найден');
  let value = account.openingMinor;
  const batchByKey = new Map(data.batches.map(batch => [batch.batchKey,batch]));
  for (const op of data.operations) {
    if (batchByKey.get(op.batchKey)?.cancelledStateRevision !== null) continue;
    if (op.accountId === accountId)
      value += op.kind === 'income' ? op.amountCents : -op.amountCents;
    if (op.kind === 'transfer' && op.targetAccountId === accountId) value += op.amountCents;
    if (!integer(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
      fail('Переполнение локального остатка');
  }
  return value;
}


// Денежные суммы хранятся целыми копейками. Допущения кредитной модели изложены в README.
export function cents(input) {
  const normalized = String(input ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Введите неотрицательную сумму, максимум две цифры после запятой');
  const [rub, kop=''] = normalized.split('.');
  const result = Number(rub) * 100 + Number(kop.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 1_000_000_000_000) throw new Error('Сумма слишком велика');
  return result;
}
export function rubles(value) { return new Intl.NumberFormat('ru-RU', {style:'currency',currency:'RUB',maximumFractionDigits:2,minimumFractionDigits:0}).format(value / 100); }
export function numberInput(value) { return ((value||0) / 100).toFixed(2); }
export function monthKey(date) { return String(date).slice(0,7); }
export function monthIndex(month) { const [y,m]=month.split('-').map(Number); return y*12 + m-1; }
export function shiftMonth(month, change=0) { const [y,m]=month.split('-').map(Number); const d=new Date(y,m-1+change,1,12); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
export function monthLabel(month) { const [y,m]=month.split('-').map(Number); return new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(new Date(y,m-1,1,12)); }
export function dayInMonth(month,day) { const [y,m]=month.split('-').map(Number); const end = new Date(y,m,0).getDate(); return `${month}-${String(Math.min(end,Math.max(1,Number(day)))).padStart(2,'0')}`; }
export function isActive(record) { return !record.deletedAt; }
export function entryDueDate(entry, month) {
  if (!isActive(entry)) return null;
  if (entry.recurrence==='once') return monthKey(entry.date) === month ? entry.date : null;
  if (entry.recurrence==='monthly' && monthIndex(month)>=monthIndex(monthKey(entry.date))) return dayInMonth(month, Number(entry.date.slice(-2)));
  if (entry.recurrence==='yearly' && monthIndex(month)>=monthIndex(monthKey(entry.date)) && month.slice(-2)===entry.date.slice(5,7)) return dayInMonth(month, Number(entry.date.slice(-2)));
  return null;
}
export function loanRate(loan) { return Number(loan.apr || 0) / 1200; }
export function annuityMonthly(balance, annualRate, months) {
  if (balance<=0) return 0;
  if (!Number.isInteger(months) || months<1 || months>1200) return null;
  const r = annualRate / 1200;
  return r===0 ? Math.ceil(balance/months) : Math.ceil(balance*r / (1 - Math.pow(1+r,-months)));
}
export function payoffMonths(balance, monthly, annualRate) {
  if(balance<=0)return 0;
  if(monthly<=0)return null;
  const r=annualRate/1200;
  if(monthly<=Math.round(balance*r) && r>0) return null;
  let rest=balance;
  for(let i=1;i<=1200;i++) {const interest=Math.round(rest*r);rest=Math.max(0,rest+interest-monthly);if(rest===0)return i;}
  return null;
}
export function addMonthsDate(date,count) { const m=shiftMonth(monthKey(date),count);return dayInMonth(m, Number(date.slice(-2))); }
export function loanLedger(loan, payments) {
  let outstanding=Number(loan.openingCents), scheduled=Number(loan.paymentCents), interestRemaining=0;
  let lastPeriod=shiftMonth(monthKey(loan.asOfDate),-1);
  const history=[];
  const active=[...payments].filter(p=>p.loanId===loan.id&&!p.voidedAt).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt));
  for(const p of active){
    if(monthKey(p.date)<monthKey(loan.asOfDate)) continue;
    const month=monthKey(p.date);
    const monthsBetween=Math.max(0, monthIndex(month)-monthIndex(lastPeriod));
    if(monthsBetween){
      // Модель начисляет месячные проценты один раз на расчётный месяц;
      // просрочка/штрафы/дневная капитализация здесь намеренно не моделируются.
      interestRemaining += monthsBetween*Math.round(outstanding*loanRate(loan));
      lastPeriod=month;
    }
    const before=outstanding;
    const provided=Math.min(p.amountCents, outstanding+interestRemaining);
    const interestPaid=Math.min(interestRemaining,provided);
    interestRemaining-=interestPaid;
    const principalPaid=Math.min(outstanding,Math.max(0, provided-interestPaid));
    outstanding=Math.max(0,outstanding-principalPaid);
    if(p.strategy==='amount' && outstanding>0){
      const elapsed=Math.max(0,monthIndex(month)-monthIndex(monthKey(loan.asOfDate))+1);
      const remaining=Math.max(1,loan.termMonths-elapsed);
      scheduled=annuityMonthly(outstanding,loan.apr,remaining) ?? scheduled;
    }
    history.push({id:p.id,date:p.date,amountCents:p.amountCents,beforeCents:before,interestPaidCents:interestPaid,principalPaidCents:principalPaid,afterCents:outstanding,unpaidInterestCents:interestRemaining,strategy:p.strategy});
  }
  const months=payoffMonths(outstanding,scheduled,loan.apr);
  const lastDate=history.length?history[history.length-1].date:loan.asOfDate;
  return {outstandingCents:outstanding,monthlyCents:scheduled,unpaidInterestCents:interestRemaining,months, projectedEnd:months===null?null:addMonthsDate(lastDate,months),history};
}
export function previewLoanPayment(loan,payments,inputCents,date,strategy='term') {
  if (!loan || inputCents<=0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Укажите положительную сумму и дату');
  if (monthIndex(monthKey(date))<monthIndex(monthKey(loan.asOfDate))) throw new Error('Дата раньше расчётного остатка кредита');
  const previous=loanLedger(loan,payments);
  const incoming={id:'preview',loanId:loan.id,amountCents:inputCents,date,strategy,createdAt:new Date().toISOString()};
  const projected=loanLedger(loan,[...payments,incoming]);
  const row=projected.history.find(r=>r.id==='preview');
  const existingThisMonth=payments.filter(p=>p.loanId===loan.id&&!p.voidedAt&&monthKey(p.date)===monthKey(date)).reduce((sum,p)=>sum+p.amountCents,0);
  return {...projected, interestPaidCents:row?.interestPaidCents||0, principalPaidCents:row?.principalPaidCents||0,
    extraCents:Math.max(0,inputCents+existingThisMonth-previous.monthlyCents),
    baselineMonths:previous.months, savedMonths:previous.months===null||projected.months===null?null:Math.max(0,previous.months-projected.months),
    canApply:inputCents <= previous.outstandingCents+Math.round(previous.outstandingCents*loanRate(loan))+previous.unpaidInterestCents};
}
export function getMonthEvents(state,month){
 const entries=(state.entries||[]).filter(isActive).map(entry=>{const date=entryDueDate(entry,month); if(!date)return null;
   const paid=(state.settlements||[]).filter(s=>s.entryId===entry.id&&!s.voidedAt&&s.occurrence===month).reduce((a,s)=>a+s.amountCents,0);
   return {key:`entry:${entry.id}`,id:entry.id,source:'entry',title:entry.title,date,kind:entry.kind,plannedCents:entry.amountCents,paidCents:paid,category:entry.category||'',recurrence:entry.recurrence};
 }).filter(Boolean);
 const loans=(state.loans||[]).filter(isActive).filter(l=>monthIndex(month)>=monthIndex(monthKey(l.asOfDate))).map(l=>{
   const past=(state.loanPayments||[]).filter(p=>p.loanId===l.id&&!p.voidedAt&&monthKey(p.date)<month);
   const loan=loanLedger(l,past);
   if(loan.outstandingCents<=0)return null;
   const paid=(state.loanPayments||[]).filter(p=>p.loanId===l.id&&!p.voidedAt&&monthKey(p.date)===month).reduce((a,p)=>a+p.amountCents,0);
   return {key:`loan:${l.id}`,id:l.id,source:'loan',title:l.title,date:dayInMonth(month,l.dueDay),kind:'expense',plannedCents:loan.monthlyCents,paidCents:paid,category:'Кредиты'};
 }).filter(Boolean);
 return [...entries,...loans].sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'ru'));
}
/** Reuse the calendar's occurrence model for every outstanding historical period. */
export function getReminderMonthEvents(state,currentMonth){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(currentMonth))throw Error('Некорректный период напоминаний');
 const base=monthIndex(currentMonth),starts=[];
 for(const entry of state.entries){
  if(!isActive(entry)||entry.kind!=='expense'||entry.recurrence==='once')continue;
  const month=monthKey(entry.date);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Некорректная дата обязательства');
  starts.push(monthIndex(month));
 }
 for(const loan of state.loans){
  if(!isActive(loan))continue;
  const month=monthKey(loan.asOfDate);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Некорректная дата кредита');
  starts.push(monthIndex(month));
 }
 const first=starts.reduce((minimum,index)=>Math.min(minimum,index),base-12);
 const months=base+2-first;
 // Refuse oversized histories instead of silently presenting an incomplete list.
 const perMonth=state.entries.length*(state.settlements.length+1)+
  state.loans.length*(state.loanPayments.length+1)+1;
 if(!Number.isSafeInteger(perMonth)||months>1200||months*perMonth>10_000_000)
  throw Error('История обязательств слишком велика для расчёта напоминаний');
 const events=[];
 for(let offset=first-base;offset<=1;offset++){
  for(const item of getMonthEvents(state,shiftMonth(currentMonth,offset))){
   if(item.kind==='expense')events.push(item);
   if(events.length>5000)throw Error('Слишком много экземпляров для расчёта напоминаний');
  }
 }
 return events;
}
function actualMonthNet(state,month){
 if(!state||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Некорректный период фактических операций');
 const entries=new Map(state.entries.map(entry=>[entry.id,entry]));
 const loans=new Set(state.loans.map(loan=>loan.id));
 if(entries.size!==state.entries.length||loans.size!==state.loans.length)
  throw Error('Повторный идентификатор финансовой записи');
 let total=0;
 const add=(amount,sign)=>{
  if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(total+sign*amount))
   throw Error('Некорректная сумма фактической операции');
  total+=sign*amount;
 };
 for(const fact of state.settlements){
  if(fact.voidedAt||monthKey(fact.date)!==month)continue;
  const entry=entries.get(fact.entryId);
  if(!entry||!['income','expense'].includes(entry.kind))throw Error('Не найдена запись фактической операции');
  add(fact.amountCents,entry.kind==='income'?1:-1);
 }
 for(const fact of state.loanPayments){
  if(fact.voidedAt||monthKey(fact.date)!==month)continue;
  if(!loans.has(fact.loanId))throw Error('Не найден кредит фактической операции');
  add(fact.amountCents,-1);
 }
 return total;
}
export function monthTotals(events,state,month){const incomes=events.filter(x=>x.kind==='income'),expenses=events.filter(x=>x.kind!=='income');return {
  incomeCents:incomes.reduce((a,x)=>a+x.plannedCents,0),expenseCents:expenses.reduce((a,x)=>a+x.plannedCents,0),
  incomePaidCents:incomes.reduce((a,x)=>a+x.paidCents,0),expensePaidCents:expenses.reduce((a,x)=>a+x.paidCents,0),
  netPlanCents:incomes.reduce((a,x)=>a+x.plannedCents,0)-expenses.reduce((a,x)=>a+x.plannedCents,0),
  netFactCents:state===undefined&&month===undefined?
   incomes.reduce((a,x)=>a+x.paidCents,0)-expenses.reduce((a,x)=>a+x.paidCents,0):actualMonthNet(state,month)
};}
export function createSampleState() {
 const asOf='2026-11-01'; return {
  version:2,revision:0,entries:[
   {id:'s-income-1',title:'Зарплата',kind:'income',amountCents:9000000,date:'2026-11-15',recurrence:'monthly',category:'Работа'},
   {id:'s-income-2',title:'Аванс',kind:'income',amountCents:9000000,date:'2026-11-30',recurrence:'monthly',category:'Работа'},
   {id:'s-utilities',title:'ЖКХ',kind:'expense',amountCents:1250000,date:'2026-11-10',recurrence:'monthly',category:'Жильё'},
   {id:'s-internet',title:'Интернет и связь',kind:'expense',amountCents:280000,date:'2026-11-20',recurrence:'monthly',category:'Связь'},
   {id:'s-groceries',title:'Продукты и бытовое',kind:'expense',amountCents:3000000,date:'2026-11-22',recurrence:'monthly',category:'Покупки'}
  ],loans:[{id:'s-mortgage',title:'Ипотека',openingCents:210000000,apr:9.5,paymentCents:3020000,termMonths:102,dueDay:16,asOfDate:asOf,schedule:[]}],
  settlements:[],loanPayments:[],categories:['Жильё','Кредиты','Работа','Связь','Покупки','Подписки','Здоровье','Другое'],audit:[],settings:{currency:'RUB'}
 };
}
export function emptyState() {return {version:2,revision:0,entries:[],loans:[],settlements:[],loanPayments:[],categories:['Жильё','Кредиты','Работа','Связь','Покупки','Подписки','Здоровье','Другое'],audit:[],settings:{currency:'RUB'}};}

export const PAYMENT_METHODS_VERSION=1;
export const MAX_PAYMENT_METHODS=6;
export const MAX_QR_BYTES=192*1024;
export const MAX_QR_TOTAL_CHARS=2_000_000; // keep QR attachments compatible with 8 MB encrypted backups
const PAYMENT_TYPES=new Set(['payment_url','sbp_link','qr_image','requisites','instructions']);
const SECRET_LABEL=/\b(?:password|passphrase|cvv|cvc|pin|otp|secret|token|access[_-]?token|api[_-]?key|authorization)\b|парол[ьяеи]|секрет|токен|пин.код/i;

export function safePaymentUrl(value){
 if(typeof value!=='string'||!value||value.length>2048||/[\s\u0000-\u001f\u007f]/.test(value))
  throw Error('Укажите корректную защищённую ссылку HTTPS');
 let url;
 try{url=new URL(value);}catch{throw Error('Укажите корректную защищённую ссылку HTTPS');}
 if(url.protocol!=='https:'||!url.hostname.includes('.')||url.username||url.password||
    /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1)/i.test(url.hostname))
  throw Error('Разрешены только внешние ссылки HTTPS без встроенных учётных данных');
 if([...url.searchParams.keys()].some(key=>SECRET_LABEL.test(key)))
  throw Error('Ссылка содержит секретный параметр, который нельзя сохранять');
 return {href:url.href,hostname:url.hostname};
}

export function validQrData(data){
 if(typeof data!=='string'||data.length>Math.ceil(MAX_QR_BYTES/3)*4+64)return false;
 const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
 if(!match||match[2].length%4!==0)return false;
 try{
  const prefix=atob(match[2].slice(0,32)),bytes=Array.from(prefix,c=>c.charCodeAt(0));
  const png=bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10';
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=prefix.startsWith('RIFF')&&prefix.slice(8,12)==='WEBP';
  return (match[1]==='png'&&png)||(match[1]==='jpeg'&&jpeg)||(match[1]==='webp'&&webp);
 }catch{return false;}
}

export function validatePaymentMethods(methods,{strict=false}={}){
 if(methods===undefined)return;
 if(!Array.isArray(methods)||methods.length>MAX_PAYMENT_METHODS)
  throw Error('Некорректный список способов оплаты');
 const ids=new Set();
 let primaries=0;
 for(const m of methods){
  if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.id!=='string'||!m.id||
     m.id.length>128||ids.has(m.id)||!PAYMENT_TYPES.has(m.type)||
     typeof m.label!=='string'||!m.label.trim()||m.label.length>80||
     typeof m.primary!=='boolean')throw Error('Повреждены способы оплаты');
  ids.add(m.id);if(m.primary)primaries++;
  if(strict&&SECRET_LABEL.test(m.label))throw Error('Не сохраняйте пароли, CVV, токены и другие секреты');
  if(m.type==='qr_image'){
   if(m.imageData!==undefined&&(typeof m.imageData!=='string'||m.imageData.length>Math.ceil(MAX_QR_BYTES/3)*4+64))
    throw Error('Повреждён размер QR-изображения');
   if(strict&&!validQrData(m.imageData))throw Error('QR-изображение отсутствует или повреждено');
  }else{
   if(typeof m.value!=='string'||m.value.length>(m.type==='requisites'?800:m.type==='instructions'?1200:2048))
    throw Error('Повреждены сведения для оплаты');
   if(strict){
    if(!m.value.trim())throw Error('Заполните сведения для оплаты');
    if(SECRET_LABEL.test(m.value))
     throw Error('Не сохраняйте пароли, CVV, токены и другие секреты');
    if(m.type==='payment_url'||m.type==='sbp_link')safePaymentUrl(m.value);
   }
  }
 }
 if(methods.length&&primaries!==1)throw Error('Выберите один основной способ оплаты');
}

function activeRegularExpense(state,entryId){
 const entry=state.entries.find(e=>e.id===entryId&&!e.deletedAt);
 if(!entry||entry.kind!=='expense'||!['monthly','yearly'].includes(entry.recurrence))
  throw Error('Способы оплаты доступны только для существующего регулярного расхода');
 return entry;
}
export function upsertPaymentMethod(state,entryId,input,{idFactory=()=>crypto.randomUUID()}={}){
 const entry=activeRegularExpense(state,entryId),methods=[...(entry.paymentMethods||[])];
 const index=input.id?methods.findIndex(x=>x.id===input.id):-1;
 if(input.id&&index<0)throw Error('Способ оплаты не найден');
 if(index<0&&methods.length>=MAX_PAYMENT_METHODS)throw Error('Можно сохранить не более шести способов оплаты');
 const old=index>=0?methods[index]:null;
 const method={id:old?.id||idFactory(),type:input.type,label:input.label.trim(),
  primary:Boolean(input.primary),...(input.type==='qr_image'?{imageData:input.imageData}:{value:input.value?.trim()??''})};
 validatePaymentMethods([{...method,primary:true}],{strict:true});
 if(index>=0)methods[index]=method;else methods.push(method);
 if(method.primary){
  for(const item of methods)item.primary=item.id===method.id;
 }else if(old?.primary){
  const successor=methods.find(x=>x.id!==method.id);
  if(successor)successor.primary=true;
  else method.primary=true;
 }else if(!methods.some(x=>x.primary))methods[0].primary=true;
 validatePaymentMethods(methods);
 entry.paymentMethods=methods;entry.paymentMethodsVersion=PAYMENT_METHODS_VERSION;
 return method.id;
}
export function deletePaymentMethod(state,entryId,methodId){
 const entry=activeRegularExpense(state,entryId),methods=[...(entry.paymentMethods||[])];
 const index=methods.findIndex(x=>x.id===methodId);if(index<0)throw Error('Способ оплаты не найден');
 const wasPrimary=methods[index].primary;methods.splice(index,1);
 if(wasPrimary&&methods.length)methods[0].primary=true;
 validatePaymentMethods(methods);
 entry.paymentMethods=methods;entry.paymentMethodsVersion=PAYMENT_METHODS_VERSION;
}
export function choosePrimaryPaymentMethod(state,entryId,methodId){
 const entry=activeRegularExpense(state,entryId),methods=entry.paymentMethods||[];
 if(!methods.some(x=>x.id===methodId))throw Error('Способ оплаты не найден');
 for(const method of methods)method.primary=method.id===methodId;
 validatePaymentMethods(methods);
 entry.paymentMethodsVersion=PAYMENT_METHODS_VERSION;
}

export function validateState(s){
 // v1 remains readable for historical IndexedDB records and encrypted backups.
 if(!s || (s.version!==1&&s.version!==2) || !Array.isArray(s.entries) ||
    !Array.isArray(s.loans)||!Array.isArray(s.settlements)||
    !Array.isArray(s.loanPayments)||!Array.isArray(s.categories)||
    !Array.isArray(s.audit))throw Error('Неподдерживаемая версия или повреждённые финансовые данные');
 // #38: optional, guest-only actual cash journal. Historical backup payloads
 // omit it. Validate all bank account/batch identities before committing IDB.
 if(s.bankStatements!==undefined)validateGuestBankLedger(s.bankStatements);
 // #40: optional account-scoped preference; older encrypted backups lack this field.
 // Strict validation prevents a malformed preference from silently corrupting UI behavior.
 if(s.settings?.paymentReminders!==undefined){
  const settings=s.settings.paymentReminders;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||
     typeof settings.enabled!=='boolean'||!Array.isArray(settings.daysBefore)||
     settings.daysBefore.length>3||
     new Set(settings.daysBefore).size!==settings.daysBefore.length||
     settings.daysBefore.some(x=>![1,3,7].includes(x)))
   throw Error('Повреждены настройки напоминаний');
 }
 if(s.version===2&&(!Number.isSafeInteger(s.revision)||s.revision<0))
  throw Error('Повреждён счётчик изменений финансовой базы');
 if(s.entries.length>50000||s.loans.length>1000||
    s.loanPayments.length>100000||s.audit.length>150000)
  throw Error('Превышен безопасный объём данных');
 const moneyFields=['amountCents','openingCents','paymentCents','balanceCents','interestCents','principalCents'];
 for(const x of [...s.entries,...s.loans,...s.settlements,...s.loanPayments]){
  if(!x||typeof x.id!=='string'||x.id.length>128)throw Error('Ошибка идентификаторов данных');
  for(const field of moneyFields)
   if(x[field]!==undefined&&(!Number.isSafeInteger(x[field])||x[field]<0))
    throw Error('Неверные суммы в финансовых данных');
 }
 let qrChars=0;
 for(const entry of s.entries){
  for(const method of entry.paymentMethods||[])if(method.type==='qr_image')qrChars+=method.imageData?.length||0;
  if(entry.paymentMethodsVersion!==undefined&&entry.paymentMethodsVersion!==PAYMENT_METHODS_VERSION)
   throw Error('Неизвестная версия способов оплаты');
  validatePaymentMethods(entry.paymentMethods);
  if(entry.paymentMethods?.length&&
     (entry.kind!=='expense'||!['monthly','yearly'].includes(entry.recurrence)))
   throw Error('Способы оплаты привязаны к нерегулярной записи');
 }
 if(qrChars>MAX_QR_TOTAL_CHARS)throw Error('Превышен общий лимит QR-изображений для резервного копирования');
 for(const loan of s.loans){
  if(loan.schedule!==undefined&&!Array.isArray(loan.schedule))
   throw Error('Повреждён график кредита');
  for(const row of loan.schedule||[]){
   if(!row||typeof row!=='object'||Array.isArray(row))
    throw Error('Повреждена строка графика кредита');
   for(const field of moneyFields){
    const value=row[field];
    // parseSchedule() intentionally stores absent optional CSV columns as null.
    if(value===undefined||((field==='interestCents'||field==='principalCents')&&value===null))
     continue;
    if(!Number.isSafeInteger(value)||value<0)
     throw Error('Неверные суммы в графике кредита');
   }
  }
 }
 return s;
}
