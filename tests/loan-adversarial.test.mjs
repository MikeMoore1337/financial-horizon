import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoan, reconcileLoanSchedule } from '../src/domain/loans/index.ts';

const terms = {
  principalCents: 100_000,
  startDate: '2026-01-01',
  firstDueDate: '2026-02-01',
  termMonths: 4,
  annualRateMicroPercent: 0,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  maxExtensionMonths: 0,
};
const pay = (date, amountCents, id = 'pay') => ({
  id, date, type: 'payment', paymentKind: 'regular', amountCents,
});

test('full settlement on the scheduled due date is retained as the last factual row', () => {
  const result = calculateLoan(terms, [pay('2026-02-01', 100_000)], {
    mode: 'actual', asOfDate: '2026-02-02',
  });
  assert.equal(result.complete, true);
  assert.equal(result.paidOffDate, '2026-02-01');
  assert.equal(result.actualOpenPeriod, null); // No duplication of the closed installment.
  assert.deepEqual(result.rows.map(row => ({
    date: row.date, amountCents: row.amountCents,
    principalCents: row.principalCents, balanceCents: row.balanceCents,
  })), [
    { date: '2026-02-01', amountCents: 100_000,
      principalCents: 100_000, balanceCents: 0 },
  ]);
  const compared = reconcileLoanSchedule(result, [{
    date: '2026-02-01', amountCents: 100_000, interestCents: 0,
    principalCents: 100_000, balanceCents: 0,
  }]);
  assert.equal(compared.exactMatch, true);
  assert.equal(compared.calculatedClosureDate, '2026-02-01');
});

test('full early settlement is never falsely dated as the next scheduled installment', () => {
  const result = calculateLoan(terms, [pay('2026-01-10', 100_000)], {
    mode: 'actual', asOfDate: '2026-01-15',
  });
  assert.equal(result.paidOffDate, '2026-01-10');
  assert.equal(result.rows.length, 0);
  assert.equal(result.actualOpenPeriod?.amountCents, 100_000);
  const comparison = reconcileLoanSchedule(result, [{
    date: '2026-01-10', amountCents: 100_000, interestCents: 0,
    principalCents: 100_000, balanceCents: 0,
  }]);
  assert.equal(comparison.calculatedClosureDate, '2026-01-10');
  assert.equal(comparison.importedClosureDate, '2026-01-10');
  assert.equal(comparison.closureDateDifferenceDays, 0);
  assert.equal(comparison.exactMatch, false); // No matching installment row for an extra payment.
});

test('stable, deterministic, seeded amortization conservation across 100 synthetic cases', () => {
  // This is a pure conservation oracle, independent of any bank-specific rules.
  let seed = 0x39aa2026;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const started = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) {
    const principal = 1 + (next() % 2_000_000);
    const months = 1 + (next() % 24);
    const rate = (next() % 31) * 1_000_000;
    const conventional = ['ACT/365F', 'ACT/360', 'ACT/ACT-ISDA', '30E/360'][next() % 4];
    const input = { ...terms, principalCents: principal, termMonths: months,
      annualRateMicroPercent: rate, dayCount: conventional, maxExtensionMonths: 0 };
    const result = calculateLoan(input, [], { mode: 'plan' });
    assert.equal(result.complete, true, 'case ' + i);
    assert.ok(result.rows.length >= 1 && result.rows.length <= months, 'case ' + i);
    assert.equal(result.principalBalanceCents, 0, 'case ' + i);
    assert.equal(result.unpaidInterestCents, 0, 'case ' + i);
    assert.equal(result.remainingDebtCents, 0, 'case ' + i);
    assert.equal(result.paidOffDate, result.rows.at(-1)?.date, 'case ' + i);
    const principalPaid = result.rows.reduce((sum, row) => sum + row.principalCents, 0);
    assert.equal(principalPaid, principal, 'case ' + i);
    let lastBalance = principal;
    for (const row of result.rows) {
      assert.equal(row.amountCents, row.principalCents + row.interestPaidCents, 'case ' + i);
      assert.equal(row.balanceCents, lastBalance - row.principalCents, 'case ' + i);
      assert.ok(row.balanceCents >= 0 && row.interestCents >= 0, 'case ' + i);
      assert.ok(row.balanceCents <= lastBalance, 'case ' + i);
      lastBalance = row.balanceCents;
    }
    assert.deepEqual(calculateLoan(input, [], { mode: 'plan' }), result, 'replay ' + i);
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
});

