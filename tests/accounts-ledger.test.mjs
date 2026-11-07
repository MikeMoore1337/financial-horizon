import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MINOR, emptyLedger, applyLedgerCommand, accountBalanceMinor,
  availableBalanceMinor, totalBalanceMinor, monthlyCashFlowMinor,
} from '../src/domain/accounts/ledger.ts';
import { planLegacyLedgerImport } from '../src/domain/accounts/legacy-import.ts';

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const actor = '0123456789abcdef0123456789abcdef';
const context = profileId => ({ profileId, actorUserId: actor });
let serial = 1000;
const unique = () => id(++serial);
const command = (state, action, payload, expected = {}, clientMutationId = unique()) => ({
  action, payload, clientMutationId, baseRevision: state.revision, expectedEntityRevisions: expected,
});
const revisionOf = (state, id) => {
  const a = state.accounts.find(a => a.id === id);
  return a?.entityRevision ?? state.transactions.find(t => t.id === id)?.entityRevision;
};
const expectFor = (state, ...ids) => Object.fromEntries(ids.map(id => [id, revisionOf(state, id)]));
const apply = (state, action, payload, expected = {}, mutationId) =>
  applyLedgerCommand(state, command(state, action, payload, expected, mutationId), context(state.profileId)).state;
const create = (state, accountId, openingMinor, kind = 'bank') =>
  apply(state, 'account.create', { id: accountId, name: 'Счёт', kind, currency: 'RUB', openingMinor });
const transfer = (state, from, to, amount, tx = unique()) => apply(state, 'account.transfer', {
  id: tx, fromAccountId: from, toAccountId: to, amountMinor: amount, occurredOn: '2026-11-07',
}, expectFor(state, from, to));
const record = (state, accountId, kind, signedMinor, tx = unique()) => apply(state, 'transaction.record', {
  id: tx, accountId, kind, signedMinor, occurredOn: '2026-11-07',
}, expectFor(state, accountId));
const pay = (state, accountId, amountMinor, link, tx = unique()) => apply(state, 'payment.record', {
  id: tx, accountId, amountMinor, link, occurredOn: '2026-11-07',
}, expectFor(state, accountId));
const reverse = (state, tx, reversal = unique()) => {
  const related = state.postings.filter(p => p.transactionId === tx).map(p => p.accountId);
  return apply(state, 'transaction.reverse', {
    id: reversal, transactionId: tx, occurredOn: '2026-11-07', reason: 'Исправление',
  }, expectFor(state, tx, ...related));
};

test('initial balance is explicit, typed, and never inferred from planned obligations', () => {
  const original = emptyLedger(id(1));
  const zero = create(original, id(2), 0);
  const negative = create(zero, id(3), -500, 'cash');
  assert.equal(accountBalanceMinor(negative, id(2)), 0);
  assert.equal(accountBalanceMinor(negative, id(3)), -500);
  assert.equal(totalBalanceMinor(negative), -500);
  assert.deepEqual(original.accounts, []);
  assert.throws(() => apply(zero, 'account.create', { id: id(4), name: 'X', kind: 'bank', currency: 'RUB' }), RangeError);
  assert.throws(() => apply(zero, 'account.create', { id: id(4), name: 'X', kind: 'bank', currency: 'USD', openingMinor: 0 }), TypeError);
});

test('transfer has paired signed postings, zero sum and no impact on expense or income', () => {
  let s = create(emptyLedger(id(1)), id(2), 100_000);
  s = create(s, id(3), 10_000, 'card');
  const before = totalBalanceMinor(s);
  s = transfer(s, id(2), id(3), 100_000, id(4));
  assert.equal(accountBalanceMinor(s, id(2)), 0);
  assert.equal(accountBalanceMinor(s, id(3)), 110_000);
  assert.equal(totalBalanceMinor(s), before);
  assert.deepEqual(s.postings.map(p => p.signedMinor), [-100_000, 100_000]);
  assert.equal(s.postings.reduce((sum, p) => sum + p.signedMinor, 0), 0);
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-11'), { incomeMinor: 0, expenseMinor: 0 });
});

