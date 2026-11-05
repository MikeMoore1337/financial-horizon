import test from 'node:test';
import assert from 'node:assert/strict';
import {cents,rubles,loanLedger,payoffMonths,annuityMonthly,previewLoanPayment,getMonthEvents,monthTotals,createSampleState,emptyState,entryDueDate,shiftMonth} from '../finance.js';
import {parseCsv,parseSchedule} from '../schedule.js';
const loan={id:'m',openingCents:210000000,paymentCents:3020000,apr:9.5,termMonths:245,dueDay:16,asOfDate:'2026-11-01'};
test('exact cent arithmetic and input validation',()=>{
 assert.equal(cents('1 234,56'),123456);assert.equal(cents('0.05'),5);assert.equal(cents('12'),1200);
 for(const v of ['-1','1.234','3a','Infinity','99999999999999999']) assert.throws(()=>cents(v));
});
test('monthly annuity loan preview applies interest before principal',()=>{
 const preview=previewLoanPayment(loan,[],4500000,'2026-11-16','term');
 assert.equal(preview.interestPaidCents,1662500);
 assert.equal(preview.principalPaidCents,2837500);
 assert.equal(preview.outstandingCents,207162500);
 assert.ok(preview.months<payoffMonths(loan.openingCents,loan.paymentCents,loan.apr));
 assert.equal(preview.canApply,true);
});
test('payment reducing installment yields lower monthly sum',()=>{
 const p=previewLoanPayment(loan,[],4500000,'2026-11-16','amount');
 assert.ok(p.monthlyCents<loan.paymentCents);
 assert.ok(p.months>0);
});
test('voided loan payment is excluded and replay is deterministic',()=>{
 const payment={id:'x',loanId:'m',date:'2026-11-16',amountCents:4500000,strategy:'term',createdAt:'2026-11-16T12:00:00Z'};
 assert.notEqual(loanLedger(loan,[payment]).outstandingCents,loan.openingCents);
 assert.equal(loanLedger(loan,[{...payment,voidedAt:'2026-11-20'}]).outstandingCents,loan.openingCents);
});
test('missed interest coverage does not reduce principal',()=>{
 const p=previewLoanPayment(loan,[],100000,'2026-11-16','term');
 assert.equal(p.principalPaidCents,0);
 assert.equal(p.outstandingCents,loan.openingCents);
 assert.ok(p.unpaidInterestCents>0);
});
test('term cannot be calculated when payment cannot cover interest',()=>{
 assert.equal(payoffMonths(10000000,2000,20),null);
 assert.equal(annuityMonthly(10000000,0,10),1000000);
});
test('plan/fact recurring and leap-year dates',()=>{
 const s=createSampleState(),events=getMonthEvents(s,'2026-11');const t=monthTotals(events);
 assert.equal(t.incomeCents,18000000);
 assert.equal(t.expenseCents,1250000+280000+3000000+3020000);
 assert.equal(t.netPlanCents,10450000);
});
test('yearly and monthly recurring dates clamp to February',()=>{
 const entry={id:'e',kind:'expense',recurrence:'monthly',date:'2026-01-31',amountCents:10000};
 assert.equal(entryDueDate(entry,'2028-02'),'2028-02-29');
 assert.equal(entryDueDate(entry,'2027-02'),'2027-02-28');
 assert.equal(shiftMonth('2026-12',1),'2027-01');
});
test('CSV schedule import supports quoted delimiter and Russian headers',()=>{
 const text='Дата;Платёж;Проценты;Основной долг;Остаток\n16.11.2026;"30 200,00";"16 625,00";"13 575,00";"2 086 425,00"\n16.12.2026;30200;16500;13700;2072725\n';
 const rows=parseSchedule(text);assert.equal(rows.length,2);assert.equal(rows[0].amountCents,3020000);assert.equal(rows[0].balanceCents,208642500);
 assert.throws(()=>parseSchedule('Date;Payment;Balance\n2026-12-01;100;500\n2026-11-01;100;400'));
});
