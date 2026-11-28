import test from 'node:test';
import assert from 'node:assert/strict';
import {projectAuthorizedCashflow} from '../src/domain/cashflow/server-projection.ts';
import {createGoal} from '../src/domain/goals/engine.ts';

const id = n => 'c0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const [P,A,BILL,SALARY,R,F,T,V,L,LF,G,GE,RE,VE] = Array.from({length:14},(_,i)=>id(i+1));
const USER = 'a'.repeat(32);
const entity = (kind,id,data,entity_revision=1) => ({kind,id,data,entity_revision});
const obligation = (id, direction, starts_on, amount_minor, recurrence_unit='none', recurrence_every=1) =>
  entity('obligation',id,{title:'Синтетический план',direction,starts_on,amount_minor,
    recurrence_unit,recurrence_every,timezone:'UTC',category:null,deleted_at:null});
const txn = (id,kind,occurred_on,signed_minor,extra={}) =>
  entity('transaction',id,{kind,occurred_on,posted_at:occurred_on+'T12:00:00Z',note:null,
    reversed_transaction_id:null,postings:[{account_id:A,signed_minor}],...extra});
const settlement = (on,paid,amount,voided=false) =>
  entity('settlement',F,{obligation_id:BILL,occurrence_on:on,paid_on:paid,
    amount_minor:amount,voided_at:voided?'2026-11-09T12:00:00Z':null},voided?2:1);
const checkpoint = (opening='2026-11-01',cash=2_000_000) =>
  ({profileId:P,revision:20,openingDate:opening,accounts:[{id:A,currency:'RUB',openingBalanceCents:cash}]});
function wire(rows=[], reserved=0, cash=2_000_000) {
  const balance=rows.filter(e=>e.kind==='transaction')
    .flatMap(e=>e.data.postings).reduce((sum,p)=>sum+p.signed_minor,cash);
  return {schema_version:1,profile_id:P,currency:'RUB',revision:20,next_cursor:null,
    entities:[entity('account',A,{name:'Синтетический счёт',type:'bank',currency:'RUB',
      opening_minor:cash,balance_minor:balance,reserved_minor:reserved,available_minor:balance-reserved,
      archived_at:null}),...rows]};
}
const project = (raw,horizon=1,cp=checkpoint(),asOf='2026-11-10') =>
  projectAuthorizedCashflow(raw,P,USER,cp,asOf,horizon);
const on = (p,date) => {
  const result=p.result.days.find(d=>d.date===date);
  assert.ok(result,date);
  return result;
};

test('authorized obligation and salary are projected at all horizons from one revision',()=>{
  const raw=wire([obligation(BILL,'expense','2026-11-12',2_500_000),
    obligation(SALARY,'income','2026-11-20',5_000_000)]);
  const original=structuredClone(raw);
  for(const h of [1,3,6,12]){
    const p=project(raw,h);
    assert.deepEqual(p.result.firstCashGap,{date:'2026-11-12',shortfallCents:500_000});
    assert.equal(on(p,'2026-11-20').expectedBalanceCents,4_500_000);
    assert.equal(p.revision,20);
  }
  assert.deepEqual(raw,original);
});

test('an explicitly covered old debt is carried without rewriting current plan/fact',()=>{
  const raw=wire([obligation(BILL,'expense','2026-10-12',100_000,'month')]);
  const p=project(raw);
  assert.equal(p.result.totalOverdueExpenseCents,100_000);
  assert.equal(p.result.planVsActual.plannedExpenseCents,0);
  assert.equal(on(p,'2026-11-10').expectedBalanceCents,1_900_000);
  assert.equal(p.result.occurrences.find(o=>o.date==='2026-10-12').overdue,true);
  assert.equal(on(p,'2026-11-12').projectedExpenseCents,100_000);
});

test('old payment already in checkpoint does not create a second debit or debt',()=>{
  const raw=wire([obligation(BILL,'expense','2026-10-12',100_000,'month'),
    settlement('2026-10-12','2026-10-12',100_000),
    txn(T,'payment','2026-10-12',-100_000,{payment_link:{settlement_id:F,loan_payment_id:null}})]);
  const p=project(raw,1,checkpoint('2026-11-01',1_900_000));
  assert.equal(p.result.totalOverdueExpenseCents,0);
  assert.equal(p.result.confirmedAsOfBalanceCents,1_900_000);
  assert.equal(p.result.planVsActual.actualExpenseCents,0);
  assert.equal(on(p,'2026-11-12').projectedExpenseCents,100_000);
});

