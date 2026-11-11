import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLedgerState } from '../src/domain/accounts/invariants.ts';
import { applyLedgerCommand, emptyLedger, totalBalanceMinor, accountBalanceMinor, availableBalanceMinor, monthlyCashFlowMinor } from '../src/domain/accounts/ledger.ts';

const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const context = profileId => ({ profileId, actorUserId: '0123456789abcdef0123456789abcdef' });
const u = (() => { let i = 100; return () => uuid(++i); })();
function run(state, action, payload, expected = {}, verifiedPaymentFact) {
  const cmd = { clientMutationId: u(), baseRevision: state.revision, expectedEntityRevisions: expected, action, payload };
  return applyLedgerCommand(state, cmd, { ...context(state.profileId), verifiedPaymentFact }).state;
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
  }, { ...revisions(s, accountId), [loanId]: 1 }, {
    profileId: s.profileId, id: loanId, source: 'loanPayment',
    direction: 'expense', amountMinor, entityRevision: 1, voidedAt: null,
  });
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

test('public balance/cash-flow readers never silently omit corrupt or foreign postings', () => {
  const broken = fixture();
  broken.postings[0].profileId = uuid(9);
  for (const query of [
    () => accountBalanceMinor(broken, uuid(2)),
    () => totalBalanceMinor(broken),
    () => availableBalanceMinor(broken, uuid(2), 100),
    () => monthlyCashFlowMinor(broken, '2026-11'),
  ]) {
    assert.throws(query, /Проводка/);
  }
});

test('hydrated ledger rejects a linked payment reversal without an atomic fact void', () => {
  const s = fixture();
  const original = s.transactions.find(tx => tx.kind === 'payment');
  assert.ok(original);
  const originalPosting = s.postings.find(p => p.transactionId === original.id);
  assert.ok(originalPosting);
  const reversalId = uuid(19);
  s.transactions.push({
    id: reversalId, profileId: s.profileId, kind: 'reversal',
    occurredOn: '2026-11-07', actorUserId: original.actorUserId,
    note: 'Небезопасная отмена', entityRevision: 1, reversedTransactionId: original.id,
  });
  s.postings.push({
    profileId: s.profileId, transactionId: reversalId,
    accountId: originalPosting.accountId, signedMinor: -originalPosting.signedMinor,
  });
  s.revision++;
  assert.throws(() => assertLedgerState(s), /Связанная оплата отменена/);
});

test('hydrated snapshot rejects a positive loan payment while allowing income settlement', () => {
  const corrupt = fixture();
  const loanPosting = corrupt.postings.find(p => p.transactionId === uuid(6));
  assert.ok(loanPosting);
  loanPosting.signedMinor = 500;
  assert.throws(() => assertLedgerState(corrupt), /Кредитный платёж не может быть поступлением/);
  let valid = create(emptyLedger(uuid(1)), uuid(2), 1_000);
  const settlementId = uuid(11);
  valid = run(valid, 'payment.record', {
    id: uuid(12), accountId: uuid(2), amountMinor: 500,
    link: { settlementId }, occurredOn: '2026-11-07',
  }, { ...revisions(valid, uuid(2)), [settlementId]: 1 }, {
    profileId: valid.profileId, id: settlementId, source: 'settlement',
    direction: 'income', amountMinor: 500, entityRevision: 1, voidedAt: null,
  });
  assert.doesNotThrow(() => assertLedgerState(valid), 'positive settlement is a valid income');
  assert.equal(accountBalanceMinor(valid, uuid(2)), 1_500);
});

test('orphan command receipt cannot suppress missing debit after corrupted restore', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  s = run(s, 'transaction.record', {
    id: uuid(18), accountId: uuid(2), kind: 'expense',
    signedMinor: -500, occurredOn: '2026-11-07',
  }, revisions(s, uuid(2)));
  const receipt = s.receipts.at(-1);
  const command = JSON.parse(receipt.requestFingerprint);
  const damaged = structuredClone(s);
  damaged.transactions = [];
  damaged.postings = [];
  assert.throws(() => assertLedgerState(damaged), /Квитанция указывает на отсутствующую/);
  assert.throws(() => applyLedgerCommand(damaged, command, context(damaged.profileId)), /Квитанция указывает на отсутствующую/);
  assert.equal(accountBalanceMinor(s, uuid(2)), 9_500);
  assert.equal(damaged.receipts.length, s.receipts.length);
});

