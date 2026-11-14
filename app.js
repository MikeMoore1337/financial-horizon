import {cents,rubles,numberInput,monthKey,monthIndex,shiftMonth,monthLabel,dayInMonth,loanLedger,previewLoanPayment,getMonthEvents,monthTotals,createSampleState,isActive,emptyState,payoffMonths,MAX_QR_BYTES,validQrData,safePaymentUrl,upsertPaymentMethod,deletePaymentMethod,choosePrimaryPaymentMethod} from './finance.js';
import {readState,updateState,replaceState,askPersistentStorage,storageStatus,selectStateScope,revokeStateScope} from './storage.js?rev=auth-scopes-v18';
import {encryptBackup,decryptBackup} from './backup.js';
import {parseSchedule} from './schedule.js';
import {readXlsxRows,parseBudgetRows,previewImportChanges} from './excel-import.js';
import {createEmailSession} from './auth-session.js?rev=auth-scopes-v18';
import {audit,applyEntry,applyLoan,applyLoanPayment,applySettlement} from './ledger-operations.js';
import {createScreenRoot} from './src/react/ScreenRoot.tsx';
import {createAppShellRoots} from './src/react/AppShell.tsx';
import {sameFinancialJSON} from './src/security/protected-staging.ts';
import {prepareLivePersonalImportCandidate,executeConfirmedPersonalImportCandidate} from './src/cloud/personal-import-transport-candidate.mjs';
import {verifySavedFinancialBackupReadOnly} from './src/cloud/read-only-backup-verification.mjs';

const $=sel=>document.querySelector(sel);
const svg=name=>`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ico-${name}"></use></svg>`;
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatDate=date=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric'}).format(new Date(`${date}T12:00:00`));
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const uuid=()=>crypto.randomUUID();
const titles={overview:'Обзор',calendar:'Календарь',obligations:'Обязательства',loans:'Кредиты',settings:'Настройки','accounts-connected':'Счета и кошельки'};
// Only an explicit reviewed release can present the optional server-backed accounts view.
// FastAPI authentication and profile scoping remain the sole authorization boundary.
const financeAccountsEnabled=document.querySelector('meta[name="fh-finance-accounts"]')?.content==='enabled';
const financeImportEnabled=financeAccountsEnabled&&document.querySelector('meta[name="fh-finance-import"]')?.content==='enabled';
let state=null,ui={view:'overview',month:monthKey(today()),selectedDate:today(),filter:'all',selectedLoan:null,expandedEntry:null},passwordMode='export',restoreFile=null,verifyBackupFile=null,cloudImportFile=null,pendingCloudImport=null,cloudImportController=null,cloudImportBusy=false,scheduleLoanId=null,channel=null,toastTimer=null,busy=false,installPrompt=null,pendingExcelImport=null;
const emailSession=createEmailSession();
let guestMode=false,activeUserId=null,authBroadcast=null,sessionValidation=null,lastDialogActivator=null;
const GUEST_MODE_KEY='fh-guest-session-v2';
let screenRoot=null;
let navRoots=null;
function getAuthAccess(){
 if(guestMode)return {kind:'guest'};
 return {kind:'account',accountId:activeUserId||'',verifiedUserId:emailSession.userId||null,sessionValid:Boolean(emailSession.userId)};
}
let storageStatusMessage='Браузер может удалить данные при очистке хранилища. Делайте резервные копии.';
let storageStatusRequest=0;
let lastStorageContext=null;
function revokeDisplayedLedger(){
 revokeStateScope(); // invalidate pending IDB reads/writes before clearing the UI
 state=null;
 restoreFile=null;verifyBackupFile=null;cloudImportFile=null;pendingCloudImport=null;cloudImportController?.abort();cloudImportController=null;pendingExcelImport=null;scheduleLoanId=null;lastDialogActivator=null;
 if(screenRoot){screenRoot.unmount();screenRoot=null;}
 if(navRoots){navRoots.unmount();navRoots=null;}
 $('#main').replaceChildren();
 // Modal forms and previews live OUTSIDE #main; reset alone can retain
 // programmatically inserted finance titles, choices and payment schedules.
 // Every caller immediately redirects to the account page.
 for(const dialog of document.querySelectorAll('dialog')){
  if(dialog.open)dialog.close();
  dialog.replaceChildren();
 }
}
const hasData=()=>state.entries.some(isActive)||state.loans.some(isActive);
const monthEvents=()=>getMonthEvents(state,ui.month);
function toast(message,kind='success'){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3800);$('#save-indicator').textContent=kind==='error'?'Ошибка':'Сохранено на устройстве';}
function fail(error){console.error(error);toast(error?.message||'Не удалось выполнить действие','error');}
async function mutate(change,msg='Сохранено на устройстве',expectedRevision=state?.revision){
 if(busy)return;busy=true;$('#save-indicator').textContent='Сохранение…';
 try{state=await updateState(s=>change(s),{expectedRevision});channel?.postMessage('updated');render();toast(msg);}catch(e){fail(e);throw e;}finally{busy=false;}
}
function stampFormRevision(form){form.dataset.stateRevision=String(state.revision);}
function revisionForForm(form){const revision=Number(form.dataset.stateRevision);if(!Number.isSafeInteger(revision)||revision<0)throw Error('Не удалось определить версию записи. Откройте форму повторно.');return revision;}
function themeSet(mode){document.documentElement.dataset.theme=mode;document.body.dataset.theme=mode;try{localStorage.setItem('fh-theme',mode);}catch{};$('#theme-color').content=mode==='dark'?'#172336':'#ffffff';$('#theme-toggle').innerHTML=svg(mode==='dark'?'sun':'moon');$('#theme-toggle').setAttribute('aria-label',mode==='dark'?'Включить светлую тему':'Включить тёмную тему');}
function syncStorageContext(){
 const serverAccounts=ui.view==='accounts-connected'&&financeAccountsEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId;
 const labels=[
  ['storage-context-chip',serverAccounts?'На сервере':'Локально'],
  ['storage-context-title',serverAccounts?'Счета в аккаунте':'Хранится на устройстве'],
  ['storage-context-detail',serverAccounts?'Локальный бюджет отдельно':'Без банковских подключений'],
  ['storage-context-footnote',serverAccounts?'Счета хранятся на сервере. Локальная бухгалтерия остаётся в этом браузере.':'Данные остаются в этом браузере. Делайте резервные копии.'],
 ];
 for(const [id,value] of labels){
  const element=document.getElementById(id);
  if(element)element.textContent=value;
 }
 // The global Add action edits the local planner, not a server account.
 // Accounts has its own explicit "Новый счёт" button.
 const globalAdd=$('#top-add');
 if(globalAdd)globalAdd.hidden=serverAccounts;
 if(lastStorageContext!==serverAccounts){
  $('#save-indicator').textContent=serverAccounts?'Серверный раздел':'Локальная база готова';
  lastStorageContext=serverAccounts;
 }
}
function navigation(view){
 if(view==='accounts-connected'&&(!financeAccountsEnabled||guestMode||!activeUserId||emailSession.userId!==activeUserId))return;
 ui.view=view;$('.sidebar')?.classList.remove('open');window.scrollTo({top:0,behavior:'instant'});render();if(view==='settings'){void renderStorageStatus();if(!guestMode)void refreshEmailSession();}}
