import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyFinanceSnapshotPagesCandidate, applyFinanceDeltaCandidate,
} from '../src/cloud/verified-delta-candidate.mjs';

const SCOPE = 'account:' + 'a'.repeat(32);
const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const T1 = '10000000-0000-4000-8000-000000000003';
const T2 = '10000000-0000-4000-8000-000000000004';
const guard = () => ({
  scope: SCOPE, profileId: PROFILE, generation: 1,
  epoch: 'c'.repeat(32), signal: new AbortController().signal,
});
const account = (id, revision, balance, reserved = 0) => ({
  id, kind: 'account', entity_revision: revision, data: {
    name: 'Synthetic', type: 'bank', currency: 'RUB', opening_minor: 10_000,
    balance_minor: balance, reserved_minor: reserved, available_minor: balance - reserved,
    archived_at: null,
  },
});
const transaction = (id, postings) => ({
  id, kind: 'transaction', entity_revision: 1, data: {
    kind: postings.length === 2 ? 'transfer' : 'expense',
    occurred_on: '2026-11-11', posted_at: '2026-11-11T00:00:00Z',
    note: null, reversed_transaction_id: null, postings,
  },
});
const local = () => ({
  scope: SCOPE, profileId: PROFILE, revision: 0,
  generation: 1, epoch: 'c'.repeat(32),
  entities: [account(A, 1, 10_000)],
  pending: [{ mutationId: T1, status: 'pending' }],
  conflicts: [{ kind: 'manual', id: T2 }],
});
const post = (id, delta) => ({ account_id: id, signed_minor: delta });
const change = (revision, ordinal, entity, affectedAccounts = []) => ({
  revision, ordinal, kind: entity.kind === 'transaction' ? 'ledger_posted' : 'upsert',
  entity_id: entity.id, entity_revision: entity.entity_revision,
  payload: { entity, ...(entity.kind === 'transaction' ? {accounts: affectedAccounts} : {}) },
});
const page = (...events) => ({
  schema_version: 1, from_revision: 0, to_revision: 1,
  next_since_revision: 1, has_more: false, changes: events,
});
const expectHold = (fn) => assert.throws(fn, /SYNC_HOLD:/);

test('complete cursor-linked snapshot is accepted without local side effects', () => {
  const first = {
    schema_version: 1, profile_id: PROFILE, revision: 7, currency: 'RUB',
    entities: [account(A, 2, 9000)],
    next_cursor: '7:account:' + A,
  };
  const second = {...first, entities: [account(B, 1, 10_000)]};
  delete second.next_cursor;
  const result = verifyFinanceSnapshotPagesCandidate(
    [{cursorSent: null, body: first},
     {cursorSent: first.next_cursor, body: second}],
    guard(),
  );
  assert.equal(result.revision, 7);
  assert.equal(result.entities.length, 2);
  assert.equal(result.scope, SCOPE);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(first.entities[0].data.balance_minor, 9000);
  expectHold(() => verifyFinanceSnapshotPagesCandidate(
    [{cursorSent: null, body: first}], guard()));
  expectHold(() => verifyFinanceSnapshotPagesCandidate(
    [{cursorSent: null, body: first}, {cursorSent: 'bad', body: second}], guard()));
  expectHold(() => verifyFinanceSnapshotPagesCandidate(
    [{cursorSent: null, body: first},
     {cursorSent: first.next_cursor, body: {...second, revision: 8}}], guard()));
});

test('contiguous ledger delta applies exactly once and never discards pending edits', () => {
  const source = local();
  const t = transaction(T1, [post(A, -1000)]);
  const delta = page(change(1, 0, t, [account(A, 2, 9000)]));
  const result = applyFinanceDeltaCandidate(source, delta, guard());
  assert.equal(result.revision, 1);
  assert.equal(result.entities.find(x => x.id === A).data.balance_minor, 9000);
  assert.equal(result.entities.find(x => x.id === T1).data.postings[0].signed_minor, -1000);
  assert.deepEqual(result.pending, source.pending);
  assert.deepEqual(result.conflicts, source.conflicts);
  assert.notEqual(result.pending, source.pending);
  assert.equal(source.revision, 0);
  assert.equal(source.entities[0].data.balance_minor, 10_000);
  expectHold(() => applyFinanceDeltaCandidate(result, delta, guard()));
});

test('multi-event revisions and multi-page journal do not split atomic payments', () => {
  const l = local();
  const expenseBase = transaction(T1, [post(A, -1200)]);
  const expense = {...expenseBase, data: {...expenseBase.data,
    kind: 'payment', payment_link: {loan_payment_id: B, settlement_id: null}}};
  const fact = {id: B, entity_revision: 1, kind: 'loan_payment', data: {
    loan_id: 'b0000000-0000-4000-8000-000000000009',
    paid_on: '2026-11-11', amount_minor: 1200, strategy: 'term', voided_at: null,
  }};
  const firstPage = {...page(change(1, 0, expense, [account(A, 2, 8800)]),
                              change(1, 1, fact)),
    to_revision: 2, has_more: true};
  const first = applyFinanceDeltaCandidate(l, firstPage, guard());
  assert.equal(first.revision, 1);
  const adj = {id: T2, entity_revision: 1, kind: 'obligation',
    data: { title: 'Synthetic', direction: 'expense', amount_minor: 1 }};
  const secondPage = {schema_version: 1, from_revision: 1, to_revision: 2,
    next_since_revision: 2, has_more: false, changes: [change(2, 0, adj)]};
  const complete = applyFinanceDeltaCandidate(first, secondPage, guard());
  assert.equal(complete.revision, 2);
  assert.equal(complete.entities.length, 4);
  const split = {...firstPage, changes: firstPage.changes.slice(0, 1)};
  expectHold(() => applyFinanceDeltaCandidate(l, split, guard()));
});