test('receipt target must match the entity kind and exact original command', () => {
  const s = create(emptyLedger(uuid(1)), uuid(2), 250);
  const mismatch = structuredClone(s);
  mismatch.receipts[0].affectedId = uuid(1);
  assert.throws(() => assertLedgerState(mismatch), /Квитанция указывает на отсутствующую/);
  const tampered = structuredClone(s);
  const request = JSON.parse(tampered.receipts[0].requestFingerprint);
  request.payload.id = uuid(19);
  tampered.receipts[0].requestFingerprint = JSON.stringify(request);
  assert.throws(() => assertLedgerState(tampered), /Квитанция указывает на отсутствующую/);
  const malformed = structuredClone(s);
  malformed.receipts[0].requestFingerprint = '{not-json';
  assert.throws(() => assertLedgerState(malformed), /Повреждён исходный запрос/);
});

test('mixed-case UUID aliases are rejected before persistence or aggregation', () => {
  const lowercase = uuid(10);
  const uppercase = lowercase.toUpperCase();
  const s = create(emptyLedger(uuid(1)), lowercase, 700);
  assert.notEqual(lowercase, uppercase);
  assert.throws(() => create(s, uppercase, 100), /UUID/);
  const damaged = structuredClone(s);
  damaged.accounts[0].id = uppercase;
  assert.throws(() => assertLedgerState(damaged), /UUID/);
  assert.equal(totalBalanceMinor(s), 700);
});

test('correction receipt cannot replay a partially restored replacement without its reversal', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  s = run(s, 'transaction.record', {
    id: uuid(3), accountId: uuid(2), kind: 'expense',
    signedMinor: -500, occurredOn: '2026-11-07',
  }, revisions(s, uuid(2)));
  s = run(s, 'transaction.correct', {
    originalTransactionId: uuid(3), reversalId: uuid(4),
    reason: 'Исправлена сумма', occurredOn: '2026-11-07',
    replacement: {
      id: uuid(5), kind: 'expense', accountId: uuid(2),
      signedMinor: -700, occurredOn: '2026-11-07',
    },
  }, revisions(s, uuid(2), uuid(3)));
  assert.equal(accountBalanceMinor(s, uuid(2)), 9_300);
  const c = JSON.parse(s.receipts.at(-1).requestFingerprint);
  const damaged = structuredClone(s);
  damaged.transactions = damaged.transactions.filter(tx => tx.id !== uuid(4));
  damaged.postings = damaged.postings.filter(p => p.transactionId !== uuid(4));
  assert.throws(() => assertLedgerState(damaged), /Квитанция исправления без нужной компенсирующей операции/);
  assert.throws(() => applyLedgerCommand(damaged, c, context(s.profileId)),
    /Квитанция исправления без нужной компенсирующей операции/);
  assert.equal(accountBalanceMinor(s, uuid(2)), 9_300);
});

test('correction receipt rejects a reversal relinked to a different equally sized expense', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  for (const txId of [uuid(3), uuid(6)]) {
    s = run(s, 'transaction.record', {
      id: txId, accountId: uuid(2), kind: 'expense',
      signedMinor: -500, occurredOn: '2026-11-07',
    }, revisions(s, uuid(2)));
  }
  s = run(s, 'transaction.correct', {
    originalTransactionId: uuid(3), reversalId: uuid(4),
    reason: 'Исправление', occurredOn: '2026-11-07',
    replacement: {
      id: uuid(5), kind: 'expense', accountId: uuid(2),
      signedMinor: -700, occurredOn: '2026-11-07',
    },
  }, revisions(s, uuid(2), uuid(3)));
  const altered = structuredClone(s);
  const reversal = altered.transactions.find(tx => tx.id === uuid(4));
  assert.ok(reversal);
  reversal.reversedTransactionId = uuid(6);
  assert.throws(() => assertLedgerState(altered), /Квитанция исправления без нужной компенсирующей операции/);
});