function render(){
 if(!state)return;
 syncStorageContext();
 $('#toolbar-title').textContent=titles[ui.view];
 if(!navRoots)navRoots=createAppShellRoots($('.sidebar-nav'),$('.bottom-nav'));
 navRoots.render(ui.view==='accounts-connected'?'settings':ui.view);
 const main=$('#main');
 if(ui.view==='calendar'||ui.view==='overview'||ui.view==='obligations'||ui.view==='loans'||ui.view==='settings'||ui.view==='accounts-connected'){
  if(!screenRoot){main.replaceChildren();screenRoot=createScreenRoot(main,getAuthAccess);}
  if(ui.view==='accounts-connected'){
   screenRoot.render({view:'accounts-connected',props:{verifiedActorUserId:emailSession.userId||null,onBack:()=>navigation('overview')}});
  }else if(ui.view==='calendar'){
   const events=monthEvents(),totals=monthTotals(events);
   screenRoot.render({view:'calendar',props:{events,month:ui.month,selectedDate:ui.selectedDate,currentDate:today(),monthTitle:monthLabel(ui.month),netPlanCents:totals.netPlanCents,netFactCents:totals.netFactCents,formatDate,rubles}});
  }else if(ui.view==='overview'){
   const currentDate=today(),events=monthEvents(),totals=monthTotals(events);
   const upcoming=events.filter(event=>event.date>=currentDate).slice(0,4);
   const groups=new Map();
   for(const event of events.filter(event=>event.kind!=='income'))
    groups.set(event.category,(groups.get(event.category)||0)+event.plannedCents);
   const ordered=[...groups.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
   const highest=Math.max(...ordered.map(([_,sum])=>sum),1);
   const categories=ordered.map(([name,amountCents])=>({name,amountCents,percent:Math.max(2,Math.round(amountCents/highest*100))}));
   const loan=state.loans.find(isActive)||null;
   const snapshot=loan?loanLedger(loan,state.loanPayments):null;
   const loanSummary=loan?{id:loan.id,title:loan.title,outstandingCents:snapshot.outstandingCents,monthlyCents:snapshot.monthlyCents,months:snapshot.months,
    percent:Math.max(0,Math.min(100,Math.round((1-snapshot.outstandingCents/loan.openingCents)*100)))}:null;
   screenRoot.render({view:'overview',props:{currentDate,monthTitle:monthLabel(ui.month),hasData:hasData(),totals,categories,upcoming,loan:loanSummary,rubles,formatDate}});
  }else if(ui.view==='obligations'){
   const items=state.entries.filter(isActive)
    .filter(e=>ui.filter==='all'||(ui.filter==='regular'&&e.recurrence!=='once')||
     (ui.filter==='once'&&e.recurrence==='once')||(ui.filter==='income'&&e.kind==='income'))
    .sort((a,b)=>a.date.localeCompare(b.date));
   const rows=items.map(entry=>{
    const payments=state.settlements.filter(s=>s.entryId===entry.id&&s.occurrence===ui.month&&!s.voidedAt);
    return {id:entry.id,title:entry.title,kind:entry.kind,category:entry.category,
     recurrence:entry.recurrence,amountCents:entry.amountCents,
     date:entry.recurrence==='once'?entry.date:dayInMonth(ui.month,Number(entry.date.slice(-2))),
     payments,paidCents:payments.reduce((sum,p)=>sum+p.amountCents,0)};
   });
   const totals=monthTotals(monthEvents());
   screenRoot.render({view:'obligations',props:{rows,month:ui.month,monthTitle:monthLabel(ui.month),
    filter:ui.filter,expandedEntry:ui.expandedEntry,currentDate:today(),
    expenseCents:totals.expenseCents,expensePaidCents:totals.expensePaidCents,rubles,formatDate}});
  }else if(ui.view==='loans'){
   const loans=state.loans.filter(isActive);
   if(!loans.find(loan=>loan.id===ui.selectedLoan))ui.selectedLoan=loans[0]?.id||null;
   const projected=loans.map(loan=>({loan,snapshot:loanLedger(loan,state.loanPayments)}));
   const summaries=projected.map(({loan,snapshot})=>({
    id:loan.id,title:loan.title,outstandingCents:snapshot.outstandingCents,
    monthlyCents:snapshot.monthlyCents,months:snapshot.months,
    paidPercent:Math.max(0,Math.min(100,Math.round((1-snapshot.outstandingCents/loan.openingCents)*100))),
   }));
   const current=projected.find(item=>item.loan.id===ui.selectedLoan);
   const summary=summaries.find(item=>item.id===ui.selectedLoan);
   const selected=current&&summary?{
    ...summary,apr:current.loan.apr,dueDay:current.loan.dueDay,
    projectedEnd:current.snapshot.projectedEnd,
    scheduleCount:current.loan.schedule?.length||0,
    scheduleSource:current.loan.scheduleSource||'CSV',
    schedule:current.loan.schedule?.slice(0,4)||[],
    bankSchedule:current.loan.schedule||[],
    legacySnapshot:{
     openingCents:current.loan.openingCents,paymentCents:current.loan.paymentCents,
     termMonths:current.loan.termMonths,dueDay:current.loan.dueDay,
     asOfDate:current.loan.asOfDate,
    },
    stateRevision:state.revision,
    history:state.loanPayments.filter(payment=>payment.loanId===current.loan.id)
     .sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt)),
   }:null;
   screenRoot.render({view:'loans',props:{loans:summaries,selected,currentDate:today(),rubles,formatDate}});
  }else{
   const archived=[
    ...state.entries.filter(x=>x.deletedAt).map(item=>({id:item.id,title:item.title,entity:'entry'})),
    ...state.loans.filter(x=>x.deletedAt).map(item=>({id:item.id,title:item.title,entity:'loan'})),
   ];
   const audit=state.audit.slice(-8).reverse().map((item,index)=>({
    id:item.id||item.date+'-'+index,description:item.description,date:item.date.slice(0,10),
   }));
   screenRoot.render({view:'settings',props:{
    currentDate:today(),categories:state.categories,archived,audit,storageMessage:storageStatusMessage,
    formatDate,showFinanceAccounts:financeAccountsEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId,
    showFinanceImport:financeImportEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId,
   }});
  }
 }else{
  if(screenRoot){screenRoot.unmount();screenRoot=null;}
  main.textContent='Неизвестный раздел';
 }
 syncAccountControls();
}
function syncAccountControls(){
 const signedIn=Boolean(emailSession.userId);
 const toolbarButton=$('#account-logout-toolbar');
 toolbarButton.hidden=!signedIn;
 toolbarButton.disabled=emailSession.busy;
 $('#account-entry-toolbar').hidden=!signedIn;
}
async function refreshEmailSession(){
 if(guestMode||!activeUserId||emailSession.busy)return true;
 // Focus, visibility and Settings can request validation together. A single
 // in-flight check avoids a stale response falsely signing out a valid session.
 if(sessionValidation)return sessionValidation;
 const pending=(async()=>{
  const verified=await emailSession.refresh();
  if(!verified||emailSession.userId!==activeUserId){
   revokeDisplayedLedger();
   window.location.replace('./account.html');
   return false;
  }
  syncAccountControls();
  return true;
 })();
 sessionValidation=pending;
 try{return await pending;}
 finally{if(sessionValidation===pending)sessionValidation=null;}
}
async function logoutEmailAccount(){
 if(busy||!emailSession.userId||emailSession.busy)return;
 const pending=emailSession.logout();
 syncAccountControls();
 try{
  if(await pending){
   // Revoke access to the displayed account before leaving the page.
   revokeDisplayedLedger();
   try{sessionStorage.removeItem(GUEST_MODE_KEY);}catch{}
   try{authBroadcast?.postMessage({type:'logout',userId:activeUserId});}catch{}
   window.location.replace('./account.html');
  }
 }catch(error){
  toast(error instanceof Error?error.message:'Не удалось выйти из аккаунта. Повторите попытку.','error');
 }finally{
  syncAccountControls();
 }
}
function pageHead(title,subtitle,actions=''){return `<header class="page-header"><div><div class="eyebrow">${formatDate(today())} · Личные финансы</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="header-tools">${actions}</div></header>`;}
const action=(type,label,kind='button-primary',props='')=>`<button class="${kind}" data-action="${type}" ${props}>${label}</button>`;
function openDialog(sel){
 const dlg=$(sel);if(!dlg||dlg.open)return;
 const focused=document.activeElement;
 const opener=focused instanceof HTMLElement&&focused!==document.body?focused:lastDialogActivator;
 if(opener instanceof HTMLElement)dlg.addEventListener('close',()=>{
  if(opener.isConnected&&!document.querySelector('dialog[open]'))opener.focus({preventScroll:true});
 },{once:true});
 dlg.showModal();
}
function formValue(form,name){return form.elements.namedItem(name).value;}
function fillSelect(el,items,selected){el.innerHTML=items.map(x=>`<option value="${escapeHtml(x.id)}" ${x.id===selected?'selected':''}>${escapeHtml(x.title)}</option>`).join('');}