test('yearly cadence and leap-year month anchors do not drift',()=>{
  const start='2028-01-01';
  const raw=wire([obligation(BILL,'expense','2028-01-31',10_000,'month'),
    obligation(SALARY,'income','2028-02-29',50_000,'year',6)]);
  const p=project(raw,3,checkpoint(start),'2028-01-10');
  assert.deepEqual(p.result.occurrences.filter(x=>x.kind==='obligation').map(x=>x.date),
    ['2028-01-31','2028-02-29','2028-03-31']);
  assert.equal(on(p,'2028-02-29').projectedIncomeCents,50_000);
});

function reserve(events=[],allocated=500_000,overrides={}){
  return entity('reserve',R,{title:'Синтетический резерв',target_minor:2_500_000,
    target_on:'2026-11-15',archived_at:null,allocated_minor:allocated,obligation_id:BILL,
    account_id:A,opened_on:'2026-11-01',first_due_on:'2026-11-15',period_months:1,due_day:15,
    contribution_mode:'fixed',fixed_monthly_minor:200_000,opening_reserved_minor:500_000,
    opening_target_minor:2_500_000,cycle_number:1,
    allocations_by_account:allocated?[{account_id:A,allocated_minor:allocated}]:[],event_log:events,
    ...overrides},events.length+1);
}
function goal(){
  const record=createGoal({id:G,eventId:GE,on:'2026-11-02',title:'Цель',
    targetCents:100_000,targetDate:'2027-01-01',openingCents:100_000});
  return entity('goal',G,{account_id:A,saved_minor:100_000,event_log:record.events},record.events.length);
}
const baseBill=()=>obligation(BILL,'expense','2026-11-12',2_500_000,'month');
const reservePayment={id:RE,reserve_id:R,revision:5,cycle_number:1,
  occurred_on:'2026-11-06',kind:'payment',amount_minor:300_000,reserved_used_minor:300_000,
  transaction_id:T};
const postedReserve=()=>txn(T,'payment','2026-11-06',-300_000,{
  payment_link:{settlement_id:F,loan_payment_id:null},
  reserve_allocation:{id:id(99),reserve_id:R,account_id:A,delta_minor:-300_000,reverses_allocation_id:null}});

test('mandatory reserve replaces its obligation date; goal lock is added exactly once',()=>{
  const p=project(wire([baseBill(),reserve(),goal()],600_000),3);
  assert.equal(p.result.confirmedAsOfBalanceCents,2_000_000);
  assert.equal(p.result.confirmedAsOfReservedCents,600_000);
  assert.equal(on(p,'2026-11-12').projectedExpenseCents,0);
  assert.equal(on(p,'2026-11-15').projectedExpenseCents,2_500_000);
  assert.equal(on(p,'2026-11-15').expectedBalanceCents,-500_000);
  assert.equal(on(p,'2026-11-15').expectedReservedCents,100_000);
  assert.deepEqual(p.result.firstCashGap,{date:'2026-11-15',shortfallCents:600_000});
  assert.equal(on(p,'2026-12-15').projectedExpenseCents,2_500_000);
  assert.equal(on(p,'2026-12-12').projectedExpenseCents,0);
});

test('reserve payment releases only the posted portion and keeps one expense',()=>{
  const p=project(wire([baseBill(),reserve([reservePayment],200_000),goal(),
    settlement('2026-11-15','2026-11-06',300_000),postedReserve()],300_000));
  assert.equal(p.result.confirmedAsOfBalanceCents,1_700_000);
  assert.equal(p.result.confirmedAsOfReservedCents,300_000);
  assert.equal(p.result.planVsActual.actualExpenseCents,300_000);
  assert.equal(on(p,'2026-11-15').projectedExpenseCents,2_200_000);
  assert.equal(on(p,'2026-11-15').expectedBalanceCents,-500_000);
  assert.equal(on(p,'2026-11-15').expectedReservedCents,100_000);
});

