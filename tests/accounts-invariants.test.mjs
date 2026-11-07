import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLedgerState } from '../src/domain/accounts/invariants.ts';
import { applyLedgerCommand, emptyLedger, totalBalanceMinor, accountBalanceMinor } from '../src/domain/accounts/ledger.ts';

const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const context = profileId => ({ profileId, actorUserId: '0123456789abcdef0123456789abcdef' });
const u = (() => { let i = 100; return () => uuid(++i); })();
function run(state, action, payload, expected = {}) {
  const cmd = { clientMutationId: u(), baseRevision: state.revision, expectedEntityRevisions: expected, action, payload };
  return applyLedgerCommand(state, cmd, context(state.profileId)).state;
}
function create(state, id, openingMinor = 0) {
  return run(state, 'account.create', { id, name: 'Синтетический счёт', kind: 'bank', currency: 'RUB', openingMinor });
}
function revisions(s, ...ids) {
  return Object.fromEntries(ids.map(id => [
    id, (s.accounts.find(a => a.id === id) ?? s.transactions.find(t => t.id === id)).entityRevision,
  ]));
}
function transfer(s, from, to, amount, transactionId = u()) {
  return run(s, 'account.transfer', {
    id: transactionId, fromAccountId: from, toAccountId: to, amountMinor: amount, occurredOn: '2026-11-07',
  }, revisions(s, from, to));
}
function payment(s, accountId, amountMinor, loanId = u(), transactionId = u()) {
  return run(s, 'payment.record', {
    id: transactionId, accountId, amountMinor, link: { loanPaymentId: loanId }, occurredOn: '2026-11-07',
  }, revisions(s, accountId));
}
function fixture() {
  let s = create(emptyLedger(uuid(1)), uuid(2), 100_000);
  s = create(s, uuid(3), 1_000);
  s = transfer(s, uuid(2), uuid(3), 8_000, uuid(4));
  s = payment(s, uuid(3), 500, uuid(5), uuid(6));
  return s;
}

test('valid ledger survives snapshot serialization and keeps its exact balances', () => {
  const s = fixture();
  assert.doesNotThrow(() => assertLedgerState(s));
  const serialized = JSON.parse(JSON.stringify(s));
  assert.doesNotThrow(() => assertLedgerState(serialized));
  assert.deepEqual(serialized, s);
  assert.equal(accountBalanceMinor(serialized, uuid(2)), 92_000);
  assert.equal(accountBalanceMinor(serialized, uuid(3)), 8_500);
  assert.equal(totalBalanceMinor(serialized), 100_500);
});

test('untrusted snapshots fail closed on scope, duplicate IDs and invalid account money', () => {
  const mutations = [
    [s => { s.accounts[0].profileId = uuid(9); }, /Чужой/],
    [s => { s.accounts.push(structuredClone(s.accounts[0])); }, /повторяющийся счёт/],
    [s => { s.transactions[0].profileId = uuid(9); }, /Чужая/],
    [s => { s.postings[0].profileId = uuid(9); }, /Проводка/],
    [s => { s.postings[0].accountId = uuid(9); }, /несуществующий/],
    [s => { s.postings[0].transactionId = uuid(9); }, /несуществующий/],
    [s => { s.postings.push(structuredClone(s.postings[0])); }, /Дублированная/],
    [s => { s.accounts[0].openingMinor = 1.1; }, /сумма/],
    [s => { s.accounts[0].openingMinor = Number.MAX_SAFE_INTEGER; }, /сумма/],
    [s => { s.accounts[0].archivedAt = '2026-02-30T00:00:00.000Z'; }, /времени/],
    [s => { s.transactions[0].occurredOn = '2026-02-30'; }, /дата/],
  ];
  for (const [mutate, pattern] of mutations) {
    const corrupt = structuredClone(fixture());
    mutate(corrupt);
    assert.throws(() => assertLedgerState(corrupt), pattern);
    assert.throws(() => run(corrupt, 'account.create', {
      id: u(), name: 'Новый', kind: 'cash', currency: 'RUB', openingMinor: 0,
    }), pattern, 'mutating corrupt source must be denied');
  }
});

test('imbalanced transfer, orphan payment and double-linked fact cannot be accepted', () => {
  const source = fixture();
  const mutations = [
    [s => { s.postings[0].signedMinor = -7_999; }, /сбалансирован/],
    [s => { s.postings.splice(0, 1); }, /сбалансирован/],
    [s => { s.paymentLinks = []; }, /Отсутствует связь/],
    [s => { s.paymentLinks.push(structuredClone(s.paymentLinks[0])); }, /несколько связей/],
    [s => { s.paymentLinks[0].settlementId = uuid(20); }, /неоднозначна/],
    [s => { s.paymentLinks[0].loanPaymentId = undefined; s.paymentLinks[0].settlementId = undefined; }, /Связь|неоднозначна/],
  ];
  for (const [mutate, pattern] of mutations) {
    const corrupt = structuredClone(source);
    mutate(corrupt);
    assert.throws(() => assertLedgerState(corrupt), pattern);
  }
});

test('reversal must exactly match original postings and preserve original transaction', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 5_000);
  s = create(s, uuid(3), 3_000);
  s = transfer(s, uuid(2), uuid(3), 1_000, uuid(4));
  s = run(s, 'transaction.reverse', {
    id: uuid(5), transactionId: uuid(4), occurredOn: '2026-11-07', reason: 'Отмена',
  }, revisions(s, uuid(2), uuid(3), uuid(4)));
  assert.doesNotThrow(() => assertLedgerState(s));
  assert.equal(totalBalanceMinor(s), 8_000);

  const tampered = structuredClone(s);
  tampered.postings.find(p => p.transactionId === uuid(5)).signedMinor = -999;
  assert.throws(() => assertLedgerState(tampered), /компенсация/);
  const missing = structuredClone(s);
  missing.transactions[1].reversedTransactionId = uuid(19);
  assert.throws(() => assertLedgerState(missing), /несуществующую/);
});

test('duplicate mutation receipts and future revisions are rejected on hydration', () => {
  const s = fixture();
  const duplicate = structuredClone(s);
  duplicate.receipts.push(structuredClone(s.receipts[0]));
  assert.throws(() => assertLedgerState(duplicate), /квитанция/);
  const impossible = structuredClone(s);
  impossible.receipts[0].revision = s.revision + 1;
  assert.throws(() => assertLedgerState(impossible), /квитанция/);
});

test('deterministic 160-transfer model maintains total wealth on every step', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 1_000_000);
  s = create(s, uuid(3), -250_000);
  const initial = totalBalanceMinor(s);
  let random = 0x4fac2bd3;
  for (let index = 0; index < 160; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const amount = random % 950_000 + 1;
    const from = index % 2 ? uuid(2) : uuid(3);
    const to = index % 2 ? uuid(3) : uuid(2);
    s = transfer(s, from, to, amount);
    assert.doesNotThrow(() => assertLedgerState(s));
    assert.equal(totalBalanceMinor(s), initial);
  }
  assert.equal(s.postings.length, 320);
  assert.equal(s.transactions.length, 160);
  assert.equal(s.revision, 162);
});