const paymentTypeNames={
 payment_url:'Ссылка',qr_image:'QR-код',sbp_link:'СБП',requisites:'Реквизиты',instructions:'Инструкция'
};
function syncEntryPaymentAccess(){
 const form=$('#entry-form'),id=formValue(form,'id');
 const entry=state.entries.find(e=>e.id===id&&!e.deletedAt);
 $('#entry-methods-access').hidden=!(entry&&formValue(form,'kind')==='expense'&&
   ['monthly','yearly'].includes(formValue(form,'recurrence')));
 $('#entry-method-count').textContent=String(entry?.paymentMethods?.length||0);
}
function updateMethodType(){
 const type=formValue($('#payment-method-form'),'type'),isQr=type==='qr_image';
 $('#payment-method-text-field').hidden=isQr;
 $('#payment-method-qr-field').hidden=!isQr;
 const f=$('#payment-method-form');f.elements.value.required=!isQr;
 $('#payment-method-value-label').textContent=type==='requisites'?'Реквизиты и назначение':type==='instructions'?'Порядок оплаты':'Адрес HTTPS';
 f.elements.value.placeholder=type==='sbp_link'?'https://qr.nspk.ru/...':type==='requisites'?'Банк, номер счёта, получатель, назначение':type==='instructions'?'Как оплатить этот расход':'https://example.com/pay';
}
function resetPaymentMethodForm(){
 const form=$('#payment-method-form');form.reset();form.elements.methodId.value='';
 $('#payment-method-save-title').textContent='Новый способ оплаты';updateMethodType();
}
function currentPaymentEntry(){
 const id=$('#payment-method-form').dataset.entryId;
 const entry=state?.entries.find(e=>e.id===id&&!e.deletedAt);
 if(!entry||entry.kind!=='expense'||!['monthly','yearly'].includes(entry.recurrence))
  throw Error('Регулярный расход недоступен');
 return entry;
}
function renderPaymentMethods(){
 const entry=currentPaymentEntry(),list=$('#payment-methods-list');list.replaceChildren();
 const methods=entry.paymentMethods||[];
 if(!methods.length){
  const empty=document.createElement('p');empty.className='form-note';
  empty.textContent='Способы оплаты пока не добавлены.';list.append(empty);
 }
 for(const method of methods){
  const row=document.createElement('div');row.className='archive-row';
  row.style.alignItems='start';row.style.gap='10px';
  const info=document.createElement('div');info.style.minWidth='0';
  const name=document.createElement('strong');name.textContent=method.label;info.append(name);
  const type=document.createElement('p');type.className='small-hint';
  type.textContent=paymentTypeNames[method.type]+(method.primary?' · Основной':'');
  info.append(type);
  if(method.type==='qr_image'){
   if(validQrData(method.imageData)){
    const img=document.createElement('img');img.src=method.imageData;img.alt='Сохранённый QR-код';
    img.style.cssText='display:block;max-width:160px;max-height:160px;object-fit:contain';
    img.onerror=()=>{img.remove();const err=document.createElement('p');err.textContent='Изображение повреждено. Замените файл.';info.append(err);};
    info.append(img);
   }else{
    const missing=document.createElement('p');missing.textContent='Изображение отсутствует или повреждено. Измените способ оплаты.';info.append(missing);
   }
  }else if(method.type==='payment_url'||method.type==='sbp_link'){
   try{
    const link=safePaymentUrl(method.value),anchor=document.createElement('a');
    anchor.href=link.href;anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.referrerPolicy='no-referrer';
    anchor.textContent='Открыть: '+link.hostname;info.append(anchor);
    if(method.type==='sbp_link'){
     const hint=document.createElement('p');hint.className='small-hint';
     hint.textContent='Если ссылка СБП не поддерживается устройством, воспользуйтесь QR или реквизитами.';
     info.append(hint);
    }
   }catch{
    const invalid=document.createElement('p');invalid.textContent='Небезопасная или неподдерживаемая ссылка. Исправьте её.';info.append(invalid);
   }
  }else{
   const value=document.createElement('p');value.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';
   value.textContent=method.value;info.append(value);
  }
  const actions=document.createElement('div');actions.style.cssText='display:flex;gap:6px;flex-wrap:wrap';
  function addButton(label,action){
   const button=document.createElement('button');button.type='button';button.className='button-text';
   button.textContent=label;button.dataset.action=action;button.dataset.id=method.id;
   actions.append(button);
  }
  if(!method.primary)addButton('Основным','primary-payment-method');
  addButton('Изменить','edit-payment-method');addButton('Удалить','delete-payment-method');
  row.append(info,actions);list.append(row);
 }
}
function openPaymentMethods(){
 const entry=state.entries.find(e=>e.id===formValue($('#entry-form'),'id')&&!e.deletedAt);
 if(!entry||entry.kind!=='expense'||!['monthly','yearly'].includes(entry.recurrence))
  throw Error('Сначала сохраните регулярный расход');
 const form=$('#payment-method-form');form.dataset.entryId=entry.id;
 resetPaymentMethodForm();stampFormRevision(form);
 $('#payment-methods-heading').textContent='Способы оплаты: '+entry.title;
 renderPaymentMethods();openDialog('#payment-methods-dialog');
}
function editPaymentMethod(id){
 const method=currentPaymentEntry().paymentMethods?.find(x=>x.id===id);
 if(!method)throw Error('Способ оплаты не найден');
 const form=$('#payment-method-form');form.reset();
 form.elements.methodId.value=method.id;form.elements.type.value=method.type;
 form.elements.label.value=method.label;form.elements.value.value=method.value||'';
 form.elements.primary.checked=method.primary;
 $('#payment-method-save-title').textContent='Изменить способ оплаты';updateMethodType();
}
async function localQrImage(file){
 if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type)||
    file.size===0||file.size>MAX_QR_BYTES)
  throw Error('Используйте PNG, JPEG или WebP размером до 192 КБ');
 const data=await new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(reader.result);
  reader.onerror=()=>reject(Error('Не удалось прочитать QR-изображение'));
  reader.readAsDataURL(file);
 });
 if(!validQrData(data))throw Error('Содержимое QR-файла не соответствует его формату');
 const blobUrl=URL.createObjectURL(file);
 try{
  await new Promise((resolve,reject)=>{
   const img=new Image();
   img.onload=()=>{
    if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth>4096||img.naturalHeight>4096)
     reject(Error('Недопустимые размеры QR-изображения'));
    else resolve();
   };
   img.onerror=()=>reject(Error('QR-изображение повреждено'));
   img.src=blobUrl;
  });
 }finally{URL.revokeObjectURL(blobUrl);}
 return data;
}
async function savePaymentMethodForm(form){
 const entry=currentPaymentEntry(),id=formValue(form,'methodId'),type=formValue(form,'type');
 const original=entry.paymentMethods?.find(m=>m.id===id);
 const input={id,type,label:formValue(form,'label'),primary:form.elements.primary.checked};
 if(type==='qr_image'){
  const file=form.elements.qrFile.files?.[0];
  input.imageData=file?await localQrImage(file):original?.type==='qr_image'?original.imageData:undefined;
 }else input.value=formValue(form,'value');
 if(!form.isConnected)throw Error('Сеанс редактирования завершён');
 await mutate(s=>{
  upsertPaymentMethod(s,entry.id,input);
  audit(s,'payment-method-save','Сохранён способ оплаты для записи '+entry.id);
 },'Способ оплаты сохранён',revisionForForm(form));
 stampFormRevision(form);stampFormRevision($('#entry-form'));
 resetPaymentMethodForm();renderPaymentMethods();syncEntryPaymentAccess();
}