test('payment receipt binds the exact settlement or loan fact and account debit', () => {
  const original = fixture();
  const command = JSON.parse(original.receipts.at(-1).requestFingerprint);
  for (const modify of [
    state => { state.paymentLinks[0].loanPaymentId = uuid(20); },
    state => { delete state.paymentLinks[0].loanPaymentId; state.paymentLinks[0].settlementId = uuid(21); },
  ]) {
    const damaged = structuredClone(original);
    modify(damaged);
    assert.throws(() => assertLedgerState(damaged), /Квитанция не соответствует связи оплаты/);
    assert.throws(() => applyLedgerCommand(damaged, command, context(damaged.profileId)),
      /Квитанция не соответствует связи оплаты/);
  }
});

test('standalone reversal receipt rejects another equally sized original', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  for (const txId of [uuid(3), uuid(6)]) {
    s = run(s, 'transaction.record', {
      id: txId, accountId: uuid(2), kind: 'expense',
      signedMinor: -500, occurredOn: '2026-11-07',
    }, revisions(s, uuid(2)));
  }
  s = run(s, 'transaction.reverse', {
    id: uuid(4), transactionId: uuid(3),
    occurredOn: '2026-11-07', reason: 'Отмена',
  }, revisions(s, uuid(2), uuid(3)));
  const damaged = structuredClone(s);
  damaged.transactions.find(tx => tx.id === uuid(4)).reversedTransactionId = uuid(6);
  assert.throws(() => assertLedgerState(damaged), /Квитанция отмены указывает на другую/);
});

test('zero-sum altered transfer and smaller debit fail immutable receipt reconciliation', () => {
  const original = fixture();
  const altered = structuredClone(original);
  altered.postings.find(p => p.transactionId === uuid(4) && p.signedMinor < 0).signedMinor = -7_000;
  altered.postings.find(p => p.transactionId === uuid(4) && p.signedMinor > 0).signedMinor = 7_000;
  assert.throws(() => assertLedgerState(altered), /Квитанция не соответствует проводкам/);

  let expense = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  expense = run(expense, 'transaction.record', {
    id: uuid(3), accountId: uuid(2), kind: 'expense',
    signedMinor: -500, occurredOn: '2026-11-07',
  }, revisions(expense, uuid(2)));
  const corrupt = structuredClone(expense);
  corrupt.postings[0].signedMinor = -200;
  assert.throws(() => assertLedgerState(corrupt), /Квитанция не соответствует проводкам/);
});

test('changed account opening balance is rejected even when signed rows are otherwise valid', () => {
  const s = fixture();
  const corrupt = structuredClone(s);
  corrupt.accounts[0].openingMinor += 700;
  assert.throws(() => assertLedgerState(corrupt), /Квитанция создания не соответствует начальному остатку/);
});

test('correction receipt verifies replacement posting amount as well as its reversal', () => {
  let s = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  s = run(s, 'transaction.record', {
    id: uuid(3), accountId: uuid(2), kind: 'expense',
    signedMinor: -500, occurredOn: '2026-11-07',
  }, revisions(s, uuid(2)));
  s = run(s, 'transaction.correct', {
    originalTransactionId: uuid(3), reversalId: uuid(4), reason: 'Правка',
    occurredOn: '2026-11-07', replacement: {
      id: uuid(5), kind: 'expense', accountId: uuid(2),
      signedMinor: -700, occurredOn: '2026-11-07',
    },
  }, revisions(s, uuid(2), uuid(3)));
  const damaged = structuredClone(s);
  damaged.postings.find(p => p.transactionId === uuid(5)).signedMinor = -800;
  assert.throws(() => assertLedgerState(damaged), /Квитанция не соответствует проводкам/);
});

test('payment receipt preserves the signed direction of real expense and income settlements', () => {
  const initial = create(emptyLedger(uuid(1)), uuid(2), 10_000);
  for (const direction of ['income', 'expense']) {
    const signed = direction === 'income' ? 500 : -500;
    const factId = direction === 'income' ? uuid(21) : uuid(22);
    const s = run(initial, 'payment.record', {
      id: direction === 'income' ? uuid(23) : uuid(24),
      accountId: uuid(2), amountMinor: 500,
      link: { settlementId: factId }, occurredOn: '2026-11-07',
    }, { ...revisions(initial, uuid(2)), [factId]: 1 }, {
      profileId: initial.profileId, id: factId, source: 'settlement',
      direction, amountMinor: 500, entityRevision: 1, voidedAt: null,
    });
    assert.doesNotThrow(() => assertLedgerState(s));
    assert.equal(s.receipts.at(-1).postedSignedMinor, signed);
    assert.equal(accountBalanceMinor(s, uuid(2)), 10_000 + signed);
    const damaged = structuredClone(s);
    damaged.postings.at(-1).signedMinor = -signed;
    assert.throws(() => assertLedgerState(damaged), /Квитанция не соответствует проводкам/);
    const reply = JSON.parse(s.receipts.at(-1).requestFingerprint);
    assert.equal(applyLedgerCommand(s, reply, context(s.profileId)).replayed, true);
    assert.equal(s.postings.length, 1);
  }
});

