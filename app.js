import {cents,rubles,numberInput,monthKey,monthIndex,shiftMonth,monthLabel,dayInMonth,loanLedger,previewLoanPayment,getMonthEvents,monthTotals,createSampleState,isActive,emptyState,payoffMonths} from './finance.js';
import {readState,updateState,replaceState,askPersistentStorage,storageStatus,selectStateScope} from './storage.js?rev=auth-scopes-v18';
import {encryptBackup,decryptBackup} from './backup.js';
import {parseSchedule} from './schedule.js';
import {readXlsxRows,parseBudgetRows,previewImportChanges} from './excel-import.js';
import {createEmailSession} from './auth-session.js?rev=auth-scopes-v18';

const $=sel=>document.querySelector(sel);
const svg=name=>`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ico-${name}"></use></svg>`;
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatDate=date=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric'}).format(new Date(`${date}T12:00:00`));
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const uuid=()=>crypto.randomUUID();
const titles={overview:'Обзор',calendar:'Календарь',obligations:'Обязательства',loans:'Кредиты',settings:'Настройки'};
let state=null,ui={view:'overview',month:monthKey(today()),selectedDate:today(),filter:'all',selectedLoan:null,expandedEntry:null},passwordMode='export',restoreFile=null,scheduleLoanId=null,channel=null,toastTimer=null,busy=false,installPrompt=null,pendingExcelImport=null;
const emailSession=createEmailSession();
let guestMode=false,activeUserId=null,authBroadcast=null;
const GUEST_MODE_KEY='fh-guest-session-v2';
const hasData=()=>state.entries.some(isActive)||state.loans.some(isActive);
const monthEvents=()=>getMonthEvents(state,ui.month);
function toast(message,kind='success'){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3800);$('#save-indicator').textContent=kind==='error'?'Ошибка':'Сохранено на устройстве';}
function fail(error){console.error(error);toast(error?.message||'Не удалось выполнить действие','error');}
function audit(s,action,description){s.audit.push({id:uuid(),action,description:String(description).slice(0,160),date:new Date().toISOString()});}
async function mutate(change,msg='Сохранено на устройстве'){
 if(busy)return;busy=true;$('#save-indicator').textContent='Сохранение…';
 try{state=await updateState(s=>change(s));channel?.postMessage('updated');render();toast(msg);}catch(e){fail(e);throw e;}finally{busy=false;}
}
function themeSet(mode){document.documentElement.dataset.theme=mode;document.body.dataset.theme=mode;try{localStorage.setItem('fh-theme',mode);}catch{};$('#theme-color').content=mode==='dark'?'#172336':'#ffffff';$('#theme-toggle').innerHTML=svg(mode==='dark'?'sun':'moon');$('#theme-toggle').setAttribute('aria-label',mode==='dark'?'Включить светлую тему':'Включить тёмную тему');}
function navigation(view){ui.view=view;$('.sidebar')?.classList.remove('open');window.scrollTo({top:0,behavior:'instant'});render();if(view==='settings'&&!guestMode)void refreshEmailSession();}
function render(){if(!state)return;$('#toolbar-title').textContent=titles[ui.view];document.querySelectorAll('[data-view]').forEach(el=>{const active=el.dataset.view===ui.view;el.classList.toggle('active',active);el.setAttribute('aria-current',active?'page':'false');});
 const sections={overview:renderOverview,calendar:renderCalendar,obligations:renderObligations,loans:renderLoans,settings:renderSettings};$('#main').innerHTML=sections[ui.view]();syncAccountControls();if(ui.view==='settings')void renderStorageStatus();}
