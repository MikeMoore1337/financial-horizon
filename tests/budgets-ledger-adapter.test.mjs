import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLedgerBudgetReport, toBudgetOperations } from '../src/domain/budgets/ledger-adapter.ts';

const profileId = 'profile-a';
const total = { id: 'main', profileId, scope: { kind: 'total' }, limitMinor: 1_000_000,
  recurrence: 'monthly', fromMonth: '2026-01' };
const category = (id) => ({ id: `rule-${id}`, profileId, scope: { kind: 'category', categoryId: id },
  limitMinor: 300_000, recurrence: 'monthly', fromMonth: '2026-01' });
const tx = (id, kind, occurredOn = '2026-01-15', reversedTransactionId = null) =>
  ({ id, profileId, kind, occurredOn, reversedTransactionId });
const post = (transactionId, accountId, signedMinor) =>
  ({ profileId, transactionId, accountId, signedMinor });
const assignment = (transactionId, categoryId) => ({ profileId, transactionId, categoryId });
const snapshot = (transactions, postings, paymentLinks = []) =>
  ({ profileId, transactions, postings, paymentLinks });

const fixture = () => snapshot([
  tx('expense', 'expense'), tx('transfer', 'transfer'), tx('loan', 'payment'),
  tx('income', 'income'), tx('reservation', 'adjustment'),
], [
  post('expense', 'bank-a', -150_000),
  post('transfer', 'bank-a', -300_000), post('transfer', 'bank-b', 300_000),
  post('loan', 'bank-a', -20_000), post('income', 'bank-b', 50_000),
  post('reservation', 'bank-a', -10_000),
], [{ profileId, transactionId: 'loan', loanPaymentId: 'fact-01' }]);

test('published #33-shape snapshot produces actual outflows but not transfer/reserve/income', () => {
  const ledger = fixture();
  const result = calculateLedgerBudgetReport({
    snapshot: ledger, month: '2026-01', rules: [total, category('food')],
    assignments: [assignment('expense', 'food'), assignment('loan', 'food')],
  });
  assert.equal(result.confirmedExpenseMinor, 170_000);
  assert.equal(result.total.remainingMinor, 830_000);
  assert.equal(result.categories[0].spentMinor, 170_000);
  assert.equal(result.total.plannedMinor, 0);
  assert.equal(ledger.transactions[0].kind, 'expense');
});

test('category reassignment does not touch immutable ledger postings', () => {
  const ledger = fixture();
  const first = calculateLedgerBudgetReport({ snapshot: ledger, month: '2026-01',
    rules: [total, category('food'), category('travel')],
    assignments: [assignment('expense', 'food')] });
  const moved = calculateLedgerBudgetReport({ snapshot: ledger, month: '2026-01',
    rules: [total, category('food'), category('travel')],
    assignments: [assignment('expense', 'travel')] });
  assert.deepEqual(first.categories.map(x => x.spentMinor), [150_000, 0]);
  assert.deepEqual(moved.categories.map(x => x.spentMinor), [0, 150_000]);
  assert.equal(moved.total.spentMinor, first.total.spentMinor);
  assert.equal(ledger.postings[0].signedMinor, -150_000);
});

test('later append-only reversal removes January expense but does not subtract February', () => {
  const ledger = snapshot([
    tx('old', 'expense', '2026-01-30'), tx('undo', 'reversal', '2026-02-01', 'old'),
  ], [post('old', 'bank-a', -40_000), post('undo', 'bank-a', 40_000)]);
  const reports = ['2026-01', '2026-02'].map(month =>
    calculateLedgerBudgetReport({ snapshot: ledger, month, rules: [total] }));
  assert.deepEqual(reports.map(x => x.total.spentMinor), [0, 0]);
});

test('one payment fact stays one ledger spending event, incoming payment ignored', () => {
  const ledger = snapshot([
    tx('pay', 'payment'), tx('refund', 'payment'),
  ], [post('pay', 'cash', -8_001), post('refund', 'cash', 50_000)], [
    { profileId, transactionId: 'pay', settlementId: 'fact-a' },
    { profileId, transactionId: 'refund', settlementId: 'fact-b' },
  ]);
  assert.equal(calculateLedgerBudgetReport({ snapshot: ledger, month: '2026-01', rules: [total] }).total.spentMinor, 8_001);
  assert.deepEqual(toBudgetOperations(ledger).filter(x => x.kind === 'payment').map(x => x.sourceFactId),
    ['settlement:fact-a', 'settlement:fact-b']);
});

