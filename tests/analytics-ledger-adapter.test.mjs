import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnalyticsTransactions, buildLedgerAnalyticsReport,
  buildAnalyticsReport } from '../src/domain/analytics/index.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const profile = id(1);
const otherProfile = id(2);
const cash = id(3);
const bank = id(4);
const salary = id(10);
const groceries = id(11);
const transfer = id(12);
const repayment = id(13);
const refunded = id(14);
const loanFact = id(20);
const tx = (uuid, kind, occurredOn, reversedTransactionId = null) => ({
  id: uuid, profileId: profile, kind, occurredOn, reversedTransactionId,
});
const posting = (transactionId, accountId, signedMinor) => ({
  profileId: profile, transactionId, accountId, signedMinor,
});
const assignment = (transactionId, categoryId) => ({
  profileId: profile, transactionId, categoryId,
});

function fixture() {
  return {
    profileId: profile, revision: 7,
    accounts: [{ id: cash, profileId: profile, currency: 'RUB' },
      { id: bank, profileId: profile, currency: 'RUB' }],
    transactions: [
      tx(salary, 'income', '2026-01-10'),
      tx(groceries, 'expense', '2026-01-12'),
      tx(transfer, 'transfer', '2026-01-14'),
      tx(repayment, 'payment', '2026-01-15'),
      tx(refunded, 'reversal', '2026-02-02', groceries),
    ],
    postings: [
      posting(salary, cash, 20000),
      posting(groceries, cash, -5000),
      posting(transfer, cash, -3000), posting(transfer, bank, 3000),
      posting(repayment, bank, -2000),
      posting(refunded, cash, 5000),
    ],
    paymentLinks: [{ profileId: profile, transactionId: repayment, loanPaymentId: loanFact }],
  };
}
const assignments = [assignment(salary, 'income'), assignment(groceries, 'food'),
  assignment(repayment, 'loan')];
const query = snapshot => ({ from: '2026-01-01', to: '2026-02-28',
  snapshot, expectedProfileId: profile,
  categoryAssignments: assignments, categories: [{ id: 'food', name: 'Еда', archived: true }],
});

test('reconciles one event per transaction against independent signed journal oracle', () => {
  const source = fixture();
  const before = structuredClone(source);
  const normalized = toAnalyticsTransactions(source, profile, assignments);
  assert.equal(normalized.length, 5);
  assert.deepEqual(normalized.map(item => [item.id, item.signedMinor]), [
    [salary, 20000], [groceries, -5000], [transfer, 0], [repayment, -2000], [refunded, 5000],
  ]);
  assert.equal(normalized.find(item => item.id === refunded).categoryId, null);
  assert.equal(normalized.find(item => item.id === groceries).categoryId, 'food');
  const report = buildLedgerAnalyticsReport(query(source));
  assert.deepEqual([report.totals.incomeMinor, report.totals.expenseMinor, report.totals.netMinor],
    [20000, 2000, 18000]);
  assert.deepEqual(report.monthly.map(row => [row.incomeMinor, row.expenseMinor, row.netMinor]),
    [[20000, 7000, 13000], [0, -5000, 5000]]);
  // Sum all posted account effects exactly once: transfer cancels, and a refund is not a second income.
  assert.equal(source.postings.reduce((acc, row) => acc + row.signedMinor, 0), report.totals.netMinor);
  assert.equal(report.categories.find(item => item.categoryId === 'food').archived, true);
  assert.deepEqual(source, before, 'read-only adapter may not change source');
  assert.deepEqual(report, buildLedgerAnalyticsReport(query(source)), 'same input -> same report');
});

test('standalone projection matches generic pure report of normalized transactions', () => {
  const source = fixture();
  const expected = buildAnalyticsReport({ from: '2026-01-01', to: '2026-02-28',
    transactions: toAnalyticsTransactions(source, profile, assignments),
    categories: [{ id: 'food', name: 'Еда', archived: true }],
  });
  assert.deepEqual(buildLedgerAnalyticsReport(query(source)), expected);
});