test('reserve payment void compensates cash and lock on the actual reversal date',()=>{
  const voidEvent={id:VE,reserve_id:R,revision:6,cycle_number:1,
    occurred_on:'2026-11-09',kind:'void',target_event_id:RE};
  const rev=txn(V,'reversal','2026-11-09',300_000,{reversed_transaction_id:T,
    reserve_allocation:{id:id(100),reserve_id:R,account_id:A,delta_minor:300_000,
      reverses_allocation_id:id(99)}});
  const p=project(wire([baseBill(),reserve([reservePayment,voidEvent]),goal(),
    settlement('2026-11-15','2026-11-06',300_000,true),postedReserve(),rev],600_000));
  assert.equal(on(p,'2026-11-06').confirmedBalanceCents,1_700_000);
  assert.equal(on(p,'2026-11-06').confirmedReservedCents,300_000);
  assert.equal(on(p,'2026-11-09').confirmedBalanceCents,2_000_000);
  assert.equal(on(p,'2026-11-09').confirmedReservedCents,600_000);
  assert.equal(on(p,'2026-11-15').projectedExpenseCents,2_500_000);
});

test('closed reserve cycle is not charged again and future cadence is retained',()=>{
  const paid={...reservePayment,amount_minor:2_500_000,reserved_used_minor:500_000};
  const close={id:VE,reserve_id:R,revision:6,cycle_number:1,occurred_on:'2026-11-07',kind:'cycle_close'};
  const post=txn(T,'payment','2026-11-06',-2_500_000,{
    payment_link:{settlement_id:F,loan_payment_id:null},
    reserve_allocation:{id:id(99),reserve_id:R,account_id:A,delta_minor:-500_000,reverses_allocation_id:null}});
  const p=project(wire([baseBill(),reserve([paid,close],0,{target_on:'2026-12-15',cycle_number:2}),
    settlement('2026-11-15','2026-11-06',2_500_000),post],0,3_000_000),3,
    checkpoint('2026-11-01',3_000_000));
  assert.equal(p.result.confirmedAsOfBalanceCents,500_000);
  assert.equal(on(p,'2026-11-15').projectedExpenseCents,0);
  assert.equal(on(p,'2026-12-15').projectedExpenseCents,2_500_000);
});

test('loan payoff uses the current approximate calendar and never posts another installment',()=>{
  const loan=entity('loan',L,{title:'Кредит',opening_minor:1_000_000,payment_minor:100_000,
    apr_basis_points:0,term_months:10,due_day:12,as_of_date:'2026-11-01',calculation_version:1,
    imported_schedule:null,deleted_at:null});
  const fact=entity('loan_payment',LF,{loan_id:L,paid_on:'2026-11-06',amount_minor:1_000_000,
    strategy:'term',voided_at:null});
  const p=project(wire([loan,fact,txn(T,'payment','2026-11-06',-1_000_000,
    {payment_link:{settlement_id:null,loan_payment_id:LF}})]),12);
  assert.equal(p.loanProjection,'estimated-calendar');
  assert.equal(p.result.confirmedAsOfBalanceCents,1_000_000);
  assert.equal(p.result.expectedClosingBalanceCents,1_000_000);
  assert.equal(p.result.planVsActual.actualExpenseCents,1_000_000);
  assert.equal(p.result.days.some(d=>d.projectedExpenseCents!==0),false);
});

test('incomplete, stale and ambiguous reserve data fail closed',()=>{
  const raw=wire([baseBill(),reserve(),goal()],600_000);
  assert.throws(()=>project({...raw,next_cursor:'partial'}));
  assert.throws(()=>project(raw,1,{...checkpoint(),revision:19}));
  const wrong=structuredClone(raw);
  wrong.entities[0].data.reserved_minor=500_000;
  wrong.entities[0].data.available_minor=1_500_000;
  assert.throws(()=>project(wrong));
  const missing=wire([baseBill(),reserve([reservePayment],200_000)],200_000);
  assert.throws(()=>project(missing),/проводка|проводкой/);
  const legacy=wire([baseBill(),reserve([],500_000,{period_months:null})],500_000);
  assert.throws(()=>project(legacy),/Старый резерв/);
  const ambiguous=wire([obligation(BILL,'expense','2026-11-01',2_500_000,'month'),
    reserve([],500_000,{opened_on:'2026-11-02'})],500_000);
  assert.throws(()=>project(ambiguous),/неоднозначен/);
});
