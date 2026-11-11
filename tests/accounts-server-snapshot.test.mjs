import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCompleteFinanceState,
} from '../src/domain/accounts/server-snapshot.ts';
import {
  assertLedgerState, accountBalanceMinor, totalBalanceMinor, monthlyCashFlowMinor,
} from '../src/domain/accounts/ledger.ts';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_P = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const USER = 'a'.repeat(32);
const A = 'b0000000-0000-4000-8000-000000000001';
const B = 'c0000000-0000-4000-8000-000000000002';
const TRANSFER = 'd0000000-0000-4000-8000-000000000003';
const PAYMENT = 'e0000000-0000-4000-8000-000000000004';
const FACT = 'f0000000-0000-4000-8000-000000000005';
const REVERSAL = 'a0000000-0000-4000-8000-000000000006';
const LOAN = 'b0000000-0000-4000-8000-000000000007';
const paymentLink = {settlement_id: null, loan_payment_id: FACT};
const posting = (account_id, signed_minor) => ({account_id, signed_minor});
const account = (id, balance, opening, revision, reserve = 0) => ({
  id, entity_revision: revision, kind: 'account',
  data: {name: id === A ? 'Основной' : 'Накопления', type: 'bank',
    currency: 'RUB', opening_minor: opening, balance_minor: balance,
    reserved_minor: reserve, available_minor: balance-reserve,
    archived_at: null},
});
const tx = (id, kind, entries, reversed = null, link = undefined) => ({
  id, kind: 'transaction', entity_revision: 1,
  data: {kind, occurred_on: '2026-11-11', note: null,
    posted_at: '2026-11-11T12:00:00+00:00',
    reversed_transaction_id: reversed, postings: entries,
    ...(link === undefined ? {} : {payment_link: link})},
});
const loanPayment = (voided_at = null) => ({
  id: FACT, kind: 'loan_payment', entity_revision: voided_at ? 2 : 1,
  data: {loan_id: LOAN, paid_on: '2026-11-11', amount_minor: 500,
    strategy: 'term', voided_at},
});
const serverState = (entities, revision = 3) => ({
  schema_version: 1, profile_id: P, revision, currency: 'RUB',
  entities, server_at: '2026-11-11T12:15:30+00:00',
});
const base = () => serverState([
  account(A, 99_000, 100_000, 4, 3_000),
  account(B, 1_000, 0, 2),
  tx(TRANSFER, 'transfer', [posting(A, -1000), posting(B, 1000)]),
  tx(PAYMENT, 'payment', [posting(A, -500)], null, paymentLink),
  tx(REVERSAL, 'reversal', [posting(A, 500)], PAYMENT),
  loanPayment('2026-11-11T12:00:00.123456+00:00'),
], 4);

test('#33 authenticated real finance state decodes exact balances and linked payment void', () => {
  const source = base();
  const original = structuredClone(source);
  const view = decodeCompleteFinanceState(source, P, USER);
  assert.equal(view.totalMinor, 100_000);
  assert.equal(view.availableMinor, 97_000);
  assert.equal(view.reservedMinorByAccount[A], 3000);
  assert.equal(view.reservedMinorByAccount[B], 0);
  assert.equal(accountBalanceMinor(view.ledger, A), 99_000);
  assert.equal(accountBalanceMinor(view.ledger, B), 1000);
  assert.equal(totalBalanceMinor(view.ledger), 100_000);
  assert.equal(monthlyCashFlowMinor(view.ledger, '2026-11').expenseMinor, 0);
  assert.equal(view.ledger.transactions.length, 3);
  assert.equal(view.ledger.linkedPaymentVoids.length, 1);
  assert.equal(view.ledger.linkedPaymentVoids[0].transactionId, PAYMENT);
  assert.equal(view.ledger.linkedPaymentVoids[0].factId, FACT);
  assert.equal(view.ledger.linkedPaymentVoids[0].reversedByTransactionId, REVERSAL);
  assert.equal(view.ledger.transactions.every(x=>x.actorUserId===USER), true);
  assert.doesNotThrow(()=>assertLedgerState(view.ledger));
  assert.deepEqual(source, original, 'adapter never modifies server-owned DTOs');
});

