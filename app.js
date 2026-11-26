import {cents,rubles,numberInput,monthKey,shiftMonth,monthLabel,dayInMonth,loanLedger,previewLoanPayment,getMonthEvents,getReminderMonthEvents,monthTotals,createSampleState,isActive,emptyState,payoffMonths,MAX_QR_BYTES,validQrData,safePaymentUrl,upsertPaymentMethod,deletePaymentMethod,choosePrimaryPaymentMethod} from './finance.js';
import {readState,updateState,replaceState,withStableImportSnapshot,askPersistentStorage,storageStatus,selectStateScope,revokeStateScope,captureStateScope} from './storage.js?rev=auth-scopes-v18';
import {encryptBackup,decryptBackup} from './backup.js';
import {parseSchedule} from './schedule.js';
import {readXlsxRows,parseBudgetRows,previewImportChanges} from './excel-import.js';
import {previewXlsxReserves} from './src/domain/reserves/xlsx-preview.ts';
import {createEmailSession} from './auth-session.js?rev=auth-scopes-v18';
import {audit,applyEntry,applyLoan,applyLoanPayment,applySettlement} from './ledger-operations.js';
import {createScreenRoot,createOfflineSyncRoot} from './src/react/ScreenRoot.tsx';
import {applyGuestBudgetCommand} from './src/domain/budgets/guest.mjs';
import {readOfflineActor,forgetOfflineActor} from './src/cloud/offline-access-hint.mjs';
import {projectOverviewCategories,projectOverviewLoan} from './src/react/OverviewModels.tsx';
import {projectObligationRows} from './src/react/ObligationsModels.tsx';
import {buildInAppReminders,readReminderSettings} from './src/domain/cashflow/in-app-reminders.ts';
import {createAppShellRoots} from './src/react/AppShell.tsx';
import {createAuxiliaryDialogRoots} from './src/react/AuxiliaryDialogs.tsx';
import {createFinanceFormRoots} from './src/react/FinanceForms.tsx';
import {createCategoryDialogController} from './src/react/CategoryDialog.tsx';
import {createConfirmationDialogController} from './src/react/ConfirmationDialog.tsx';
import {sameFinancialJSON} from './src/security/protected-staging.ts';
import {addGuestBankAccount,commitGuestBankBatch,undoGuestBankBatch} from './src/importers/bank-statements/guest-ledger.js';
import {prepareLivePersonalImportCandidate,preparePersonalMergeReviewCandidate,executeConfirmedPersonalImportCandidate} from './src/cloud/personal-import-transport-candidate.mjs';
import {verifySavedFinancialBackupReadOnly} from './src/cloud/read-only-backup-verification.mjs';

const $=sel=>document.querySelector(sel);
const svg=name=>`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ico-${name}"></use></svg>`;
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatDate=date=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric'}).format(new Date(`${date}T12:00:00`));
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const uuid=()=>crypto.randomUUID();
const titles={overview:'Обзор',calendar:'Календарь',obligations:'Обязательства',loans:'Кредиты',budgets:'Бюджеты',settings:'Настройки','accounts-connected':'Счета и кошельки','bank-import':'Импорт выписки'};
// Only an explicit reviewed release can present the optional server-backed accounts view.
// FastAPI authentication and profile scoping remain the sole authorization boundary.
const financeAccountsEnabled=document.querySelector('meta[name="fh-finance-accounts"]')?.content==='enabled';
const financeSyncEnabled=financeAccountsEnabled&&document.querySelector('meta[name="fh-finance-sync"]')?.content==='enabled';
const financeBudgetsEnabled=financeSyncEnabled&&document.querySelector('meta[name="fh-finance-budgets"]')?.content==='enabled';
const financeImportEnabled=financeAccountsEnabled&&document.querySelector('meta[name="fh-finance-import"]')?.content==='enabled';
// #38 signed bank import needs an independently approved production backend.
const bankImportEnabled=financeAccountsEnabled&&document.querySelector('meta[name="fh-finance-bank-import"]')?.content==='enabled';
const financeReservesEnabled=financeAccountsEnabled&&document.querySelector('meta[name="fh-finance-reserves"]')?.content==='enabled';
let state=null,ui={view:'overview',month:monthKey(today()),selectedDate:today(),filter:'all',selectedLoan:null,expandedEntry:null,obligationsSection:'payments',paymentSource:'local',calendarSource:'local',overviewSource:'local',focusReserveId:null,reserveSuggestions:[]},passwordMode='export',restoreFile=null,verifyBackupFile=null,cloudImportFile=null,pendingCloudImport=null,cloudImportController=null,cloudImportBusy=false,scheduleLoanId=null,channel=null,toastTimer=null,busy=false,installPrompt=null,pendingExcelImport=null;
const emailSession=createEmailSession();
let guestMode=false,activeUserId=null,authBroadcast=null,sessionValidation=null,lastDialogActivator=null;
let cloudImportSourceKind='account';
const GUEST_MODE_KEY='fh-guest-session-v2';
let screenRoot=null;
let backgroundSyncRoot=null,backgroundSyncHost=null,accountScreenVersion=0;
let navRoots=null;
let auxiliaryDialogRoots=null;
let financeFormRoots=null;
let categoryDialogController=null;
let confirmationController=null;
function getAuthAccess(){
 if(guestMode)return {kind:'guest'};
 return {kind:'account',accountId:activeUserId||'',verifiedUserId:emailSession.userId||null,sessionValid:Boolean(emailSession.userId)};
}
let storageStatusMessage='Браузер может удалить данные при очистке хранилища. Делайте резервные копии.';
let storageStatusRequest=0;
let lastStorageContext=null;
let offlineSyncView=false,lastSyncContext=false;
function revokeDisplayedLedger(){
 revokeStateScope(); // invalidate pending IDB reads/writes before clearing the UI
 state=null;
 offlineSyncView=false;

 if(typeof ui!=='undefined'){
  ui.reserveSuggestions=[];ui.focusReserveId=null;ui.obligationsSection='payments';
 }
 restoreFile=null;verifyBackupFile=null;cloudImportFile=null;pendingCloudImport=null;cloudImportController?.abort();cloudImportController=null;pendingExcelImport=null;scheduleLoanId=null;lastDialogActivator=null;
 if(screenRoot){screenRoot.unmount();screenRoot=null;}
 if(backgroundSyncRoot){backgroundSyncRoot.unmount();backgroundSyncRoot=null;}
 if(backgroundSyncHost){backgroundSyncHost.remove();backgroundSyncHost=null;}
 if($('#main'))$('#main').style.display='';
 if(navRoots){navRoots.unmount();navRoots=null;}
 if(typeof auxiliaryDialogRoots!=='undefined'&&auxiliaryDialogRoots){auxiliaryDialogRoots.dispose();auxiliaryDialogRoots=null;}
 if(typeof financeFormRoots!=='undefined'&&financeFormRoots){financeFormRoots.dispose();financeFormRoots=null;}
 if(typeof categoryDialogController!=='undefined'&&categoryDialogController){categoryDialogController.dispose();categoryDialogController=null;}
 if(typeof confirmationController!=='undefined'&&confirmationController){confirmationController.dispose();confirmationController=null;}
 $('#main').replaceChildren();
 // Modal forms and previews live OUTSIDE #main; reset alone can retain
 // programmatically inserted finance titles, choices and payment schedules.
 // Every caller immediately redirects to the account page.
 for(const dialog of document.querySelectorAll('dialog')){
  if(dialog.open)dialog.close();
  dialog.replaceChildren();
 }
}
function startOfflineSync(actor){
 // The hint merely chooses an encrypted vault; it is never a live auth session.
 // If cross-tab revocation cannot be observed, do not expose the local vault.
 authBroadcast=new BroadcastChannel('fh-auth-session-v2');
 authBroadcast.onmessage=event=>{
  if(event.data?.type==='session-changed'||(event.data?.type==='logout'&&event.data.userId===actor)){
   forgetOfflineActor(actor);
   revokeDisplayedLedger();
   window.location.replace('./account.html');
  }
 };
 for(const selector of ['.sidebar','.toolbar','.footer','.bottom-nav']){
  const element=$(selector);if(element)element.style.display='none';
 }
 const main=$('#main');main.replaceChildren();
 screenRoot=createOfflineSyncRoot(main,actor,()=>window.location.replace('./account.html'),true,undefined,financeBudgetsEnabled);
}
function openBackgroundSync(budgetMode=false){
 if(!financeSyncEnabled||guestMode||!activeUserId||emailSession.userId!==activeUserId)return;
 if(!backgroundSyncRoot){
  const main=$('#main');
  backgroundSyncHost=document.createElement('main');
  backgroundSyncHost.className='page';backgroundSyncHost.id='offline-sync-main';
  main.insertAdjacentElement('afterend',backgroundSyncHost);
  const actor=activeUserId;
  backgroundSyncRoot=createOfflineSyncRoot(backgroundSyncHost,actor,()=>navigation('overview'),false,()=>{
   forgetOfflineActor(actor);revokeDisplayedLedger();window.location.replace('./account.html');
  });
 }
 backgroundSyncRoot.setBudgetMode(budgetMode===true);
 $('#main').style.display='none';backgroundSyncHost.style.display='';
 offlineSyncView=true;syncStorageContext();syncAccountControls();
}
function hideBackgroundSync(){
 if(backgroundSyncHost)backgroundSyncHost.style.display='none';
 const main=$('#main');if(main)main.style.display='';
 offlineSyncView=false;
}
const hasData=()=>state.entries.some(isActive)||state.loans.some(isActive);
const monthEvents=()=>getMonthEvents(state,ui.month);
// Read-only: reuse the same monthly event oracle as Calendar, including confirmed
// settlements and loan payments. Do not create a duplicate payment ledger.
function currentPaymentReminders(currentDate){
 const payments=getReminderMonthEvents(state,monthKey(currentDate));
 return buildInAppReminders({
  scopeKey:guestMode?'guest-state-v2':'account-state-v2:'+activeUserId,
  currentDate,settings:readReminderSettings(state.settings?.paymentReminders),
  payments,maxAlerts:100,
 });
}
function toast(message,kind='success'){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3800);$('#save-indicator').textContent=kind==='error'?'Ошибка':'Сохранено на устройстве';}
function fail(error){console.error(error);toast(error?.message||'Не удалось выполнить действие','error');}
async function mutate(change,msg='Сохранено на устройстве',expectedRevision=state?.revision){
 if(busy)return;busy=true;$('#save-indicator').textContent='Сохранение…';
 try{state=await updateState(s=>change(s),{expectedRevision});channel?.postMessage('updated');render();toast(msg);}catch(e){fail(e);throw e;}finally{busy=false;}
}
function stampFormRevision(form){form.dataset.stateRevision=String(state.revision);}
function revisionForForm(form){const revision=Number(form.dataset.stateRevision);if(!Number.isSafeInteger(revision)||revision<0)throw Error('Не удалось определить версию записи. Откройте форму повторно.');return revision;}
function themeSet(mode){document.documentElement.dataset.theme=mode;document.body.dataset.theme=mode;try{localStorage.setItem('fh-theme',mode);}catch{};$('#theme-color').content=mode==='dark'?'#172336':'#ffffff';if(!navRoots){const toggle=$('#theme-toggle');if(toggle){toggle.innerHTML=svg(mode==='dark'?'sun':'moon');toggle.setAttribute('aria-label',mode==='dark'?'Включить светлую тему':'Включить тёмную тему');}}}
function syncStorageContext(){
 const eligible=financeAccountsEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId;
 const serverPayments=eligible&&ui.view==='obligations'&&ui.obligationsSection==='due'&&ui.paymentSource==='server';
 const serverCalendar=eligible&&ui.view==='calendar'&&ui.calendarSource==='server';
 const serverOverview=eligible&&ui.view==='overview'&&ui.overviewSource==='server';
 const serverAccounts=eligible&&((ui.view==='accounts-connected'||ui.view==='bank-import'||ui.view==='budgets')||serverPayments||serverCalendar||serverOverview);
 const syncView=serverAccounts&&(ui.view==='accounts-connected'||ui.view==='budgets')&&offlineSyncView;
 const labels=[
  ['storage-context-chip',syncView?'Локальная копия':serverAccounts?'На сервере':'Локально'],
  ['storage-context-title',syncView?'Офлайн-синхронизация':serverOverview?'Обзор аккаунта':serverCalendar?'Календарь аккаунта':serverPayments?'Оплаты в аккаунте':serverAccounts?'Счета в аккаунте':'Хранится на устройстве'],
  ['storage-context-detail',syncView?'Подтверждённый снимок и очередь':serverAccounts?'Локальный бюджет отдельно':'Без банковских подключений'],
  ['storage-context-footnote',syncView?'Снимок и ожидающие операции хранятся на устройстве в зашифрованном виде.':serverOverview||serverCalendar||serverPayments?'Данные хранятся в аккаунте. Локальные записи остаются в этом браузере.':serverAccounts?'Счета хранятся на сервере. Локальная бухгалтерия остаётся в этом браузере.':'Данные остаются в этом браузере. Делайте резервные копии.'],
 ];
 for(const [id,value] of labels){
  const element=document.getElementById(id);
  if(element&&(!navRoots||id!=='storage-context-chip'))element.textContent=value;
 }
 // The global Add action edits the local planner, not a server account.
 // Accounts has its own explicit "Новый счёт" button.
 const globalAdd=$('#top-add');
 if(!navRoots&&globalAdd)globalAdd.hidden=serverAccounts;
 if(lastStorageContext!==serverAccounts||lastSyncContext!==syncView){
  $('#save-indicator').textContent=syncView?'Зашифрованная локальная копия':serverAccounts?'Серверный раздел':'Локальная база готова';
  lastStorageContext=serverAccounts;
  lastSyncContext=syncView;
 }
}
function navigation(view){
 if(view==='budgets'&&(!financeBudgetsEnabled||(!guestMode&&(!activeUserId||emailSession.userId!==activeUserId))))return;
 if(view==='accounts-connected'&&(!financeAccountsEnabled||guestMode||!activeUserId||emailSession.userId!==activeUserId))return;
 if(view==='bank-import'&&!guestMode&&(!bankImportEnabled||!activeUserId||emailSession.userId!==activeUserId))return;
 hideBackgroundSync();
 if(view==='accounts-connected')accountScreenVersion++;
 if(view==='calendar'&&ui.view!=='calendar')ui.calendarSource=financeReservesEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId?'server':'local';
 if(view==='overview'&&ui.view!=='overview')ui.overviewSource=financeReservesEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId?'server':'local';
 ui.view=view;$('.sidebar')?.classList.remove('open');window.scrollTo({top:0,behavior:'instant'});render();if(view==='settings'){void renderStorageStatus();if(!guestMode)void refreshEmailSession();}}