function openEntry(id=null,kind='expense'){
 const form=$('#entry-form');form.reset();stampFormRevision(form);const record=state.entries.find(x=>x.id===id);$('#entry-heading').textContent=record?'Изменить запись':'Добавить запись';
 form.elements.id.value=id||'';form.elements.title.value=record?.title||'';form.elements.kind.value=record?.kind||kind;form.elements.amount.value=record?numberInput(record.amountCents):'';
 form.elements.date.value=record?.date||today();form.elements.recurrence.value=record?.recurrence||'monthly';
 fillSelect($('#entry-category'),state.categories.map(x=>({id:x,title:x})),record?.category||'Другое');syncEntryPaymentAccess();openDialog('#entry-dialog');
}
function openLoan(id=null){
 const form=$('#loan-form');form.reset();stampFormRevision(form);const record=state.loans.find(x=>x.id===id);$('#loan-heading').textContent=record?'Изменить кредит':'Добавить кредит';
 form.elements.id.value=id||'';form.elements.title.value=record?.title||'';form.elements.opening.value=record?numberInput(record.openingCents):'';
 form.elements.apr.value=record?String(record.apr).replace('.',','):'';form.elements.payment.value=record?numberInput(record.paymentCents):'';
 form.elements.term.value=record?.termMonths??'';form.elements.asOfDate.value=record?.asOfDate||today();form.elements.dueDay.value=record?.dueDay??15;openDialog('#loan-dialog');
}
function openPayment(id=null,paymentId=null){
 const loans=state.loans.filter(isActive);if(!loans.length){toast('Сначала добавьте кредит','error');return;}
 const form=$('#payment-form');form.reset();stampFormRevision(form);fillSelect($('#payment-loan'),loans.map(x=>({id:x.id,title:x.title})),id||ui.selectedLoan||loans[0].id);
 const payment=state.loanPayments.find(p=>p.id===paymentId&&!p.voidedAt);const loan=loans.find(x=>x.id===formValue(form,'loanId'));
 form.elements.paymentId.value=paymentId||'';form.elements.amount.value=payment?numberInput(payment.amountCents):(loan?numberInput(loanLedger(loan,state.loanPayments).monthlyCents):'');
 form.elements.date.value=payment?.date||today();form.querySelector(`[name="strategy"][value="${payment?.strategy||'term'}"]`).checked=true;$('#payment-heading').textContent=payment?'Изменить платёж':'Внести платёж';
 openDialog('#payment-dialog');updatePaymentPreview();
}
function updatePaymentPreview(){
 const form=$('#payment-form'),panel=$('#payment-preview'),loan=state.loans.find(l=>l.id===formValue(form,'loanId'));
 if(!loan){panel.textContent='Выберите кредит';return;}
 try{
  const amount=cents(formValue(form,'amount'));const date=formValue(form,'date');const strategy=form.querySelector('[name="strategy"]:checked')?.value||'term';
  const paymentId=formValue(form,'paymentId');const activePayments=state.loanPayments.map(p=>p.id===paymentId?{...p,voidedAt:'PREVIEW'}:p);const p=previewLoanPayment(loan,activePayments,amount,date,strategy);
  panel.innerHTML=`<div class="eyebrow">Предварительный пересчёт</div><div class="forecast-row"><span>Из платежа на основной долг</span><strong>${rubles(p.principalPaidCents)}</strong></div><div class="forecast-row"><span>На проценты (модель)</span><strong>${rubles(p.interestPaidCents)}</strong></div><div class="forecast-row"><span>Остаток после платежа</span><strong>${rubles(p.outstandingCents)}</strong></div><div class="forecast-row"><span>${strategy==='term'?'Прогноз срока':'Новый платёж'}</span><strong>${strategy==='term'?(p.months===null?'Не рассчитывается':`${p.months} мес.`):rubles(p.monthlyCents)}</strong></div>${p.canApply?'':'<p class="neg" style="margin:6px 0 0">Сумма превышает долг и проценты в упрощённой модели</p>'}`;
  form.querySelector('button[type=submit]').disabled=!p.canApply;
 }catch(error){panel.textContent=error.message;form.querySelector('button[type=submit]').disabled=true;}
}
function openSettlement(entryId,occurrence=ui.month,paymentId=null){
 const entry=state.entries.find(e=>e.id===entryId);if(!entry)return;
 const form=$('#settlement-form');form.reset();stampFormRevision(form);const existing=state.settlements.find(p=>p.id===paymentId);
 form.elements.entryId.value=entryId;form.elements.occurrence.value=existing?.occurrence||occurrence;
 const paid=state.settlements.filter(s=>s.entryId===entryId&&s.occurrence===occurrence&&!s.voidedAt).reduce((a,b)=>a+b.amountCents,0);
 form.elements.amount.value=existing?numberInput(existing.amountCents):numberInput(Math.max(0,entry.amountCents-paid));
 form.elements.date.value=existing?.date||dayInMonth(occurrence,Math.min(Number(entry.date.slice(-2)),28));
 form.dataset.paymentId=paymentId||'';
 $('#settlement-heading').textContent=existing?'Изменить фактическую сумму':'Отметить фактическую сумму';
 $('#settlement-description').textContent=`${entry.title}. План: ${rubles(entry.amountCents)}. Уже внесено: ${rubles(paid)}. Можно внести часть суммы.`;
 openDialog('#settlement-dialog');
}
function requireConfirm(title,text){return new Promise(resolve=>{
 const dialog=$('#confirmation-dialog');$('#confirmation-title').textContent=title;$('#confirmation-text').textContent=text;
 let done=false;
 const finish=value=>{if(done)return;done=true;dialog.close();resolve(value);};
 const yes=$('#confirm-yes'),no=$('#confirm-cancel');
 yes.onclick=()=>finish(true);no.onclick=()=>finish(false);
 dialog.oncancel=e=>{e.preventDefault();finish(false);};
 dialog.showModal();
 });}