test('#33 planned obligations do not move confirmed money', () => {
  const state = base();
  state.entities.push({id: LOAN, kind: 'obligation', entity_revision: 1,
    data: {title: 'Плановые расходы', direction: 'expense',
      amount_minor: 2_000_000, starts_on:'2026-11-11'}});
  const view = decodeCompleteFinanceState(state, P, USER);
  assert.equal(view.totalMinor, 100_000);
  assert.equal(view.reservedMinorByAccount[A], 3000);
});

test('#33 different entity tables can legally share UUIDs while duplicates within one fail', () => {
  const source = base();
  source.entities.push({id: A, kind: 'obligation', entity_revision: 1,
    data: {title: 'Synthetic same UUID', direction: 'expense'}});
  assert.equal(decodeCompleteFinanceState(source,P,USER).totalMinor, 100000);
  source.entities.push(structuredClone(source.entities[0]));
  assert.throws(()=>decodeCompleteFinanceState(source,P,USER),
    /Повторяющийся идентификатор/);
});

test('#33 individually bounded postings can accumulate above a single-operation limit', () => {
  const original = account(A, 1_000_000_000_001, 1_000_000_000_000, 2);
  const input = serverState([original, tx(TRANSFER, 'income', [posting(A, 1)])], 1);
  const view = decodeCompleteFinanceState(input, P, USER);
  assert.equal(view.totalMinor, 1_000_000_000_001);
  assert.equal(view.availableMinor, 1_000_000_000_001);
});

test('#33 archived server UTC timestamps normalize to immutable ledger format', () => {
  const input = serverState([
    {...account(A, 1_000, 1_000, 2),
      data: {...account(A,1_000,1_000,2).data,
        archived_at: '2026-11-11T12:00:00.123456+00:00'}},
  ], 2);
  const view = decodeCompleteFinanceState(input,P,USER);
  assert.equal(view.ledger.accounts[0].archivedAt,
    '2026-11-11T12:00:00.123Z');
  assert.doesNotThrow(()=>assertLedgerState(view.ledger));
});

test('#33 foreign profile, missing trusted actor and incomplete keyset pages fail closed', () => {
  const state = base();
  assert.throws(()=>decodeCompleteFinanceState(state, OTHER_P, USER),
    /INVALID_FINANCE_SNAPSHOT/);
  assert.throws(()=>decodeCompleteFinanceState(state, P, ''),
    /INVALID_FINANCE_SNAPSHOT/);
  assert.throws(()=>decodeCompleteFinanceState({...state,
    next_cursor: '4:account:'+A},P,USER),/Нет полного/);
  assert.throws(()=>decodeCompleteFinanceState({...state,
    entities: null},P,USER),/Нет полного/);
});

test('#33 corrupt payment fact, missing cash reversal or wrong payment source cannot hydrate', () => {
  const source = base();
  const cases = [
    s => { s.entities = s.entities.filter(x=>x.id!==FACT); },
    s => { s.entities = s.entities.filter(x=>x.id!==REVERSAL); },
    s => { s.entities.find(x=>x.id===FACT).entity_revision=1; },
    s => { s.entities.find(x=>x.id===FACT).kind='settlement'; },
    s => { s.entities.find(x=>x.id===FACT).data.voided_at=null; },
    s => { s.entities.find(x=>x.id===REVERSAL).data.postings[0].signed_minor=250; },
    s => { s.entities.find(x=>x.id===REVERSAL).data.reversed_transaction_id=TRANSFER; },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(()=>decodeCompleteFinanceState(changed,P,USER),
      /INVALID_FINANCE_SNAPSHOT|Факт|оплата|проводок|компенсация|Связанная|сбалансирован|Остаток|Квитанция|Неверное/,
      'tampered fact/transaction may not become a displayed confirmed balance');
  }
});

test('#33 wrong server cash image, reserve allocation, currency or actor claim fails closed', () => {
  const source = base();
  const tests = [
    s => { s.entities[0].data.balance_minor+=1; },
    s => { s.entities[0].data.reserved_minor=-1; },
    s => { s.entities[0].data.available_minor=88; },
    s => { s.entities[0].data.currency='EUR'; },
    s => { s.entities.find(x=>x.id===PAYMENT).data.actor_user_id='b'.repeat(32); },
    s => { s.entities.find(x=>x.id===TRANSFER).data.postings[0].account_id=OTHER_P; },
    s => { s.entities[0].data.archived_at='2026-02-30T12:00:00Z'; },
  ];
  for (const tamper of tests) {
    const input = structuredClone(source);
    tamper(input);
    assert.throws(()=>decodeCompleteFinanceState(input,P,USER));
  }
});