function render(){
 if(!state)return;
 syncStorageContext();
 const main=$('#main');
 if(ui.view==='budgets'){
  if(!guestMode){openBackgroundSync(true);return;}
  if(!screenRoot){main.replaceChildren();screenRoot=createScreenRoot(main,getAuthAccess);}
  const revision=state.revision;
  screenRoot.render({view:'budgets',props:{mode:'guest',guestState:state,writable:true,pending:false,
   onCommand:async(action,payload,versions)=>{
    if(!guestMode||busy)throw Error('Локальная база недоступна');
    await mutate(s=>applyGuestBudgetCommand(s,action,payload,versions,revision),'Бюджет сохранён',revision);
   }}});
  syncAccountControls();return;
 }
 if(ui.view==='calendar'||ui.view==='overview'||ui.view==='obligations'||ui.view==='loans'||ui.view==='settings'||ui.view==='accounts-connected'||ui.view==='bank-import'){
  if(!screenRoot){main.replaceChildren();screenRoot=createScreenRoot(main,getAuthAccess);}
  if(ui.view==='accounts-connected'){
   screenRoot.render({view:'accounts-connected',props:{verifiedActorUserId:emailSession.userId||null,syncEnabled:financeSyncEnabled,onOpenSync:openBackgroundSync,refreshVersion:accountScreenVersion,onBack:()=>navigation('overview')}});
  }else if(ui.view==='bank-import'){
   screenRoot.render({view:'bank-import',props:{
    mode:guestMode?'guest':'account',
    verifiedActorUserId:guestMode?null:(emailSession.userId===activeUserId?emailSession.userId:null),
    guestLedger:guestMode?state.bankStatements||null:null,
    guestRevision:state.revision,
    onBack:()=>navigation(guestMode?'settings':'accounts-connected'),
    onOpenAccounts:()=>navigation('accounts-connected'),
    onGuestAddAccount:async(name,openingMinor,revision)=>{
     if(!guestMode)throw Error('Локальная запись разрешена только гостю');
     await mutate(s=>addGuestBankAccount(s,{id:uuid(),name,openingMinor},revision),
      'Банковский счёт создан локально',revision);
    },
    onGuestCommit:async(plan,digest,revision)=>{
     if(!guestMode)throw Error('Неверный финансовый профиль');
     await mutate(s=>commitGuestBankBatch(s,plan,digest,revision),
      'Банковская партия сохранена локально',revision);
    },
    onGuestUndo:async(key,revision)=>{
     if(!guestMode)throw Error('Неверный финансовый профиль');
     await mutate(s=>undoGuestBankBatch(s,key,revision),
      'Партия отменена локально',revision);
    },
   }});
  }else if(ui.view==='calendar'){
   const events=monthEvents(),totals=monthTotals(events,state,ui.month);
   screenRoot.render({view:'calendar',props:{events,month:ui.month,selectedDate:ui.selectedDate,currentDate:today(),monthTitle:monthLabel(ui.month),netPlanCents:totals.netPlanCents,netFactCents:totals.netFactCents,formatDate,rubles,financeEnabled:financeReservesEnabled&&!guestMode&&emailSession.userId===activeUserId,verifiedActorUserId:emailSession.userId||null,onSourceChange:source=>{ui.calendarSource=source;syncStorageContext();syncAccountControls();}}});
  }else if(ui.view==='overview'){
   const currentDate=today(),events=monthEvents(),totals=monthTotals(events);
   const upcoming=events.filter(event=>event.date>=currentDate).slice(0,4);
   const categories=projectOverviewCategories(events);
   const loan=state.loans.find(isActive)||null;
   const snapshot=loan?loanLedger(loan,state.loanPayments):null;
   const loanSummary=projectOverviewLoan(loan,snapshot);
   screenRoot.render({view:'overview',props:{currentDate,month:ui.month,monthTitle:monthLabel(ui.month),hasData:hasData(),totals,categories,upcoming,loan:loanSummary,rubles,formatDate,financeEnabled:financeReservesEnabled&&!guestMode&&emailSession.userId===activeUserId,verifiedActorUserId:emailSession.userId||null,onSourceChange:source=>{ui.overviewSource=source;syncStorageContext();syncAccountControls();}}});
  }else if(ui.view==='obligations'){
   const rows=projectObligationRows(state.entries,state.settlements,ui.month,ui.filter,dayInMonth);
   const totals=monthTotals(monthEvents()),currentDate=today();
   let reminderResult=null,reminderError=null;
   try{reminderResult=currentPaymentReminders(currentDate);}
   catch(error){reminderError=['История обязательств слишком велика для расчёта напоминаний',
    'Слишком много экземпляров для расчёта напоминаний'].includes(error?.message)?error.message:
    'Не удалось рассчитать напоминания из сохранённых платежей.';}
   const reminderSettings=readReminderSettings(state.settings?.paymentReminders);
   const paymentMethods=Object.fromEntries(state.entries.filter(isActive)
    .map(entry=>[entry.id,entry.paymentMethods||[]]));
   screenRoot.render({view:'obligations',props:{rows,month:ui.month,monthTitle:monthLabel(ui.month),
    filter:ui.filter,expandedEntry:ui.expandedEntry,currentDate,
    expenseCents:totals.expenseCents,expensePaidCents:totals.expensePaidCents,rubles,formatDate,
    financeEnabled:financeReservesEnabled&&!guestMode&&emailSession.userId===activeUserId,
    verifiedActorUserId:emailSession.userId||null,reserveSection:ui.obligationsSection,
    reminderResult,reminderError,reminderSettings,paymentMethods,
    reminderScopeKey:guestMode?'guest-state-v2':'account-state-v2:'+activeUserId,
    onReminderSettingsChange:async next=>{
     await mutate(s=>{
      s.settings.paymentReminders={enabled:next.enabled,daysBefore:[...next.daysBefore]};
      audit(s,'reminder-settings','Изменены локальные настройки напоминаний');
     },'Настройки напоминаний сохранены');
    },
    focusReserveId:ui.focusReserveId,importSuggestions:ui.reserveSuggestions,
    onPaymentSourceChange:source=>{ui.paymentSource=source;syncStorageContext();syncAccountControls();},
    onReserveSectionChange:next=>{
     ui.obligationsSection=next;ui.paymentSource=next==='due'&&financeReservesEnabled&&!guestMode&&emailSession.userId===activeUserId?'server':'local';ui.focusReserveId=null;render();
    }}});
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
    showBankStatementImport:guestMode||(bankImportEnabled&&Boolean(activeUserId)&&emailSession.userId===activeUserId),
   }});
  }
 }else{
  if(screenRoot){screenRoot.unmount();screenRoot=null;}
  main.textContent='Неизвестный раздел';
 }
 syncAccountControls();
}
function syncAccountControls(){
 if(!state)return;
 const signedIn=Boolean(emailSession.userId);
 if(!navRoots)navRoots=createAppShellRoots($('.sidebar-nav'),$('.bottom-nav'),$('.toolbar'));
 navRoots.render(ui.view==='accounts-connected'||ui.view==='bank-import'?'settings':ui.view,{
  title:titles[ui.view],theme:document.body.dataset.theme==='dark'?'dark':'light',
  signedIn,busy:Boolean(emailSession.busy),
  serverAccounts:lastStorageContext===true,
  localSnapshot:lastSyncContext,
  budgetsEnabled:financeBudgetsEnabled&&(guestMode||Boolean(activeUserId)&&emailSession.userId===activeUserId),
  hideGlobalAdd:ui.view==='budgets',
 });
}
async function refreshEmailSession(){
 if(guestMode||!activeUserId||emailSession.busy)return true;
 if(emailSession.userId!==activeUserId){
  forgetOfflineActor(activeUserId);
  revokeDisplayedLedger();
  window.location.replace('./account.html');
  return false;
 }
 // A known offline transition cannot establish whether the session was
 // revoked. Keep the already-open view, but do not authorize new online work.
 if(globalThis.navigator?.onLine===false)return false;
 // Focus, visibility and Settings can request validation together. A single
 // in-flight check avoids a stale response falsely signing out a valid session.
 if(sessionValidation)return sessionValidation;
 const pending=(async()=>{
  const verified=await emailSession.refresh();
  if(!verified||emailSession.userId!==activeUserId){
   // The connection may have dropped while the request was in flight. An
   // actual HTTP rejection still revokes immediately, even during a drop.
   if(!verified&&emailSession.userId===activeUserId&&['network','unavailable'].includes(emailSession.lastRefreshFailure))return false;
   forgetOfflineActor(activeUserId);
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
   forgetOfflineActor(activeUserId);
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
 await new Promise((resolve,reject)=>{
  const img=new Image();
  img.onload=()=>{
   if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth>4096||img.naturalHeight>4096)
    reject(Error('Недопустимые размеры QR-изображения'));
   else resolve();
  };
  img.onerror=()=>reject(Error('QR-изображение повреждено'));
  img.src=data;
 });
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
 form.elements.date.value=existing?.date||today();
 form.dataset.paymentId=paymentId||'';
 $('#settlement-heading').textContent=existing?'Изменить фактическую сумму':'Отметить фактическую сумму';
 $('#settlement-description').textContent=`${entry.title}. План: ${rubles(entry.amountCents)}. Уже внесено: ${rubles(paid)}. Осталось: ${rubles(Math.max(0,entry.amountCents-paid))}. Можно внести часть суммы.`;
 openDialog('#settlement-dialog');
}
function requireConfirm(title,text){
 if(!confirmationController){
  const dialog=$('#confirmation-dialog');
  if(!dialog)throw Error('Диалог подтверждения недоступен');
  confirmationController=createConfirmationDialogController(dialog);
 }
 return confirmationController.confirm(title,text);
}
async function handleAction(button){
 const type=button.dataset.action,id=button.dataset.id;
 if(type==='account-logout'){await logoutEmailAccount();return;}
 if(type==='new-entry'){openEntry(null,button.dataset.kind||'expense');return;}
 if(type==='copy-payment-requisites'){
  const entry=state.entries.find(row=>row.id===id&&isActive(row));
  const method=entry?.paymentMethods?.find(row=>row.id===button.dataset.methodId);
  if(!method||method.type!=='requisites'||typeof method.value!=='string')
   throw Error('Реквизиты недоступны');
  if(!navigator.clipboard?.writeText)throw Error('Буфер обмена недоступен в этом браузере');
  await navigator.clipboard.writeText(method.value);
  toast('Реквизиты скопированы, оплата ещё не подтверждена');
  return;
 }
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
 if(type==='open-server-payments'){if(financeReservesEnabled&&!guestMode&&emailSession.userId===activeUserId){ui.obligationsSection='due';ui.paymentSource='server';navigation('obligations');}return;}
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
 if(type==='cloud-import'||type==='cloud-import-guest'){
  if(!financeImportEnabled||guestMode||!activeUserId||emailSession.userId!==activeUserId)throw Error('Перенос доступен только своему FH-аккаунту');
  if(cloudImportBusy||busy)throw Error('Дождитесь завершения текущей проверки');
  cloudImportSourceKind=type==='cloud-import-guest'?'guest':'account';
  pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-file').value='';$('#cloud-import-file').click();return;
 }
 if(type==='cancel-cloud-import'){
  cloudImportController?.abort();pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-guest-consent').checked=false;$('#cloud-import-guest-row').hidden=true;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
  $('#cloud-import-dialog').close();return;
 }
 if(type==='prepare-cloud-merge'){await prepareCloudMergeReview();return;}
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
  ui.reserveSuggestions=data.reservePreviews.filter(preview=>preview.status==='suggestion');
  $('#excel-import-dialog').close();pendingExcelImport=null;ui.view='overview';render();
  if(ui.reserveSuggestions.length){
   toast('Импорт завершён. Найдены предложения по накоплениям ('+ui.reserveSuggestions.length+'). Откройте раздел «Накопления» для ручного подтверждения.');
  }
  return;
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
 if(type==='edit-category'){
  const cat=button.dataset.category;
  if(!categoryDialogController)categoryDialogController=createCategoryDialogController($('#category-dialog'));
  categoryDialogController.render();
  const form=$('#rename-category-form');form.elements.old.value=cat;form.elements.newName.value=cat;
  openDialog('#category-dialog');return;
 }
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
 let reservePreviews=[];
 let reserveHintWarning=null;
 try{
  reservePreviews=previewXlsxReserves(data.rows,diff.entries.map(entry=>({
   source:entry.source,title:entry.title,kind:entry.kind,amountCents:entry.amountCents
  })));
 }catch{
  // Suggestions are optional. Invalid spreadsheet metadata MUST NOT block
  // the existing expense import or silently reinterpret its recurrence.
  reserveHintWarning='Не удалось однозначно распознать накопления. Стандартный импорт сохранён без изменений.';
 }
 pendingExcelImport={parsed,name:file.name.slice(0,120),reservePreviews};
 const summary=$('#excel-import-summary'),items=$('#excel-import-items'),warnings=$('#excel-import-warnings');
 summary.replaceChildren();items.replaceChildren();warnings.replaceChildren();
 const paragraph=document.createElement('p');
 paragraph.textContent='Лист «'+data.sheetName+'». Добавятся: '+diff.entries.length+' доходов и расходов, '+diff.loans.length+' кредитов. Пропущено повторов: '+diff.duplicates+'.';
 summary.append(paragraph);
 const totals=document.createElement('p');
 totals.textContent='Плановые доходы: '+rubles(diff.incomeCents)+'. Плановые расходы: '+rubles(diff.expenseCents)+' (без обязательных платежей по кредитам).';
 summary.append(totals);
 if(reserveHintWarning){
  const warning=document.createElement('p');warning.className='small-hint';
  warning.textContent=reserveHintWarning;summary.append(warning);
 }
 if(reservePreviews.length){
  const notice=document.createElement('p');notice.className='small-hint';
  const suggested=reservePreviews.filter(preview=>preview.status==='suggestion').length;
  const invalid=reservePreviews.length-suggested;
  notice.textContent='Периодические расходы в XLSX: '+suggested+' возможных накоплений'+
   (invalid?' · '+invalid+' неоднозначных подсказок требуют проверки':'')+
   '. Предложения не создаются автоматически. После локального импорта нужно отдельно подтвердить резерв, счёт и обработку прежнего расхода.';
  summary.append(notice);
 }
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
 const assertCurrentScope=captureStateScope();
 const source=await readState();assertCurrentScope();
 const file=await encryptBackup(source,password);assertCurrentScope();
 const url=URL.createObjectURL(new Blob([file],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`finansovyi-gorizont-${today()}-encrypted.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),12000);toast('Шифрованная резервная копия подготовлена');
}
async function performVerifyBackup(password){
 if(!verifyBackupFile)throw Error('Выберите сохранённый зашифрованный файл');
 const assertCurrentScope=captureStateScope(),file=verifyBackupFile;
 const actor=activeUserId,wasGuest=guestMode;
 const original=await readState();
 assertCurrentScope();
 if(actor!==activeUserId||wasGuest!==guestMode||!state)
  throw Error('Сессия сменилась во время проверки копии');
 const backupText=await file.text();assertCurrentScope();
 const result=await verifySavedFinancialBackupReadOnly({
  backupText,password,currentSnapshot:original,
 });
 assertCurrentScope();
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
 const assertCurrentScope=captureStateScope(),file=restoreFile;
 if(!file)throw Error('Выберите сохранённую резервную копию');
 const originalRevision=state?.revision;
 const backupText=await file.text();assertCurrentScope();
 const decrypted=await decryptBackup(backupText,password);assertCurrentScope();
 const confirmed=await requireConfirm('Заменить локальные данные?', 'Импорт заменит всю текущую бухгалтерию данными из резервной копии. При необходимости сохраните текущую копию перед продолжением.');
 assertCurrentScope();
 if(!confirmed)return;
 await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,structuredClone(decrypted));audit(s,'restore-backup','Восстановлена резервная копия');},'Данные восстановлены',originalRevision);
}

// Owner-only, dormant by default. Preview NEVER posts financial data.
async function prepareCloudImport(password){
 if(cloudImportBusy||busy||!financeImportEnabled||guestMode||!cloudImportFile)
  throw Error('Перенос недоступен или уже выполняется');
 const actor=activeUserId,sourceKind=cloudImportSourceKind;
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
   signal:controller.signal,explicitConsent:true,sourceKind,
   explicitGuestTransfer:sourceKind==='guest',
  });
  if(controller.signal.aborted||guestMode||activeUserId!==actor||emailSession.userId!==actor)
   throw Error('Сессия изменилась во время проверки импорта');
  pendingCloudImport=prepared;
  if(prepared.bankComparison){
   if(prepared.preview.bankTransfer)renderCloudImportComparison(prepared);
   renderCloudBankHistory(prepared,Boolean(prepared.preview.bankTransfer));
   $('#cloud-import-heading').textContent='Сравнение банковской истории';
   $('#cloud-import-summary').textContent='Просмотр без записи: счетов '+prepared.bankComparison.sourceAccounts.length+
    ', операций '+prepared.bankComparison.operations.length+'. Совпадения требуют ручной проверки. '+
    (prepared.preview.bankTransfer?'Выберите действие для каждой записи, счёта и операции. Исходные данные сохранены.':
     'Перенос банковской истории ещё не доступен; исходные данные сохранены.');
   $('#cloud-import-final-consent').closest('label').hidden=true;
   $('#cloud-import-dialog [data-action="prepare-cloud-merge"]').hidden=!prepared.preview.bankTransfer;
   $('#cloud-import-preserve-row').hidden=true;$('#cloud-import-guest-row').hidden=!prepared.guestSource;
   $('#cloud-import-guest-consent').checked=false;
   cloudImportFile=null;return;
  }
  renderCloudImportComparison(prepared);
  const count=prepared.preview.counts;
  $('#cloud-import-heading').textContent=prepared.serverCounts ?
   'Проверка профилей' : 'Подтвердить перенос';
  $('#cloud-import-final-consent').closest('label').hidden=Boolean(prepared.serverCounts);
  $('#cloud-import-dialog [data-action="prepare-cloud-merge"]').hidden=!prepared.serverCounts;
  $('#cloud-import-summary').textContent=
   (prepared.guestSource ? 'Гостевая копия: ' : (prepared.serverCounts ? 'Локальная копия: ' : 'Готово к переносу: '))+
   count.entries+' обязательств, '+count.loans+' кредитов, '+
   count.settlements+' фактических оплат и '+count.loanPayments+' платежей по кредитам. '+
   'Серверная ревизия: '+prepared.revision+'. Пока ничего не загружено.'+
   (prepared.serverCounts ? ' На сервере: счетов '+prepared.serverCounts.account+
    ', обязательств '+prepared.serverCounts.obligation+', кредитов '+prepared.serverCounts.loan+
    ', резервов '+prepared.serverCounts.reserve+', операций '+prepared.serverCounts.transaction+
    ', фактических оплат '+prepared.serverCounts.settlement+
    ', платежей по кредитам '+prepared.serverCounts.loan_payment+
    '. Возможных совпадений: '+prepared.comparison.candidatePairs+
    '. Сходство не доказывает дубль. Выберите действие для каждой записи; данные пока не изменены.' : '')+
   (prepared.preservedZeroAccountId ? ' Существующий счёт «'+
    prepared.preservedZeroAccountName+'» с нулевым остатком останется на сервере без изменений.' : '');
  $('#cloud-import-preserve-row').hidden=!prepared.preservedZeroAccountId;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-guest-row').hidden=!prepared.guestSource;
  $('#cloud-import-guest-consent').checked=false;
  $('#cloud-import-final-consent').checked=false;
  // Never retain the original encrypted file or password in global state.
  cloudImportFile=null;
 }catch(error){
  pendingCloudImport=null;cloudImportFile=null;controller.abort();
  throw error;
 }finally{cloudImportBusy=false;}
}
function renderCloudBankHistory(prepared,editable=false){
 const root=$('#cloud-import-comparison');if(!editable)root.replaceChildren();
 const ledger=prepared.snapshot.bankStatements,entities=new Map(prepared.serverEntities.map(row=>[row.id,row]));
 const bankRows=new Map(prepared.bankHistory.rows.map(row=>[row.transaction_id,row]));
 const accounts=new Map(ledger.accounts.map(row=>[row.id,row]));
 const serverNumbers=new Map();
 for(const kind of ['account','transaction'])prepared.serverEntities.filter(x=>x.kind===kind).map(x=>x.id).sort()
  .forEach((id,index)=>serverNumbers.set(id,index+1));
 const kind=value=>({income:'доход',expense:'расход',transfer:'перевод'}[value]||'операция');
 const add=(title,lines,control)=>{
  const group=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');
  summary.textContent=title;for(const [index,text] of lines.entries()){
   const item=document.createElement('li');item.textContent=text;
   if(control)item.append(control(index));list.append(item);
  }
  group.append(summary,list);root.append(group);
 };
 add('Локальные счета и текущие остатки',prepared.bankComparison.sourceAccounts.map((row,index)=>{
  const source=accounts.get(row.sourceId),matches=row.candidateIds.map(id=>entities.get(id)?.data?.name||'Счёт');
  return `Счёт №${index+1}: ${source.name} · начальный ${rubles(row.openingMinor)} · остаток ${rubles(row.balanceMinor)} · `+
   (matches.length?'Возможные серверные счета: '+matches.join(', '):'Похожих серверных счетов не найдено');
 }),editable?index=>{
  const row=prepared.bankComparison.sourceAccounts[index],source=accounts.get(row.sourceId);
  const select=document.createElement('select');select.dataset.bankAccount=row.sourceId;
  select.setAttribute('aria-label','Действие для счёта '+source.name);
  const option=(value,label)=>{const el=document.createElement('option');el.value=value;el.textContent=label;select.append(el);};
  option('','Выберите действие');
  for(const [type,label] of [['bank','банк'],['card','карта'],['cash','наличные'],['savings','накопительный'],['other','другой']])
   option('add:'+type,'Добавить: '+label);
  for(const id of row.candidateIds){
   const target=entities.get(id)?.data;
   if(target?.name===source.name&&target.opening_minor===source.openingMinor&&target.archived_at==null)
    option('link:'+id,'Связать с серверным счётом №'+serverNumbers.get(id)+' '+target.name+' · остаток '+rubles(target.balance_minor));
  }
  return select;
 }:null);
 const localOperations=new Map(ledger.operations.map(row=>[row.sourceKey,row]));
 let similarCount=0;
 add('Локальные банковские операции',prepared.bankComparison.operations.map((row,index)=>{
  const source=localOperations.get(row.sourceKey),target=accounts.get(source.targetAccountId);
  const matches=row.candidateIds.map(id=>bankRows.get(id)).filter(Boolean);
  const similar=editable?bankReviewMatches(prepared,source,null,null):[];
  similarCount+=similar.length;
  if(similar.length>100||similarCount>10000)throw Error('Слишком много похожих операций для безопасного просмотра');
  return `Операция №${index+1}: ${source.date} · ${source.description||'Без описания'} · ${kind(source.kind)} · ${rubles(source.amountCents)} · категория ${source.category||'нет'} · `+
   `${accounts.get(source.accountId)?.name||'Счёт'}${target?' → '+target.name:''} · `+
   `${row.status==='cancelled'?'отменена':'действует'} · `+
   (row.identityConflict?'конфликт идентичности; требуется проверка':`возможных банковских совпадений: ${matches.length}`)+
   (similar.length?' · Похожие серверные движения: '+similar.map(item=>
    `№${serverNumbers.get(item.id)} ${item.data.occurred_on} ${item.data.note||'без описания'} (${item.data.kind}; `+
    item.data.postings.map(p=>`счёт №${serverNumbers.get(p.account_id)} ${entities.get(p.account_id)?.data?.name||'Счёт'} ${rubles(p.signed_minor)}`).join(', ')+')').join('; '):'');
 }),editable?index=>{
  const row=prepared.bankComparison.operations[index],source=localOperations.get(row.sourceKey);
  const select=document.createElement('select');select.dataset.bankOperation=row.sourceKey;
  select.setAttribute('aria-label','Действие для операции '+(source.description||source.date));
  const option=(value,label)=>{const el=document.createElement('option');el.value=value;el.textContent=label;select.append(el);};
  option('','Выберите действие');option('add','Добавить отдельную операцию');
  if(!row.identityConflict)for(const id of row.candidateIds){
   const target=bankRows.get(id);if(target)option('link:'+id,'Связать с операцией №'+serverNumbers.get(id)+': '+target.occurred_on+' · '+
    (target.description||'Без описания')+' · '+rubles(target.amount_minor)+' · '+
    (entities.get(target.account_id)?.data?.name||'Счёт'));
  }
  return select;
 }:null);
 add('Серверная банковская история',prepared.bankHistory.rows.map(row=>
  `Операция №${serverNumbers.get(row.transaction_id)}: ${row.occurred_on} · ${row.description||'Без описания'} · ${kind(row.kind)} · ${rubles(row.amount_minor)} · категория ${row.category||'нет'} · `+
  `счёт №${serverNumbers.get(row.account_id)} ${entities.get(row.account_id)?.data?.name||'Счёт'}${row.target_account_id?' → счёт №'+serverNumbers.get(row.target_account_id)+' '+(entities.get(row.target_account_id)?.data?.name||'Счёт'):''} · ${prepared.bankComparison.serverStatuses[row.transaction_id]==='cancelled'?'отменена':'сохранена'}`));
}
function bankReviewMatches(prepared,source,accountId,targetId){
 const transactions=prepared.serverEntities.filter(x=>x.kind==='transaction');
 const reversed=new Set(transactions.map(x=>x.data.reversed_transaction_id).filter(Boolean));
 const signed=source.kind==='income'?source.amountCents:-source.amountCents;
 return transactions.filter(item=>{
  const d=item.data;
  if(d.kind==='reversal'||reversed.has(item.id)||d.occurred_on!==source.date||!Array.isArray(d.postings))return false;
  if(!d.postings.some(p=>(!accountId||p.account_id===accountId)&&p.signed_minor===signed))return false;
  if(source.kind==='transfer')return d.kind==='transfer'&&(!targetId||
   d.postings.some(p=>p.account_id===targetId&&p.signed_minor===source.amountCents));
  return true;
 });
}
function previewBankBalances(prepared,decisions){
 const ledger=prepared.snapshot.bankStatements,entities=new Map(prepared.serverEntities.map(x=>[x.id,x]));
 const operations=new Map(decisions.operations.map(x=>[x.sourceKey,x]));
 const batches=new Map(ledger.batches.map(x=>[x.batchKey,x]));
 const rows=new Map(decisions.accounts.map(choice=>{
  const source=ledger.accounts.find(x=>x.id===choice.sourceId),target=entities.get(choice.targetId)?.data;
  const before=choice.action==='link'?target?.balance_minor:source?.openingMinor;
  const reserved=choice.action==='link'?target?.reserved_minor:0;
  if(!source||!Number.isSafeInteger(before)||!Number.isSafeInteger(reserved))
   throw Error('Нельзя рассчитать итоговый остаток счёта');
  return [source.id,{name:source.name,action:choice.action,before,after:before,reserved}];
 }));
 for(const op of ledger.operations){
  if(operations.get(op.sourceKey)?.action!=='add'||batches.get(op.batchKey)?.cancelledStateRevision!==null)continue;
  const account=rows.get(op.accountId),target=op.targetAccountId?rows.get(op.targetAccountId):null;
  if(!account||(op.targetAccountId&&!target))throw Error('Не сопоставлены счета банковской операции');
  account.after+=op.kind==='income'?op.amountCents:-op.amountCents;
  if(target)target.after+=op.amountCents;
  if(!Number.isSafeInteger(account.after)||(target&&!Number.isSafeInteger(target.after)))
   throw Error('Превышен безопасный остаток счёта');
 }
 for(const row of rows.values())if(row.reserved>0&&row.after<row.reserved)
  throw Error('После переноса остаток меньше уже зарезервированной суммы');
 return [...rows.values()];
}
function renderCloudImportComparison(prepared){
 const root=$('#cloud-import-comparison');root.replaceChildren();
 if(!prepared.comparison)return;
 const labels={entries:'Обязательства',loans:'Кредиты',settlements:'Оплаты',loanPayments:'Платежи по кредитам'};
 const entities=new Map(prepared.serverEntities.map(item=>[item.id,item]));
 const serverNumbers=new Map();
 for(const kind of ['account','obligation','loan','reserve','transaction','settlement','loan_payment'])
  prepared.serverEntities.filter(item=>item.kind===kind).map(item=>item.id).sort()
   .forEach((id,index)=>serverNumbers.set(id,index+1));
 const parents={entries:new Map(prepared.snapshot.entries.map(item=>[item.id,item])),
  loans:new Map(prepared.snapshot.loans.map(item=>[item.id,item]))};
 const localNumbers={entries:new Map(prepared.comparison.groups.entries.local.map((row,index)=>[row.sourceId,index+1])),
  loans:new Map(prepared.comparison.groups.loans.local.map((row,index)=>[row.sourceId,index+1]))};
 const money=value=>Number.isSafeInteger(value)?rubles(value):'сумма не указана';
 const recurrence=value=>({once:'один раз',none:'один раз',monthly:'ежемесячно',month:'ежемесячно',yearly:'ежегодно',year:'ежегодно'}[value]||'не указана');
 const strategy=value=>({term:'уменьшение срока',amount:'уменьшение платежа'}[value]||'не указана');
 const schedule=rows=>Array.isArray(rows)?(rows.length?rows.map(row=>
  `${row.date}: платёж ${money(row.amountCents)}, остаток ${money(row.balanceCents)}, проценты ${money(row.interestCents)}, долг ${money(row.principalCents)}`).join('; '):'пустой'):'нет';
 const localText=(kind,row)=>{
  if(kind==='entries')return `${row.title} · ${row.kind==='income'?'доход':'расход'} · ${money(row.amountCents)} · ${row.date} · ${recurrence(row.recurrence)} · зона UTC · категория ${row.category||'нет'} · удалено ${row.deletedAt||'нет'}`;
  if(kind==='loans')return `${row.title} · долг ${money(row.openingCents)} · платёж ${money(row.paymentCents)} · ставка ${row.apr}% · срок ${row.termMonths} мес. · день ${row.dueDay} · на ${row.asOfDate} · версия расчёта 1 · удалено ${row.deletedAt||'нет'} · график: ${schedule(row.schedule)}`;
  const parent=kind==='settlements'?parents.entries.get(row.entryId):parents.loans.get(row.loanId);
  const number=kind==='settlements'?localNumbers.entries.get(row.entryId):localNumbers.loans.get(row.loanId);
  return `${parent?.title||'Связанная запись'} №${number||'—'} · ${money(row.amountCents)} · ${row.date} · ${kind==='settlements'?'период '+row.occurrence:'стратегия '+strategy(row.strategy)} · отменено ${row.voidedAt||'нет'}`;
 };
 const serverText=item=>{
  const d=item.data;
  if(item.kind==='account')return `${d.name} · ${{bank:'банк',cash:'наличные',savings:'накопительный'}[d.type]||'счёт'} · ${d.currency} · начальный ${money(d.opening_minor)} · остаток ${money(d.balance_minor)} · резерв ${money(d.reserved_minor)} · доступно ${money(d.available_minor)} · архив ${d.archived_at||'нет'}`;
  if(item.kind==='reserve')return `${d.title} · цель ${money(d.target_minor)} на ${d.target_on||'не указана'} · отложено ${money(d.allocated_minor)} · счёт №${serverNumbers.get(d.account_id)||'—'} ${entities.get(d.account_id)?.data?.name||'не указан'} · обязательство №${serverNumbers.get(d.obligation_id)||'—'} ${entities.get(d.obligation_id)?.data?.title||'не указано'} · архив ${d.archived_at||'нет'}`;
  if(item.kind==='transaction')return `${{income:'доход',expense:'расход',transfer:'перевод',adjustment:'корректировка',payment:'платёж',reversal:'отмена'}[d.kind]||'операция'} · ${d.occurred_on} · ${d.note||'без примечания'} · проведена ${d.posted_at||'нет'} · проводки: ${d.postings.map(posting=>`счёт №${serverNumbers.get(posting.account_id)} ${entities.get(posting.account_id).data.name}: ${money(posting.signed_minor)}`).join('; ')}`;
  if(item.kind==='obligation')return `${d.title} · ${d.direction==='income'?'доход':'расход'} · ${money(d.amount_minor)} · ${d.starts_on} · ${recurrence(d.recurrence_unit)}, интервал ${d.recurrence_every}, зона ${d.timezone} · категория ${d.category||'нет'} · удалено ${d.deleted_at||'нет'}`;
  if(item.kind==='loan')return `${d.title} · долг ${money(d.opening_minor)} · платёж ${money(d.payment_minor)} · ставка ${d.apr_basis_points/100}% · срок ${d.term_months} мес. · день ${d.due_day} · на ${d.as_of_date} · версия расчёта ${d.calculation_version} · удалено ${d.deleted_at||'нет'} · график: ${schedule(d.imported_schedule)}`;
  const parent=entities.get(item.kind==='settlement'?d.obligation_id:d.loan_id);
  return `${parent?.data?.title||'Связанная запись'} №${serverNumbers.get(parent?.id)||'—'} · ${money(d.amount_minor)} · ${d.paid_on} · ${item.kind==='settlement'?'период '+d.occurrence_on:'стратегия '+strategy(d.strategy)} · отменено ${d.voided_at||'нет'}`;
 };
 const shortServerText=item=>{
  const d=item.data,parent=entities.get(item.kind==='settlement'?d.obligation_id:d.loan_id);
  return `${d.title||parent?.data?.title||'Связанная запись'} · ${money(d.amount_minor??d.opening_minor)} · ${d.starts_on||d.as_of_date||d.paid_on||'дата не указана'}`;
 };
 const differences=(kind,row,item)=>{
  const d=item.data, fields=[];
  const field=(label,left,right)=>{if(JSON.stringify(left??null)!==JSON.stringify(right??null))fields.push(label);};
  if(kind==='entries'){
   field('название',row.title,d.title);field('направление',row.kind,d.direction);
   field('сумма',row.amountCents,d.amount_minor);field('дата',row.date,d.starts_on);
   field('повторение',recurrence(row.recurrence),recurrence(d.recurrence_unit));
   field('интервал',1,d.recurrence_every);field('часовой пояс','UTC',d.timezone);
   field('категория',row.category,d.category);field('удаление',row.deletedAt,d.deleted_at);
  }else if(kind==='loans'){
   field('название',row.title,d.title);field('долг',row.openingCents,d.opening_minor);
   field('платёж',row.paymentCents,d.payment_minor);field('ставка',Math.round(row.apr*100),d.apr_basis_points);
   field('срок',row.termMonths,d.term_months);field('день платежа',row.dueDay,d.due_day);
   field('дата',row.asOfDate,d.as_of_date);field('версия расчёта',1,d.calculation_version);
   if(row.schedule!=null||d.imported_schedule!=null)fields.push('график требует сверки');
   field('удаление',row.deletedAt,d.deleted_at);
  }else{
   field('сумма',row.amountCents,d.amount_minor);field('дата',row.date,d.paid_on);
   if(kind==='settlements')field('период',row.occurrence+'-01',d.occurrence_on);
   else field('стратегия',row.strategy,d.strategy);
   field('отмена',row.voidedAt,d.voided_at);
   fields.push('связь с обязательством или кредитом нужно проверить');
  }
  return fields.length?'Различия или проверка: '+fields.join(', '):'Основные поля совпадают; дублирование не подтверждено';
 };
 let optionCount=0;
 for(const [kind,label] of Object.entries(labels)){
  const group=prepared.comparison.groups[kind];
  optionCount+=group.local.length*group.serverIds.length;
  if(optionCount>100000)throw Error('Слишком много вариантов для безопасного просмотра. Перенос остановлен.');
  if(!group.local.length&&!group.serverIds.length)continue;
  const details=document.createElement('details'),summary=document.createElement('summary');
  summary.textContent=`${label}: локально ${group.local.length}, на сервере ${group.serverIds.length}`;
  details.append(summary);
  details.addEventListener('toggle',()=>{
   if(!details.open||details.children.length>1)return;
   const list=document.createElement('ul'),rows=new Map(prepared.snapshot[kind].map(row=>[row.id,row]));
   for(const [index,entry] of group.local.entries()){
    const li=document.createElement('li');li.textContent='Локально №'+(index+1)+': '+localText(kind,rows.get(entry.sourceId));
    if(entry.candidateIds.length){
     const matches=document.createElement('ul');
     for(const id of entry.candidateIds){const candidate=document.createElement('li'),target=entities.get(id);candidate.textContent='Возможно совпадает с серверной №'+serverNumbers.get(id)+': '+shortServerText(target)+'. '+differences(kind,rows.get(entry.sourceId),target);matches.append(candidate);}
     li.append(matches);
    }else li.append(' — похожие записи по проверенным признакам не найдены');
    const decisionLabel=document.createElement('label');decisionLabel.textContent=' Решение: ';
    const select=document.createElement('select');select.dataset.mergeKind=kind;select.dataset.sourceId=entry.sourceId;
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выберите действие';select.append(placeholder);
    const add=document.createElement('option');add.value='add';add.textContent='Добавить отдельную запись';select.append(add);
    for(const id of group.serverIds){const option=document.createElement('option');option.value='link:'+id;option.textContent='Связать с серверной №'+serverNumbers.get(id)+': '+shortServerText(entities.get(id));select.append(option);}
    const comparison=document.createElement('p');
    select.addEventListener('change',()=>{comparison.textContent=select.value.startsWith('link:')?
     differences(kind,rows.get(entry.sourceId),entities.get(select.value.slice(5))):'';});
    decisionLabel.append(select,comparison);li.append(decisionLabel);
    list.append(li);
   }
   const remote=document.createElement('li');remote.textContent='Все серверные записи:';
   const remoteList=document.createElement('ul');
   for(const id of group.serverIds){const li=document.createElement('li');li.textContent='№'+serverNumbers.get(id)+': '+serverText(entities.get(id));remoteList.append(li);}
   remote.append(remoteList);list.append(remote);details.append(list);
  });
  root.append(details);
 }
 const other=prepared.serverEntities.filter(item=>['account','reserve','transaction'].includes(item.kind));
 if(other.length){
  const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');
  summary.textContent=`Серверные счета, резервы и операции: ${other.length} — сохраняются`;
  for(const item of other){const li=document.createElement('li');li.textContent='№'+serverNumbers.get(item.id)+': '+serverText(item);list.append(li);}
  details.append(summary,list);root.append(details);
 }
}
async function prepareCloudMergeReview(){
 if(cloudImportBusy||!pendingCloudImport||pendingCloudImport.preview.status!=='NEEDS_CONFLICT_DECISION')
  throw Error('Сначала проверьте обе финансовые базы');
 const prepared=pendingCloudImport, actor=prepared.actor;
 const choices=[...$('#cloud-import-comparison').querySelectorAll('select[data-merge-kind]')];
 if(choices.length!==prepared.preview.recordCount||choices.some(select=>!select.value))
  throw Error('Откройте все разделы и выберите действие для каждой локальной записи');
 const decisions=choices.map(select=>({kind:select.dataset.mergeKind,sourceId:select.dataset.sourceId,
  action:select.value==='add'?'add':'link',...(select.value==='add'?{}:{targetId:select.value.slice(5)})}));
 const bankChoices=[...$('#cloud-import-comparison').querySelectorAll('select[data-bank-account],select[data-bank-operation]')];
 let bankDecisions=null,bankBalances=null;
 if(prepared.preview.bankTransfer){
  if(bankChoices.length!==prepared.snapshot.bankStatements.accounts.length+prepared.snapshot.bankStatements.operations.length||
     bankChoices.some(select=>!select.value))throw Error('Выберите действие для каждого счёта и банковской операции');
  const bankAccounts=bankChoices.filter(select=>select.dataset.bankAccount).map(select=>({
   sourceId:select.dataset.bankAccount,action:select.value.startsWith('add:')?'add':'link',
   ...(select.value.startsWith('add:')?{accountKind:select.value.slice(4)}:{targetId:select.value.slice(5)})}));
  const mapped=new Map(bankAccounts.map(x=>[x.sourceId,x.action==='link'?x.targetId:null]));
  const bankOperations=bankChoices.filter(select=>select.dataset.bankOperation).map(select=>{
   const source=prepared.snapshot.bankStatements.operations.find(x=>x.sourceKey===select.dataset.bankOperation);
   if(select.value.startsWith('link:'))return {sourceKey:source.sourceKey,action:'link',targetId:select.value.slice(5)};
   if(source.kind==='expense'||source.kind==='income'){
    const local=prepared.snapshot,entries=new Map(local.entries.map(x=>[x.id,x]));
    const same=x=>x.date===source.date&&x.amountCents===source.amountCents&&!x.voidedAt;
    const localPaid=(source.kind==='expense'&&local.loanPayments.some(same))||
     local.settlements.some(x=>same(x)&&entries.get(x.entryId)?.kind===source.kind);
    const remote=new Map(prepared.serverEntities.map(x=>[x.id,x]));
    const remotePaid=prepared.serverEntities.some(x=>['settlement','loan_payment'].includes(x.kind)&&
     !x.data.voided_at&&x.data.paid_on===source.date&&x.data.amount_minor===source.amountCents&&
     (x.kind==='loan_payment'?source.kind==='expense':remote.get(x.data.obligation_id)?.data?.direction===source.kind));
    if(localPaid||remotePaid)throw Error('Банковская операция совпадает с фактической записью. Сначала выполните ручную сверку.');
   }
   const account=mapped.get(source.accountId),target=source.targetAccountId?mapped.get(source.targetAccountId):null;
   if(prepared.bankHistory.rows.some(row=>row.source_key===source.sourceKey||
      (account&&source.externalId!==null&&row.account_id===account&&row.external_id===source.externalId)))
    throw Error('Эта банковская операция уже есть на сервере. Выберите связь или разрешите конфликт.');
   const matches=account&&(source.kind!=='transfer'||target)?bankReviewMatches(prepared,source,account,target):[];
   if(matches.length>32||matches.some(x=>x.data.kind==='payment'||x.data.payment_link)||
      (source.kind==='transfer'&&matches.length))
    throw Error('Похожие серверные платежи или переводы требуют ручной сверки до переноса');
   return {sourceKey:source.sourceKey,action:'add',reviewedTransactionIds:matches.map(x=>x.id)};
  });
  bankDecisions={accounts:bankAccounts,operations:bankOperations};
  bankBalances=previewBankBalances(prepared,bankDecisions);
 }
 for(const select of [...choices,...bankChoices])select.disabled=true;
 cloudImportBusy=true;
 let finished=false;
 try{
  if(guestMode||actor!==activeUserId||emailSession.userId!==actor||!await refreshEmailSession())
   throw Error('Сессия изменилась. Проверка остановлена.');
  const reviewed=await withStableImportSnapshot(current=>sameFinancialJSON(current,prepared.snapshot),
   signal=>preparePersonalMergeReviewCandidate({prepared,verifiedActorUserId:actor,
    currentLocalSnapshotMatches:true,decisions,bankDecisions,signal}),
   {signal:cloudImportController?.signal,...(prepared.guestSource?{guestSource:prepared.guestSource}:{})});
  if(cloudImportController?.signal.aborted||guestMode||activeUserId!==actor||emailSession.userId!==actor)
   throw Error('Сессия изменилась. Проверка остановлена.');
  pendingCloudImport=reviewed;
  for(const select of [...choices,...bankChoices]){
   const decision=document.createElement('p');decision.textContent=select.selectedOptions[0].textContent;
   select.hidden=true;select.after(decision);
  }
  if(bankBalances){
   const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');
   summary.textContent='Итог после переноса по счетам';details.open=true;
   bankBalances.forEach((row,index)=>{const item=document.createElement('li');
    item.textContent=`Счёт №${index+1} ${row.name}: ${row.action==='link'?'серверный остаток':'начальный остаток'} ${rubles(row.before)} → итог ${rubles(row.after)} · резерв ${rubles(row.reserved)}`;
    list.append(item);});
   details.append(summary,list);$('#cloud-import-comparison').append(details);
  }
  $('#cloud-import-heading').textContent='Проверьте план переноса';
  $('#cloud-import-summary').textContent='План подготовлен. Добавить: '+
   Object.values(reviewed.mergeCounts.add).reduce((a,b)=>a+b,0)+', связать с сервером: '+
   Object.values(reviewed.mergeCounts.link).reduce((a,b)=>a+b,0)+
   (reviewed.bankCounts?'. Счета: добавить '+reviewed.bankCounts.accountsAdded+', связать '+reviewed.bankCounts.accountsLinked+
    '; банковские операции: добавить '+reviewed.bankCounts.operationsAdded+', связать '+reviewed.bankCounts.operationsLinked+
    '; проводок '+reviewed.bankCounts.postings:'')+
   '. Все существующие серверные счета, резервы и операции сохраняются. '+
   'Исходная копия сохраняется целиком; дополнительные поля из неё могут быть доступны только в архиве. Сервер повторно проверит связи и ревизию до записи. Пока ничего не отправлено.';
  $('#cloud-import-final-consent').closest('label').hidden=false;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-dialog [data-action="prepare-cloud-merge"]').hidden=true;
  $('#cloud-import-dialog [data-action="confirm-cloud-import"]').disabled=false;
  $('#cloud-import-dialog .dialog-body').scrollTop=0;
  finished=true;
 }finally{if(!finished)for(const select of [...choices,...bankChoices])select.disabled=false;cloudImportBusy=false;}
}
async function confirmCloudImport(){
 if(cloudImportBusy||busy||!financeImportEnabled||!pendingCloudImport)
  throw Error('Нет подтверждённого переноса. Сначала проверьте резервную копию.');
 if($('#cloud-import-final-consent').checked!==true)
  throw Error('Требуется отдельное подтверждение сохранённой шифрованной копии');
 const prepared=pendingCloudImport, actor=prepared.actor;
 if(prepared.guestSource&&$('#cloud-import-guest-consent').checked!==true)
  throw Error('Отдельно подтвердите перенос гостевой копии в текущий аккаунт');
 if(prepared.preservedZeroAccountId&&$('#cloud-import-preserve-zero-account').checked!==true)
  throw Error('Отдельно подтвердите сохранение существующего пустого счёта');
 cloudImportBusy=true;
 const button=$('#cloud-import-dialog [data-action="confirm-cloud-import"]');
 button.disabled=true;
 let requested=false;
 try{
  if(guestMode||actor!==activeUserId||emailSession.userId!==actor||
     !await refreshEmailSession())
   throw Error('Сессия изменилась. Перенос отменён.');
  const result=await withStableImportSnapshot(
   current=>sameFinancialJSON(current,prepared.snapshot),
   signal=>{requested=true;return executeConfirmedPersonalImportCandidate({
    prepared,verifiedActorUserId:actor,currentLocalSnapshotMatches:true,
    explicitFinalConsent:true,
    explicitGuestTransfer:prepared.guestSource ? $('#cloud-import-guest-consent').checked===true : false,
    explicitPreserveZeroAccountConsent:prepared.preservedZeroAccountId ?
     $('#cloud-import-preserve-zero-account').checked===true : false,
    fetchImpl:window.fetch.bind(window),signal,
   });},{signal:cloudImportController?.signal,...(prepared.guestSource?{guestSource:prepared.guestSource}:{})},
  );
  let changedDuringTransfer;
  if(prepared.guestSource){
   try{await withStableImportSnapshot(current=>sameFinancialJSON(current,prepared.snapshot),()=>true,
    {signal:cloudImportController?.signal,guestSource:prepared.guestSource});changedDuringTransfer=false;}
   catch{changedDuringTransfer=true;}
  }else changedDuringTransfer=!sameFinancialJSON(await readState(),prepared.snapshot);
  pendingCloudImport=null;cloudImportFile=null;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-guest-consent').checked=false;$('#cloud-import-guest-row').hidden=true;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
  $('#cloud-import-summary').textContent=
   (result.mergeCounts?'Добавлено '+Object.values(result.mergeCounts.add).reduce((a,b)=>a+b,0)+
    ', сопоставлено '+Object.values(result.mergeCounts.link).reduce((a,b)=>a+b,0)+'. ':'Перенесено '+result.recordCount+' записей. ')+
   (result.bankCounts?'Банковские счета: добавлено '+result.bankCounts.accountsAdded+', сопоставлено '+
    result.bankCounts.accountsLinked+'; операции: добавлено '+result.bankCounts.operationsAdded+', сопоставлено '+
    result.bankCounts.operationsLinked+'; проводок '+result.bankCounts.postings+'. ':'')+
   'Сервер вернул точную копию исходных данных. '+
   (result.bankCounts?'Остатки и банковские операции сверены с сервером. ':'')+
   'Локальная бухгалтерия не удалена. Пока синхронизация не включена, '+
   'не ведите параллельные изменения на разных устройствах.'+
   (changedDuringTransfer?' Локальные данные изменились во время переноса: требуется новое сравнение.':'');
  toast(changedDuringTransfer?'Перенос выполнен; нужны повторное сравнение и проверка локальных изменений':'Перенос подтверждён сервером, исходные данные сохранены',changedDuringTransfer?'error':'success');
 }catch(error){
  // A network failure AFTER commit is UNKNOWN. Do not retry automatically.
  pendingCloudImport=null;cloudImportFile=null;cloudImportController?.abort();
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-guest-consent').checked=false;$('#cloud-import-guest-row').hidden=true;
  $('#cloud-import-preserve-zero-account').checked=false;
  $('#cloud-import-preserve-row').hidden=true;
  $('#cloud-import-summary').textContent=requested?
   'Результат переноса неизвестен. Локальные данные сохранены. Не повторяйте импорт, '+
   'пока не проверите серверную копию и квитанцию.':
   'Перенос не отправлен. Локальные данные сохранены; проверьте их и подготовьте новый просмотр.';
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
   const passwordInput=form.elements.password,password=passwordInput.value;
   if(password.length<12)throw Error('Пароль должен содержать не менее 12 символов');
   try{
    if(passwordMode==='export')await performBackup(password);
    else if(passwordMode==='verify')await performVerifyBackup(password);
    else if(passwordMode==='cloud')await prepareCloudImport(password);
    else await performRestore(password);
   }finally{passwordInput.value='';}
   if(!form.isConnected)return;
   $('#password-dialog').close();
   if(passwordMode==='cloud'&&pendingCloudImport){
    $('#cloud-import-dialog [data-action="confirm-cloud-import"]').disabled=
     pendingCloudImport.preview.status!=='PREVIEW_ONLY';
    openDialog('#cloud-import-dialog');
   }
  }
 }catch(e){if(state)fail(e);}
}
function bindEvents(){
 // Safari does not always focus clicked buttons; retain the actual dialog trigger.
 document.addEventListener('click',event=>{
  const button=event.target instanceof Element?event.target.closest('button,[role="button"]'):null;
  if(button)lastDialogActivator=button;
 },true);
 document.addEventListener('click',async event=>{
   if(event.target.closest('#menu-toggle')){
    event.preventDefault();$('.sidebar')?.classList.toggle('open');return;
   }
   if(event.target.closest('#theme-toggle')){
    event.preventDefault();themeSet(document.body.dataset.theme==='dark'?'light':'dark');render();return;
   }
   if(event.target.closest('#top-add')){
    event.preventDefault();if(lastStorageContext!==true)openEntry();return;
   }
  const nav=event.target.closest('[data-view]');if(nav){event.preventDefault();navigation(nav.dataset.view);return;}
  const actionEl=event.target.closest('[data-action]');if(actionEl){
   event.preventDefault();
   if(actionEl.dataset.action==='open-reserves'){
    if(financeReservesEnabled&&!guestMode&&emailSession.userId===activeUserId){
     ui.obligationsSection='reserves';ui.focusReserveId=actionEl.dataset.id||null;
     navigation('obligations');
    }
    return;
   }
   try{await handleAction(actionEl);}catch(e){fail(e);}return;
  }
 });
 document.addEventListener('submit',onFormSubmit);
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
  $('#cloud-import-comparison').replaceChildren();
  $('#cloud-import-dialog [data-action="prepare-cloud-merge"]').hidden=true;
  $('#cloud-import-final-consent').checked=false;
  $('#cloud-import-guest-consent').checked=false;$('#cloud-import-guest-row').hidden=true;
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
 // Account validation remains mandatory BEFORE another read of scoped finance data.
 // Guest and verified account views both refresh on return from offline/other tab.
 let reminderRefresh=null;
 const refreshVisibleLedger=()=>{
  if(reminderRefresh||!state||document.visibilityState!=='visible')return;
  const actor=activeUserId;
  const pending=(async()=>{
   if(!guestMode&&actor&&!await refreshEmailSession())return;
   if(!state||actor!==activeUserId)return;
   const updated=await readState(); // scopeEpoch protects logout and account switch
   if(!state||actor!==activeUserId)return;
   state=updated;render();
  })();
  reminderRefresh=pending;
  void pending.catch(error=>{if(state)fail(error);}).finally(()=>{
   if(reminderRefresh===pending)reminderRefresh=null;
  });
 };
 window.addEventListener('focus',refreshVisibleLedger);
 window.addEventListener('online',refreshVisibleLedger);
 document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible')refreshVisibleLedger();
 });
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
 // Install native forms before attaching the unchanged delegated listeners.
 if(!financeFormRoots&&typeof createFinanceFormRoots==='function'&&$('#entry-dialog')){
  financeFormRoots=createFinanceFormRoots({
   entry:$('#entry-dialog'),loan:$('#loan-dialog'),payment:$('#payment-dialog'),
   settlement:$('#settlement-dialog'),password:$('#password-dialog'),
  });
  financeFormRoots.mount();
 }
 // Render the native-compatible auxiliary dialogs before binding delegated listeners.
 if(!auxiliaryDialogRoots&&typeof createAuxiliaryDialogRoots==='function'&&$('#payment-methods-dialog')){
  auxiliaryDialogRoots=createAuxiliaryDialogRoots({
   paymentMethods:$('#payment-methods-dialog'),
   excelImport:$('#excel-import-dialog'),
   cloudImport:$('#cloud-import-dialog'),
  });
  auxiliaryDialogRoots.mount();
 }
 bindEvents();
 if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
 try{
  const url=new URL(window.location.href);
  // A successful OAuth callback replaces guest mode with the verified account.
  const oauthSessionChanged=url.searchParams.get('auth')==='success';
  if(oauthSessionChanged){
   forgetOfflineActor();
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
    const offlineActor=financeSyncEnabled&&['network','unavailable'].includes(emailSession.lastRefreshFailure)?readOfflineActor():null;
    if(offlineActor){startOfflineSync(offlineActor);return;}
    if(!['network','unavailable'].includes(emailSession.lastRefreshFailure))forgetOfflineActor();
    window.location.replace('./account.html');
    return;
   }
   activeUserId=emailSession.userId;
   const previousOfflineActor=readOfflineActor();
   if(previousOfflineActor&&previousOfflineActor!==activeUserId)forgetOfflineActor(previousOfflineActor);
   await selectStateScope(activeUserId);
   try{
    authBroadcast=new BroadcastChannel('fh-auth-session-v2');
    authBroadcast.onmessage=event=>{
     if(event.data?.type==='session-changed'||
        (event.data?.type==='logout'&&event.data.userId===activeUserId)){
      forgetOfflineActor(activeUserId);
      revokeDisplayedLedger();
      window.location.replace('./account.html');
     }
    };
    if(oauthSessionChanged)authBroadcast.postMessage({type:'session-changed'});
   }catch{}
  }
  state=await readState();
  ui.overviewSource=financeReservesEnabled&&!guestMode&&Boolean(activeUserId)&&emailSession.userId===activeUserId?'server':'local';
  render();
  $('#save-indicator').textContent=ui.overviewSource==='server'?'Серверный раздел':'Локальная база готова';
 }catch(e){onErrorNoStorage(e);return;}
 if(ui.view==='settings')renderStorageStatus();
}
init();