async function handleAction(button){
 const type=button.dataset.action,id=button.dataset.id;
 if(type==='account-logout'){await logoutEmailAccount();return;}
 if(type==='new-entry'){openEntry(null,button.dataset.kind||'expense');return;}
 if(type==='new-loan'){openLoan();return;}
 if(type==='edit-entry'){openEntry(id);return;}
 if(type==='open-payment-methods'){openPaymentMethods();return;}
 if(type==='close-payment-methods'){$('#payment-methods-dialog').close();return;}
 if(type==='reset-payment-method'){resetPaymentMethodForm();return;}
 if(type==='edit-payment-method'){editPaymentMethod(id);return;}
 if(type==='primary-payment-method'){
  const form=$('#payment-method-form'),entry=currentPaymentEntry();
  await mutate(s=>{
   choosePrimaryPaymentMethod(s,entry.id,id);
   audit(s,'payment-method-primary','Изменён основной способ для записи '+entry.id);
  },'Основной способ изменён',revisionForForm(form));
  stampFormRevision(form);stampFormRevision($('#entry-form'));
  renderPaymentMethods();syncEntryPaymentAccess();return;
 }
 if(type==='delete-payment-method'){
  const form=$('#payment-method-form'),entry=currentPaymentEntry(),revision=revisionForForm(form);
  if(!await requireConfirm('Удалить способ оплаты?','Будет удалён только способ оплаты. Расход, график и фактические платежи сохранятся.'))return;
  await mutate(s=>{
   deletePaymentMethod(s,entry.id,id);
   audit(s,'payment-method-delete','Удалён способ оплаты для записи '+entry.id);
  },'Способ оплаты удалён',revision);
  stampFormRevision(form);stampFormRevision($('#entry-form'));
  resetPaymentMethodForm();renderPaymentMethods();syncEntryPaymentAccess();return;
 }
 if(type==='edit-loan'){openLoan(id);return;}
 if(type==='pay'){openPayment(id);return;}
 if(type==='edit-payment'){const p=state.loanPayments.find(x=>x.id===id&&!x.voidedAt);if(p)openPayment(p.loanId,id);return;}
 if(type==='settle'){openSettlement(id,button.dataset.month||ui.month);return;}
 if(type==='edit-settlement'){const p=state.settlements.find(x=>x.id===id&&!x.voidedAt);if(p)openSettlement(p.entryId,p.occurrence,id);return;}
 if(type==='expand-entry'){ui.expandedEntry=ui.expandedEntry===id?null:id;render();return;}
 if(type==='select-loan'){ui.selectedLoan=id;render();return;}
 if(type==='select-day'){ui.selectedDate=button.dataset.date;render();document.querySelector('.cal-day.selected')?.focus({preventScroll:true});return;}
 if(type==='prev-month'||type==='next-month'){ui.month=shiftMonth(ui.month,type==='prev-month'?-1:1);ui.selectedDate=dayInMonth(ui.month,Math.min(Number(ui.selectedDate.slice(-2))||1,28));render();return;}
 if(type==='filter'){ui.filter=button.dataset.filter;render();return;}
 if(type==='theme'){themeSet(button.dataset.theme);render();return;}
 if(type==='persist'){const ok=await askPersistentStorage();toast(ok?'Браузер подтвердил постоянное хранение':'Браузер не предоставил постоянное хранение. Экспортируйте копии.',ok?'success':'error');renderStorageStatus();return;}
 if(type==='backup'){passwordMode='export';$('#password-heading').textContent='Создать резервную копию';$('#password-form').reset();openDialog('#password-dialog');return;}
 if(type==='verify-backup'){$('#backup-verify-status').textContent='';$('#verify-backup-file').value='';$('#verify-backup-file').click();return;}
 if(type==='restore'){$('#restore-file').value='';$('#restore-file').click();return;}
 if(type==='cloud-import'){
  if(!financeImportEnabled||guestMode||!activeUserId||emailSession.userId!==activeUserId)throw Error('Перенос доступен только своему FH-аккаунту');
  pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-file').value='';$('#cloud-import-file').click();return;
 }
 if(type==='cancel-cloud-import'){
  cloudImportController?.abort();pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
  $('#cloud-import-dialog').close();return;
 }
 if(type==='confirm-cloud-import'){await confirmCloudImport();return;}
 if(type==='excel-import'){$('#excel-file').value='';$('#excel-file').click();return;}
 if(type==='cancel-excel-import'){pendingExcelImport=null;$('#excel-import-dialog').close();return;}
 if(type==='confirm-excel-import'){
  if(!pendingExcelImport||busy)return;
  const data=pendingExcelImport;
  await mutate(s=>{
   const diff=previewImportChanges(data.parsed,s);
   if(!diff.entries.length&&!diff.loans.length)throw Error('Все подходящие записи уже есть в бухгалтерии');
   for(const cat of diff.categories)if(!s.categories.includes(cat))s.categories.push(cat);
   for(const row of diff.entries){const {source,...value}=row;s.entries.push({...value,id:uuid()});}
   for(const row of diff.loans){const {source,...value}=row;s.loans.push({...value,id:uuid()});}
   audit(s,'excel-import','Добавлены записи из Excel: '+diff.entries.length+' платежей, '+diff.loans.length+' кредитов');
  },'Данные из Excel добавлены локально');
  $('#excel-import-dialog').close();pendingExcelImport=null;ui.view='overview';render();return;
 }
 if(type==='install'){if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;}else toast('iPhone: Safari → Поделиться → На экран «Домой». Mac: Safari → Добавить в Dock.');return;}
 if(type==='sample'){
  const originalRevision=state?.revision;
  const ok=await requireConfirm('Загрузить вымышленные данные?',hasData()?'Это заменит вашу текущую бухгалтерию демонстрационными записями. Сначала сохраните резервную копию.':'Будет создана отдельная вымышленная бухгалтерия, которую можно удалить.');
  if(!ok)return;const sample=createSampleState();audit(sample,'sample','Загружен вымышленный пример');await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,sample);},'Демонстрационные данные загружены',originalRevision);ui.month='2026-11';ui.selectedDate='2026-11-15';render();return;
 }
 if(type==='clear'){
  const originalRevision=state?.revision;
  const ok=await requireConfirm('Удалить всю бухгалтерию?', 'Все локальные доходы, расходы, кредиты, фактические платежи и журнал будут очищены. Восстановить можно только из заранее созданной резервной копии.');
  if(!ok)return;const initial=emptyState();await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,initial);},'Бухгалтерия очищена',originalRevision);return;
 }
 if(type==='archive-entry'||type==='archive-loan'){
  const originalRevision=state?.revision;
  const isLoan=type==='archive-loan',item=state[isLoan?'loans':'entries'].find(x=>x.id===id);if(!item)return;
  if(!await requireConfirm('Перенести в архив?',`Запись «${item.title}» исчезнет из активных расчётов. История оплат сохранится.`))return;
  await mutate(s=>{const target=s[isLoan?'loans':'entries'].find(x=>x.id===id);target.deletedAt=new Date().toISOString();audit(s,'archive',`Архив: ${target.title}`);},'Запись перенесена в архив',originalRevision);return;
 }
 if(type==='restore-item'){
  const key=button.dataset.entity==='loan'?'loans':'entries';await mutate(s=>{const item=s[key].find(x=>x.id===id);if(!item)return;delete item.deletedAt;if(key==='entries'&&item.category&&!s.categories.includes(item.category))s.categories.push(item.category);audit(s,'restore',`Восстановлено: ${item.title}`);},'Запись восстановлена');return;
 }
 if(type==='void-payment'||type==='void-settlement'){
  const originalRevision=state?.revision;
  const key=type==='void-payment'?'loanPayments':'settlements';const record=state[key].find(x=>x.id===id);if(!record||record.voidedAt)return;
  if(!await requireConfirm('Отменить фактическую оплату?',`Сумма ${rubles(record.amountCents)} перестанет участвовать в расчёте. Запись об отмене останется в истории.`))return;
  await mutate(s=>{s[key].find(x=>x.id===id).voidedAt=new Date().toISOString();audit(s,'void',`Отменена оплата ${rubles(record.amountCents)}`);},'Операция отменена, прогноз обновлён',originalRevision);return;
 }
 if(type==='edit-category'){const cat=button.dataset.category;const form=$('#rename-category-form');form.elements.old.value=cat;form.elements.newName.value=cat;openDialog('#category-dialog');return;}
 if(type==='clear-schedule'){if(!await requireConfirm('Удалить импортированный график?', 'Изменится только справочный график банка. Фактические платежи и параметры кредита сохранятся.'))return;await mutate(s=>{const l=s.loans.find(x=>x.id===id);l.schedule=[];delete l.scheduleSource;audit(s,'schedule-remove',`Удалён график кредита: ${l.title}`);},'График удалён');return;}
 if(type==='delete-category'){
  const cat=button.dataset.category;
  if(state.entries.some(x=>isActive(x)&&x.category===cat)){toast('Категория используется. Сначала измените её в записях.','error');return;}
  await mutate(s=>{s.categories=s.categories.filter(c=>c!==cat);audit(s,'category',`Удалена категория «${cat}»`);},'Категория удалена');return;
 }
 if(type==='schedule-import'){
  scheduleLoanId=id;$('#schedule-file').value='';$('#schedule-file').click();return;
 }
}
async function renderStorageStatus(){
 if(ui.view!=='settings'||!state)return;
 const request=++storageStatusRequest;
 try{
  const info=await storageStatus();
  if(request!==storageStatusRequest||ui.view!=='settings'||!state)return;
  const next=info.persistent===true
   ?'Постоянное хранение браузером разрешено. Экспорт копий всё равно обязателен для надёжности.'
   :'Постоянное хранение не подтверждено. Очистка данных сайта может уничтожить бухгалтерию.';
  if(next!==storageStatusMessage){storageStatusMessage=next;render();}
 }catch(error){
  if(ui.view==='settings')toast('Не удалось проверить состояние хранилища','error');
 }
}
async function previewExcelImport(file){
 if(!file)return;
 if(!/\.xlsx$/i.test(file.name))throw Error('Выберите файл XLSX. Старый формат XLS не поддерживается.');
 if(file.size>4000000)throw Error('Размер XLSX не должен превышать 4 МБ');
 const data=await readXlsxRows(await file.arrayBuffer());
 const parsed=parseBudgetRows(data.rows,today());
 const diff=previewImportChanges(parsed,state);
 pendingExcelImport={parsed,name:file.name.slice(0,120)};
 const summary=$('#excel-import-summary'),items=$('#excel-import-items'),warnings=$('#excel-import-warnings');
 summary.replaceChildren();items.replaceChildren();warnings.replaceChildren();
 const paragraph=document.createElement('p');
 paragraph.textContent='Лист «'+data.sheetName+'». Добавятся: '+diff.entries.length+' доходов и расходов, '+diff.loans.length+' кредитов. Пропущено повторов: '+diff.duplicates+'.';
 summary.append(paragraph);
 const totals=document.createElement('p');
 totals.textContent='Плановые доходы: '+rubles(diff.incomeCents)+'. Плановые расходы: '+rubles(diff.expenseCents)+' (без обязательных платежей по кредитам).';
 summary.append(totals);
 const itemsList=document.createElement('ul');
 for(const record of [...diff.entries,...diff.loans].slice(0,50)){
  const li=document.createElement('li');
  li.textContent=(record.source||'')+' · '+record.title+' · '+rubles(record.amountCents??record.openingCents)+' · '+(record.kind?((record.kind==='income'?'доход':'расход')+' · '+record.date+' · '+(record.recurrence==='once'?'однократно':'ежемесячно')+' · '+record.category):('кредит · платёж '+record.dueDay+'-го числа · приблизительно '+record.termMonths+' мес.'));
  itemsList.append(li);
 }
 if(!itemsList.childElementCount){const li=document.createElement('li');li.textContent='Новых записей нет.';itemsList.append(li);}
 items.append(itemsList);
 const list=document.createElement('ul');
 for(const warning of diff.warnings.slice(0,60)){const li=document.createElement('li');li.textContent=warning.source+': '+warning.message;list.append(li);}
 if(!list.childElementCount){const li=document.createElement('li');li.textContent='Нет замечаний.';list.append(li);}
 warnings.append(list);
 $('#excel-import-confirm').disabled=!diff.entries.length&&!diff.loans.length;
 openDialog('#excel-import-dialog');
}
function onErrorNoStorage(error){if(screenRoot){screenRoot.unmount();screenRoot=null;}$('#main').innerHTML=`<section class="surface empty-panel"><h1>Хранилище недоступно</h1><p>${escapeHtml(error.message)}</p><p>Финансовые данные не будут незаметно записаны в ненадёжное временное хранилище. Откройте приложение в обычном окне Safari или другого браузера и разрешите сохранение данных.</p></section>`;}
async function saveEntry(form){
 const id=formValue(form,'id'),title=formValue(form,'title').trim(),amountCents=cents(formValue(form,'amount'));
 const kind=formValue(form,'kind'),date=formValue(form,'date'),recurrence=formValue(form,'recurrence'),category=formValue(form,'category');
 if(!title||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['income','expense'].includes(kind)||!['monthly','once','yearly'].includes(recurrence)||amountCents<1)throw Error('Заполните корректные поля записи');
 if(!state.categories.includes(category))throw Error('Категория не найдена');
 if(state.entries.find(e=>e.id===id)?.paymentMethods?.length&&(kind!=='expense'||recurrence==='once'))
  throw Error('Сначала удалите способы оплаты, затем измените тип или периодичность расхода');
 await mutate(s=>applyEntry(s,{id,title,amountCents,kind,date,recurrence,category}),id?'Запись обновлена':'Запись добавлена',revisionForForm(form));
 $('#entry-dialog').close();
}
async function saveLoan(form){
 const id=formValue(form,'id'),title=formValue(form,'title').trim(),openingCents=cents(formValue(form,'opening')),
 paymentCents=cents(formValue(form,'payment')),apr=Number(formValue(form,'apr').replace(',','.')),
 termMonths=Number(formValue(form,'term')),dueDay=Number(formValue(form,'dueDay')),asOfDate=formValue(form,'asOfDate');
 if(!title||openingCents<1||paymentCents<1||!Number.isFinite(apr)||apr<0||apr>100||!Number.isInteger(termMonths)||termMonths<1||termMonths>1200||!Number.isInteger(dueDay)||dueDay<1||dueDay>31||!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate))throw Error('Проверьте параметры кредита');
 if(paymentCents<=Math.round(openingCents*apr/1200))throw Error('Платёж не покрывает месячные проценты: срок не рассчитан');
 if(id&&state.loanPayments.some(p=>p.loanId===id&&!p.voidedAt)){
  if(!await requireConfirm('Изменить условия кредита?', 'У этого кредита уже есть фактические оплаты. Изменение исходных условий пересчитает прогноз, но не удалит историю операций.'))return;
 }
 await mutate(s=>{
  const loanId=applyLoan(s,{id,title,openingCents,paymentCents,apr,termMonths,dueDay,asOfDate});
  if(!id)ui.selectedLoan=loanId;
 },id?'Кредит обновлён':'Кредит добавлен',revisionForForm(form));
 $('#loan-dialog').close();
}
async function savePayment(form){
 const loanId=formValue(form,'loanId'),paymentId=formValue(form,'paymentId'),amountCents=cents(formValue(form,'amount')),date=formValue(form,'date'),strategy=form.querySelector('[name="strategy"]:checked')?.value;
 const loan=state.loans.find(l=>l.id===loanId&&isActive(l));if(!loan||!['term','amount'].includes(strategy))throw Error('Кредит недоступен');
 const paymentsExcludingOld=state.loanPayments.map(p=>p.id===paymentId?{...p,voidedAt:'EDIT_PREVIEW'}:p);
 const projection=previewLoanPayment(loan,paymentsExcludingOld,amountCents,date,strategy);
 if(!projection.canApply)throw Error('Сумма выше долга с процентами в расчётной модели');
 await mutate(s=>applyLoanPayment(s,{loanId,paymentId,amountCents,date,strategy}),paymentId?'Платёж исправлен, прогноз обновлён':'Фактический платёж сохранён и учтён в прогнозе',revisionForForm(form));
 $('#payment-dialog').close();ui.selectedLoan=loanId;
}
async function saveSettlement(form){
 const entryId=formValue(form,'entryId'),occurrence=formValue(form,'occurrence'),date=formValue(form,'date'),amountCents=cents(formValue(form,'amount')),
 id=form.dataset.paymentId;
 if(amountCents<=0||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/\d{4}-\d{2}/.test(occurrence)||!state.entries.find(e=>e.id===entryId&&isActive(e)))throw Error('Некорректная фактическая операция');
 await mutate(s=>applySettlement(s,{id,entryId,occurrence,date,amountCents}),'Фактическая сумма учтена',revisionForForm(form));
 $('#settlement-dialog').close();
}
async function performBackup(password){
 const file=await encryptBackup(await readState(),password);const url=URL.createObjectURL(new Blob([file],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`finansovyi-gorizont-${today()}-encrypted.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),12000);toast('Шифрованная резервная копия подготовлена');
}
async function performVerifyBackup(password){
 if(!verifyBackupFile)throw Error('Выберите сохранённый зашифрованный файл');
 const actor=activeUserId,wasGuest=guestMode;
 const original=await readState();
 if(actor!==activeUserId||wasGuest!==guestMode||!state)
  throw Error('Сессия сменилась во время проверки копии');
 const result=await verifySavedFinancialBackupReadOnly({
  backupText:await verifyBackupFile.text(),password,currentSnapshot:original,
 });
 if(actor!==activeUserId||wasGuest!==guestMode||!state)
  throw Error('Сессия сменилась во время проверки копии');
 const counts=result.recordCounts;
 const prefix='AES-GCM: файл расшифрован, финансовая схема проверена. '+
  'Записей: '+counts.entries+', кредитов: '+counts.loans+
  ', фактических оплат: '+counts.settlements+
  ', платежей по кредитам: '+counts.loanPayments+'. ';
 $('#backup-verify-status').textContent=prefix+
  (result.matchesCurrent
   ? 'Содержимое полностью совпадает с текущей локальной бухгалтерией. Данные не менялись.'
   : 'Содержимое отличается от текущей локальной бухгалтерии. Для переноса создайте и проверьте новую копию. Данные не менялись.');
}
async function performRestore(password){
 const originalRevision=state?.revision;
 const decrypted=await decryptBackup(await restoreFile.text(),password);
 if(!await requireConfirm('Заменить локальные данные?', 'Импорт заменит всю текущую бухгалтерию данными из резервной копии. При необходимости сохраните текущую копию перед продолжением.'))return;
 await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,structuredClone(decrypted));audit(s,'restore-backup','Восстановлена резервная копия');},'Данные восстановлены',originalRevision);
}

// Owner-only, dormant by default. Preview NEVER posts financial data.
async function prepareCloudImport(password){
 if(cloudImportBusy||busy||!financeImportEnabled||guestMode||!cloudImportFile)
  throw Error('Перенос недоступен или уже выполняется');
 const actor=activeUserId;
 if(!actor||emailSession.userId!==actor||!await refreshEmailSession())
  throw Error('Сессия финансового аккаунта не подтверждена');
 cloudImportBusy=true;
 cloudImportController?.abort();
 const controller=new AbortController();
 cloudImportController=controller;
 pendingCloudImport=null;
 try{
  const text=await cloudImportFile.text();
  if(text.length>8_000_000)throw Error('Зашифрованный файл превышает 8 МБ');
  const prepared=await prepareLivePersonalImportCandidate({
   verifiedActorUserId:actor,backupText:text,backupPassword:password,
   fetchImpl:window.fetch.bind(window),origin:window.location.origin,
   signal:controller.signal,explicitConsent:true,
  });
  if(controller.signal.aborted||guestMode||activeUserId!==actor||emailSession.userId!==actor)
   throw Error('Сессия изменилась во время проверки импорта');
  pendingCloudImport=prepared;
  const count=prepared.preview.counts;
  $('#cloud-import-summary').textContent=
   'Готово к переносу: '+count.entries+' регулярных записей, '+count.loans+' кредитов, '+
   count.settlements+' фактических оплат и '+count.loanPayments+' платежей по кредитам. '+
   'Серверная ревизия: '+prepared.revision+'. Пока ничего не загружено.'+
   (prepared.preservedZeroAccountId ? ' Существующий счёт «'+
    prepared.preservedZeroAccountName+'» с нулевым остатком останется на сервере без изменений.' : '');
  $('#cloud-import-preserve-row').hidden=!prepared.preservedZeroAccountId;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-final-consent').checked=false;
  // Never retain the original encrypted file or password in global state.
  cloudImportFile=null;
 }catch(error){
  pendingCloudImport=null;cloudImportFile=null;controller.abort();
  throw error;
 }finally{cloudImportBusy=false;}
}
async function confirmCloudImport(){
 if(cloudImportBusy||busy||!financeImportEnabled||!pendingCloudImport)
  throw Error('Нет подтверждённого переноса. Сначала проверьте резервную копию.');
 if($('#cloud-import-final-consent').checked!==true)
  throw Error('Требуется отдельное подтверждение сохранённой шифрованной копии');
 const prepared=pendingCloudImport, actor=prepared.actor;
 if(prepared.preservedZeroAccountId&&$('#cloud-import-preserve-zero-account').checked!==true)
  throw Error('Отдельно подтвердите сохранение существующего пустого счёта');
 cloudImportBusy=true;
 const button=$('#cloud-import-dialog [data-action="confirm-cloud-import"]');
 button.disabled=true;
 try{
  if(guestMode||actor!==activeUserId||emailSession.userId!==actor||
     !await refreshEmailSession())
   throw Error('Сессия изменилась. Перенос отменён.');
  const current=await readState();
  const unchanged=sameFinancialJSON(current,prepared.snapshot);
  if(!unchanged)throw Error('Локальные данные изменились. Создайте новую копию и предпросмотр.');
  const result=await executeConfirmedPersonalImportCandidate({
   prepared,verifiedActorUserId:actor,currentLocalSnapshotMatches:unchanged,
   explicitFinalConsent:true,
   explicitPreserveZeroAccountConsent:prepared.preservedZeroAccountId ?
    $('#cloud-import-preserve-zero-account').checked===true : false,
   fetchImpl:window.fetch.bind(window),
   signal:cloudImportController?.signal,
  });
  pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
  $('#cloud-import-summary').textContent=
   'Перенесено '+result.recordCount+' записей. Сервер вернул точную копию исходных данных. '+
   'Локальная бухгалтерия не удалена. Пока синхронизация не включена, '+
   'не ведите параллельные изменения на разных устройствах.';
  toast('Перенос подтверждён сервером, исходные данные сохранены');
 }catch(error){
  // A network failure AFTER commit is UNKNOWN. Do not retry automatically.
  pendingCloudImport=null;cloudImportFile=null;cloudImportController?.abort();
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
  $('#cloud-import-summary').textContent=
   'Результат переноса неизвестен. Локальные данные сохранены. Не повторяйте импорт, '+
   'пока не проверите серверную копию и квитанцию.';
  throw error;
 }finally{cloudImportBusy=false;button.disabled=true;}
}
async function onFormSubmit(event){
 const form=event.target;
 // A dialog cancel button must use the browser's native method="dialog" close path.
 if(event.submitter?.value==='cancel'&&form.closest('dialog'))return;
 event.preventDefault();if(busy)return;
 try{
  if(form.getAttribute('id')==='entry-form')await saveEntry(form);
  if(form.getAttribute('id')==='payment-method-form')await savePaymentMethodForm(form);
  if(form.getAttribute('id')==='loan-form')await saveLoan(form);
  if(form.getAttribute('id')==='payment-form')await savePayment(form);
  if(form.getAttribute('id')==='settlement-form')await saveSettlement(form);
  if(form.getAttribute('id')==='rename-category-form'){const old=form.elements.old.value,newName=form.elements.newName.value.trim();if(!newName||newName.length>40)throw Error('Введите название категории');if(old.toLowerCase()!==newName.toLowerCase()&&state.categories.some(x=>x.toLowerCase()===newName.toLowerCase()))throw Error('Такая категория уже есть');await mutate(s=>{s.categories=s.categories.map(x=>x===old?newName:x);for(const e of s.entries)if(e.category===old)e.category=newName;audit(s,'category-rename',`Категория «${old}» переименована`);},'Категория обновлена');$('#category-dialog').close();}
  if(form.getAttribute('id')==='category-form'){
   const title=form.elements.namedItem('name').value.trim();if(!title||title.length>40)throw Error('Название категории должно быть от 1 до 40 символов');
   if(state.categories.some(x=>x.toLowerCase()===title.toLowerCase()))throw Error('Такая категория уже существует');
   await mutate(s=>{s.categories.push(title);audit(s,'category',`Добавлена категория: ${title}`);},'Категория добавлена');
   if(form.isConnected)form.reset();
  }
  if(form.getAttribute('id')==='password-form'){
   const password=form.elements.password.value;
   if(password.length<12)throw Error('Пароль должен содержать не менее 12 символов');
   try{
    if(passwordMode==='export')await performBackup(password);
    else if(passwordMode==='verify')await performVerifyBackup(password);
    else if(passwordMode==='cloud')await prepareCloudImport(password);
    else await performRestore(password);
   }finally{form.elements.password.value='';}
   $('#password-dialog').close();
   if(passwordMode==='cloud'&&pendingCloudImport){
    $('#cloud-import-dialog [data-action="confirm-cloud-import"]').disabled=false;
    openDialog('#cloud-import-dialog');
   }
  }
 }catch(e){fail(e);}
}
function bindEvents(){
 // Safari does not always focus clicked buttons; retain the actual dialog trigger.
 document.addEventListener('click',event=>{
  const button=event.target instanceof Element?event.target.closest('button,[role="button"]'):null;
  if(button)lastDialogActivator=button;
 },true);
 document.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-view]');if(nav){event.preventDefault();navigation(nav.dataset.view);return;}
  const actionEl=event.target.closest('[data-action]');if(actionEl){event.preventDefault();try{await handleAction(actionEl);}catch(e){fail(e);}return;}
 });
 document.addEventListener('submit',onFormSubmit);
 $('#theme-toggle').addEventListener('click',()=>{themeSet(document.body.dataset.theme==='dark'?'light':'dark');render();});
 $('#top-add').addEventListener('click',()=>openEntry());
 $('#entry-form').addEventListener('change',syncEntryPaymentAccess);
 $('#payment-method-type').addEventListener('change',updateMethodType);
 $('#payment-form').addEventListener('input',updatePaymentPreview);
 $('#payment-form').addEventListener('change',updatePaymentPreview);
 $('#payment-loan').addEventListener('change',()=>{const l=state.loans.find(x=>x.id===$('#payment-loan').value);if(l){$('#payment-form').elements.amount.value=numberInput(loanLedger(l,state.loanPayments).monthlyCents);updatePaymentPreview();}});
 $('#password-dialog').addEventListener('close',()=>{
  verifyBackupFile=null;
  $('#verify-backup-file').value='';
 });
 $('#verify-backup-file').addEventListener('change',event=>{
  const file=event.target.files[0];if(!file)return;
  if(file.size>8_000_000){toast('Зашифрованная копия превышает 8 МБ','error');return;}
  verifyBackupFile=file;passwordMode='verify';
  $('#password-heading').textContent='Проверить копию без восстановления';
  $('#password-form').reset();openDialog('#password-dialog');
 });
 $('#restore-file').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;if(file.size>8_000_000){toast('Файл превышает предел 8 МБ','error');return;}restoreFile=file;passwordMode='import';$('#password-heading').textContent='Восстановить резервную копию';$('#password-form').reset();openDialog('#password-dialog');});
 $('#cloud-import-file').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;if(file.size>8_000_000){toast('Зашифрованная копия превышает 8 МБ','error');return;}cloudImportFile=file;passwordMode='cloud';$('#password-heading').textContent='Проверить шифрованную копию для переноса';$('#password-form').reset();openDialog('#password-dialog');});
 $('#cloud-import-dialog').addEventListener('close',()=>{
  cloudImportController?.abort();cloudImportController=null;
  pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
 });
 $('#excel-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{await previewExcelImport(file);}catch(e){pendingExcelImport=null;fail(e);}finally{event.target.value='';}});
 $('#schedule-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;
  try{if(file.size>1_000_000)throw Error('График CSV превышает 1 МБ');const rows=parseSchedule(await file.text());const id=scheduleLoanId;
  await mutate(s=>{const loan=s.loans.find(x=>x.id===id);if(!loan)throw Error('Кредит не найден');loan.schedule=rows;loan.scheduleSource=file.name.slice(0,80);audit(s,'schedule',`Импортирован график из CSV: ${loan.title}, ${rows.length} строк`);},'График импортирован локально');}catch(e){fail(e);}
 });
 window.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){
   if(e.key.toLowerCase()==='n'){e.preventDefault();openEntry();}
   const nums=['overview','calendar','obligations','loans','settings'];if(/^[1-5]$/.test(e.key)){e.preventDefault();navigation(nums[Number(e.key)-1]);}
  }
 });
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;});
 window.addEventListener('storage',e=>{if(e.key==='fh-theme'&&e.newValue&&['light','dark'].includes(e.newValue)){themeSet(e.newValue);render();}});
 // Revoked sessions on other devices become invalid when this tab is revisited.
 // Concurrent focus/visibility checks share the same request.
 window.addEventListener('focus',()=>{if(!guestMode&&activeUserId)void refreshEmailSession();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!guestMode&&activeUserId)void refreshEmailSession();});
 window.addEventListener('pageshow',event=>{
  if(!event.persisted||guestMode||!activeUserId)return;
  // A restored page from back/forward cache must re-validate authorization
  // before it can show any finance records.
  state=null;
  if(screenRoot){screenRoot.unmount();screenRoot=null;}
  $('#main').textContent='Проверяем доступ к бухгалтерии…';
  void (async()=>{
   if(!await refreshEmailSession())return;
   state=await readState();
   render();
  })().catch(()=>window.location.replace('./account.html'));
 });
 try{channel=new BroadcastChannel('financial-horizon-updates');channel.onmessage=async()=>{if(!state)return;try{state=await readState();render();}catch(e){fail(e);}};}catch{}
}
async function init(){
 try{themeSet(localStorage.getItem('fh-theme')||((window.matchMedia?.('(prefers-color-scheme: dark)').matches)?'dark':'light'));}catch{themeSet('light');}
 bindEvents();
 if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
 try{
  const url=new URL(window.location.href);
  // A successful OAuth callback replaces guest mode with the verified account.
  if(url.searchParams.get('auth')==='success'){
   try{sessionStorage.removeItem(GUEST_MODE_KEY);}catch{}
   url.searchParams.delete('auth');
   history.replaceState(null,'',url.pathname+url.search+url.hash);
  }
  if(url.searchParams.get('guest')==='1'){
   guestMode=true;
   try{sessionStorage.setItem(GUEST_MODE_KEY,'1');}catch{}
   url.searchParams.delete('guest');
   history.replaceState(null,'',url.pathname+url.search+url.hash);
  }else{
   try{guestMode=sessionStorage.getItem(GUEST_MODE_KEY)==='1';}catch{}
  }
  if(guestMode){
   await selectStateScope(null);
  }else{
   // Validate the server session BEFORE reading any account ledger.
   const verified=await emailSession.refresh();
   if(!verified||!emailSession.userId){
    window.location.replace('./account.html');
    return;
   }
   activeUserId=emailSession.userId;
   await selectStateScope(activeUserId);
   try{
    authBroadcast=new BroadcastChannel('fh-auth-session-v2');
    authBroadcast.onmessage=event=>{
     if(event.data?.type==='logout'&&event.data.userId===activeUserId){
      revokeDisplayedLedger();
      window.location.replace('./account.html');
     }
    };
   }catch{}
  }
  state=await readState();
  render();
  $('#save-indicator').textContent='Локальная база готова';
 }catch(e){onErrorNoStorage(e);return;}
 if(ui.view==='settings')renderStorageStatus();
}
init();