test('missing or altered signed payment receipt must not hide a changed cash direction', () => {
  const source = fixture();
  const without = structuredClone(source);
  delete without.receipts.at(-1).postedSignedMinor;
  assert.throws(() => assertLedgerState(without), /Повреждена сумма/);
  const changed = structuredClone(source);
  changed.receipts.at(-1).postedSignedMinor = 500;
  assert.throws(() => assertLedgerState(changed), /Квитанция не соответствует проводкам/);
});

test('monthly cash flow remains exact on 6000 transfers and cross-month compensation', () => {
  const profileId = uuid(1);
  const bankId = uuid(2);
  const cashId = uuid(3);
  const actorUserId = context(profileId).actorUserId;
  const s = emptyLedger(profileId);
  s.revision = 6005;
  s.accounts = [
    { id: bankId, profileId, name: 'Банк', kind: 'bank', currency: 'RUB', openingMinor: 100_000, entityRevision: 6004, archivedAt: null },
    { id: cashId, profileId, name: 'Наличные', kind: 'cash', currency: 'RUB', openingMinor: 0, entityRevision: 6001, archivedAt: null },
  ];
  const tx = (id, kind, occurredOn, reversedTransactionId = null) => ({
    id, profileId, kind, occurredOn, actorUserId, note: null, entityRevision: 1, reversedTransactionId,
  });
  const posting = (transactionId, accountId, signedMinor) =>
    ({ profileId, transactionId, accountId, signedMinor });

  for (let i = 0; i < 6000; i++) {
    const transactionId = uuid(1000 + i);
    s.transactions.push(tx(transactionId, 'transfer', '2026-11-07'));
    s.postings.push(posting(transactionId, bankId, -1), posting(transactionId, cashId, 1));
  }
  const incomeId = uuid(9001), expenseId = uuid(9002), reversalId = uuid(9003);
  s.transactions.push(
    tx(incomeId, 'income', '2026-11-08'),
    tx(expenseId, 'expense', '2026-11-08'),
    tx(reversalId, 'reversal', '2026-12-01', incomeId),
  );
  s.postings.push(
    posting(incomeId, bankId, 450),
    posting(expenseId, bankId, -125),
    posting(reversalId, bankId, -450),
  );

  assert.doesNotThrow(() => assertLedgerState(s));
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-11'), { incomeMinor: 450, expenseMinor: 125 });
  assert.deepEqual(monthlyCashFlowMinor(s, '2026-12'), { incomeMinor: -450, expenseMinor: 0 });
  assert.equal(totalBalanceMinor(s), 99_875);
});


function snapshotWithAtomicLinkedVoid(source = 'loanPayment') {
  let s;
  if (source === 'loanPayment') {
    s = fixture();
  } else {
    s = create(emptyLedger(uuid(1)), uuid(2), 10_000);
    const settlementId = uuid(22);
    s = run(s, 'payment.record', {
      id: uuid(23), accountId: uuid(2), amountMinor: 200,
      link: { settlementId }, occurredOn: '2026-11-07',
    }, { ...revisions(s, uuid(2)), [settlementId]: 1 }, {
      profileId: s.profileId, id: settlementId, source: 'settlement',
      direction: 'income', amountMinor: 200, entityRevision: 1,
      voidedAt: null,
    });
  }
  const payment = s.transactions.find(tx => tx.kind === 'payment');
  const link = s.paymentLinks.find(item => item.transactionId === payment.id);
  const factId = source === 'loanPayment' ? link.loanPaymentId : link.settlementId;
  const posting = s.postings.find(item => item.transactionId === payment.id);
  const reversalId = uuid(31);
  s.transactions.push({
    id: reversalId, profileId: s.profileId, kind: 'reversal',
    occurredOn: '2026-11-11', actorUserId: payment.actorUserId,
    note: 'Подтверждённое аннулирование', entityRevision: 1,
    reversedTransactionId: payment.id,
  });
  s.postings.push({
    profileId: s.profileId, transactionId: reversalId,
    accountId: posting.accountId, signedMinor: -posting.signedMinor,
  });
  s.accounts.find(x => x.id === posting.accountId).entityRevision++;
  s.revision++;
  s.linkedPaymentVoids = [{
    profileId: s.profileId, transactionId: payment.id,
    factId, source, entityRevision: 2, reversedByTransactionId: reversalId,
    voidedAt: '2026-11-11T12:30:41.123456+00:00',
  }];
  return s;
}