test('income, expense, adjustment and negative balances remain exact minor units', () => {
  let s = create(emptyLedger(id(1)), id(2), 0);
  s = record(s, id(2), 'income', 25_001);
  s = record(s, id(2), 'expense', -30_003);
  s = record(s, id(2), 'adjustment', -50);
  assert.equal(accountBalanceMinor(s, id(2)), -5_052);
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-11'), { incomeMinor: 25_001, expenseMinor: 30_003 });
  assert.throws(() => record(s, id(2), 'income', -3), /знак/);
  assert.throws(() => record(s, id(2), 'expense', 3), /знак/);
  assert.throws(() => record(s, id(2), 'adjustment', 0), RangeError);
});

test('identical mutation key replays the exact receipt, without double debit even after revision changes', () => {
  let s = create(emptyLedger(id(1)), id(2), 30_000);
  const c = command(s, 'transaction.record', {
    id: id(3), accountId: id(2), kind: 'expense', signedMinor: -15_000, occurredOn: '2026-11-07',
  }, expectFor(s, id(2)), id(9));
  const first = applyLedgerCommand(s, c, context(s.profileId));
  const second = applyLedgerCommand(first.state, c, context(s.profileId));
  assert.equal(second.replayed, true);
  assert.strictEqual(second.state, first.state);
  assert.equal(second.receipt.revision, first.receipt.revision);
  assert.equal(first.state.postings.length, 1);
  assert.equal(accountBalanceMinor(first.state, id(2)), 15_000);
  const changed = structuredClone(c);
  changed.payload.signedMinor = -10_000;
  assert.throws(() => applyLedgerCommand(first.state, changed, context(s.profileId)), /idempotency_key_reuse/);
  s = first.state;
  assert.throws(() => apply(s, 'transaction.record', {
    id: id(3), accountId: id(2), kind: 'expense', signedMinor: -5_000, occurredOn: '2026-11-07',
  }, expectFor(s, id(2))), /существует/);
});

test('canonical fingerprint ignores JSON object key ordering but not request preconditions', () => {
  const s = create(emptyLedger(id(1)), id(2), 20_000);
  const c = command(s, 'transaction.record', {
    id: id(3), accountId: id(2), kind: 'expense', signedMinor: -1, occurredOn: '2026-11-07',
  }, expectFor(s, id(2)), id(4));
  const result = applyLedgerCommand(s, c, context(s.profileId));
  const reordered = { expectedEntityRevisions: { [id(2)]: revisionOf(s, id(2)) }, payload: {
    occurredOn: '2026-11-07', signedMinor: -1, kind: 'expense', accountId: id(2), id: id(3),
  }, baseRevision: s.revision, clientMutationId: id(4), action: 'transaction.record' };
  assert.equal(applyLedgerCommand(result.state, reordered, context(s.profileId)).replayed, true);
  assert.throws(() => applyLedgerCommand(result.state, { ...c, baseRevision: result.state.revision }, context(s.profileId)), /idempotency_key_reuse/);
});

test('partial + full payments have one debit each, linked facts cannot be charged twice', () => {
  let s = create(emptyLedger(id(1)), id(2), 40_000);
  s = pay(s, id(2), 3_000, { settlementId: id(3) }, id(4));
  s = pay(s, id(2), 7_000, { settlementId: id(5) }, id(6));
  s = pay(s, id(2), 10_000, { loanPaymentId: id(7) }, id(8));
  assert.equal(accountBalanceMinor(s, id(2)), 20_000);
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-11'), { incomeMinor: 0, expenseMinor: 20_000 });
  assert.equal(s.paymentLinks.length, 3);
  assert.throws(() => pay(s, id(2), 3_000, { settlementId: id(3) }), /уже проведена/);
  assert.throws(() => pay(s, id(2), 10_000, { loanPaymentId: id(7) }), /уже проведена/);
  assert.throws(() => pay(s, id(2), 1, { settlementId: id(10), loanPaymentId: id(11) }), /ровно на один/);
});

