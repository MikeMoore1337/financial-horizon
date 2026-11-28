import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfirmedCashflowLedger} from '../src/domain/cashflow/confirmed-ledger.ts';
import {adaptCashflowSources, forecastCashflow} from '../src/domain/cashflow/index.ts';

const id = n => 'b0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const P = id(1), A = id(2), B = id(3), BILL = id(4), FACT = id(5), PAY = id(6);
const REV = id(7), LOAN = id(8), LOANFACT = id(9);
const USER = 'a'.repeat(32);
const entity = (kind, id, data, entity_revision = 1) => ({kind, id, data, entity_revision});
const bill = () => entity('obligation', BILL, {direction: 'expense'});
const fact = (voided = false) => entity('settlement', FACT, {
  obligation_id: BILL, occurrence_on: '2026-11-12',
  paid_on: '2026-11-06', amount_minor: 500_000,
  voided_at: voided ? '2026-11-09T12:00:00Z' : null,
}, voided ? 2 : 1);
const tx = (id, kind, date, postings, extra = {}) => entity('transaction', id, {
  kind, occurred_on: date, note: null, reversed_transaction_id: null,
  postings: postings.map(([account_id, signed_minor]) => ({account_id, signed_minor})),
  ...extra,
});
const payment = () => tx(PAY, 'payment', '2026-11-06', [[A, -500_000]],
  {payment_link: {settlement_id: FACT}});
const reversal = (date = '2026-11-09') =>
  tx(REV, 'reversal', date, [[A, 500_000]], {reversed_transaction_id: PAY});
function wire(rows = [], initial = [[A, 2_000_000]], reserved = {}) {
  const accounts = initial.map(([account, opening]) => {
    const balance = rows.filter(e => e.kind === 'transaction')
      .flatMap(e => e.data.postings).filter(p => p.account_id === account)
      .reduce((sum, p) => sum + p.signed_minor, opening);
    const allocated = reserved[account] ?? 0;
    return entity('account', account, {
      name: account, type: 'bank', currency: 'RUB', opening_minor: opening,
      balance_minor: balance, reserved_minor: allocated, available_minor: balance - allocated,
      archived_at: null,
    });
  });
  return {schema_version: 1, profile_id: P, currency: 'RUB', revision: 12,
    entities: [...accounts, bill(), ...rows], next_cursor: null};
}
const checkpoint = (balances = [[A, 2_000_000]], openingDate = '2026-11-01') => ({
  profileId: P, revision: 12, openingDate,
  accounts: balances.map(([id, openingBalanceCents]) => ({id, currency: 'RUB', openingBalanceCents})),
});
const read = (raw, cp = checkpoint(), asOf = '2026-11-10') =>
  readConfirmedCashflowLedger(raw, P, USER, cp, asOf);
const plans = [{id: BILL, kind: 'obligation', dueDate: '2026-11-12', amountCents: 2_500_000},
  {id: 'salary', kind: 'income', dueDate: '2026-11-20', amountCents: 5_000_000}];
function project(ledger, horizonMonths = 1, extra = {}) {
  return forecastCashflow(adaptCashflowSources({...ledger, horizonMonths, plans, reserves: [], ...extra}));
}
const on = (result, date) => {
  const row = result.days.find(d => d.date === date);
  assert.ok(row, date);
  return row;
};

test('confirmed checkpoint feeds mandatory cash gap at every horizon', () => {
  const ledger = read(wire(), checkpoint(), '2026-11-08');
  for (const horizon of [1, 3, 6, 12]) {
    const result = project(ledger, horizon);
    assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
    assert.deepEqual(result.firstCashGap, {date: '2026-11-12', shortfallCents: 500_000});
  }
});

test('linked partial settlement is one posted debit and reduces only the residual', () => {
  const raw = wire([fact(), payment()]);
  const before = structuredClone(raw);
  const ledger = read(raw);
  assert.deepEqual(raw, before);
  assert.equal(ledger.actuals.length, 1);
  assert.equal(ledger.actuals[0].planId, BILL);
  assert.equal(ledger.actuals[0].occurrenceDate, '2026-11-12');
  const result = project(ledger);
  assert.equal(result.confirmedAsOfBalanceCents, 1_500_000);
  assert.equal(result.planVsActual.actualExpenseCents, 500_000);
  assert.equal(on(result, '2026-11-12').projectedExpenseCents, 2_000_000);
  assert.deepEqual(result.firstCashGap, {date: '2026-11-12', shortfallCents: 500_000});
});