test('authoritative settlement/loan fact void and matching reversal are accepted', () => {
  for (const source of ['loanPayment', 'settlement']) {
    const s = snapshotWithAtomicLinkedVoid(source);
    assert.doesNotThrow(() => assertLedgerState(s));
    const original = s.transactions.find(x => x.kind === 'payment');
    const reversed = s.transactions.find(x => x.kind === 'reversal');
    assert.equal(reversed.reversedTransactionId, original.id);
    assert.equal(s.linkedPaymentVoids.length, 1);
    assert.equal(s.linkedPaymentVoids[0].entityRevision, 2);
    const originalPosting = s.postings.find(x => x.transactionId === original.id);
    const reversalPosting = s.postings.find(x => x.transactionId === reversed.id);
    assert.equal(originalPosting.signedMinor + reversalPosting.signedMinor, 0);
    // Compensated movement cannot invent assets, change original payment or
    // silently double-charge the financial profile.
    assert.equal(totalBalanceMinor(s),
      source === 'loanPayment' ? 101_000 : 10_000);
    assert.doesNotThrow(() => assertLedgerState(JSON.parse(JSON.stringify(s))));
  }
});

test('linked reversal proof must match original, fact, source and compensated transaction', () => {
  const clean = snapshotWithAtomicLinkedVoid('loanPayment');
  const mutations = [
    [s => { delete s.linkedPaymentVoids; }, /Связанная оплата отменена/],
    [s => { s.linkedPaymentVoids = []; }, /Связанная оплата отменена/],
    [s => { s.linkedPaymentVoids[0].profileId = uuid(9); }, /Чужой/],
    [s => { s.linkedPaymentVoids[0].transactionId = uuid(9); }, /Факт отмены/],
    [s => { s.linkedPaymentVoids[0].factId = uuid(9); }, /Факт отмены/],
    [s => { s.linkedPaymentVoids[0].source = 'settlement'; }, /Факт отмены/],
    [s => { s.linkedPaymentVoids[0].reversedByTransactionId = uuid(9); }, /Факт отмены/],
    [s => { s.linkedPaymentVoids[0].entityRevision = 1; }, /ревизия/],
    [s => { s.linkedPaymentVoids[0].voidedAt = '2026-02-30T00:00:00Z'; }, /дата/],
    [s => { s.linkedPaymentVoids.push(structuredClone(s.linkedPaymentVoids[0])); }, /Факт отмены|Повреждены факты/],
    [s => { s.transactions.find(x => x.kind === 'reversal').reversedTransactionId = uuid(19); }, /Факт отмены/],
    [s => { s.postings.find(x => x.transactionId === uuid(31)).signedMinor = -7; }, /компенсация/],
  ];
  for (const [modify, message] of mutations) {
    const broken = structuredClone(clean);
    modify(broken);
    assert.throws(() => assertLedgerState(broken), message);
    assert.throws(() => totalBalanceMinor(broken), message,
      'Financial totals must not silently accept a corrupt void proof');
  }
});

test('void metadata without its cash reversal is not a completed linked payment', () => {
  const clean = snapshotWithAtomicLinkedVoid();
  const missing = structuredClone(clean);
  missing.transactions = missing.transactions.filter(x => x.id !== uuid(31));
  missing.postings = missing.postings.filter(x => x.transactionId !== uuid(31));
  assert.throws(() => assertLedgerState(missing), /Факт отмены/);
});