test('wrong user, stale generation, missing revision and stale cookie cannot mutate state', () => {
  const orig = local();
  const valid = page(change(1, 0, transaction(T1, [post(A, -1000)]),
                            [account(A, 2, 9000)]));
  for (const patch of [
    {scope: 'account:' + 'b'.repeat(32)},
    {profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},
    {generation: 2}, {epoch: 'd'.repeat(32)},
  ]) expectHold(() => applyFinanceDeltaCandidate(orig, valid, {...guard(), ...patch}));
  const controller = new AbortController(); controller.abort();
  expectHold(() => applyFinanceDeltaCandidate(orig, valid,
    {...guard(), signal: controller.signal}));
  for (const patch of [
    {from_revision: 1},
    {next_since_revision: 0},
    {has_more: true},
    {changes: [{...valid.changes[0], revision: 3}]},
    {changes: [{...valid.changes[0], ordinal: 1}]},
    {changes: []},
  ]) expectHold(() => applyFinanceDeltaCandidate(orig, {...valid, ...patch}, guard()));
  assert.equal(orig.revision, 0);
});

test('unbalanced transfers, unproven accounts and malformed money fail closed', () => {
  const orig = {...local(), entities: [account(A, 1, 10_000), account(B, 1, 10_000)]};
  const wrong = transaction(T1, [post(A, -100), post(B, 90)]);
  expectHold(() => applyFinanceDeltaCandidate(orig,
    page(change(1, 0, wrong, [account(A, 2, 9900), account(B, 2, 10_090)])), guard()));
  const correct = transaction(T1, [post(A, -100), post(B, 100)]);
  expectHold(() => applyFinanceDeltaCandidate(orig,
    page(change(1, 0, correct, [account(A, 2, 9900)])), guard()));
  expectHold(() => applyFinanceDeltaCandidate(orig,
    page(change(1, 0, correct, [account(A, 2, 9900),
      {...account(B, 2, 10_100), data: {...account(B, 2, 10_100).data, available_minor: 12}}])), guard()));
  const injected = JSON.parse('{"__proto__":{"polluted":true}}');
  expectHold(() => applyFinanceDeltaCandidate(orig,
    page({...change(1, 0, correct, [account(A, 2, 9900), account(B, 2, 10_100)]),
      payload: {...change(1, 0, correct).payload, extra: injected,
        accounts: [account(A, 2, 9900), account(B, 2, 10_100)]}}), guard()));
});


test('linked payment compensation requires a fact-void event in the same revision', () => {
  const payment = transaction(T1, [post(A, -1200)]);
  payment.data.kind = 'payment';
  payment.data.payment_link = {loan_payment_id: B, settlement_id: null};
  const oldFact = {id: B, entity_revision: 1, kind: 'loan_payment',
    data: {loan_id: 'b0000000-0000-4000-8000-000000000009',
      paid_on: '2026-11-11', amount_minor: 1200,
      strategy: 'term', voided_at: null}};
  const before = {...local(), revision: 5,
    entities: [account(A, 2, 8800), payment, oldFact]};
  const reversed = transaction(T2, [post(A, 1200)]);
  reversed.data.kind = 'reversal';
  reversed.data.reversed_transaction_id = T1;
  const voided = {...oldFact, entity_revision: 2,
    data: {...oldFact.data, voided_at: '2026-11-11T12:00:00Z'}};
  const valid = {schema_version: 1, from_revision: 5, to_revision: 6,
    next_since_revision: 6, has_more: false, changes: [
      change(6, 0, reversed, [account(A, 3, 10_000)]),
      change(6, 1, voided),
    ]};
  const next = applyFinanceDeltaCandidate(before, valid, guard());
  assert.equal(next.revision, 6);
  assert.equal(next.entities.find(x => x.id === B).data.voided_at,
    '2026-11-11T12:00:00Z');
  const split = {...valid, changes: valid.changes.slice(0, 1)};
  expectHold(() => applyFinanceDeltaCandidate(before, split, guard()));
});

test('never accepts a past-revision event or an empty has_more page', () => {
  const orig = local();
  const valid = page(change(1, 0, transaction(T1, [post(A, -100)]),
    [account(A, 2, 9900)]));
  expectHold(() => applyFinanceDeltaCandidate(orig, {
    ...valid, changes: [{...valid.changes[0], revision: 0}],
  }, guard()));
  expectHold(() => applyFinanceDeltaCandidate(orig, {
    ...valid, changes: [], has_more: true, to_revision: 2,
    next_since_revision: 0,
  }, guard()));
});
