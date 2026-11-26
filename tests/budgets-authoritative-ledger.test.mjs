import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompleteFinanceState } from '../src/domain/accounts/server-snapshot.ts';
import { monthlyCashFlowMinor } from '../src/domain/accounts/ledger.ts';
import {
  calculateAuthoritativeLedgerBudgetReport,
  toAuthoritativeBudgetOperations,
  toBudgetOperations,
} from '../src/domain/budgets/ledger-adapter.ts';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = 'b0000000-0000-4000-8000-000000000001';
const PAY = 'e0000000-0000-4000-8000-000000000004';
const FACT = 'f0000000-0000-4000-8000-000000000005';
const REV = 'a0000000-0000-4000-8000-000000000006';
const LOAN = 'b0000000-0000-4000-8000-000000000007';
const EXP = 'b0000000-0000-4000-8000-000000000008';
const USER = 'a'.repeat(32);
const tx = (id, kind, day, amount, reversed = null, link) => ({
  id, kind: 'transaction', entity_revision: 1,
  data: { kind, occurred_on: day, note: null, posted_at: day+'T12:00:00Z',
    reversed_transaction_id: reversed, postings: [{ account_id: A, signed_minor: amount }],
    ...(link ? { payment_link: link } : {}) },
});
function wire(cancelled = false) {
  const entities = [
    { id: A, kind: 'account', entity_revision: 1, data: { name: 'Синтетический счёт',
      type: 'bank', currency: 'RUB', opening_minor: 1_000_000,
      balance_minor: cancelled ? 920_000 : 900_000,
      reserved_minor: 0, available_minor: cancelled ? 920_000 : 900_000, archived_at: null } },
    tx(PAY, 'payment', '2026-01-20', -100_000, null,
      { settlement_id: null, loan_payment_id: FACT }),
    { id: FACT, kind: 'loan_payment', entity_revision: cancelled ? 2 : 1,
      data: { loan_id: LOAN, paid_on: '2026-01-20', amount_minor: 100_000,
        strategy: 'term', voided_at: cancelled ? '2026-02-02T12:00:00Z' : null } },
  ];
  if (cancelled) entities.push(tx(REV, 'reversal', '2026-02-02', 100_000, PAY),
    tx(EXP, 'expense', '2026-02-02', -80_000));
  return { schema_version: 1, profile_id: P, revision: cancelled ? 4 : 2,
    currency: 'RUB', entities, server_at: '2026-02-02T12:15:00Z' };
}
const rules = [
  { id: 'all', profileId: P, scope: { kind: 'total' }, recurrence: 'monthly',
    fromMonth: '2026-01', limitMinor: 1_000_000 },
  { id: 'food', profileId: P, scope: { kind: 'category', categoryId: 'food' },
    recurrence: 'monthly', fromMonth: '2026-01', limitMinor: 1_000_000 },
];
const assign = id => ({ profileId: P, transactionId: id, categoryId: 'food' });
const report = (ledger, month, assignments) =>
  calculateAuthoritativeLedgerBudgetReport({ snapshot: ledger, month, rules, assignments });

test('authoritative #33 confirmed linked payment consumes budget exactly once', () => {
  const ledger = decodeCompleteFinanceState(wire(), P, USER).ledger;
  const result = report(ledger, '2026-01', [assign(PAY)]);
  assert.equal(result.confirmedExpenseMinor, 100_000);
  assert.equal(result.total.remainingMinor, 900_000);
  assert.equal(result.categories[0].spentMinor, 100_000);
  assert.equal(result.uncategorizedExpenseMinor, 0);
});

test('atomic void removes original budget spending without rewriting the #33 cash flow', () => {
  const input = wire(true), before = structuredClone(input);
  const ledger = decodeCompleteFinanceState(input, P, USER).ledger;
  const beforeLedger = structuredClone(ledger);
  const assignments = [assign(PAY), assign(EXP)];
  assert.equal(report(ledger, '2026-01', assignments).total.spentMinor, 0);
  const february = report(ledger, '2026-02', assignments);
  assert.equal(february.total.spentMinor, 80_000);
  assert.equal(february.categories[0].spentMinor, 80_000);
  assert.equal(monthlyCashFlowMinor(ledger, '2026-01').expenseMinor, 100_000);
  assert.equal(monthlyCashFlowMinor(ledger, '2026-02').expenseMinor, -20_000);
  const operations = toAuthoritativeBudgetOperations(ledger, assignments);
  const voided = operations.find(x => x.id === PAY);
  assert.equal(voided.status, 'voided');
  assert.equal(voided.categoryId, 'food');
  assert.equal(operations.some(x => x.id === REV), false);
  assert.deepEqual(ledger, beforeLedger);
  assert.deepEqual(input, before);
});

test('structural adapter still rejects a reversal even when a proof-shaped field is supplied', () => {
  const ledger = decodeCompleteFinanceState(wire(true), P, USER).ledger;
  assert.throws(() => toBudgetOperations(ledger), /atomic fact cancellation/);
});

test('missing, mismatched, duplicated and foreign void proofs cannot hide spending', () => {
  const ledger = decodeCompleteFinanceState(wire(true), P, USER).ledger;
  for (const tamper of [
    x => { delete x.linkedPaymentVoids; },
    x => { x.linkedPaymentVoids[0].factId = A; },
    x => { x.linkedPaymentVoids.push(structuredClone(x.linkedPaymentVoids[0])); },
    x => { x.linkedPaymentVoids[0].profileId = A; },
    x => { x.linkedPaymentVoids[0].entityRevision = 1; },
    x => { x.linkedPaymentVoids[0].reversedByTransactionId = EXP; },
    x => { x.postings.find(p => p.transactionId === REV).signedMinor = 10; },
  ]) {
    const corrupt = structuredClone(ledger);
    tamper(corrupt);
    assert.throws(() => report(corrupt, '2026-01', [assign(PAY)]));
  }
});
