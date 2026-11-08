import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBudgetReport } from '../src/domain/budgets/index.ts';
import { calculateLedgerBudgetReport } from '../src/domain/budgets/ledger-adapter.ts';

const profileId = 'contract-profile';
const rule = { id: 'total', profileId, scope: { kind: 'total' },
  limitMinor: 100_000, recurrence: 'monthly', fromMonth: '2026-01' };

function transaction(id, kind, occurredOn, reversedTransactionId = null) {
  return { id, kind, occurredOn, reversedTransactionId, profileId };
}
function posting(transactionId, signedMinor, accountId = 'cash-account') {
  return { transactionId, signedMinor, accountId, profileId };
}

/** Independent posting-date oracle; not the budget definition of spending. */
function cashflowExpensesInMonth(snapshot, month) {
  return snapshot.postings.reduce((sum, p) => {
    const tx = snapshot.transactions.find(t => t.id === p.transactionId);
    if (!tx || !tx.occurredOn.startsWith(`${month}-`)) return sum;
    // A reversal of an expense is a negative cashflow expense in its own month.
    return sum - p.signedMinor;
  }, 0);
}

test('budget spending and posting-date cashflow remain distinct for cross-month correction (#41)', () => {
  const snapshot = {
    profileId,
    transactions: [
      transaction('expense-old', 'expense', '2026-01-10'),
      transaction('reverse-old', 'reversal', '2026-02-02', 'expense-old'),
      transaction('expense-replacement', 'expense', '2026-02-02'),
    ],
    postings: [
      posting('expense-old', -100_000),
      posting('reverse-old', 100_000),
      posting('expense-replacement', -80_000),
    ],
    paymentLinks: [],
  };
  const budgets = ['2026-01', '2026-02'].map(month =>
    calculateLedgerBudgetReport({ snapshot, month, rules: [rule] }));
  const cashflow = ['2026-01', '2026-02'].map(month =>
    cashflowExpensesInMonth(snapshot, month));
  assert.deepEqual(budgets.map(x => x.confirmedExpenseMinor), [0, 80_000]);
  assert.deepEqual(cashflow, [100_000, -20_000]);
  assert.equal(budgets.reduce((sum, report) => sum + report.confirmedExpenseMinor, 0), 80_000);
  assert.equal(cashflow.reduce((sum, amount) => sum + amount, 0), 80_000);
  assert.ok(budgets[0].confirmedExpenseMinor !== cashflow[0]);
  assert.ok(budgets[1].confirmedExpenseMinor !== cashflow[1]);
  // Reversing source collection order does not affect any projection.
  const reordered = { ...snapshot, transactions: [...snapshot.transactions].reverse(),
    postings: [...snapshot.postings].reverse() };
  assert.deepEqual(budgets, ['2026-01', '2026-02'].map(month =>
    calculateLedgerBudgetReport({ snapshot: reordered, month, rules: [rule] })));
});

test('archiving a category rule does not erase historical confirmed spending', () => {
  const ruleCategory = { id: 'category-food', profileId,
    scope: { kind: 'category', categoryId: 'food' }, limitMinor: 20_000,
    recurrence: 'monthly', fromMonth: '2026-01', archivedFromMonth: '2026-02' };
  const operations = [
    { id: 'a', profileId, kind: 'expense', signedMinor: -3_001,
      status: 'confirmed', occurredOn: '2026-01-25', categoryId: 'food' },
    { id: 'b', profileId, kind: 'expense', signedMinor: -4_002,
      status: 'confirmed', occurredOn: '2026-02-25', categoryId: 'food' },
  ];
  const jan = calculateBudgetReport({ profileId, month: '2026-01',
    operations, rules: [rule, ruleCategory] });
  const feb = calculateBudgetReport({ profileId, month: '2026-02',
    operations, rules: [rule, ruleCategory] });
  assert.equal(jan.total.spentMinor, 3_001);
  assert.equal(jan.categories[0].spentMinor, 3_001);
  assert.equal(jan.categories[0].remainingMinor, 16_999);
  assert.equal(feb.categories.length, 0);
  assert.equal(feb.total.spentMinor, 4_002);
  assert.equal(jan.uncategorizedExpenseMinor, 0);
  assert.equal(feb.uncategorizedExpenseMinor, 0);
});