test('reversal preserves original history and corrects expense by compensating postings', () => {
  let s = create(emptyLedger(id(1)), id(2), 1_000);
  s = record(s, id(2), 'expense', -500, id(3));
  s = reverse(s, id(3), id(4));
  assert.equal(accountBalanceMinor(s, id(2)), 1_000);
  assert.equal(s.transactions.length, 2);
  assert.equal(s.transactions[1].reversedTransactionId, id(3));
  assert.deepEqual(s.postings.map(p => p.signedMinor), [-500, 500]);
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-11'), { incomeMinor: 0, expenseMinor: 0 });
  assert.throws(() => reverse(s, id(3)), /уже отменена/);
  assert.throws(() => reverse(s, id(4)), /недоступна/);
  s = record(s, id(2), 'expense', -450, id(5));
  assert.equal(accountBalanceMinor(s, id(2)), 550);
  assert.equal(s.transactions.length, 3);
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-11'), { incomeMinor: 0, expenseMinor: 450 });
});

test('transfer reversal restores both balances and keeps total assets unchanged', () => {
  let s = create(emptyLedger(id(1)), id(2), 10_000);
  s = create(s, id(3), 2_000);
  s = transfer(s, id(2), id(3), 900, id(4));
  s = reverse(s, id(4), id(5));
  assert.equal(accountBalanceMinor(s, id(2)), 10_000);
  assert.equal(accountBalanceMinor(s, id(3)), 2_000);
  assert.equal(totalBalanceMinor(s), 12_000);
  assert.equal(s.postings.length, 4);
});

test('reversal of paid fact preserves link tombstone so new mutation cannot double-charge', () => {
  let s = create(emptyLedger(id(1)), id(2), 10_000);
  s = pay(s, id(2), 5_000, { settlementId: id(3) }, id(4));
  s = reverse(s, id(4), id(5));
  assert.equal(accountBalanceMinor(s, id(2)), 10_000);
  assert.equal(s.paymentLinks.length, 1);
  assert.throws(() => pay(s, id(2), 5_000, { settlementId: id(3) }), /уже проведена/);
});