test('voided linked settlement restores remaining debt but preserves posting-date cash history', () => {
  const ledger = read(wire([fact(true), payment(), reversal()]));
  assert.equal(ledger.actuals.length, 1);
  assert.equal(ledger.actuals[0].reversedOn, '2026-11-09');
  assert.equal(ledger.actuals[0].voided, true);
  const result = project(ledger);
  assert.equal(on(result, '2026-11-06').confirmedBalanceCents, 1_500_000);
  assert.equal(on(result, '2026-11-09').confirmedBalanceCents, 2_000_000);
  assert.equal(on(result, '2026-11-09').actualExpenseCents, -500_000);
  assert.equal(on(result, '2026-11-09').actualIncomeCents, 0);
  assert.equal(result.planVsActual.actualExpenseCents, 0);
  assert.equal(on(result, '2026-11-12').projectedExpenseCents, 2_500_000);
  assert.deepEqual(result.firstCashGap, {date: '2026-11-12', shortfallCents: 500_000});
});

test('compensation within the window does not repeat an original before its opening', () => {
  const ledger = read(wire([fact(true), payment(), reversal()]),
    checkpoint([[A, 1_500_000]], '2026-11-08'));
  const result = project(ledger);
  assert.equal(on(result, '2026-11-08').confirmedBalanceCents, 1_500_000);
  assert.equal(on(result, '2026-11-09').confirmedBalanceCents, 2_000_000);
  assert.equal(result.planVsActual.actualExpenseCents, -500_000);
  assert.equal(on(result, '2026-11-12').projectedExpenseCents, 2_500_000);
});

test('own-account transfers, fees and adjustments retain distinct cash semantics', () => {
  const initial = [[A, 2_000_000], [B, 100_000]];
  const raw = wire([
    tx(id(10), 'transfer', '2026-11-05', [[A, -300_000], [B, 300_000]]),
    tx(id(11), 'expense', '2026-11-05', [[A, -1000]]),
    tx(id(12), 'adjustment', '2026-11-05', [[B, 10000]]),
  ], initial, {[B]: 100_000});
  const ledger = read(raw, checkpoint(initial));
  assert.equal(ledger.actuals.length, 2);
  assert.equal(ledger.confirmedAsOfReservedCents, 100_000);
  const result = project(ledger, 1, {reserves: [{id: 'reserve', accountId: B,
    openingReservedCents: 100_000}]});
  assert.equal(result.confirmedAsOfBalanceCents, 2_109_000);
  assert.equal(result.confirmedAdjustmentCents, 10_000);
  assert.equal(result.planVsActual.actualExpenseCents, 1000);
  assert.equal(result.planVsActual.actualIncomeCents, 0);
  assert.equal(result.confirmedAsOfReservedCents, 100_000);
});

test('confirmed early loan payment is not inferred to settle an arbitrary installment', () => {
  const ledger = read(wire([
    entity('loan', LOAN, {}),
    entity('loan_payment', LOANFACT, {loan_id: LOAN, paid_on: '2026-11-06',
      amount_minor: 100_000, voided_at: null}),
    tx(PAY, 'payment', '2026-11-06', [[A, -100_000]], {payment_link: {loan_payment_id: LOANFACT}}),
  ]));
  assert.equal(ledger.actuals.length, 1);
  assert.equal(ledger.actuals[0].planId, undefined);
  assert.equal(ledger.actuals[0].kind, 'expense');
  assert.equal(project(ledger, 1, {plans: []}).confirmedAsOfBalanceCents, 1_900_000);
});

test('missing, stale, foreign, duplicate or mismatched checkpoints fail closed', () => {
  const raw = wire([fact(), payment()]);
  const cp = checkpoint();
  for (const invalid of [null, {...cp, revision: 11}, {...cp, profileId: id(99)},
    {...cp, accounts: []}, {...cp, accounts: [cp.accounts[0], cp.accounts[0]]},
    checkpoint([[B, 2_000_000]]), checkpoint([[A, 1_500_000]]),
    checkpoint([[A, 2_000_000.5]])]) {
    assert.throws(() => readConfirmedCashflowLedger(raw, P, USER, invalid, '2026-11-10'));
  }
  assert.throws(() => read({...raw, next_cursor: 'partial'}));
  assert.throws(() => read({...raw, profile_id: id(99)}));
  assert.throws(() => read(raw, cp, '2026-11-05'));
});

test('unlinked and inconsistent settled facts cannot disappear from cash', () => {
  assert.throws(() => read(wire([fact()])), /Активная оплата/);
  for (const update of [{amount_minor: 500_001}, {paid_on: '2026-11-07'},
    {obligation_id: id(99)}, {occurrence_on: '2026-02-30'}]) {
    const wrong = fact();
    Object.assign(wrong.data, update);
    assert.throws(() => read(wire([wrong, payment()])));
  }
});

test('invalid dated reversals fail even when logical void is truthy', () => {
  for (const extra of [
    {voided: true, reversedOn: '2026-11-05'},
    {voided: true, reversedOn: '2026-11-11'},
    {voided: true, reversedOn: ''},
    {voided: false, reversedOn: '2026-11-09'},
    {voided: 'true', reversedOn: '2026-11-09'},
  ]) {
    assert.throws(() => project(read(wire()), 1, {actuals: [
      {id: PAY, kind: 'expense', date: '2026-11-06', amountCents: 500_000, ...extra},
    ]}));
  }
});