test('bank CSV without interest/principal never claims exact match', () => {
  const plan = calculateLoan(terms, [], { mode: 'plan' });
  const partial = plan.rows.map(row => ({
    date: row.date, amountCents: row.amountCents, balanceCents: row.balanceCents,
  }));
  const result = reconcileLoanSchedule(plan.rows, partial);
  assert.equal(result.matchingKnownFields, true);
  assert.equal(result.comparisonComplete, false);
  assert.equal(result.exactMatch, false);
  assert.equal(result.mismatchedRows, 0);
  assert.deepEqual(result.rows[0].missingFields, ['interestCents', 'principalCents']);
});

test('bank allocation gap remains visible instead of rejecting fee-bearing schedules', () => {
  const plan = calculateLoan(terms, [], { mode: 'plan' });
  const first = plan.rows[0];
  const bank = [{
    date: first.date, amountCents: first.amountCents + 50,
    interestCents: first.interestCents,
    principalCents: first.principalCents,
    balanceCents: first.balanceCents,
  }];
  const result = reconcileLoanSchedule([first], bank);
  assert.equal(result.rows[0].bankUnallocatedCents, 50);
  assert.equal(result.rows[0].amountDeltaCents, -50);
  assert.equal(result.exactMatch, false);
});

test('same-rate change effective on the installment date includes today in annuity recalculation', () => {
  const contract = { ...terms, termMonths: 2, annualRateMicroPercent: 12_000_000 };
  const original = calculateLoan(contract, [], { mode: 'plan' });
  const repriced = calculateLoan(contract, [{
    id: 'same-rate-on-due', type: 'rate-change', date: '2026-02-01',
    annualRateMicroPercent: 12_000_000,
  }], { mode: 'plan' });
  assert.equal(original.rows.length, 2);
  assert.deepEqual(repriced.rows, original.rows);
  assert.equal(repriced.paidOffDate, original.paidOffDate);
  assert.equal(repriced.scheduledPaymentCents, original.scheduledPaymentCents);
});

test('future due-date change cannot alter an actual snapshot before the event occurs', () => {
  const contract = { ...terms, termMonths: 2, annualRateMicroPercent: 12_000_000 };
  const asOfDate = '2026-02-01';
  const initial = calculateLoan(contract, [], { mode: 'actual', asOfDate });
  const withFuture = calculateLoan(contract, [{
    id: 'reschedule-march', type: 'due-date-change',
    date: '2026-02-10', dayOfMonth: 28,
  }], { mode: 'actual', asOfDate });
  assert.equal(initial.rows.length, 1);
  assert.deepEqual(withFuture, initial);
  assert.equal(initial.nextDueDate, '2026-03-01');
});

test('no paid-on-due amounts leak into an actual open period, in both factual and forecast views', () => {
  const payment = pay('2026-02-01', 100_000);
  for (const mode of ['actual', 'forecast']) {
    const result = calculateLoan(terms, [payment], { mode, asOfDate: '2026-02-02' });
    assert.equal(result.complete, true, mode);
    assert.equal(result.rows.length, 1, mode);
    assert.equal(result.rows[0].amountCents, 100_000, mode);
    assert.equal(result.actualOpenPeriod, null, mode);
    assert.equal(result.history.length, 1, mode);
  }
});

test('reduce-payment after the regular same-day due installment excludes the already-paid due', () => {
  const normal = pay('2026-02-01', 25_000, 'normal-february');
  const extra = {
    id: 'extra-february', date: '2026-02-01', type: 'payment',
    paymentKind: 'extra', amountCents: 15_000, strategy: 'reduce-payment',
  };
  for (const mode of ['actual', 'forecast']) {
    const actual = calculateLoan(terms, [normal, extra], {
      mode, asOfDate: '2026-02-02',
    });
    assert.equal(actual.rows[0].amountCents, 40_000, mode);
    assert.equal(actual.rows[0].plannedPaymentCents, 25_000, mode); // Original February obligation.
    assert.equal(actual.principalBalanceCents, mode === 'actual' ? 60_000 : 0, mode);
    assert.equal(actual.scheduledPaymentCents, 20_000, mode);
    assert.equal(actual.actualOpenPeriod, null, mode);
    if (mode === 'forecast') {
      assert.equal(actual.complete, true);
      assert.equal(actual.paidOffDate, '2026-05-01');
      assert.deepEqual(actual.rows.map(row => row.amountCents),
        [40_000, 20_000, 20_000, 20_000]);
    }
  }
});