test('negative and zero balances, explicit reserves and overflow thresholds', () => {
  let s = create(emptyLedger(id(1)), id(2), 0);
  assert.equal(availableBalanceMinor(s, id(2), 0), 0);
  s = record(s, id(2), 'expense', -100);
  assert.equal(accountBalanceMinor(s, id(2)), -100);
  assert.equal(availableBalanceMinor(s, id(2), 500), -600);
  assert.throws(() => availableBalanceMinor(s, id(2), -1), RangeError);
  assert.throws(() => availableBalanceMinor(s, id(2), 0.1), RangeError);
  assert.throws(() => create(s, id(3), Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => record(s, id(2), 'income', 1.01), RangeError);
  assert.throws(() => record(s, id(2), 'income', MAX_MINOR + 1), RangeError);
  const maxed = create(emptyLedger(id(5)), id(6), MAX_MINOR);
  assert.throws(() => record(maxed, id(6), 'income', 1), /Остаток/);
});

test('two concurrent tabs reject stale revisions, leaving confirmed state unchanged', () => {
  const base = create(emptyLedger(id(1)), id(2), 10_000);
  const first = command(base, 'transaction.record', {
    id: id(3), accountId: id(2), kind: 'expense', signedMinor: -2_000, occurredOn: '2026-11-07',
  }, expectFor(base, id(2)));
  const stale = command(base, 'transaction.record', {
    id: id(4), accountId: id(2), kind: 'expense', signedMinor: -5_000, occurredOn: '2026-11-07',
  }, expectFor(base, id(2)));
  const accepted = applyLedgerCommand(base, first, context(base.profileId)).state;
  assert.throws(() => applyLedgerCommand(accepted, stale, context(base.profileId)), /stale_revision/);
  assert.equal(accountBalanceMinor(accepted, id(2)), 8_000);
  assert.equal(base.postings.length, 0);
});

test('two users are separate scopes; no authenticated context may mutate another profile', () => {
  const a = create(emptyLedger(id(1)), id(3), 20_000);
  const b = create(emptyLedger(id(2)), id(4), 5_000);
  const c = command(a, 'account.transfer', {
    id: id(5), fromAccountId: id(3), toAccountId: id(4), amountMinor: 1, occurredOn: '2026-11-07',
  }, { ...expectFor(a, id(3)), [id(4)]: revisionOf(b, id(4)) });
  assert.throws(() => applyLedgerCommand(a, c, context(b.profileId)), /запрещён/);
  assert.throws(() => applyLedgerCommand(a, c, context(a.profileId)), /недоступен/);
  assert.equal(totalBalanceMinor(a), 20_000);
  assert.equal(totalBalanceMinor(b), 5_000);
});

test('archive is reversible for historical accounting but blocks future transactions', () => {
  let s = create(emptyLedger(id(1)), id(2), 1_000);
  s = record(s, id(2), 'expense', -100, id(3));
  s = apply(s, 'account.archive', { accountId: id(2), archivedAt: '2026-11-07T10:00:00.000Z' }, expectFor(s, id(2)));
  assert.equal(accountBalanceMinor(s, id(2)), 900);
  assert.throws(() => record(s, id(2), 'expense', -10), /недоступен/);
  s = reverse(s, id(3));
  assert.equal(accountBalanceMinor(s, id(2)), 1_000);
});

test('date, duplicated transaction, malformed command and revision boundaries fail closed', () => {
  const s = create(emptyLedger(id(1)), id(2), 50);
  for (const occurredOn of ['2026-02-30', '2026-13-01', 'wrong']) {
    assert.throws(() => apply(s, 'transaction.record', { id: unique(), accountId: id(2), kind: 'income', signedMinor: 1, occurredOn }, expectFor(s, id(2))), /дат/);
  }
  assert.throws(() => transfer(s, id(2), id(2), 1), /тот же счёт/);
  assert.throws(() => apply(s, 'account.create', { id: unique(), name: '', kind: 'bank', currency: 'RUB', openingMinor: 0 }), /текст/);
  assert.throws(() => applyLedgerCommand(s, { action: 'account.create', baseRevision: -1, clientMutationId: unique(), expectedEntityRevisions: {}, payload: { id: unique(), name: 'Ok', kind: 'bank', currency: 'RUB', openingMinor: 0 } }, context(s.profileId)), RangeError);
});

test('reload from a serialized snapshot preserves balances and dedup receipts', () => {
  let s = create(emptyLedger(id(1)), id(2), 10_000);
  const c = command(s, 'transaction.record', { id: id(3), accountId: id(2), kind: 'expense', signedMinor: -100, occurredOn: '2026-11-07' }, expectFor(s, id(2)));
  s = applyLedgerCommand(s, c, context(s.profileId)).state;
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(accountBalanceMinor(restored, id(2)), 9_900);
  assert.equal(applyLedgerCommand(restored, c, context(s.profileId)).replayed, true);
  assert.equal(restored.receipts.length, 2);
});

test('versioned legacy staging never manufactures opening accounts or erases v1/v2 records', () => {
  const v1 = { version: 1, entries: [{ amountCents: 12_300 }], loans: [{}], settlements: [{ amountCents: 123 }], loanPayments: [], categories: [], audit: [], settings: { currency: 'RUB' } };
  const original = structuredClone(v1);
  const manifest1 = planLegacyLedgerImport(v1);
  assert.deepEqual(v1, original);
  assert.deepEqual(manifest1.plannedAccounts, []);
  assert.deepEqual(manifest1.plannedTransactions, []);
  assert.equal(manifest1.requiresExplicitOpeningBalances, true);
  assert.equal(manifest1.sourceRevision, null);
  const v2 = { ...v1, version: 2, revision: 42 };
  const manifest2 = planLegacyLedgerImport(v2);
  assert.equal(manifest2.sourceRevision, 42);
  assert.equal(manifest2.entriesCount, 1);
  assert.throws(() => planLegacyLedgerImport({ ...v1, version: 3 }), /Неизвестная/);
  assert.throws(() => planLegacyLedgerImport({ ...v2, revision: -1 }), /ревизия/);
});