function syncAccountControls(){
 const toolbarButton=$('#account-logout-toolbar');
 toolbarButton.hidden=!Boolean(emailSession.email);
 toolbarButton.disabled=emailSession.busy;
}
async function refreshEmailSession(){
 if(guestMode)return;
 const verified=await emailSession.refresh();
 if(!verified||emailSession.userId!==activeUserId||!emailSession.email){
  // Never render the previous account's ledger after its session expires.
  state=null;
  window.location.replace('./account.html');
  return;
 }
 syncAccountControls();
}
async function logoutEmailAccount(){
 if(busy||!emailSession.email||emailSession.busy)return;
 const pending=emailSession.logout();
 syncAccountControls();
 try{
  if(await pending){
   // Revoke access to the displayed account before leaving the page.
   state=null;
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
function moneyRow(event,{compact=false}={}){
 const remaining=Math.max(0,event.plannedCents-event.paidCents);
 const status=event.paidCents<=0?'Ожидается':remaining===0?'Оплачено':'Частично';
 const chip=`<span class="pill ${event.paidCents?remaining===0?'pill-paid':'pill-partial':''}">${status}</span>`;
 const isIncome=event.kind==='income';
 const click=event.source==='loan'?`data-action="pay" data-id="${escapeHtml(event.id)}"`:`data-action="settle" data-id="${escapeHtml(event.id)}" data-month="${escapeHtml(monthKey(event.date))}"`;
 return `<div class="list-row"><div class="list-icon">${svg(isIncome?'download':event.source==='loan'?'credit':'calendar')}</div><div class="list-row-main"><strong>${escapeHtml(event.title)}</strong><small>${formatDate(event.date)} · ${escapeHtml(event.category)} ${event.paidCents?`· факт ${rubles(event.paidCents)}`:''}</small></div><div class="list-row-right"><strong class="${isIncome?'pos':''}">${isIncome?'+':'−'}${rubles(event.plannedCents)}</strong>${chip}</div><button class="mini-action" aria-label="${isIncome?'Отметить поступление':'Отметить оплату'}: ${escapeHtml(event.title)}" ${click}>${svg('check')}</button></div>`;
}
function renderOverview(){
 const events=monthEvents(),totals=monthTotals(events);
 if(!hasData()) return pageHead('Обзор месяца','Начните без регистрации. Все записи сохранятся только в этом браузере.')+`<div class="surface empty-panel">${svg('lock')}<h3>Ваша бухгалтерия пока пуста</h3><p>Добавьте поступления, обязательные платежи и ипотеку. Можно сначала включить вымышленные данные, чтобы посмотреть приложение.</p><div class="setting-actions" style="justify-content:center">${action('new-entry','Добавить доход', 'button-primary','data-kind="income"')}${action('new-loan','Добавить кредит','button-secondary')}${action('sample','Показать пример','button-secondary')}</div></div>`;
 const activeLoans=state.loans.filter(isActive);const upcoming=events.filter(e=>e.date>=today()).slice(0,4);
 const grouped=new Map();for(const e of events.filter(e=>e.kind!=='income'))grouped.set(e.category,(grouped.get(e.category)||0)+e.plannedCents);
 const categoryRows=[...grouped.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
 const max=Math.max(...categoryRows.map(x=>x[1]),1);
 const loan=activeLoans[0],snapshot=loan?loanLedger(loan,state.loanPayments):null;
 return pageHead('Обзор месяца',`${monthLabel(ui.month)} · план и фактически внесённые суммы`,`${action('prev-month',svg('chevron'),'button-secondary','aria-label="Предыдущий месяц"')}${action('next-month',svg('chevron'),'button-secondary','aria-label="Следующий месяц"')}`)+`
 <div class="overview-grid"><div class="overview-column"><div class="surface hero-money"><div class="hero-label">Плановый остаток после обязательств</div><div class="hero-amount">${rubles(totals.netPlanCents)}</div><div class="hero-foot">Доходы за месяц минус обязательные платежи. Это не остаток на банковском счёте.</div></div><div class="kpi-grid"><div class="surface kpi"><div class="kpi-label">Плановые доходы</div><div class="kpi-num pos">${rubles(totals.incomeCents)}</div><div class="small-hint">Получено: ${rubles(totals.incomePaidCents)}</div></div><div class="surface kpi"><div class="kpi-label">Обязательства</div><div class="kpi-num">${rubles(totals.expenseCents)}</div><div class="small-hint">Оплачено: ${rubles(totals.expensePaidCents)}</div></div></div>
 <div class="section-title"><h2>Распределение платежей</h2><button class="button-text" data-view="obligations">Все записи ${svg('chevron')}</button></div><div class="surface">${categoryRows.length?categoryRows.map(([name,sum])=>`<div class="allocation-row"><div class="allocation-label"><span>${escapeHtml(name)}</span><strong>${rubles(sum)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(2,Math.round(sum/max*100))}%"></div></div></div>`).join(''):'<p class="small-hint">Добавьте расходы для построения распределения.</p>'}</div></div>
 <div class="overview-column"><div class="section-title" style="margin-top:0"><h2>Ближайшие события</h2><button class="button-text" data-view="calendar">Календарь ${svg('chevron')}</button></div><div class="surface plain-list">${upcoming.length?upcoming.map(e=>moneyRow(e)).join(''):'<div class="empty-mini">В этом месяце больше нет запланированных событий.</div>'}</div>
 <div class="section-title"><h2>${loan?'Кредитный горизонт':'Кредиты'}</h2><button class="button-text" data-view="loans">Подробнее ${svg('chevron')}</button></div><div class="surface loan-spotlight">${loan?`<div class="small-hint">Осталось выплатить · ${escapeHtml(loan.title)}</div><div class="loan-balance">${rubles(snapshot.outstandingCents)}</div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(0,Math.min(100,Math.round((1-snapshot.outstandingCents/loan.openingCents)*100)))}%"></div></div><p class="small-hint" style="margin:10px 0">Ориентировочный срок: ${snapshot.months===null?'не рассчитывается':`${snapshot.months} мес.`}. Платёж: ${rubles(snapshot.monthlyCents)}</p>${action('pay',`${svg('plus')} Внести платёж`,'button-primary',`data-id="${escapeHtml(loan.id)}"`)}`:`<p class="small-hint">Кредитов пока нет.</p>${action('new-loan','Добавить кредит','button-primary')}`}</div></div></div>`;
}
function renderCalendar(){
 const events=monthEvents(),totals=monthTotals(events);const [year,mon]=ui.month.split('-').map(Number);
 const first=new Date(year,mon-1,1,12);const start=(first.getDay()+6)%7;const end=new Date(year,mon,0).getDate();const selected=monthKey(ui.selectedDate)===ui.month?ui.selectedDate:dayInMonth(ui.month,1);
 const selectedEvents=events.filter(e=>e.date===selected);
 const header=`<div class="month-controls"><button data-action="prev-month" aria-label="Предыдущий месяц">${svg('chevron')}</button><strong>${monthLabel(ui.month)}</strong><button data-action="next-month" aria-label="Следующий месяц">${svg('chevron')}</button></div>`;
 const heads=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<div class="cal-head">${x}</div>`).join('');
 const blanks=Array.from({length:start},()=>'<div class="cal-blank"></div>').join('');
 const days=Array.from({length:end},(_,i)=>{const d=dayInMonth(ui.month,i+1);const todays=events.filter(e=>e.date===d);return `<button class="cal-day ${d===selected?'selected':''} ${d===today()?'today':''}" data-action="select-day" data-date="${d}" aria-label="${formatDate(d)}; ${todays.length} событий"><span class="cal-number">${i+1}</span><span class="cal-tokens">${todays.slice(0,4).map(e=>`<i class="${e.kind==='income'?'income':'expense'}"></i>`).join('')}</span><span class="cal-summ">${todays.slice(0,2).map(e=>`<span>${escapeHtml(e.title)}</span>`).join('')}</span></button>`}).join('');
 return pageHead('Календарь платежей','Поступления, регулярные обязательства и даты оплаты в едином календаре',`${action('new-entry',`${svg('plus')} Запись`,'button-primary')}`)+`
 <div class="cal-layout"><div><div class="surface"><div class="filter-bar">${header}<span class="pill">${events.length} событий</span></div><div class="calendar-grid">${heads}${blanks}${days}</div><div class="calendar-legend"><span><i></i>Поступления</span><span><i></i>Платежи</span></div></div></div>
 <div><div class="surface"><h2 class="cal-selected-title">${formatDate(selected)}</h2><div class="small-hint" style="margin-bottom:12px">Нажмите на дату, чтобы увидеть обязательства и отметить оплату</div><div class="plain-list">${selectedEvents.length?selectedEvents.map(e=>moneyRow(e)).join(''):'<div class="empty-mini">В этот день ничего не запланировано.</div>'}</div></div><div class="surface" style="margin-top:13px"><div class="kpi-label">Плановый итог месяца</div><div class="amount-medium">${rubles(totals.netPlanCents)}</div><div class="small-hint" style="margin-top:8px">Подтверждённый поток: ${rubles(totals.netFactCents)}. Суммы не включают начальный остаток на счетах.</div></div></div></div>`;
}
function entryRecord(entry){
 const date=entry.recurrence==='once'?entry.date:dayInMonth(ui.month,Number(entry.date.slice(-2)));
 const occurrence=ui.month;
 const actual=state.settlements.filter(s=>s.entryId===entry.id&&s.occurrence===occurrence&&!s.voidedAt);
 const status=`<span class="pill ${actual.length?'pill-paid':''}">${actual.length?`Внесено ${rubles(actual.reduce((a,b)=>a+b.amountCents,0))}`:'План'}</span>`;
 const buttons=`<button class="mini-action" data-action="settle" data-id="${escapeHtml(entry.id)}" data-month="${ui.month}" aria-label="Отметить сумму">${svg('check')}</button><button class="mini-action" data-action="edit-entry" data-id="${escapeHtml(entry.id)}" aria-label="Изменить">${svg('edit')}</button><button class="mini-action" data-action="archive-entry" data-id="${escapeHtml(entry.id)}" aria-label="Удалить">${svg('trash')}</button>`;
 const more=ui.expandedEntry===entry.id && actual.length?`<div style="padding:10px 15px;background:var(--soft);border-radius:12px">${actual.map(p=>`<div class="archive-row"><div>${formatDate(p.date)} · ${rubles(p.amountCents)}</div><span>${action('edit-settlement','Изменить','button-text',`data-id="${escapeHtml(p.id)}"`)} ${action('void-settlement','Отменить','button-text',`data-id="${escapeHtml(p.id)}"`)}</span></div>`).join('')}</div>`:'';
 return `<tr><td><div class="record-title">${escapeHtml(entry.title)}</div><div class="record-sub">${escapeHtml(entry.category||'Без категории')} ${entry.recurrence!=='once'?'· '+({monthly:'Каждый месяц',yearly:'Ежегодно'}[entry.recurrence]||''):''}</div></td><td>${formatDate(date)}</td><td>${status}</td><td class="money-cell ${entry.kind==='income'?'pos':''}">${entry.kind==='income'?'+':'−'}${rubles(entry.amountCents)}</td><td class="record-actions">${buttons}</td></tr>${more?`<tr><td colspan="5">${more}</td></tr>`:''}`;
}
function mobileEntry(entry){
 const payments=state.settlements.filter(s=>s.entryId===entry.id&&s.occurrence===ui.month&&!s.voidedAt);
 const actual=payments.reduce((a,b)=>a+b.amountCents,0);
 const date=entry.recurrence==='once'?entry.date:dayInMonth(ui.month,Number(entry.date.slice(-2)));
 return `<div class="record-mobile-row"><div class="list-icon">${svg(entry.kind==='income'?'download':'calendar')}</div><div><strong>${escapeHtml(entry.title)}</strong><small>${formatDate(date)} · ${escapeHtml(entry.category)}</small><small>${payments.length?`Факт ${rubles(actual)}`:'Ожидается'}</small></div><div><div class="record-mobile-amount ${entry.kind==='income'?'pos':''}">${entry.kind==='income'?'+':'−'}${rubles(entry.amountCents)}</div><div class="record-mobile-actions"><button class="mini-action" data-action="settle" data-id="${escapeHtml(entry.id)}" data-month="${ui.month}" aria-label="Отметить оплату">${svg('check')}</button><button class="mini-action" data-action="edit-entry" data-id="${escapeHtml(entry.id)}" aria-label="Изменить">${svg('edit')}</button><button class="mini-action" data-action="archive-entry" data-id="${escapeHtml(entry.id)}" aria-label="Удалить">${svg('trash')}</button></div>${payments.length?`<button class="button-text" style="font-size:12px" data-action="expand-entry" data-id="${escapeHtml(entry.id)}">История</button>`:''}</div></div>${ui.expandedEntry===entry.id?payments.map(p=>`<div class="archive-row" style="padding:10px">${rubles(p.amountCents)} · ${formatDate(p.date)}<span>${action('edit-settlement','Править','button-text',`data-id="${escapeHtml(p.id)}"`)}${action('void-settlement','Отмена','button-text',`data-id="${escapeHtml(p.id)}"`)}</span></div>`).join(''):''}`;
}
function renderObligations(){
 const items=state.entries.filter(isActive).filter(e=>ui.filter==='all'||(ui.filter==='regular'&&e.recurrence!=='once')||(ui.filter==='once'&&e.recurrence==='once')||(ui.filter==='income'&&e.kind==='income')).sort((a,b)=>a.date.localeCompare(b.date));
 const total=monthTotals(monthEvents());
 return pageHead('Обязательства','Доходы и расходы. Полный учёт запланированных и фактических сумм',`${action('new-entry',`${svg('plus')} Добавить`,'button-primary')}`)+`
 <div class="kpi-grid" style="max-width:760px;margin:0 0 20px"><div class="surface kpi"><div class="kpi-label">Расходы по плану</div><div class="kpi-num">${rubles(total.expenseCents)}</div></div><div class="surface kpi"><div class="kpi-label">Оплачено фактически</div><div class="kpi-num pos">${rubles(total.expensePaidCents)}</div></div></div>
 <div class="filter-bar"><div class="segment">${[['all','Все'],['regular','Регулярные'],['once','Разовые'],['income','Доходы']].map(([key,label])=>`<button class="${ui.filter===key?'selected':''}" data-action="filter" data-filter="${key}" aria-pressed="${ui.filter===key}">${label}</button>`).join('')}</div><span class="small-hint">${items.length} записей · ${monthLabel(ui.month)}</span></div>
 <div class="surface">${items.length?`<table class="records-table"><thead><tr><th>Название</th><th>Дата</th><th>Состояние</th><th style="text-align:right">Сумма</th><th></th></tr></thead><tbody>${items.map(entryRecord).join('')}</tbody></table><div class="records-mobile">${items.map(mobileEntry).join('')}</div>`:`<div class="empty-panel">${svg('list')}<h3>Здесь пока нет записей</h3><p>Добавляйте регулярные платежи, зарплату или разовые расходы. Их можно изменять и архивировать.</p>${action('new-entry','Добавить запись','button-primary')}</div>`}</div><p class="small-hint" style="margin-top:13px">Кредиты учитываются в общем финансовом плане и на странице «Кредиты». Архивирование сохраняет историю.</p>`;
}
function renderLoanHistory(loan,snapshot){
 const rows=state.loanPayments.filter(x=>x.loanId===loan.id).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt));
 if(!rows.length)return '<p class="small-hint">Фактических платежей пока нет. Они появятся здесь после внесения.</p>';
 return `<div style="overflow-x:auto"><table class="compact-table"><thead><tr><th>Дата</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr><td>${formatDate(p.date)}</td><td>${rubles(p.amountCents)}</td><td>${p.voidedAt?'<span class="pill">Отменён</span>':'<span class="pill pill-paid">Учтён</span>'}</td><td>${p.voidedAt?'':action('void-payment','Отменить','button-text',`data-id="${escapeHtml(p.id)}"`)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderLoans(){
 const loans=state.loans.filter(isActive);if(!loans.find(l=>l.id===ui.selectedLoan))ui.selectedLoan=loans[0]?.id||null;
 const selected=loans.find(l=>l.id===ui.selectedLoan);const snap=selected?loanLedger(selected,state.loanPayments):null;
 return pageHead('Кредиты и ипотека','Остатки долга, реальные платежи и приблизительный прогноз погашения',`${action('new-loan',`${svg('plus')} Кредит`,'button-primary')}`)+`
 ${loans.length?`<div class="loan-grid"><div>${loans.map(l=>{const s=loanLedger(l,state.loanPayments);const paid=Math.max(0,Math.min(100,Math.round((1-s.outstandingCents/l.openingCents)*100)));return `<button class="loan-card ${l.id===ui.selectedLoan?'selected':''}" data-action="select-loan" data-id="${escapeHtml(l.id)}" aria-pressed="${l.id===ui.selectedLoan}"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span class="title">${escapeHtml(l.title)}</span><span class="pill">${paid}% закрыто</span></div><div class="balance">${rubles(s.outstandingCents)}</div><div class="progress-track"><div class="progress-fill" style="width:${paid}%"></div></div><div class="small-hint" style="margin-top:10px">${rubles(s.monthlyCents)} / мес. · ${s.months??'—'} мес. приблизительно</div></button>`}).join('')}</div><div class="surface loan-detail"><div class="section-title" style="margin-top:0"><h2>${escapeHtml(selected.title)}</h2><span class="pill">${selected.apr}% годовых</span></div><div class="eyebrow">Текущий расчётный долг</div><div class="hero-amount" style="font-size:39px">${rubles(snap.outstandingCents)}</div><div class="loan-stats"><div><span>Плановый платёж</span><strong>${rubles(snap.monthlyCents)}</strong></div><div><span>Осталось ориентировочно</span><strong>${snap.months===null?'Нет расчёта':snap.months+' мес.'}</strong></div><div><span>Предполагаемая дата</span><strong>${snap.projectedEnd?formatDate(snap.projectedEnd):'Не определена'}</strong></div><div><span>День платежа</span><strong>${selected.dueDay}-е число</strong></div></div><div class="loan-actions">${action('pay',`${svg('plus')} Внести платёж`,'button-primary',`data-id="${escapeHtml(selected.id)}"`)}${action('edit-loan',`${svg('edit')} Изменить`,'button-secondary',`data-id="${escapeHtml(selected.id)}"`)}${action('schedule-import','Импорт графика CSV','button-secondary',`data-id="${escapeHtml(selected.id)}"`)}${action('archive-loan','В архив','button-secondary',`data-id="${escapeHtml(selected.id)}"`)}</div><div class="info-card" style="margin-top:14px"><strong style="font-size:13px">Расчёт по аннуитетной модели</strong><p class="small-hint" style="margin:7px 0 0">Не учитывает индивидуальные банковские правила, ежедневные проценты, комиссии и просрочки. Итоговые даты проверяйте по официальному графику.</p></div>${selected.schedule?.length?`<div class="section-title"><h2>Импортированный график</h2>${action('clear-schedule','Удалить график','button-text',`data-id="${escapeHtml(selected.id)}"`)}</div><span class="pill">${selected.schedule.length} строк</span><p class="small-hint">Источник: ${escapeHtml(selected.scheduleSource||'CSV')}. График хранится на устройстве для сверки с прогнозом; автоматически не подменяет факты.</p><div style="overflow:auto"><table class="compact-table"><tr><th>Дата</th><th>Платёж</th><th>Остаток</th></tr>${selected.schedule.slice(0,4).map(r=>`<tr><td>${formatDate(r.date)}</td><td>${rubles(r.amountCents)}</td><td>${rubles(r.balanceCents)}</td></tr>`).join('')}</table></div>`:''}<div class="loan-history"><h3>История оплат</h3>${renderLoanHistory(selected,snap)}</div></div></div>`:`<div class="surface empty-panel">${svg('credit')}<h3>Кредитов пока нет</h3><p>Можно добавить ипотеку, остаток и параметры платежа. График обновится после каждого сохранённого фактического платежа.</p>${action('new-loan','Добавить ипотеку или кредит','button-primary')}</div>`}`;
}
function renderSettings(){
 const deleted=[...state.entries.filter(x=>x.deletedAt).map(x=>({...x,entity:'entry'})),...state.loans.filter(x=>x.deletedAt).map(x=>({...x,entity:'loan'}))];
 const panelIcon=name=>'<div class="settings-symbol" aria-hidden="true">'+svg(name)+'</div>';
 return pageHead('Настройки','Безопасность, данные и управление записями')+`<div class="settings-grid">
 <section class="surface settings-card" data-settings-card="security">
  ${panelIcon('shield')}<div class="settings-card-body">
   <h2>Локальная безопасность</h2>
   <p>Финансовые записи хранятся в этом браузере и не передаются на сервер. В приватном режиме они могут быть удалены после закрытия окна.</p>
   <div class="setting-actions">${action('persist',`${svg('lock')} Запросить постоянное хранение`,'button-secondary')}</div>
   <p id="storage-status" class="small-hint settings-footnote" role="status">Браузер может удалить данные при очистке хранилища. Делайте резервные копии.</p>
  </div>
 </section>
 <section class="surface settings-card" data-settings-card="backup">
  ${panelIcon('download')}<div class="settings-card-body">
   <h2>Зашифрованная копия</h2>
   <p>Сохраните записи в зашифрованный файл (AES-256-GCM) для переноса на другое устройство или восстановления.</p>
   <div class="setting-actions">${action('backup',`${svg('download')} Скачать копию`,'button-primary settings-cta')}${action('restore',`${svg('upload')} Восстановить`,'button-secondary')}</div>
  </div>
 </section>
 <section class="surface settings-card" data-settings-card="import">
  ${panelIcon('sheet')}<div class="settings-card-body">
   <h2>Импорт из Excel</h2>
   <p>Выберите XLSX для предварительного просмотра. Файл обрабатывается в браузере, текущие записи не заменяются.</p>
   <div class="setting-actions">${action('excel-import',`${svg('upload')} Выбрать файл`,'button-secondary')}</div>
   <p class="small-hint settings-footnote">Поддерживается шаблон с доходами и кредитами. Перед импортом проверьте суммы, даты и остатки.</p>
  </div>
 </section>
 <section class="surface settings-card" data-settings-card="categories">
  ${panelIcon('tag')}<div class="settings-card-body">
   <h2>Категории</h2>
   <p>Добавляйте, переименовывайте и удаляйте категории. Используемую категорию сначала замените в записях.</p>
   <div class="category-items">${state.categories.map(x=>`<span class="category-chip"><span class="category-name">${escapeHtml(x)}</span><button type="button" data-action="edit-category" data-category="${escapeHtml(x)}" aria-label="Переименовать категорию ${escapeHtml(x)}" title="Переименовать">${svg('edit')}</button><button type="button" data-action="delete-category" data-category="${escapeHtml(x)}" aria-label="Удалить категорию ${escapeHtml(x)}" title="Удалить">${svg('trash')}</button></span>`).join('')}</div>
   <form id="category-form" class="category-add"><input name="name" maxlength="40" required aria-label="Новая категория" placeholder="Название категории"><button class="button-primary settings-cta" type="submit">Добавить</button></form>
  </div>
 </section>
 <section class="surface settings-card" data-settings-card="archive">
  ${panelIcon('archive')}<div class="settings-card-body">
   <h2>Архив записей</h2>
   <p>Удалённые записи остаются в архиве и доступны для восстановления.</p>
   <div class="archive-list">${deleted.length?deleted.map(x=>`<div class="archive-row"><span>${escapeHtml(x.title)}</span>${action('restore-item','Восстановить','button-text',`data-id="${escapeHtml(x.id)}" data-entity="${x.entity}"`)}</div>`).join(''):'<div class="small-hint">Архив пуст.</div>'}</div>
  </div>
 </section>
 <section class="surface settings-card" data-settings-card="history">
  ${panelIcon('database')}<div class="settings-card-body">
   <h2>Пример и история</h2>
   <p>Загрузите пример записей для знакомства с интерфейсом или очистите бухгалтерию.</p>
   <div class="setting-actions">${action('sample','Загрузить пример','button-secondary')}${action('clear','Очистить бухгалтерию','button-secondary danger-zone')}</div>
   <details class="settings-history"><summary>Последние изменения${state.audit.length?' ('+Math.min(state.audit.length,8)+')':''}</summary>
    <div class="archive-list">${state.audit.slice(-8).reverse().map(x=>`<div class="archive-row"><span>${escapeHtml(x.description)}</span><span class="muted">${formatDate(x.date.slice(0,10))}</span></div>`).join('')||'<div class="small-hint">Пока изменений нет.</div>'}</div>
   </details>
  </div>
 </section>
 <section class="surface settings-card settings-install" data-settings-card="install">
  ${panelIcon('smartphone')}<div class="settings-card-body">
   <h2>Установка приложения</h2>
   <p>Установите приложение через меню браузера. На iPhone используйте «Поделиться» → «На экран Домой», на Mac - «Добавить в Dock». Данные разных устройств автоматически не объединяются.</p>
   <div class="setting-actions">${action('install','Установить (где поддерживается)','button-secondary')}</div>
  </div>
 </section>
 </div>`;
}
function openDialog(sel){const dlg=$(sel);if(!dlg?.open)dlg.showModal();}
function formValue(form,name){return form.elements.namedItem(name).value;}
function fillSelect(el,items,selected){el.innerHTML=items.map(x=>`<option value="${escapeHtml(x.id)}" ${x.id===selected?'selected':''}>${escapeHtml(x.title)}</option>`).join('');}
function openEntry(id=null,kind='expense'){
 const form=$('#entry-form');form.reset();const record=state.entries.find(x=>x.id===id);$('#entry-heading').textContent=record?'Изменить запись':'Добавить запись';
 form.elements.id.value=id||'';form.elements.title.value=record?.title||'';form.elements.kind.value=record?.kind||kind;form.elements.amount.value=record?numberInput(record.amountCents):'';
 form.elements.date.value=record?.date||today();form.elements.recurrence.value=record?.recurrence||'monthly';
 fillSelect($('#entry-category'),state.categories.map(x=>({id:x,title:x})),record?.category||'Другое');openDialog('#entry-dialog');
}
function openLoan(id=null){
 const form=$('#loan-form');form.reset();const record=state.loans.find(x=>x.id===id);$('#loan-heading').textContent=record?'Изменить кредит':'Добавить кредит';
 form.elements.id.value=id||'';form.elements.title.value=record?.title||'';form.elements.opening.value=record?numberInput(record.openingCents):'';
 form.elements.apr.value=record?String(record.apr).replace('.',','):'';form.elements.payment.value=record?numberInput(record.paymentCents):'';
 form.elements.term.value=record?.termMonths??'';form.elements.asOfDate.value=record?.asOfDate||today();form.elements.dueDay.value=record?.dueDay??15;openDialog('#loan-dialog');
}
function openPayment(id=null,paymentId=null){
 const loans=state.loans.filter(isActive);if(!loans.length){toast('Сначала добавьте кредит','error');return;}
 const form=$('#payment-form');form.reset();fillSelect($('#payment-loan'),loans.map(x=>({id:x.id,title:x.title})),id||ui.selectedLoan||loans[0].id);
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
 const form=$('#settlement-form');form.reset();const existing=state.settlements.find(p=>p.id===paymentId);
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
 if(type==='edit-loan'){openLoan(id);return;}
 if(type==='pay'){openPayment(id);return;}
 if(type==='edit-payment'){const p=state.loanPayments.find(x=>x.id===id&&!x.voidedAt);if(p)openPayment(p.loanId,id);return;}
 if(type==='settle'){openSettlement(id,button.dataset.month||ui.month);return;}
 if(type==='edit-settlement'){const p=state.settlements.find(x=>x.id===id&&!x.voidedAt);if(p)openSettlement(p.entryId,p.occurrence,id);return;}
 if(type==='expand-entry'){ui.expandedEntry=ui.expandedEntry===id?null:id;render();return;}
 if(type==='select-loan'){ui.selectedLoan=id;render();return;}
 if(type==='select-day'){ui.selectedDate=button.dataset.date;render();return;}
 if(type==='prev-month'||type==='next-month'){ui.month=shiftMonth(ui.month,type==='prev-month'?-1:1);ui.selectedDate=dayInMonth(ui.month,Math.min(Number(ui.selectedDate.slice(-2))||1,28));render();return;}
 if(type==='filter'){ui.filter=button.dataset.filter;render();return;}
 if(type==='theme'){themeSet(button.dataset.theme);render();return;}
 if(type==='persist'){const ok=await askPersistentStorage();toast(ok?'Браузер подтвердил постоянное хранение':'Браузер не предоставил постоянное хранение. Экспортируйте копии.',ok?'success':'error');renderStorageStatus();return;}
 if(type==='backup'){passwordMode='export';$('#password-heading').textContent='Создать резервную копию';$('#password-form').reset();openDialog('#password-dialog');return;}
 if(type==='restore'){$('#restore-file').value='';$('#restore-file').click();return;}
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
  const ok=await requireConfirm('Загрузить вымышленные данные?',hasData()?'Это заменит вашу текущую бухгалтерию демонстрационными записями. Сначала сохраните резервную копию.':'Будет создана отдельная вымышленная бухгалтерия, которую можно удалить.');
  if(!ok)return;const sample=createSampleState();audit(sample,'sample','Загружен вымышленный пример');await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,sample);},'Демонстрационные данные загружены');ui.month='2026-11';ui.selectedDate='2026-11-15';render();return;
 }
 if(type==='clear'){
  const ok=await requireConfirm('Удалить всю бухгалтерию?', 'Все локальные доходы, расходы, кредиты, фактические платежи и журнал будут очищены. Восстановить можно только из заранее созданной резервной копии.');
  if(!ok)return;const initial=emptyState();await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,initial);},'Бухгалтерия очищена');return;
 }
 if(type==='archive-entry'||type==='archive-loan'){
  const isLoan=type==='archive-loan',item=state[isLoan?'loans':'entries'].find(x=>x.id===id);if(!item)return;
  if(!await requireConfirm('Перенести в архив?',`Запись «${item.title}» исчезнет из активных расчётов. История оплат сохранится.`))return;
  await mutate(s=>{const target=s[isLoan?'loans':'entries'].find(x=>x.id===id);target.deletedAt=new Date().toISOString();audit(s,'archive',`Архив: ${target.title}`);},'Запись перенесена в архив');return;
 }
 if(type==='restore-item'){
  const key=button.dataset.entity==='loan'?'loans':'entries';await mutate(s=>{const item=s[key].find(x=>x.id===id);if(!item)return;delete item.deletedAt;if(key==='entries'&&item.category&&!s.categories.includes(item.category))s.categories.push(item.category);audit(s,'restore',`Восстановлено: ${item.title}`);},'Запись восстановлена');return;
 }
 if(type==='void-payment'||type==='void-settlement'){
  const key=type==='void-payment'?'loanPayments':'settlements';const record=state[key].find(x=>x.id===id);if(!record||record.voidedAt)return;
  if(!await requireConfirm('Отменить фактическую оплату?',`Сумма ${rubles(record.amountCents)} перестанет участвовать в расчёте. Запись об отмене останется в истории.`))return;
  await mutate(s=>{s[key].find(x=>x.id===id).voidedAt=new Date().toISOString();audit(s,'void',`Отменена оплата ${rubles(record.amountCents)}`);},'Операция отменена, прогноз обновлён');return;
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
 if(ui.view!=='settings')return;
 const info=await storageStatus();const el=$('#storage-status');if(!el)return;
 el.textContent=info.persistent===true?'Постоянное хранение браузером разрешено. Экспорт копий всё равно обязателен для надёжности.':'Постоянное хранение не подтверждено. Очистка данных сайта может уничтожить бухгалтерию.';
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
function onErrorNoStorage(error){$('#main').innerHTML=`<section class="surface empty-panel"><h1>Хранилище недоступно</h1><p>${escapeHtml(error.message)}</p><p>Финансовые данные не будут незаметно записаны в ненадёжное временное хранилище. Откройте приложение в обычном окне Safari или другого браузера и разрешите сохранение данных.</p></section>`;}
async function saveEntry(form){
 const id=formValue(form,'id'),title=formValue(form,'title').trim(),amountCents=cents(formValue(form,'amount'));
 const kind=formValue(form,'kind'),date=formValue(form,'date'),recurrence=formValue(form,'recurrence'),category=formValue(form,'category');
 if(!title||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['income','expense'].includes(kind)||!['monthly','once','yearly'].includes(recurrence)||amountCents<1)throw Error('Заполните корректные поля записи');
 if(!state.categories.includes(category))throw Error('Категория не найдена');
 await mutate(s=>{
  if(id){const current=s.entries.find(x=>x.id===id);if(!current)throw Error('Запись не найдена');Object.assign(current,{title,amountCents,kind,date,recurrence,category,updatedAt:new Date().toISOString()});audit(s,'update',`Изменено: ${title}`);}
  else{s.entries.push({id:uuid(),title,amountCents,kind,date,recurrence,category,createdAt:new Date().toISOString()});audit(s,'create',`Добавлено: ${title}`);}
 },id?'Запись обновлена':'Запись добавлена');$('#entry-dialog').close();
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
  const fields={title,openingCents,paymentCents,apr,termMonths,dueDay,asOfDate};
  if(id){const current=s.loans.find(x=>x.id===id);if(!current)throw Error('Кредит не найден');Object.assign(current,fields,{updatedAt:new Date().toISOString()});audit(s,'loan-update',`Изменён кредит: ${title}`);}
  else {const loanId=uuid();s.loans.push({id:loanId,...fields,schedule:[],createdAt:new Date().toISOString()});ui.selectedLoan=loanId;audit(s,'loan-create',`Добавлен кредит: ${title}`);}
 },id?'Кредит обновлён':'Кредит добавлен');$('#loan-dialog').close();
}
async function savePayment(form){
 const loanId=formValue(form,'loanId'),paymentId=formValue(form,'paymentId'),amountCents=cents(formValue(form,'amount')),date=formValue(form,'date'),strategy=form.querySelector('[name="strategy"]:checked')?.value;
 const loan=state.loans.find(l=>l.id===loanId&&isActive(l));if(!loan||!['term','amount'].includes(strategy))throw Error('Кредит недоступен');
 const paymentsExcludingOld=state.loanPayments.map(p=>p.id===paymentId?{...p,voidedAt:'EDIT_PREVIEW'}:p);
 const projection=previewLoanPayment(loan,paymentsExcludingOld,amountCents,date,strategy);
 if(!projection.canApply)throw Error('Сумма выше долга с процентами в расчётной модели');
 await mutate(s=>{
  if(paymentId){const original=s.loanPayments.find(x=>x.id===paymentId);if(!original||original.voidedAt)throw Error('Исходный платёж недоступен');const before=`${rubles(original.amountCents)}, ${original.date}`;Object.assign(original,{loanId,amountCents,date,strategy,updatedAt:new Date().toISOString()});audit(s,'payment-update',`Исправлена оплата ${loan.title}: ${before} → ${rubles(amountCents)}, ${date}`);}
  else{s.loanPayments.push({id:uuid(),loanId,amountCents,date,strategy,createdAt:new Date().toISOString()});audit(s,'payment',`Оплата «${loan.title}» ${rubles(amountCents)}; перерасчёт: ${strategy==='term'?'срок':'платёж'}`);}
 },paymentId?'Платёж исправлен, прогноз обновлён':'Фактический платёж сохранён и учтён в прогнозе');
 $('#payment-dialog').close();ui.selectedLoan=loanId;
}
async function saveSettlement(form){
 const entryId=formValue(form,'entryId'),occurrence=formValue(form,'occurrence'),date=formValue(form,'date'),amountCents=cents(formValue(form,'amount')),
 id=form.dataset.paymentId;
 if(amountCents<=0||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/\d{4}-\d{2}/.test(occurrence)||!state.entries.find(e=>e.id===entryId&&isActive(e)))throw Error('Некорректная фактическая операция');
 await mutate(s=>{if(id){const existing=s.settlements.find(p=>p.id===id);if(!existing||existing.voidedAt)throw Error('Операция не найдена');Object.assign(existing,{amountCents,date,updatedAt:new Date().toISOString()});audit(s,'fact-update',`Исправлена фактическая сумма: ${rubles(amountCents)}`);}
 else{s.settlements.push({id:uuid(),entryId,occurrence,date,amountCents,createdAt:new Date().toISOString()});audit(s,'fact-create',`Отмечено фактически: ${rubles(amountCents)}`);}},'Фактическая сумма учтена');$('#settlement-dialog').close();
}
async function performBackup(password){
 const file=await encryptBackup(await readState(),password);const url=URL.createObjectURL(new Blob([file],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`finansovyi-gorizont-${today()}-encrypted.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),12000);toast('Шифрованная резервная копия подготовлена');
}
async function performRestore(password){
 const decrypted=await decryptBackup(await restoreFile.text(),password);
 if(!await requireConfirm('Заменить локальные данные?', 'Импорт заменит всю текущую бухгалтерию данными из резервной копии. При необходимости сохраните текущую копию перед продолжением.'))return;
 await mutate(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,structuredClone(decrypted));audit(s,'restore-backup','Восстановлена резервная копия');},'Данные восстановлены');
}
async function onFormSubmit(event){
 const form=event.target;
 // A dialog cancel button must use the browser's native method="dialog" close path.
 if(event.submitter?.value==='cancel'&&form.closest('dialog'))return;
 event.preventDefault();if(busy)return;
 try{
  if(form.getAttribute('id')==='entry-form')await saveEntry(form);
  if(form.getAttribute('id')==='loan-form')await saveLoan(form);
  if(form.getAttribute('id')==='payment-form')await savePayment(form);
  if(form.getAttribute('id')==='settlement-form')await saveSettlement(form);
  if(form.getAttribute('id')==='rename-category-form'){const old=form.elements.old.value,newName=form.elements.newName.value.trim();if(!newName||newName.length>40)throw Error('Введите название категории');if(old.toLowerCase()!==newName.toLowerCase()&&state.categories.some(x=>x.toLowerCase()===newName.toLowerCase()))throw Error('Такая категория уже есть');await mutate(s=>{s.categories=s.categories.map(x=>x===old?newName:x);for(const e of s.entries)if(e.category===old)e.category=newName;audit(s,'category-rename',`Категория «${old}» переименована`);},'Категория обновлена');$('#category-dialog').close();}
  if(form.getAttribute('id')==='category-form'){
   const title=form.elements.namedItem('name').value.trim();if(!title||title.length>40)throw Error('Название категории должно быть от 1 до 40 символов');
   if(state.categories.some(x=>x.toLowerCase()===title.toLowerCase()))throw Error('Такая категория уже существует');
   await mutate(s=>{s.categories.push(title);audit(s,'category',`Добавлена категория: ${title}`);},'Категория добавлена');
  }
  if(form.getAttribute('id')==='password-form'){
   const password=form.elements.password.value;
   if(password.length<12)throw Error('Пароль должен содержать не менее 12 символов');
   if(passwordMode==='export')await performBackup(password);else await performRestore(password);
   form.elements.password.value='';$('#password-dialog').close();
  }
 }catch(e){fail(e);}
}
function bindEvents(){
 document.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-view]');if(nav){event.preventDefault();navigation(nav.dataset.view);return;}
  const actionEl=event.target.closest('[data-action]');if(actionEl){event.preventDefault();try{await handleAction(actionEl);}catch(e){fail(e);}return;}
 });
 document.addEventListener('submit',onFormSubmit);
 $('#theme-toggle').addEventListener('click',()=>{themeSet(document.body.dataset.theme==='dark'?'light':'dark');render();});
 $('#top-add').addEventListener('click',()=>openEntry());
 $('#payment-form').addEventListener('input',updatePaymentPreview);
 $('#payment-form').addEventListener('change',updatePaymentPreview);
 $('#payment-loan').addEventListener('change',()=>{const l=state.loans.find(x=>x.id===$('#payment-loan').value);if(l){$('#payment-form').elements.amount.value=numberInput(loanLedger(l,state.loanPayments).monthlyCents);updatePaymentPreview();}});
 $('#restore-file').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;if(file.size>8_000_000){toast('Файл превышает предел 8 МБ','error');return;}restoreFile=file;passwordMode='import';$('#password-heading').textContent='Восстановить резервную копию';$('#password-form').reset();openDialog('#password-dialog');});
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
 window.addEventListener('pageshow',event=>{
  if(!event.persisted||guestMode||!activeUserId)return;
  // A restored page from back/forward cache must re-validate authorization
  // before it can show any finance records.
  state=null;
  $('#main').textContent='Проверяем доступ к бухгалтерии…';
  void (async()=>{
   const verified=await emailSession.refresh();
   if(!verified||emailSession.userId!==activeUserId){
    window.location.replace('./account.html');
    return;
   }
   state=await readState();
   render();
  })().catch(()=>window.location.replace('./account.html'));
 });
 try{channel=new BroadcastChannel('financial-horizon-updates');channel.onmessage=async()=>{try{state=await readState();render();}catch(e){fail(e);}};}catch{}
}
async function init(){
 try{themeSet(localStorage.getItem('fh-theme')||((window.matchMedia?.('(prefers-color-scheme: dark)').matches)?'dark':'light'));}catch{themeSet('light');}
 bindEvents();
 if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
 try{
  const url=new URL(window.location.href);
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
      state=null;
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
