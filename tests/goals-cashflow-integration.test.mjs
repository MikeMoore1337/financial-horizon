import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCashflow, adaptCashflowSources } from '../src/domain/cashflow/index.ts';
import {
  createGoal, applyGoalEvent, withGoalCashflowSources,
} from '../src/domain/goals/index.ts';

const base = (additional = {}) => ({
  openingDate:'2026-01-01', asOfDate:'2026-03-05', horizonMonths:12,
  accounts:[{id:'bank', currency:'RUB', openingBalanceCents:50_000_000}],
  reserves:[], plans:[], actuals:[], ...additional,
});
const start = (extra = {}) => createGoal({
  id:'goal',eventId:'create',on:'2026-01-01',title:'Резерв',
  targetCents:12_000_000,targetDate:'2027-01-01',...extra,
});
const funding = (goal, id, on, amountCents, extra = {}) =>
  applyGoalEvent(goal,{id,type:'contribution',on,amountCents,funding:'virtual',...extra});
const using = (goal, id, on, amountCents, extra = {}) =>
  applyGoalEvent(goal,{id,type:'use',on,amountCents,usage:'virtual-release',...extra});
const calc = (goals, source) => forecastCashflow(adaptCashflowSources(
  withGoalCashflowSources(source,goals,[{goalId:'goal',accountId:'bank'}])));

test('real #36: goal contributions reserve funds; bank cash and reported spending remain unchanged',()=>{
  const goal=funding(start(),'reserve-1','2026-02-01',3_000_000);
  const result=calc([goal],base());
  assert.equal(result.confirmedAsOfBalanceCents,50_000_000);
  assert.equal(result.confirmedAsOfReservedCents,3_000_000);
  assert.equal(result.planVsActual.actualExpenseCents,0);
  assert.equal(result.planVsActual.actualIncomeCents,0);
  assert.equal(result.days.find(x=>x.date==='2026-03-05').expectedAvailableCents,47_000_000);
});

test('real #36: one booked purchase plus goal release does not debit bank twice',()=>{
  let goal=funding(start(),'fund','2026-02-01',3_000_000);
  goal=using(goal,'purchase','2026-03-02',1_000_000,{
    usage:'expense', ledgerMovementId:'posted-expense',
  });
  const actuals=[{id:'posted-expense',date:'2026-03-02',amountCents:1_000_000,kind:'expense'}];
  const result=calc([goal],base({actuals}));
  assert.equal(result.confirmedAsOfBalanceCents,49_000_000);
  assert.equal(result.confirmedAsOfReservedCents,2_000_000);
  assert.equal(result.planVsActual.actualExpenseCents,1_000_000);
  assert.equal(result.days.find(x=>x.date==='2026-03-05').expectedAvailableCents,47_000_000);
});

test('real #36: confirmed internal transfer is not external cashflow, reserve reflects earmarking',()=>{
  const goal=funding(start(),'fund','2026-02-01',3_000_000,{
    funding:'account-transfer',ledgerMovementId:'posted-internal-transfer',
  });
  const result=calc([goal],base({actuals:[{
    id:'posted-internal-transfer',date:'2026-02-01',kind:'transfer',amountCents:3_000_000,
  }]}));
  assert.equal(result.confirmedAsOfBalanceCents,50_000_000);
  assert.equal(result.confirmedAsOfReservedCents,3_000_000);
  assert.equal(result.planVsActual.actualExpenseCents,0);
  assert.equal(result.planVsActual.actualIncomeCents,0);
});