test('fails closed on foreign profile, accounts, postings or category links', () => {
  assert.throws(() => toAnalyticsTransactions(fixture(), otherProfile, assignments), /чужой финансовый профиль/);
  for (const change of [
    data => { data.accounts[0].profileId = otherProfile; },
    data => { data.transactions[0].profileId = otherProfile; },
    data => { data.postings[0].profileId = otherProfile; },
    data => { data.paymentLinks[0].profileId = otherProfile; },
    data => { data.postings[0].accountId = id(100); },
    data => { data.postings[0].transactionId = id(200); },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => toAnalyticsTransactions(data, profile, assignments));
  }
  assert.throws(() => toAnalyticsTransactions(fixture(), profile,
    [{ ...assignments[0], profileId: otherProfile }]), /категория/);
  assert.throws(() => toAnalyticsTransactions(fixture(), profile,
    [...assignments, assignment(groceries, 'other')]), /категория/);
  assert.throws(() => toAnalyticsTransactions(fixture(), profile,
    [assignment(refunded, 'false-refund')]), /категория/);
});

test('rejects double payment fact even with different transaction UUIDs', () => {
  const data = fixture();
  const again = id(40);
  data.transactions.push(tx(again, 'payment', '2026-01-21'));
  data.postings.push(posting(again, cash, -2000));
  data.paymentLinks.push({ profileId: profile, transactionId: again, loanPaymentId: loanFact });
  assert.throws(() => buildLedgerAnalyticsReport(query(data)), /повторное проведение/);
});

test('rejects malformed, orphaned and ambiguous linked payments', () => {
  for (const change of [
    data => { data.paymentLinks = []; },
    data => { data.paymentLinks[0].settlementId = id(22); },
    data => { data.paymentLinks[0].loanPaymentId = ''; },
    data => { data.paymentLinks[0].loanPaymentId = 'INVALID'; },
    data => { data.paymentLinks[0].transactionId = groceries; },
    data => { data.postings.find(p => p.transactionId === repayment).signedMinor = 2000; },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => toAnalyticsTransactions(data, profile, assignments));
  }
});

test('reversals require the original postings on exactly the same accounts', () => {
  for (const change of [
    data => { data.transactions.find(t => t.id === refunded).reversedTransactionId = id(500); },
    data => { data.postings.find(p => p.transactionId === refunded).signedMinor = 4000; },
    data => { data.postings.find(p => p.transactionId === refunded).accountId = bank; },
    data => { data.postings = data.postings.filter(p => p.transactionId !== refunded); },
    data => { data.transactions.push(tx(id(55), 'reversal', '2026-02-04', groceries));
      data.postings.push(posting(id(55), cash, 5000)); },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => toAnalyticsTransactions(data, profile, assignments));
  }
});

test('until atomic #67 void+reversal exists, never turn linked payment refund into valid data', () => {
  const data = fixture();
  data.transactions.push(tx(id(50), 'reversal', '2026-02-10', repayment));
  data.postings.push(posting(id(50), bank, 2000));
  assert.throws(() => toAnalyticsTransactions(data, profile, assignments), /отмена связанного платежа/);
});

test('rejects unbalanced transfers, repeated account legs, and missing postings', () => {
  for (const change of [
    data => { data.postings.find(p => p.transactionId === transfer && p.accountId === bank).signedMinor = 3001; },
    data => { data.postings.find(p => p.transactionId === transfer && p.accountId === bank).accountId = cash; },
    data => { data.postings = data.postings.filter(p => p.transactionId !== salary); },
    data => { data.accounts.push({ ...data.accounts[0] }); },
    data => { data.transactions.push({ ...data.transactions[0] }); },
    data => { data.postings.find(p => p.transactionId === groceries).signedMinor = 0; },
    data => { data.transactions[0].occurredOn = '2026-02-30'; },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => toAnalyticsTransactions(data, profile, assignments));
  }
});

test('an unassigned payment stays without category rather than guessing from note or account', () => {
  const projected = toAnalyticsTransactions(fixture(), profile, []);
  assert.equal(projected.find(item => item.id === repayment).categoryId, null);
  assert.equal(projected.find(item => item.id === salary).categoryId, null);
  const report = buildLedgerAnalyticsReport({ ...query(fixture()), categoryAssignments: [] });
  assert.equal(report.categories.find(item => item.categoryId === null).expenseMinor, 2000);
  assert.equal(report.categories.find(item => item.categoryId === null).incomeMinor, 20000);
});