test('unconfirmed plan passes through adapter without becoming an actual posting', () => {
  const planned = { id: 'planned-1', profileId, occurredOn: '2026-01-15',
    kind: 'expense', status: 'planned', signedMinor: -90_000, categoryId: 'food' };
  const result = calculateLedgerBudgetReport({ snapshot: snapshot([], []), month: '2026-01',
    rules: [total], planned: [planned] });
  assert.equal(result.total.spentMinor, 0);
  assert.equal(result.total.plannedMinor, 90_000);
});

test('malformed snapshots fail rather than silently skipping orphan or duplicated records', () => {
  const ledger = fixture();
  assert.throws(() => toBudgetOperations({ ...ledger, transactions: [ledger.transactions[0], ledger.transactions[0]] }), /duplicate transaction/);
  assert.throws(() => toBudgetOperations({ ...ledger, postings: [...ledger.postings, post('missing', 'bank-a', -1)] }), /orphan posting/);
  assert.throws(() => toBudgetOperations({ ...ledger, postings: ledger.postings.filter(x => x.transactionId !== 'expense') }), /posting count/);
  assert.throws(() => toBudgetOperations({ ...ledger, postings: ledger.postings.map(x => x.transactionId === 'transfer' && x.accountId === 'bank-b' ? { ...x, signedMinor: 200_000 } : x) }), /unbalanced transfer/);
  assert.throws(() => toBudgetOperations({ ...ledger, paymentLinks: [] }), /unlinked payment/);
  assert.throws(() => toBudgetOperations({ ...ledger, paymentLinks: [
    ...ledger.paymentLinks, { profileId, transactionId: 'loan', settlementId: 'another' },
  ] }), /ambiguous payment link/);
  assert.throws(() => toBudgetOperations({ ...ledger, transactions: ledger.transactions.map(x => x.id === 'expense' ? { ...x, profileId: 'other' } : x) }), /foreign transaction/);
  assert.throws(() => toBudgetOperations(ledger, [assignment('expense', 'food'), assignment('expense', 'travel')]), /duplicate category assignment/);
  assert.throws(() => toBudgetOperations(ledger, [assignment('missing', 'food')]), /category assignment/);
});

test('reversal with wrong account or amount is rejected before budget calculation', () => {
  const ledger = snapshot([tx('base', 'expense'), tx('reverse', 'reversal', '2026-02-02', 'base')],
    [post('base', 'bank-a', -10_000), post('reverse', 'bank-b', 10_000)]);
  assert.throws(() => toBudgetOperations(ledger), /reversal postings/);
  assert.throws(() => toBudgetOperations({ ...ledger, postings: [post('base', 'bank-a', -10_000), post('reverse', 'bank-a', 9_999)] }), /reversal postings/);
});

test('duplicate settlement fact referenced by two payments is rejected', () => {
  const ledger = snapshot([tx('p1', 'payment'), tx('p2', 'payment')],
    [post('p1', 'bank-a', -1), post('p2', 'bank-b', -1)], [
      { profileId, transactionId: 'p1', settlementId: 'same' },
      { profileId, transactionId: 'p2', settlementId: 'same' },
    ]);
  assert.throws(() => toBudgetOperations(ledger), /duplicate settled payment/);
});


test('linked payment cancellation without atomically voided fact fails closed (#33)', () => {
  const ledger = snapshot([
    tx('pay', 'payment', '2026-01-15'),
    tx('undo', 'reversal', '2026-02-15', 'pay'),
  ], [post('pay', 'bank-a', -10_000), post('undo', 'bank-a', 10_000)], [
    { profileId, transactionId: 'pay', settlementId: 'fact-a' },
  ]);
  assert.throws(() => toBudgetOperations(ledger), /linked payment reversal requires atomic/);
});

test('payment link must carry exactly one valid fact key, even with malformed second field', () => {
  const base = snapshot([tx('pay', 'payment')], [post('pay', 'bank-a', -100)]);
  for (const link of [
    { transactionId: 'pay', settlementId: 'ok', loanPaymentId: '' },
    { transactionId: 'pay', settlementId: 'ok', loanPaymentId: 100 },
    { transactionId: 'pay', settlementId: '', loanPaymentId: 'ok' },
    { transactionId: 'pay', settlementId: '' },
    { transactionId: 'pay', settlementId: null },
    { transactionId: 'pay', loanPaymentId: 5 },
    { transactionId: 'pay', settlementId: ' ' },
    { transactionId: 'pay', settlementId: ' fact-a' },
    { transactionId: 'pay', loanPaymentId: 'fact-a ' },
  ]) {
    assert.throws(() => toBudgetOperations({ ...base,
      paymentLinks: [{ profileId, ...link }] }), /ambiguous payment link|invalid payment fact ID/);
  }
});