test('due-day changes never rewrite already scheduled historical installments', () => {
  const contract = { ...terms, termMonths: 2, annualRateMicroPercent: 12_000_000 };
  const baseline = calculateLoan(contract, [], { mode: 'plan' });
  const change = {
    id: 'shift-next-month', date: '2026-02-10',
    type: 'due-date-change', dayOfMonth: 28,
  };
  const changed = calculateLoan(contract, [change], { mode: 'plan' });
  assert.equal(changed.rows[0].plannedPaymentCents, baseline.rows[0].plannedPaymentCents);
  assert.equal(changed.rows[0].amountCents, baseline.rows[0].amountCents);
  assert.equal(changed.rows[0].date, '2026-02-01');
  assert.equal(changed.rows[1].date, '2026-03-28');
  assert.equal(changed.scheduledPaymentCents, baseline.scheduledPaymentCents);
  const historical = calculateLoan(contract, [change], {
    mode: 'actual', asOfDate: '2026-02-20',
  });
  assert.equal(historical.rows[0].plannedPaymentCents, baseline.rows[0].plannedPaymentCents);
  assert.equal(historical.nextDueDate, '2026-03-28');
});

test('explicit due-date recalculate policy preserves the current due and amortizes on new dates', () => {
  const contract = {
    ...terms, termMonths: 2, annualRateMicroPercent: 12_000_000,
    dueDateChangePolicy: 'recalculate',
  };
  const baseline = calculateLoan(contract, [], { mode: 'plan' });
  const changedBetween = calculateLoan(contract, [{
    id: 'change-feb-10', type: 'due-date-change',
    date: '2026-02-10', dayOfMonth: 28,
  }], { mode: 'plan' });
  assert.deepEqual(changedBetween.rows.map(row => row.date), ['2026-02-01', '2026-03-28']);
  assert.equal(changedBetween.rows[0].amountCents, baseline.rows[0].amountCents);
  assert.equal(changedBetween.rows[1].balanceCents, 0);
  assert.equal(changedBetween.complete, true);
  assert.ok(changedBetween.scheduledPaymentCents > baseline.scheduledPaymentCents);
  const changedOnDue = calculateLoan(contract, [{
    id: 'change-at-due', type: 'due-date-change',
    date: '2026-02-01', dayOfMonth: 28,
  }], { mode: 'plan' });
  assert.equal(changedOnDue.rows[0].amountCents, baseline.rows[0].amountCents);
  assert.equal(changedOnDue.rows[0].date, baseline.rows[0].date);
  assert.equal(changedOnDue.rows[1].date, '2026-03-28');
  assert.equal(changedOnDue.rows[1].balanceCents, 0);
});

test('a later date change cannot affect an earlier same-rate repricing event', () => {
  const contract = { ...terms, termMonths: 2, annualRateMicroPercent: 12_000_000 };
  const unchanged = calculateLoan(contract, [], { mode: 'plan' });
  const result = calculateLoan(contract, [
    { id: 'rate-jan', type: 'rate-change',
      date: '2026-01-15', annualRateMicroPercent: 12_000_000 },
    { id: 'day-feb', type: 'due-date-change',
      date: '2026-02-10', dayOfMonth: 28 },
  ], { mode: 'plan' });
  assert.equal(result.rows[0].amountCents, unchanged.rows[0].amountCents);
  assert.equal(result.rows[0].plannedPaymentCents, unchanged.rows[0].plannedPaymentCents);
  assert.equal(result.rows[0].date, unchanged.rows[0].date);
  assert.equal(result.rows[1].date, '2026-03-28');
  assert.throws(() => calculateLoan({ ...contract, dueDateChangePolicy: 'unknown' },
    [], { mode: 'plan' }), RangeError);
});

test('rate change effective on due date updates the due amount before any payment', () => {
  const contract = { ...terms, termMonths: 2 };
  const baseline = calculateLoan(contract, [], { mode: 'plan' });
  const changed = calculateLoan(contract, [{
    id: 'rate-effective-feb-due', type: 'rate-change',
    date: '2026-02-01', annualRateMicroPercent: 12_000_000,
  }], { mode: 'plan' });
  assert.equal(baseline.rows[0].plannedPaymentCents, 50_000);
  assert.equal(changed.rows[0].plannedPaymentCents, changed.rows[0].amountCents);
  assert.ok(changed.rows[0].plannedPaymentCents > baseline.rows[0].plannedPaymentCents);
  assert.equal(changed.complete, true);
  assert.equal(changed.rows[1].balanceCents, 0);
});


test('explicit contractual installment change applies on due day without booking cash movement', () => {
  const change = { id:'contract-amendment', type:'payment-change',
    date:'2026-03-01', paymentCents:30_000 };
  const planned = calculateLoan(terms, [change], { mode:'plan' });
  assert.deepEqual(planned.rows.map(r=>r.plannedPaymentCents),
    [25_000,30_000,30_000,30_000]);
  assert.deepEqual(planned.rows.map(r=>r.amountCents),
    [25_000,30_000,30_000,15_000]);
  assert.equal(planned.complete, true);
  const actual = calculateLoan(terms, [change], { mode:'actual', asOfDate:'2026-03-01' });
  assert.deepEqual(actual.rows.map(r=>r.plannedPaymentCents), [25_000, 30_000]);
  assert.deepEqual(actual.rows.map(r=>r.amountCents), [0, 0]);
  assert.equal(actual.principalBalanceCents, terms.principalCents);
  assert.equal(actual.history[0]?.scheduledPaymentCents, 30_000);
  const future = calculateLoan(terms, [change], { mode:'actual', asOfDate:'2026-02-01' });
  const unchanged = calculateLoan(terms, [], { mode:'actual', asOfDate:'2026-02-01' });
  assert.deepEqual(future, unchanged);
  const voided = calculateLoan(terms, [{...change, voidedAt:'2026-04-01T00:00:00Z'}],
    { mode:'plan' });
  assert.deepEqual(voided, calculateLoan(terms, [], {mode:'plan'}));
});

test('payment-change is validated and explicit contractual amount overrides same-day rate change', () => {
  const common = { id:'amend',date:'2026-02-01',type:'payment-change' };
  for (const paymentCents of [0,-1,1.1,Number.MAX_SAFE_INTEGER]) {
    assert.throws(()=>calculateLoan(terms,[{...common,paymentCents}],{mode:'plan'}),RangeError);
  }
  assert.throws(()=>calculateLoan({...terms,scheduleType:'differentiated'},
    [{...common,paymentCents:25_000}],{mode:'plan'}),RangeError);
  const simultaneous = calculateLoan({...terms,annualRateMicroPercent:12_000_000}, [
    {id:'rate',date:'2026-02-01',type:'rate-change',annualRateMicroPercent:13_000_000},
    {...common,paymentCents:35_000},
  ],{mode:'plan'});
  assert.equal(simultaneous.rows[0].plannedPaymentCents, 35_000);
  assert.equal(simultaneous.history.find(x=>x.type==='payment-change')?.scheduledPaymentCents,35_000);
  assert.throws(() => calculateLoan(terms, [
    {...common,id:'first-change',paymentCents:25_000},
    {...common,id:'second-change',paymentCents:30_000},
  ], {mode:'plan'}), RangeError);
  assert.doesNotThrow(() => calculateLoan(terms, [
    {...common,id:'first-change',paymentCents:25_000,voidedAt:'2026-02-02'},
    {...common,id:'second-change',paymentCents:30_000},
  ], {mode:'plan'}));
});

test('manual payment change overrides same-day deferred due-date repricing in every mode', () => {
  const contract = { ...terms, dueDateChangePolicy: 'recalculate' };
  const changes = [
    {id:'due-change',type:'due-date-change',date:'2026-02-01',dayOfMonth:28},
    {id:'explicit-amount',type:'payment-change',date:'2026-02-01',paymentCents:30_000},
  ];
  const planned = calculateLoan(contract, changes, {mode:'plan'});
  assert.equal(planned.scheduledPaymentCents,30_000);
  assert.deepEqual(planned.rows.map(r=>r.date),
    ['2026-02-01','2026-03-28','2026-04-28','2026-05-28']);
  assert.deepEqual(planned.rows.map(r=>r.amountCents),
    [30_000,30_000,30_000,10_000]);
  for (const mode of ['actual','forecast']) {
    const result = calculateLoan(contract, changes,
      {mode,asOfDate:'2026-02-01'});
    assert.equal(result.scheduledPaymentCents,30_000,mode);
    assert.equal(result.rows[0].plannedPaymentCents,30_000,mode);
    assert.equal(result.rows[0].amountCents,0,mode);
  }
});
