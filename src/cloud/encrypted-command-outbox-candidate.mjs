/**
 * #68 - account-scoped encrypted offline command queue.
 *
 * This module makes no HTTP calls or optimistic cash postings. Queue operations
 * are encrypted with the existing #34 snapshot/outbox/conflict native IDB CAS;
 * the authenticated controller owns dispatch and its browser lifecycle.
 * The server remains authoritative for confirmed account balances.
 */
import {
  readAtomicEncryptedCandidate,
  compareAndSwapAtomicEncryptedCandidate,
} from '../security/protected-atomic-candidate.ts';
import {applyFinanceDeltaCandidate} from './verified-delta-candidate.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPE = /^account:[a-f0-9]{32}$/;
const EPOCH = /^[a-f0-9]{32}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_BYTES = 32768;
const MAX_QUEUE = 1000;
const ACTION_FIELDS = Object.freeze({
  'obligation.create': ['title', 'direction', 'amount_minor', 'starts_on', 'timezone', 'recurrence_unit', 'recurrence_every'],
  'account.transfer': ['from_account_id', 'to_account_id', 'amount_minor', 'occurred_on'],
  'transaction.reverse': ['transaction_id', 'reason'],
  'account.create': ['id', 'name', 'kind', 'currency', 'opening_minor'],
  'account.update': ['account_id', 'name', 'kind'],
  'account.archive': ['account_id'],
  'account.unarchive': ['account_id'],
  'transaction.record': ['id', 'account_id', 'kind', 'signed_minor', 'occurred_on'],
  'settlement.payment.record': ['obligation_id', 'account_id', 'amount_minor', 'paid_on', 'occurrence_on'],
  'loan.payment.record': ['loan_id', 'account_id', 'amount_minor', 'paid_on', 'strategy'],
  'settlement.payment.void': ['transaction_id', 'fact_id', 'account_id', 'reason'],
  'loan.payment.void': ['transaction_id', 'fact_id', 'account_id', 'reason'],
});
const OPTIONAL_FIELDS = Object.freeze({
  'transaction.record': ['note'],
  'settlement.payment.record': ['reserve_id', 'reserved_used_minor'],
  'settlement.payment.void': ['reserve_id'],
});

function hold(message) { throw Error('SYNC_HOLD: ' + message); }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function plain(value) {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
     Object.getPrototypeOf(value) === null);
}
function safeJson(value, visited = new Set(), depth = 0) {
  if (depth > 24) hold('Слишком глубокая финансовая команда');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== 'object' || visited.has(value)) {
    hold('Некорректное поле финансовой команды');
  }
  visited.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length ||
        Object.keys(value).length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1 ||
        value.length > 1000) hold('Некорректный массив');
    result = [];
    for (let i = 0; i < value.length; i++) {
      const field = Object.getOwnPropertyDescriptor(value, i);
      if (!field || !Object.hasOwn(field, 'value')) hold('Недопустимый элемент массива');
      result.push(safeJson(field.value, visited, depth + 1));
    }
  } else {
    if (!plain(value) || Object.getOwnPropertySymbols(value).length ||
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
        Object.keys(value).length > 100) hold('Некорректная структура команды');
    // Produce ordinary JSON objects: the independent authoritative delta
    // validator rejects exotic/null prototypes. Dangerous field names and
    // accessors are rejected before assigning into this plain object.
    result = {};
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (name === '__proto__' || name === 'prototype' || name === 'constructor' ||
          !Object.hasOwn(descriptor, 'value')) hold('Недоверенное поле команды');
      result[name] = safeJson(descriptor.value, visited, depth + 1);
    }
  }
  visited.delete(value);
  return result;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k =>
      JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function keysExactly(object, required, optional = []) {
  if (!plain(object)) hold('Неверная структура команды');
  const current = Object.keys(object);
  if (current.length < required.length ||
      !required.every(k => Object.hasOwn(object, k)) ||
      current.some(k => !required.includes(k) && !optional.includes(k))) {
    hold('Неизвестные или отсутствующие финансовые поля');
  }
}
/** Bind the server's independently observed payment to the exact queued intent. */
function consistentEvent(change) {
  const entity = change?.payload?.entity;
  return plain(entity) && UUID.test(entity.id) && change.entity_id === entity.id &&
    integer(entity.entity_revision, 1) && change.entity_revision === entity.entity_revision;
}
function verifySettlementReceipt(command, changes, entities, previouslyApplied) {
  if (command.action !== 'settlement.payment.record') return;
  if (!Array.isArray(entities)) hold('Нет подтверждённого снимка обязательств');
  const payload = command.payload;
  const obligations = entities.filter(entity => entity.id === payload.obligation_id &&
    entity.kind === 'obligation');
  const transactions = changes.filter(change => change.kind === 'ledger_posted' &&
    change.payload?.entity?.kind === 'transaction');
  const facts = changes.filter(change => change.kind === 'upsert' &&
    change.payload?.entity?.kind === 'settlement');
  if (obligations.length !== 1 || transactions.length !== 1 || facts.length !== 1 ||
      !consistentEvent(transactions[0]) || !consistentEvent(facts[0])) {
    hold('Подтверждение не соответствует ожидаемой оплате');
  }
  const direction = obligations[0].data?.direction;
  const transaction = transactions[0].payload.entity;
  const fact = facts[0].payload.entity;
  const tx = transaction.data;
  const settlement = fact.data;
  const hasReserve = Object.hasOwn(payload, 'reserve_id');
  const used = hasReserve ? payload.reserved_used_minor : 0;
  const signed = direction === 'expense' ? -payload.amount_minor :
    direction === 'income' ? payload.amount_minor : null;
  if (signed === null || tx?.kind !== 'payment' || tx.occurred_on !== payload.paid_on ||
      !Array.isArray(tx.postings) || tx.postings.length !== 1 ||
      tx.postings[0]?.account_id !== payload.account_id ||
      tx.postings[0]?.signed_minor !== signed ||
      tx.payment_link?.settlement_id !== fact.id ||
      tx.payment_link?.loan_payment_id !== null ||
      settlement?.obligation_id !== payload.obligation_id ||
      settlement.amount_minor !== payload.amount_minor ||
      settlement.occurrence_on !== payload.occurrence_on ||
      settlement.paid_on !== payload.paid_on || settlement.voided_at !== null) {
    hold('Проводка или факт оплаты не соответствуют исходной команде');
  }
  if (hasReserve) {
    const reserveEvents = changes.filter(change => change.kind === 'upsert' &&
      change.payload?.entity?.kind === 'reserve' && change.payload.entity.id === payload.reserve_id);
    const reserves = entities.filter(entity => entity.kind === 'reserve' && entity.id === payload.reserve_id);
    const allocation = tx.reserve_allocation;
    if (reserveEvents.length !== 1 || !consistentEvent(reserveEvents[0]) ||
        reserves.length !== 1 || direction !== 'expense' ||
        (used > 0 && (!plain(allocation) || !UUID.test(allocation.id) ||
          allocation.reserve_id !== payload.reserve_id || allocation.account_id !== payload.account_id ||
          allocation.delta_minor !== -used || allocation.reverses_allocation_id !== null)) ||
        (used === 0 && allocation !== undefined)) {
      hold('Не подтверждена связь оплаты с резервом');
    }
    const priorReserve = reserves[0].data;
    const updatedReserve = reserveEvents[0].payload.entity.data;
    const log = updatedReserve?.event_log;
    const matches = Array.isArray(log) ? log.filter(event =>
      event.kind === 'payment' && event.transaction_id === transaction.id &&
      event.revision === transactions[0].revision) : [];
    if (updatedReserve?.account_id !== payload.account_id ||
        updatedReserve?.obligation_id !== payload.obligation_id ||
        updatedReserve?.target_on !== payload.occurrence_on || matches.length !== 1 ||
        !UUID.test(matches[0].id) ||
        matches[0].reserve_id !== payload.reserve_id ||
        matches[0].occurred_on !== payload.paid_on ||
        matches[0].cycle_number !== updatedReserve.cycle_number ||
        matches[0].amount_minor !== payload.amount_minor ||
        matches[0].reserved_used_minor !== used) {
      hold('История резерва не подтверждает оплату');
    }
    if (!previouslyApplied && (!Array.isArray(priorReserve?.event_log) ||
        priorReserve.account_id !== payload.account_id ||
        priorReserve.obligation_id !== payload.obligation_id ||
        priorReserve.target_on !== payload.occurrence_on ||
        !integer(priorReserve.allocated_minor) || !integer(priorReserve.allocated_minor - used) ||
        updatedReserve.allocated_minor !== priorReserve.allocated_minor - used ||
        log.length !== priorReserve.event_log.length + 1 ||
        canonical(log.slice(0, -1)) !== canonical(priorReserve.event_log))) {
      hold('Изменение резерва не соответствует оплате');
    }
    if (previouslyApplied && (!Array.isArray(priorReserve?.event_log) ||
        !priorReserve.event_log.some(event => canonical(event) === canonical(matches[0])))) {
      hold('Сохранённый снимок не содержит событие оплаты резерва');
    }
  } else if (tx.reserve_allocation !== undefined || changes.some(change =>
    change.payload?.entity?.kind === 'reserve')) {
    hold('Неожиданное движение резерва');
  }
  if (previouslyApplied) {
    const storedTransaction = entities.filter(entity => entity.kind === 'transaction' && entity.id === transaction.id);
    const storedFacts = entities.filter(entity => entity.kind === 'settlement' && entity.id === fact.id);
    if (storedTransaction.length !== 1 || storedFacts.length !== 1 ||
        canonical(storedTransaction[0].data) !== canonical(transaction.data) ||
        storedFacts[0].data?.obligation_id !== settlement.obligation_id ||
        storedFacts[0].data?.amount_minor !== settlement.amount_minor ||
        storedFacts[0].data?.paid_on !== settlement.paid_on ||
        storedFacts[0].data?.occurrence_on !== settlement.occurrence_on) {
      hold('Сохранённый снимок не содержит подтверждённую оплату');
    }
  }
  if (!previouslyApplied) {
    const prior = entities.filter(entity => entity.id === payload.account_id && entity.kind === 'account');
    const updated = transactions[0].payload.accounts;
    if (prior.length !== 1 || !Array.isArray(updated) || updated.length !== 1 ||
        updated[0]?.id !== payload.account_id || updated[0]?.kind !== 'account' ||
        !Number.isSafeInteger(prior[0].data?.balance_minor + signed) ||
        updated[0].data?.balance_minor !== prior[0].data?.balance_minor + signed ||
        updated[0].data?.reserved_minor !== prior[0].data?.reserved_minor - used) {
      hold('Остаток счёта не соответствует подтверждённой оплате');
    }
  }
}
function verifySettlementReversalReceipt(command, changes, entities, previouslyApplied) {
  if (command.action !== 'settlement.payment.void') return;
  if (!Array.isArray(entities)) hold('Нет подтверждённого снимка оплаты');
  const payload = command.payload;
  const hasReserve = Object.hasOwn(payload, 'reserve_id');
  const originals = entities.filter(entity => entity.kind === 'transaction' &&
    entity.id === payload.transaction_id);
  const previousFacts = entities.filter(entity => entity.kind === 'settlement' &&
    entity.id === payload.fact_id);
  const reversals = changes.filter(change => change.kind === 'ledger_posted' &&
    change.payload?.entity?.kind === 'transaction');
  const facts = changes.filter(change => change.kind === 'upsert' &&
    change.payload?.entity?.kind === 'settlement');
  if (originals.length !== 1 || previousFacts.length !== 1 ||
      reversals.length !== 1 || facts.length !== 1 ||
      !consistentEvent(reversals[0]) || !consistentEvent(facts[0])) {
    hold('Нет исходной оплаты или её отмены');
  }
  const original = originals[0].data;
  const priorFact = previousFacts[0].data;
  const reversalEntity = reversals[0].payload.entity;
  const reversal = reversalEntity.data;
  const fact = facts[0].payload.entity;
  const posting = original?.postings?.[0];
  const restored = posting ? -posting.signed_minor : null;
  if (original?.kind !== 'payment' || original.payment_link?.settlement_id !== payload.fact_id ||
      original.payment_link?.loan_payment_id !== null ||
      !Array.isArray(original.postings) || original.postings.length !== 1 ||
      posting?.account_id !== payload.account_id || !Number.isSafeInteger(restored) || restored === 0 ||
      priorFact?.amount_minor !== Math.abs(restored) ||
      fact.id !== payload.fact_id || fact.data?.obligation_id !== priorFact.obligation_id ||
      fact.data?.amount_minor !== priorFact.amount_minor || fact.data?.paid_on !== priorFact.paid_on ||
      fact.data?.occurrence_on !== priorFact.occurrence_on ||
      typeof fact.data?.voided_at !== 'string' || !Number.isFinite(Date.parse(fact.data.voided_at)) ||
      reversal?.kind !== 'reversal' || reversal.reversed_transaction_id !== payload.transaction_id ||
      reversal.note !== payload.reason.trim() ||
      !Array.isArray(reversal.postings) || reversal.postings.length !== 1 ||
      reversal.postings[0]?.account_id !== payload.account_id ||
      reversal.postings[0]?.signed_minor !== restored) {
    hold('Отмена не соответствует исходной оплате');
  }
  let used = 0;
  if (hasReserve) {
    const reserves = entities.filter(entity => entity.kind === 'reserve' && entity.id === payload.reserve_id);
    const reserveEvents = changes.filter(change => change.kind === 'upsert' &&
      change.payload?.entity?.kind === 'reserve' && change.payload.entity.id === payload.reserve_id);
    if (reserves.length !== 1 || reserveEvents.length !== 1 || !consistentEvent(reserveEvents[0])) {
      hold('Нет подтверждённого резерва');
    }
    const priorReserve = reserves[0].data;
    const updatedReserve = reserveEvents[0].payload.entity.data;
    const log = updatedReserve?.event_log;
    const paid = Array.isArray(log) ? log.filter(event => event.kind === 'payment' &&
      event.transaction_id === payload.transaction_id) : [];
    if (paid.length !== 1 || !UUID.test(paid[0].id) || paid[0].reserve_id !== payload.reserve_id ||
        paid[0].amount_minor !== priorFact.amount_minor ||
        paid[0].occurred_on !== priorFact.paid_on ||
        !integer(paid[0].reserved_used_minor, 0, priorFact.amount_minor)) {
      hold('Нет исходного события оплаты резерва');
    }
    used = paid[0].reserved_used_minor;
    const voidEvents = log.filter(event => event.kind === 'void' &&
      event.transaction_id === reversalEntity.id && event.revision === reversals[0].revision);
    if (updatedReserve.account_id !== payload.account_id ||
        updatedReserve.obligation_id !== priorFact.obligation_id ||
        updatedReserve.target_on !== priorFact.occurrence_on ||
        updatedReserve.cycle_number !== paid[0].cycle_number || voidEvents.length !== 1 ||
        !UUID.test(voidEvents[0].id) ||
        voidEvents[0].reserve_id !== payload.reserve_id ||
        voidEvents[0].cycle_number !== paid[0].cycle_number ||
        voidEvents[0].target_event_id !== paid[0].id ||
        voidEvents[0].note !== payload.reason.trim()) {
      hold('История резерва не подтверждает отмену');
    }
    const outgoing = original.reserve_allocation;
    const incoming = reversal.reserve_allocation;
    if ((used > 0 && (!plain(outgoing) || !plain(incoming) ||
        !UUID.test(outgoing.id) || !UUID.test(incoming.id) ||
        outgoing.reserve_id !== payload.reserve_id || outgoing.account_id !== payload.account_id ||
        outgoing.delta_minor !== -used || outgoing.reverses_allocation_id !== null ||
        incoming.reserve_id !== payload.reserve_id || incoming.account_id !== payload.account_id ||
        incoming.delta_minor !== used || incoming.reverses_allocation_id !== outgoing.id)) ||
        (used === 0 && (outgoing !== undefined || incoming !== undefined))) {
      hold('Возврат резерва не соответствует исходному движению');
    }
    if (!previouslyApplied && (!Array.isArray(priorReserve?.event_log) ||
        priorReserve.account_id !== payload.account_id ||
        priorReserve.obligation_id !== priorFact.obligation_id ||
        priorReserve.cycle_number !== paid[0].cycle_number ||
        !integer(priorReserve.allocated_minor) || !integer(priorReserve.allocated_minor + used) ||
        updatedReserve.allocated_minor !== priorReserve.allocated_minor + used ||
        log.length !== priorReserve.event_log.length + 1 ||
        canonical(log.slice(0, -1)) !== canonical(priorReserve.event_log))) {
      hold('Остаток резерва не соответствует отмене оплаты');
    }
    if (previouslyApplied && (!Array.isArray(priorReserve?.event_log) ||
        !priorReserve.event_log.some(event => canonical(event) === canonical(voidEvents[0])))) {
      hold('Сохранённый снимок не содержит событие отмены резерва');
    }
  } else if (original.reserve_allocation !== undefined || reversal.reserve_allocation !== undefined ||
      changes.some(change => change.payload?.entity?.kind === 'reserve')) {
    hold('Неожиданный возврат резерва');
  }
  if (previouslyApplied) {
    const stored = entities.filter(entity => entity.kind === 'transaction' && entity.id === reversalEntity.id);
    if (stored.length !== 1 || canonical(stored[0].data) !== canonical(reversalEntity.data) ||
        canonical(previousFacts[0].data) !== canonical(fact.data)) {
      hold('Сохранённый снимок не содержит подтверждённую отмену');
    }
  }
  if (!previouslyApplied) {
    const prior = entities.filter(entity => entity.id === payload.account_id && entity.kind === 'account');
    const updated = reversals[0].payload.accounts;
    if (prior.length !== 1 || !Array.isArray(updated) || updated.length !== 1 ||
        updated[0]?.id !== payload.account_id || updated[0]?.kind !== 'account' ||
        !Number.isSafeInteger(prior[0].data?.balance_minor + restored) ||
        updated[0].data?.balance_minor !== prior[0].data?.balance_minor + restored ||
        updated[0].data?.reserved_minor !== prior[0].data?.reserved_minor + used) {
      hold('Возвращённый остаток не соответствует отмене оплаты');
    }
  }
}
function verifySettlementDependencies(command, entities) {
  if (!['settlement.payment.record', 'settlement.payment.void'].includes(command.action)) return;
  if (!Array.isArray(entities)) hold('Нет подтверждённого серверного снимка');
  const payload = command.payload;
  const find = (id, kind) => {
    const matches = entities.filter(entity => entity.id === id && entity.kind === kind);
    if (matches.length !== 1 ||
        matches[0].entity_revision !== command.expected_entity_revisions[id]) {
      hold('Сущность или её серверная ревизия недоступны');
    }
    return matches[0].data;
  };
  const account = find(payload.account_id, 'account');
  if (command.action === 'settlement.payment.record') {
    const obligation = find(payload.obligation_id, 'obligation');
    if (account?.archived_at != null || obligation?.deleted_at != null ||
        !['income', 'expense'].includes(obligation?.direction)) {
      hold('Счёт или обязательство недоступны для оплаты');
    }
    if (Object.hasOwn(payload, 'reserve_id')) {
      const reserve = find(payload.reserve_id, 'reserve');
      if (obligation.direction !== 'expense' || reserve?.archived_at != null ||
          reserve?.account_id !== payload.account_id || reserve?.obligation_id !== payload.obligation_id ||
          reserve?.target_on !== payload.occurrence_on) {
        hold('Резерв не относится к этому счёту и периоду');
      }
    }
  } else {
    const transaction = find(payload.transaction_id, 'transaction');
    const fact = find(payload.fact_id, 'settlement');
    if (transaction?.kind !== 'payment' || transaction.payment_link?.settlement_id !== payload.fact_id ||
        transaction.payment_link?.loan_payment_id !== null || fact?.voided_at != null ||
        !Array.isArray(transaction.postings) || transaction.postings.length !== 1 ||
        transaction.postings[0]?.account_id !== payload.account_id) {
      hold('Исходная оплата недоступна для отмены');
    }
    if (Object.hasOwn(payload, 'reserve_id')) {
      const reserve = find(payload.reserve_id, 'reserve');
      if (reserve?.account_id !== payload.account_id || reserve?.obligation_id !== fact.obligation_id) {
        hold('Резерв не относится к исходной оплате');
      }
    }
  }
}
function verifyLoanDependencies(command, entities) {
  if (!['loan.payment.record', 'loan.payment.void'].includes(command.action)) return;
  if (!Array.isArray(entities)) hold('Нет подтверждённого снимка кредита');
  const p = command.payload;
  const find = (id, kind) => {
    const found = entities.filter(e => e.id === id && e.kind === kind);
    if (found.length !== 1 || found[0].entity_revision !== command.expected_entity_revisions[id]) {
      hold('Сущность или её серверная ревизия недоступны');
    }
    return found[0].data;
  };
  const account = find(p.account_id, 'account');
  if (command.action === 'loan.payment.record') {
    const loan = find(p.loan_id, 'loan');
    if (account?.archived_at != null || loan?.deleted_at != null) hold('Счёт или кредит недоступны');
  } else {
    const transaction = find(p.transaction_id, 'transaction');
    const fact = find(p.fact_id, 'loan_payment');
    if (transaction?.kind !== 'payment' || transaction.payment_link?.loan_payment_id !== p.fact_id ||
        transaction.payment_link?.settlement_id !== null || transaction.reserve_allocation !== undefined ||
        fact?.voided_at != null || !Array.isArray(transaction.postings) ||
        transaction.postings.length !== 1 || transaction.postings[0]?.account_id !== p.account_id ||
        transaction.postings[0]?.signed_minor !== -fact.amount_minor ||
        entities.some(e => e.kind === 'transaction' && e.data?.reversed_transaction_id === p.transaction_id)) {
      hold('Исходный кредитный платёж недоступен для отмены');
    }
  }
}
function verifyLoanReceipt(command, changes, entities, previouslyApplied) {
  if (!['loan.payment.record', 'loan.payment.void'].includes(command.action)) return;
  if (!Array.isArray(entities) || changes.length !== 2) hold('Нет подтверждения кредитного платежа');
  const p = command.payload;
  const reversal = command.action === 'loan.payment.void';
  const postings = changes.filter(e => e.kind === 'ledger_posted' && e.payload?.entity?.kind === 'transaction');
  const facts = changes.filter(e => e.kind === 'upsert' && e.payload?.entity?.kind === 'loan_payment');
  if (postings.length !== 1 || facts.length !== 1 ||
      !consistentEvent(postings[0]) || !consistentEvent(facts[0])) hold('Неполная квитанция кредитного платежа');
  const txEntity = postings[0].payload.entity, tx = txEntity.data, factEntity = facts[0].payload.entity;
  const fact = factEntity.data;
  let signed;
  if (!reversal) {
    signed = -p.amount_minor;
    if (tx?.kind !== 'payment' || tx.occurred_on !== p.paid_on ||
        tx.payment_link?.settlement_id !== null || tx.payment_link?.loan_payment_id !== factEntity.id ||
        fact?.loan_id !== p.loan_id || fact.amount_minor !== p.amount_minor ||
        fact.paid_on !== p.paid_on || fact.strategy !== p.strategy || fact.voided_at !== null ||
        entities.filter(e => e.kind === 'loan' && e.id === p.loan_id).length !== 1) {
      hold('Факт кредитного платежа не соответствует команде');
    }
  } else {
    const originals = entities.filter(e => e.kind === 'transaction' && e.id === p.transaction_id);
    const oldFacts = entities.filter(e => e.kind === 'loan_payment' && e.id === p.fact_id);
    const original = originals[0]?.data, oldFact = oldFacts[0]?.data;
    signed = oldFact?.amount_minor;
    if (originals.length !== 1 || oldFacts.length !== 1 || !integer(signed, 1) ||
        original?.kind !== 'payment' || original.payment_link?.settlement_id !== null ||
        original.payment_link?.loan_payment_id !== p.fact_id || original.reserve_allocation !== undefined ||
        !Array.isArray(original.postings) || original.postings.length !== 1 ||
        original.postings[0]?.account_id !== p.account_id || original.postings[0]?.signed_minor !== -signed ||
        factEntity.id !== p.fact_id || fact?.loan_id !== oldFact.loan_id ||
        fact.amount_minor !== signed || fact.paid_on !== oldFact.paid_on || fact.strategy !== oldFact.strategy ||
        typeof fact.voided_at !== 'string' || !Number.isFinite(Date.parse(fact.voided_at)) ||
        tx?.kind !== 'reversal' || tx.reversed_transaction_id !== p.transaction_id || tx.note !== p.reason.trim()) {
      hold('Отмена не соответствует исходному кредитному платежу');
    }
    if (previouslyApplied && canonical(oldFact) !== canonical(fact)) hold('Сохранённая отмена не совпадает');
  }
  if (tx?.reserve_allocation !== undefined || !Array.isArray(tx?.postings) || tx.postings.length !== 1 ||
      tx.postings[0]?.account_id !== p.account_id || tx.postings[0]?.signed_minor !== signed) {
    hold('Проводка не соответствует кредитному платежу');
  }
  if (previouslyApplied) {
    const stored = entities.filter(e => e.kind === 'transaction' && e.id === txEntity.id);
    const storedFacts = entities.filter(e => e.kind === 'loan_payment' && e.id === factEntity.id);
    if (stored.length !== 1 || canonical(stored[0].data) !== canonical(tx) || storedFacts.length !== 1 ||
        storedFacts[0].data?.loan_id !== fact.loan_id || storedFacts[0].data?.amount_minor !== fact.amount_minor ||
        storedFacts[0].data?.paid_on !== fact.paid_on || storedFacts[0].data?.strategy !== fact.strategy) {
      hold('Сохранённый снимок не содержит кредитный платёж');
    }
  } else {
    const prior = entities.filter(e => e.kind === 'account' && e.id === p.account_id);
    const updated = postings[0].payload.accounts;
    if (prior.length !== 1 || !Array.isArray(updated) || updated.length !== 1 ||
        updated[0]?.kind !== 'account' || updated[0]?.id !== p.account_id ||
        !Number.isSafeInteger(prior[0].data?.balance_minor + signed) ||
        updated[0].data?.balance_minor !== prior[0].data?.balance_minor + signed ||
        updated[0].data?.reserved_minor !== prior[0].data?.reserved_minor) {
      hold('Остаток не соответствует кредитному платежу');
    }
  }
}
function validateCommand(command) {
  const dto = safeJson(command);
  keysExactly(dto, [
    'schema_version', 'client_mutation_id', 'base_revision',
    'action', 'expected_entity_revisions', 'payload',
  ]);
  if (![1, 2].includes(dto.schema_version) || !UUID.test(dto.client_mutation_id) ||
      !integer(dto.base_revision) ||
      typeof dto.action !== 'string' ||
      !Object.hasOwn(ACTION_FIELDS, dto.action) ||
      (dto.schema_version === 1) !== ['obligation.create', 'account.transfer', 'transaction.reverse'].includes(dto.action)) {
    hold('Недопустимая версия или действие команды');
  }
  keysExactly(dto.payload, ACTION_FIELDS[dto.action], OPTIONAL_FIELDS[dto.action] || []);
  if (dto.action === 'settlement.payment.record' &&
      (Object.hasOwn(dto.payload, 'reserve_id') !== Object.hasOwn(dto.payload, 'reserved_used_minor') ||
       (Object.hasOwn(dto.payload, 'reserved_used_minor') &&
        (!integer(dto.payload.reserved_used_minor, 0, 1_000_000_000_000) ||
         dto.payload.reserved_used_minor > dto.payload.amount_minor)))) {
    hold('Неверная сумма или связь резерва');
  }
  if (!plain(dto.expected_entity_revisions) ||
      Object.keys(dto.expected_entity_revisions).length > 100 ||
      Object.entries(dto.expected_entity_revisions).some(([id, rev]) =>
        !UUID.test(id) || !integer(rev, 1))) hold('Неверные ревизии сущностей');
  // Mirror the exact account IDs whose revisions the server will lock.
  // Rejecting invalid commands before queueing prevents persistent offline
  // entries that can never succeed after a network reconnect.
  let requiredRevisions;
  if (dto.action === 'account.create' || dto.action === 'obligation.create') {
    requiredRevisions = [];
  } else if (dto.action === 'account.transfer') {
    requiredRevisions = [dto.payload.from_account_id, dto.payload.to_account_id];
  } else if (dto.action === 'transaction.reverse') {
    // The exact account IDs are checked against the encrypted authoritative
    // transaction image below; only the original ID is present in payload.
    requiredRevisions = Object.keys(dto.expected_entity_revisions);
    if (requiredRevisions.length < 2 || requiredRevisions.length > 3 ||
        !requiredRevisions.includes(dto.payload.transaction_id)) {
      hold('Отсутствуют ревизии отменяемой операции и счетов');
    }
  } else if (dto.action === 'settlement.payment.record') {
    requiredRevisions = [dto.payload.account_id, dto.payload.obligation_id];
    if (Object.hasOwn(dto.payload, 'reserve_id')) requiredRevisions.push(dto.payload.reserve_id);
  } else if (dto.action === 'loan.payment.record') {
    requiredRevisions = [dto.payload.account_id, dto.payload.loan_id];
  } else if (dto.action.endsWith('.payment.void')) {
    requiredRevisions = [dto.payload.account_id,
      dto.payload.fact_id, dto.payload.transaction_id];
    if (Object.hasOwn(dto.payload, 'reserve_id')) requiredRevisions.push(dto.payload.reserve_id);
  } else {
    requiredRevisions = [dto.payload.account_id];
  }
  const revisionKeys = Object.keys(dto.expected_entity_revisions);
  if (new Set(requiredRevisions).size !== requiredRevisions.length ||
      revisionKeys.length !== requiredRevisions.length ||
      requiredRevisions.some(id => !UUID.test(id) ||
        !Object.hasOwn(dto.expected_entity_revisions, id))) {
    hold('Отсутствуют точные ревизии финансовых сущностей');
  }
  if (Object.hasOwn(dto.payload, 'currency') && dto.payload.currency !== 'RUB') {
    hold('Поддерживаются только рубли');
  }
  if (Object.hasOwn(dto.payload, 'kind')) {
    const kinds = dto.action === 'transaction.record'
      ? ['income', 'expense', 'adjustment']
      : ['bank', 'card', 'cash', 'savings', 'other'];
    if (!kinds.includes(dto.payload.kind)) hold('Недопустимый тип операции');
  }
  if (Object.hasOwn(dto.payload, 'strategy') &&
      !['term', 'amount'].includes(dto.payload.strategy)) {
    hold('Недопустимая стратегия платежа');
  }
  if (dto.action === 'obligation.create') {
    const p = dto.payload;
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 160 ||
        !['income', 'expense'].includes(p.direction) ||
        !integer(p.amount_minor, 0, 1_000_000_000_000) ||
        !['none', 'month', 'year'].includes(p.recurrence_unit) ||
        !integer(p.recurrence_every, 1, 120) || typeof p.timezone !== 'string' ||
        p.timezone.length < 1 || p.timezone.length > 64) hold('Некорректное обязательство');
    try { new Intl.DateTimeFormat('en', {timeZone:p.timezone}); }
    catch { hold('Недопустимый часовой пояс'); }
  }
  for (const name of ['name', 'reason']) {
    if (Object.hasOwn(dto.payload, name) &&
        (typeof dto.payload[name] !== 'string' ||
         !dto.payload[name].trim() ||
         dto.payload[name].length > (name === 'name' ? 160 : 500))) {
      hold('Не заполнено обязательное поле команды');
    }
  }
  if (Object.hasOwn(dto.payload, 'note') &&
      dto.payload.note !== null &&
      (typeof dto.payload.note !== 'string' || dto.payload.note.length > 500)) {
    hold('Недопустимое примечание');
  }
  for (const name of ['paid_on', 'occurred_on', 'occurrence_on', 'starts_on']) {
    if (Object.hasOwn(dto.payload, name)) {
      const value = dto.payload[name];
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
          new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
        hold('Недопустимая дата финансовой операции');
      }
    }
  }
  if (dto.action === 'transaction.record') {
    const minor = dto.payload.signed_minor;
    if (minor === 0 ||
        (dto.payload.kind === 'income' && minor <= 0) ||
        (dto.payload.kind === 'expense' && minor >= 0)) {
      hold('Знак суммы не соответствует направлению операции');
    }
  }
    for (const [name, value] of Object.entries(dto.payload)) {
    if ((name === 'opening_minor' || name === 'signed_minor') &&
        !integer(value, -1_000_000_000_000, 1_000_000_000_000)) {
      hold('Недопустимая сумма');
    }
    if (name === 'amount_minor' && !integer(value, dto.action === 'obligation.create' ? 0 : 1, 1_000_000_000_000)) {
      hold('Недопустимая сумма');
    }
    if ((name === 'account_id' || name === 'from_account_id' || name === 'to_account_id' || name === 'obligation_id' ||
         name === 'loan_id' || name === 'transaction_id' ||
         name === 'fact_id' || name === 'reserve_id' || name === 'id') && !UUID.test(value)) {
      hold('Недопустимый идентификатор');
    }
  }
  return dto;
}

function verifyObligationReceipt(command, changes, entities, previouslyApplied) {
  if (command.action !== 'obligation.create') return;
  const p = command.payload, change = changes[0], entity = change?.payload?.entity, data = entity?.data;
  if (!Array.isArray(entities) || changes.length !== 1 || change?.kind !== 'upsert' ||
      !consistentEvent(change) || entity.kind !== 'obligation' || entity.entity_revision !== 1 ||
      data?.title !== p.title.trim() || data.direction !== p.direction ||
      data.amount_minor !== p.amount_minor || data.starts_on !== p.starts_on ||
      data.timezone !== p.timezone || data.recurrence_unit !== p.recurrence_unit ||
      data.recurrence_every !== p.recurrence_every || data.category !== null || data.deleted_at !== null) {
    hold('Созданное обязательство не соответствует исходной команде');
  }
  if (previouslyApplied && !entities.some(e => e.kind === 'obligation' && e.id === entity.id)) {
    hold('Подтверждённое обязательство отсутствует в сохранённом снимке');
  }
}

/** A matching receipt and journal can still describe the wrong intention. */
function verifyAccountReceipt(command, changes, entities, previouslyApplied) {
  if (!['account.create', 'account.update', 'account.archive', 'account.unarchive'].includes(command.action)) return;
  if (!Array.isArray(entities)) hold('Нет подтверждённого снимка счетов');
  const p = command.payload;
  const creating = command.action === 'account.create';
  const id = creating ? p.id : p.account_id;
  const expectedRevision = creating ? 1 : command.expected_entity_revisions[id] + 1;
  const change = changes[0], entity = change?.payload?.entity, data = entity?.data;
  if (changes.length !== 1 || change?.kind !== 'upsert' || !consistentEvent(change) ||
      entity.kind !== 'account' || entity.id !== id || entity.entity_revision !== expectedRevision ||
      !plain(data) || data.currency !== 'RUB') hold('Подтверждение счёта не соответствует команде');
  if (creating && (data.name !== p.name.trim() || data.type !== p.kind ||
      data.opening_minor !== p.opening_minor || data.balance_minor !== p.opening_minor ||
      data.reserved_minor !== 0 || data.available_minor !== p.opening_minor || data.archived_at !== null)) {
    hold('Созданный счёт не соответствует исходной команде');
  }
  if (command.action === 'account.update' &&
      (data.name !== p.name.trim() || data.type !== p.kind || data.archived_at !== null)) {
    hold('Изменение счёта не соответствует исходной команде');
  }
  if (command.action === 'account.archive' &&
      (typeof data.archived_at !== 'string' || !Number.isFinite(Date.parse(data.archived_at)))) {
    hold('Архивирование счёта не подтверждено');
  }
  if (command.action === 'account.unarchive' && data.archived_at !== null) {
    hold('Восстановление счёта не подтверждено');
  }
  if (!creating && !previouslyApplied) {
    const prior = entities.filter(value => value.kind === 'account' && value.id === id);
    if (prior.length !== 1 || prior[0].entity_revision !== expectedRevision - 1 ||
        (command.action === 'account.unarchive'
          ? typeof prior[0].data?.archived_at !== 'string'
          : prior[0].data?.archived_at !== null) ||
        ['opening_minor', 'balance_minor', 'reserved_minor', 'available_minor', 'currency']
          .some(key => prior[0].data?.[key] !== data[key]) ||
        (command.action !== 'account.update' &&
          (prior[0].data?.name !== data.name || prior[0].data?.type !== data.type))) {
      hold('Остаток или свойства счёта изменились неожиданно');
    }
  }
}

function verifyCashMovementReceipt(command, changes, entities, previouslyApplied) {
  if (command.action !== 'transaction.record') return;
  if (!Array.isArray(entities)) hold('Нет подтверждённого снимка счетов');
  const p = command.payload, change = changes[0], event = change?.payload;
  const transaction = event?.entity, data = transaction?.data;
  if (changes.length !== 1 || change?.kind !== 'ledger_posted' || !consistentEvent(change) ||
      transaction.kind !== 'transaction' || transaction.id !== p.id || transaction.entity_revision !== 1 ||
      event.account_id !== p.account_id || event.signed_minor !== p.signed_minor ||
      event.transaction_kind !== p.kind || data?.kind !== p.kind || data.occurred_on !== p.occurred_on ||
      data.note !== (p.note ?? null) || data.reversed_transaction_id !== null ||
      Object.hasOwn(data, 'payment_link') || Object.hasOwn(data, 'reserve_allocation') ||
      !Array.isArray(data.postings) || data.postings.length !== 1 ||
      data.postings[0]?.account_id !== p.account_id || data.postings[0]?.signed_minor !== p.signed_minor ||
      !Array.isArray(event.accounts) || event.accounts.length !== 1 ||
      event.accounts[0]?.id !== p.account_id || event.accounts[0]?.kind !== 'account') {
    hold('Денежная операция не соответствует исходной команде');
  }
  if (!previouslyApplied) {
    const prior = entities.filter(value => value.kind === 'account' && value.id === p.account_id);
    const updated = event.accounts[0];
    if (prior.length !== 1 || prior[0].entity_revision !== command.expected_entity_revisions[p.account_id] ||
        updated.entity_revision !== prior[0].entity_revision + 1 ||
        !Number.isSafeInteger(prior[0].data?.balance_minor + p.signed_minor) ||
        updated.data?.balance_minor !== prior[0].data.balance_minor + p.signed_minor ||
        updated.data?.available_minor !== prior[0].data.available_minor + p.signed_minor ||
        ['reserved_minor', 'name', 'type', 'currency', 'opening_minor', 'archived_at']
          .some(key => updated.data?.[key] !== prior[0].data?.[key])) {
      hold('Остаток не соответствует денежной операции');
    }
  }
}

function reversalOriginal(command, entities) {
  if (!Array.isArray(entities)) hold('Нет подтверждённого журнала операций');
  const id = command.payload.transaction_id;
  const matches = entities.filter(entity => entity.kind === 'transaction' && entity.id === id);
  const original = matches[0];
  if (matches.length !== 1 || original.entity_revision !== command.expected_entity_revisions[id] ||
      !['income', 'expense', 'adjustment', 'transfer'].includes(original.data?.kind) ||
      !Array.isArray(original.data?.postings) || ![1, 2].includes(original.data.postings.length) ||
      original.data.postings.some(posting => !UUID.test(posting?.account_id) ||
        !Number.isSafeInteger(posting?.signed_minor) || posting.signed_minor === 0) ||
      new Set(original.data.postings.map(posting => posting.account_id)).size !== original.data.postings.length) {
    hold('Исходная операция для отмены недоступна');
  }
  const revisions = Object.keys(command.expected_entity_revisions);
  if (revisions.length !== original.data.postings.length + 1 ||
      original.data.postings.some(posting => !Object.hasOwn(command.expected_entity_revisions, posting.account_id))) {
    hold('Не подтверждены все счета отменяемой операции');
  }
  return original;
}

function verifyReversalDependencies(command, entities) {
  if (command.action !== 'transaction.reverse') return;
  const original = reversalOriginal(command, entities);
  if (entities.some(entity => entity.kind === 'transaction' &&
      entity.data?.reversed_transaction_id === original.id)) hold('Операция уже отменена');
  for (const posting of original.data.postings) {
    const accounts = entities.filter(entity => entity.kind === 'account' && entity.id === posting.account_id &&
      entity.entity_revision === command.expected_entity_revisions[posting.account_id]);
    const data = accounts[0]?.data;
    const next = data?.balance_minor - posting.signed_minor;
    if (accounts.length !== 1 || !Number.isSafeInteger(next) || !integer(data?.reserved_minor) ||
        (data.reserved_minor > 0 && next < data.reserved_minor)) {
      hold('Отмена недоступна для текущих остатков счетов');
    }
  }
}

function verifyReversalReceipt(command, changes, entities, previouslyApplied) {
  if (command.action !== 'transaction.reverse') return;
  const original = reversalOriginal(command, entities), change = changes[0], event = change?.payload;
  const reversal = event?.entity, data = reversal?.data;
  if (changes.length !== 1 || change?.kind !== 'ledger_posted' || !consistentEvent(change) ||
      reversal.kind !== 'transaction' || reversal.entity_revision !== 1 ||
      event.transaction_kind !== 'reversal' || event.reversed_transaction_id !== original.id ||
      data?.kind !== 'reversal' || data.reversed_transaction_id !== original.id ||
      data.note !== command.payload.reason.trim() || Object.hasOwn(data, 'payment_link') ||
      Object.hasOwn(data, 'reserve_allocation') || !Array.isArray(data.postings) ||
      data.postings.length !== original.data.postings.length || !Array.isArray(event.accounts) ||
      event.accounts.length !== original.data.postings.length) hold('Отмена не соответствует исходной операции');
  for (const posting of original.data.postings) {
    const inverse = data.postings.filter(item => item.account_id === posting.account_id &&
      item.signed_minor === -posting.signed_minor);
    const updated = event.accounts.filter(item => item.kind === 'account' && item.id === posting.account_id);
    if (inverse.length !== 1 || updated.length !== 1) hold('Компенсирующие проводки не подтверждены');
    if (!previouslyApplied) {
      const prior = entities.filter(item => item.kind === 'account' && item.id === posting.account_id);
      if (prior.length !== 1 || prior[0].entity_revision !== command.expected_entity_revisions[posting.account_id] ||
          updated[0].entity_revision !== prior[0].entity_revision + 1 ||
          !Number.isSafeInteger(prior[0].data?.balance_minor - posting.signed_minor) ||
          updated[0].data?.balance_minor !== prior[0].data.balance_minor - posting.signed_minor ||
          updated[0].data?.available_minor !== prior[0].data.available_minor - posting.signed_minor ||
          ['reserved_minor', 'name', 'type', 'currency', 'opening_minor', 'archived_at']
            .some(key => updated[0].data?.[key] !== prior[0].data?.[key])) {
        hold('Остатки счетов не соответствуют отмене');
      }
    }
  }
}

function verifyTransferReceipt(command, changes, entities, previouslyApplied) {
  if (command.action !== 'account.transfer') return;
  const p = command.payload;
  if (changes.length !== 1 || changes[0].kind !== 'ledger_posted') hold('Не подтверждён перевод');
  const event = changes[0].payload, transaction = event?.entity;
  if (!plain(event) || event.from_account_id !== p.from_account_id ||
      event.to_account_id !== p.to_account_id || event.amount_minor !== p.amount_minor ||
      event.transaction_kind !== 'transfer' || transaction?.kind !== 'transaction' ||
      transaction.id !== changes[0].entity_id ||
      transaction.entity_revision !== changes[0].entity_revision ||
      transaction.data?.kind !== 'transfer' || transaction.data.occurred_on !== p.occurred_on ||
      !Array.isArray(transaction.data.postings) || transaction.data.postings.length !== 2 ||
      !Array.isArray(event.accounts) || event.accounts.length !== 2) {
    hold('Квитанция перевода не соответствует команде');
  }
  for (const [id, amount] of [[p.from_account_id, -p.amount_minor], [p.to_account_id, p.amount_minor]]) {
    const postings = transaction.data.postings.filter(x => x?.account_id === id && x.signed_minor === amount);
    const updated = event.accounts.filter(x => x?.kind === 'account' && x.id === id);
    if (postings.length !== 1 || updated.length !== 1) hold('Проводки перевода не подтверждены');
    if (!previouslyApplied) {
      const previous = entities.filter(x => x?.kind === 'account' && x.id === id);
      if (previous.length !== 1 || previous[0].entity_revision !== command.expected_entity_revisions[id] ||
          updated[0].entity_revision !== previous[0].entity_revision + 1 ||
          updated[0].data?.balance_minor !== previous[0].data?.balance_minor + amount ||
          updated[0].data?.reserved_minor !== previous[0].data?.reserved_minor) {
        hold('Изменение остатка перевода не подтверждено');
      }
    }
  }
}

function verifyCashMovementDependencies(command, entities) {
  if (command.action !== 'transaction.record') return;
  if (!Array.isArray(entities)) hold('Снимок счетов недоступен');
  const p = command.payload;
  const matches = entities.filter(x => x?.kind === 'account' && x.id === p.account_id &&
    x.entity_revision === command.expected_entity_revisions[p.account_id]);
  if (matches.length !== 1 || matches[0].data?.archived_at !== null ||
      !Number.isSafeInteger(matches[0].data?.balance_minor) ||
      !Number.isSafeInteger(matches[0].data.balance_minor + p.signed_minor) ||
      !integer(matches[0].data.reserved_minor) || !Number.isSafeInteger(matches[0].data.available_minor) ||
      (p.signed_minor < 0 && matches[0].data.reserved_minor > 0 &&
        matches[0].data.available_minor < -p.signed_minor)) {
    hold('Операция не соответствует доступному остатку счёта');
  }
}

function verifyTransferDependencies(command, entities) {
  if (command.action !== 'account.transfer') return;
  if (!Array.isArray(entities)) hold('Снимок счетов недоступен');
  const {from_account_id: from, to_account_id: to, amount_minor: amount} = command.payload;
  for (const id of [from, to]) {
    const matches = entities.filter(x => x?.kind === 'account' && x.id === id &&
      x.entity_revision === command.expected_entity_revisions[id]);
    if (matches.length !== 1 || matches[0].data?.archived_at !== null) {
      hold('Счёт или его подтверждённая ревизия недоступны');
    }
    const balance = matches[0].data.balance_minor;
    const delta = id === from ? -amount : amount;
    if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(balance + delta)) {
      hold('Остаток после перевода недопустим');
    }
    if (id === from && matches[0].data.reserved_minor > 0 &&
        matches[0].data.available_minor < amount) {
      hold('Перевод затронет зарезервированные средства');
    }
  }
}
function active(scope, session, identity) {
  if (!SCOPE.test(scope) || !identity ||
      identity.scope !== scope || !UUID.test(identity.profileId) ||
      !EPOCH.test(identity.epoch) ||
      !integer(identity.generation, 1) ||
      session?.state !== 'unlocked' || session.selectedScope !== scope ||
      session.lifecycleVersion !== identity.generation ||
      session.lifecycleSignal.aborted ||
      identity.signal?.aborted) hold('Нет действующего разблокированного финансового сеанса');
}
function existingQueue(queue, scope, identity) {
  if (!Array.isArray(queue) || queue.length > MAX_QUEUE ||
      queue.some(x => !plain(x) || x.scope !== scope ||
        x.profileId !== identity.profileId ||
        x.epoch !== identity.epoch ||
        !integer(x.generation, 1) ||
        !UUID.test(x.mutationId) ||
        !/^[a-f0-9]{64}$/.test(x.fingerprint) ||
        x.status !== 'pending' ||
        !plain(x.command))) hold('Несовместимая защищённая очередь');
}
async function fingerprint(scope, profileId, ifMatch, command) {
  const bytes = new TextEncoder().encode(canonical([scope, profileId, ifMatch, command]));
  if (bytes.byteLength > MAX_BYTES) hold('Финансовая команда превышает лимит');
  if (!globalThis.crypto?.subtle) hold('Web Crypto недоступна');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * An explicit user command is persisted, but NOT sent or marked paid.
 * A local duplicate with an identical immutable fingerprint is a no-op;
 * a reused mutation ID with different funds/ETag is rejected.
 */
export async function enqueueEncryptedFinanceCommandCandidate({
  scope, session, identity, command, ifMatch, expectedEpoch,
}) {
  active(scope, session, identity);
  if (typeof ifMatch !== 'string' || !STRONG_ETAG.test(ifMatch) ||
      !integer(expectedEpoch)) hold('Отсутствует актуальная версия сервера');
  const pinned = validateCommand(command);
  const digest = await fingerprint(scope, identity.profileId, ifMatch, pinned);
  active(scope, session, identity);
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.schemaVersion !== 2 ||
      current.snapshot?.version !== 2 || current.epoch !== expectedEpoch ||
      !Array.isArray(current.conflicts)) hold('Защищённое хранилище изменилось');
  const cloud = current.snapshot.cloudFinance;
  if (!plain(cloud) || cloud.schemaVersion !== 1 ||
      cloud.scope !== scope || cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch ||
      !integer(cloud.generation, 1) ||
      !integer(cloud.revision)) hold('Серверная версия изменилась');
  // The old in-memory unlock generation is not a durable credential.
  // It may differ after a real browser restart. A fresh FH session and
  // currently unlocked keyset are checked above; queue identity is fenced
  // by the persistent account scope, owner profile and cutover epoch.
  existingQueue(current.outbox, scope, identity);
  const proven = current.snapshot.cloudFinance.appliedReceipts;
  if (proven !== undefined && (!Array.isArray(proven) || proven.length > 2000 ||
      proven.some(x => !plain(x) || !UUID.test(x.mutationId) ||
        !/^[a-f0-9]{64}$/.test(x.fingerprint) || !integer(x.revision, 1)))) {
    hold('Повреждена история подтверждённых операций');
  }
  const alreadyApplied = (proven || []).find(x => x.mutationId === pinned.client_mutation_id);
  if (alreadyApplied) {
    if (alreadyApplied.fingerprint !== digest) {
      hold('Идентификатор принадлежит другой уже проведённой операции');
    }
    return Object.freeze({status: 'ALREADY_CONFIRMED', bundleEpoch: expectedEpoch,
      pending: current.outbox.length, serverBalanceChanged: false, sent: false});
  }
  const duplicate = current.outbox.find(x => x.mutationId === pinned.client_mutation_id);
  if (duplicate) {
    if (duplicate.fingerprint !== digest || duplicate.ifMatch !== ifMatch) {
      hold('Повторно использован идентификатор другой операции');
    }
    return Object.freeze({status: 'ALREADY_QUEUED', bundleEpoch: expectedEpoch,
      pending: current.outbox.length, serverBalanceChanged: false, sent: false});
  }
  // A persisted identical mutation remains retryable even when newer
  // verified server deltas advance the cursor. A NEW mutation must still
  // start from the exact latest authoritative server revision.
  if (cloud.revision !== pinned.base_revision) hold('Серверная версия изменилась');
  if (cloud.serverEtag !== undefined && cloud.serverEtag !== ifMatch) {
    hold('Условие записи не соответствует сохранённому серверному снимку');
  }
  verifySettlementDependencies(pinned, cloud.entities);
  verifyLoanDependencies(pinned, cloud.entities);
  verifyCashMovementDependencies(pinned, cloud.entities);
  verifyReversalDependencies(pinned, cloud.entities);
  verifyTransferDependencies(pinned, cloud.entities);
  if (current.outbox.length >= MAX_QUEUE) hold('Достигнут лимит офлайн-операций');
  const item = {
    scope, profileId: identity.profileId,
    generation: identity.generation, epoch: identity.epoch,
    mutationId: pinned.client_mutation_id, fingerprint: digest,
    ifMatch, command: pinned, status: 'pending', attempts: 0,
  };
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2,
    {snapshot: current.snapshot, outbox: [...current.outbox, item],
     conflicts: current.conflicts},
  );
  active(scope, session, identity);
  return Object.freeze({status: 'QUEUED_ENCRYPTED', bundleEpoch: nextEpoch,
    pending: current.outbox.length + 1,
    serverBalanceChanged: false, sent: false});
}

/** Classification only. ACK is NEVER allowed to remove an outbox item. */
export function classifyFinanceOutboxResponseCandidate(status, attempts = 0) {
  if (!integer(attempts, 0, 32)) hold('Недопустимое число попыток');
  if (status === 200 || status === 201) {
    return {decision: 'VERIFY_DURABLE_RECEIPT_AND_DELTA', retryDelayMs: null};
  }
  if (status === 401 || status === 403) {
    return {decision: 'AUTH_HOLD', retryDelayMs: null};
  }
  if (status === 409 || status === 412) {
    return {decision: 'CONFLICT_HOLD', retryDelayMs: null};
  }
  if (status === 410) {
    return {decision: 'SNAPSHOT_REQUIRED_HOLD', retryDelayMs: null};
  }
  if (status === null || status === 429 || status === 502 ||
      status === 503 || status === 504) {
    return {decision: 'RETRY_SAME_UUID',
      retryDelayMs: Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))};
  }
  return {decision: 'RECOVERY_HOLD', retryDelayMs: null};
}


/**
 * #68 Inactive, bounded durable server-receipt reconciliation.
 *
 * Must be called ONLY with the outputs of two authenticated, uncached calls
 * to the accepted FH finance service under the same live session:
 *   POST /api/finance/v2/commands -> receipt
 *   GET /api/finance/v1/changes -> delta, beginning at the stored cursor
 *
 * This method performs NO HTTP call and does not trust a 200/201 reply alone.
 * It requires byte-equivalent canonical event images from the independent
 * authoritative server delta, then persists the image, cursor, applied
 * fingerprint proof and outbox removal in a SINGLE encrypted native IDB CAS.
 */
export async function persistAuthenticatedFinanceReceiptCandidate({
  scope, session, identity, expectedEpoch, receipt, deltaPage,
  commandHttpStatus, deltaHttpStatus,
}) {
  active(scope, session, identity);
  if (!integer(expectedEpoch) ||
      ![200, 201].includes(commandHttpStatus) ||
      deltaHttpStatus !== 200) {
    hold('Не подтверждены оба серверных финансовых ответа');
  }
  const ack = safeJson(receipt);
  const delta = safeJson(deltaPage);
  if (!plain(ack) || ![1, 2].includes(ack.schema_version) ||
      !UUID.test(ack.client_mutation_id) ||
      !integer(ack.revision, 1) ||
      typeof ack.replayed !== 'boolean' ||
      !Array.isArray(ack.changes) || ack.changes.length === 0 ||
      ack.changes.length > 100 ||
      !plain(delta) || delta.schema_version !== 1 ||
      !Array.isArray(delta.changes) || delta.changes.length > 100) {
    hold('Некорректное подтверждение финансовой операции');
  }
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.epoch !== expectedEpoch ||
      current.schemaVersion !== 2 || current.snapshot?.version !== 2 ||
      !Array.isArray(current.outbox) || !Array.isArray(current.conflicts)) {
    hold('Зашифрованный финансовый снимок изменился');
  }
  const cloud = current.snapshot.cloudFinance;
  if (!plain(cloud) || cloud.schemaVersion !== 1 ||
      cloud.scope !== scope || cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch || !integer(cloud.revision) ||
      !integer(cloud.generation, 1)) hold('Серверный профиль изменился');
  existingQueue(current.outbox, scope, identity);
  const first = current.outbox[0];
  if (!first || first.mutationId !== ack.client_mutation_id ||
      first.command.client_mutation_id !== ack.client_mutation_id ||
      first.status !== 'pending') {
    hold('Получено подтверждение не первой ожидающей команды');
  }
  const digest = await fingerprint(
    scope, identity.profileId, first.ifMatch, first.command,
  );
  active(scope, session, identity);
  if (first.fingerprint !== digest || first.command.schema_version !== ack.schema_version) {
    hold('Финансовая команда изменилась после записи');
  }
  // The accepted v1 API pages changes by whole PostgreSQL revisions.
  // No partial page, missing fact, competing revision or client-supplied
  // receipt can ever cause the outbox to be cleared.
  // A crash may happen AFTER the independent delta was already
  // persisted but BEFORE the ACK was durably recorded. The server receipt
  // can then describe an older revision: re-fetch exactly that historical
  // delta, verify it again, and clear only this UUID without changing
  // current balances or moving the cursor backwards.
  const previouslyApplied = ack.revision <= cloud.revision;
  const expectedFromRevision = previouslyApplied
    ? ack.revision - 1 : cloud.revision;
  if ((!previouslyApplied && ack.revision !== cloud.revision + 1) ||
      first.command.base_revision !== ack.revision - 1 ||
      delta.from_revision !== expectedFromRevision ||
      !integer(delta.to_revision, ack.revision) ||
      delta.next_since_revision !== ack.revision ||
      typeof delta.has_more !== 'boolean' ||
      ack.changes.some((entry, index) =>
        !plain(entry) || entry.revision !== ack.revision ||
        !integer(entry.ordinal, 0) || entry.ordinal !== index) ||
      canonical(ack.changes) !== canonical(delta.changes)) {
    hold('Квитанция не совпадает с независимым серверным журналом');
  }
  verifySettlementReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifySettlementReversalReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifyLoanReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifyObligationReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifyAccountReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifyCashMovementReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifyReversalReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  verifyTransferReceipt(first.command, ack.changes, cloud.entities, previouslyApplied);
  let checked;
  if (previouslyApplied) {
    // The authenticated cloud image already contains revision ack.revision.
    // A future delta must never replay this old cash movement twice.
    checked = {revision: cloud.revision, entities: cloud.entities};
  } else {
    checked = applyFinanceDeltaCandidate(
      {...cloud, generation: identity.generation,
       pending: current.outbox, conflicts: current.conflicts},
      delta, identity,
    );
    if (checked.revision !== ack.revision) {
      hold('Подтверждённая ревизия не записана');
    }
  }
  const storedProofs = cloud.appliedReceipts || [];
  if (!Array.isArray(storedProofs) || storedProofs.length >= 2000 ||
      storedProofs.some(x => !plain(x) || !UUID.test(x.mutationId) ||
        !/^[a-f0-9]{64}$/.test(x.fingerprint) || !integer(x.revision, 1) ||
        x.mutationId === first.mutationId)) {
    hold('Некорректная история подтверждённых операций');
  }
  const sealedSnapshot = structuredClone(current.snapshot);
  sealedSnapshot.cloudFinance = {
    schemaVersion: 1, scope, profileId: identity.profileId,
    epoch: identity.epoch, generation: identity.generation,
    revision: checked.revision, entities: checked.entities,
    appliedReceipts: [...storedProofs, {
      mutationId: first.mutationId, fingerprint: digest, revision: ack.revision,
    }],
  };
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2, {
      snapshot: sealedSnapshot, outbox: current.outbox.slice(1),
      conflicts: current.conflicts,
    },
  );
  active(scope, session, identity);
  return Object.freeze({
    status: 'DURABLY_CONFIRMED',
    bundleEpoch: nextEpoch, serverRevision: ack.revision,
    pending: current.outbox.length - 1,
    serverBalanceChanged: !previouslyApplied,
    // The server already committed it; this method only reconciles locally.
    sentByThisFunction: false,
  });
}


/**
 * Persist bounded retry count with the unchanged original mutation ID,
 * If-Match and command in one encrypted IndexedDB CAS. This is not a server
 * payment confirmation and never changes authoritative cash balances.
 */
export async function recordEncryptedFinanceRetryCandidate({
  scope, session, identity, expectedEpoch, mutationId,
}) {
  active(scope, session, identity);
  if (!integer(expectedEpoch) || !UUID.test(mutationId)) {
    hold('Неверный идентификатор повторной отправки');
  }
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.epoch !== expectedEpoch ||
      current.schemaVersion !== 2 || current.snapshot?.version !== 2 ||
      !Array.isArray(current.outbox) || !Array.isArray(current.conflicts)) {
    hold('Защищённая очередь изменилась');
  }
  const cloud = current.snapshot.cloudFinance;
  if (!plain(cloud) || cloud.scope !== scope ||
      cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch ||
      !integer(cloud.revision)) {
    hold('Профиль очереди изменился');
  }
  existingQueue(current.outbox, scope, identity);
  const first = current.outbox[0];
  if (!first || first.mutationId !== mutationId ||
      !integer(first.attempts, 0, 32) ||
      first.command.client_mutation_id !== mutationId) {
    hold('Команда не подлежит повторной отправке');
  }
  const expectedFingerprint = await fingerprint(
    scope, identity.profileId, first.ifMatch, first.command,
  );
  active(scope, session, identity);
  if (expectedFingerprint !== first.fingerprint) {
    hold('Изменилась исходная команда');
  }
  const attempts = Math.min(32, first.attempts + 1);
  const outbox = [
    {...first, attempts}, ...current.outbox.slice(1),
  ];
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2, {
      snapshot: current.snapshot, outbox, conflicts: current.conflicts,
    },
  );
  active(scope, session, identity);
  return Object.freeze({
    status: 'RETRY_PERSISTED', attempts, bundleEpoch: nextEpoch,
    mutationId, pending: outbox.length,
    serverBalanceChanged: false, commandUnchanged: true,
  });
}


/**
 * Persist a server 409/412 or 410 reconciliation hold in the SAME protected
 * account bundle. Never discard the pending operation, change confirmed
 * balances, or silently rebase its immutable original If-Match/UUID.
 * Explicit UI conflict resolution is a separate, not-yet-enabled workflow.
 */
export async function persistEncryptedFinanceHoldCandidate({
  scope, session, identity, expectedEpoch, mutationId,
  httpStatus, decision, source, negativeAck = null,
}) {
  active(scope, session, identity);
  if (!integer(expectedEpoch) || !UUID.test(mutationId) ||
      ![409, 412, 410].includes(httpStatus) ||
      !['CONFLICT_HOLD', 'SNAPSHOT_REQUIRED_HOLD'].includes(decision) ||
      (decision === 'CONFLICT_HOLD' && ![409, 412].includes(httpStatus)) ||
      (decision === 'SNAPSHOT_REQUIRED_HOLD' && httpStatus !== 410) ||
      !['command', 'delta'].includes(source)) {
    hold('Некорректная причина остановки синхронизации');
  }
  const pinnedNegativeAck = negativeAck === null ? null : safeJson(negativeAck);
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.epoch !== expectedEpoch ||
      current.schemaVersion !== 2 || current.snapshot?.version !== 2 ||
      !Array.isArray(current.outbox) || !Array.isArray(current.conflicts)) {
    hold('Зашифрованная очередь изменилась');
  }
  const cloud = current.snapshot.cloudFinance;
  if (!plain(cloud) || cloud.scope !== scope ||
      cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch ||
      !integer(cloud.revision)) {
    hold('Подтверждённый финансовый профиль изменился');
  }
  existingQueue(current.outbox, scope, identity);
  const head = current.outbox[0];
  if (!head || head.mutationId !== mutationId ||
      head.command.client_mutation_id !== mutationId) {
    hold('Остановлена неизвестная финансовая команда');
  }
  const already = current.conflicts.find(item =>
    plain(item) && item.kind === 'finance_sync_hold' &&
    item.mutationId === mutationId
  );
  if (already) {
    if (already.scope !== scope || already.profileId !== identity.profileId ||
        !['CONFLICT_HOLD', 'SNAPSHOT_REQUIRED_HOLD'].includes(already.decision)) {
      hold('Повреждена ранее сохранённая остановка');
    }
    return Object.freeze({
      status: already.decision, bundleEpoch: expectedEpoch,
      queuePreserved: true, previouslyRecorded: true,
    });
  }
  if (current.conflicts.length >= 1000) {
    hold('Заполнен журнал конфликтов финансов');
  }
  const entry = {
    kind: 'finance_sync_hold', scope, profileId: identity.profileId,
    mutationId, httpStatus, decision, source,
    baseRevision: head.command.base_revision,
  };
  // Only the authenticated transport may supply this parsed server response.
  // A bare HTTP status, including a proxy-generated 412, is not sufficient
  // to release or replace a financial command.
  if (httpStatus === 412 && source === 'command' &&
      plain(pinnedNegativeAck) && pinnedNegativeAck.code === 'stale_revision' &&
      integer(pinnedNegativeAck.server_revision, head.command.base_revision + 1)) {
    entry.verifiedStaleRevision = pinnedNegativeAck.server_revision;
  }
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2, {
      snapshot: current.snapshot,
      outbox: current.outbox,
      conflicts: [...current.conflicts, entry],
    },
  );
  active(scope, session, identity);
  return Object.freeze({
    status: decision, bundleEpoch: nextEpoch,
    queuePreserved: true, previouslyRecorded: false,
  });
}


/**
 * #68 - INACTIVE user-initiated conflict choice, persisted in the same
 * encrypted IndexedDB CAS as the original pending command. This records a
 * decision for a later independently verified resolution flow; it does NOT
 * resolve a conflict, release a hold, rebase a command, send an HTTP request,
 * discard pending money, or claim that an external backup exists.
 *
 * A 410 after a successful POST can mean the server already committed. Even
 * "prefer server" must NOT discard the queued UUID before an authenticated
 * receipt/delta or other independently audited recovery proves its outcome.
 */
export async function recordManualFinanceConflictChoiceCandidate({
  scope, session, identity, expectedEpoch, mutationId,
  choice, observedCachedRevision, explicitUserChoice = false,
}) {
  active(scope, session, identity);
  if (!integer(expectedEpoch) || !UUID.test(mutationId) ||
      !integer(observedCachedRevision) || explicitUserChoice !== true ||
      !['KEEP_ORIGINAL_FOR_REVIEW', 'PREFER_SERVER_FOR_REVIEW'].includes(choice)) {
    hold('Не подтверждён ручной выбор для конфликта');
  }
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.epoch !== expectedEpoch ||
      current.schemaVersion !== 2 || current.snapshot?.version !== 2 ||
      !Array.isArray(current.outbox) || !Array.isArray(current.conflicts)) {
    hold('Зашифрованное состояние конфликта изменилось');
  }
  const cloud = current.snapshot.cloudFinance;
  if (!plain(cloud) || cloud.scope !== scope ||
      cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch ||
      !integer(cloud.revision) || cloud.revision !== observedCachedRevision) {
    hold('Изменился видимый снимок финансового профиля');
  }
  existingQueue(current.outbox, scope, identity);
  const head = current.outbox[0];
  if (!head || head.mutationId !== mutationId ||
      head.command.client_mutation_id !== mutationId ||
      !STRONG_ETAG.test(head.ifMatch) ||
      !integer(head.command.base_revision) ||
      !/^[a-f0-9]{64}$/.test(head.fingerprint)) {
    hold('Не найдена неизменённая исходная команда');
  }
  const matches = current.conflicts.filter(entry =>
    plain(entry) && entry.kind === 'finance_sync_hold' &&
    entry.mutationId === mutationId);
  if (matches.length !== 1) hold('Не найден однозначный защищённый конфликт');
  const prior = matches[0];
  if (prior.scope !== scope || prior.profileId !== identity.profileId ||
      prior.baseRevision !== head.command.base_revision ||
      ![409, 412, 410].includes(prior.httpStatus) ||
      !['CONFLICT_HOLD', 'SNAPSHOT_REQUIRED_HOLD'].includes(prior.decision) ||
      (prior.decision === 'CONFLICT_HOLD' &&
        ![409, 412].includes(prior.httpStatus)) ||
      (prior.decision === 'SNAPSHOT_REQUIRED_HOLD' &&
        prior.httpStatus !== 410)) {
    hold('Повреждена запись финансового конфликта');
  }
  const actualFingerprint = await fingerprint(
    scope, identity.profileId, head.ifMatch, head.command,
  );
  active(scope, session, identity);
  if (actualFingerprint !== head.fingerprint) {
    hold('Изменилась исходная ожидающая операция');
  }
  if (prior.manualChoice !== undefined) {
    const stored = prior.manualChoice;
    if (!plain(stored) || stored.choice !== choice ||
        stored.observedCachedRevision !== observedCachedRevision ||
        stored.originalFingerprint !== actualFingerprint) {
      hold('Ручное решение уже записано с другими условиями');
    }
    return Object.freeze({
      status: 'MANUAL_CHOICE_ALREADY_STAGED', bundleEpoch: expectedEpoch,
      queuePreserved: true, conflictStillHeld: true, sent: false,
    });
  }
  const manualChoice = {
    choice, observedCachedRevision, originalFingerprint: actualFingerprint,
  };
  const nextConflicts = current.conflicts.map(entry =>
    entry === prior ? {...prior, manualChoice} : entry);
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2, {
      snapshot: current.snapshot, outbox: current.outbox,
      conflicts: nextConflicts,
    },
  );
  active(scope, session, identity);
  return Object.freeze({
    status: 'MANUAL_CHOICE_STAGED', bundleEpoch: nextEpoch,
    queuePreserved: true, conflictStillHeld: true, sent: false,
  });
}

/** Persist an authenticated server tombstone before allowing conflict resolution. */
export async function recordVerifiedFinanceCancellation({
  scope, session, identity, expectedEpoch, mutationId, cancellationAck,
}) {
  active(scope, session, identity);
  if (!integer(expectedEpoch) || !UUID.test(mutationId)) hold('Неверная отмена операции');
  const ack = safeJson(cancellationAck);
  if (!plain(ack) || ack.code !== 'command_cancelled' || ack.client_mutation_id !== mutationId ||
      ![1, 2].includes(ack.schema_version) || !integer(ack.base_revision)) {
    hold('Сервер не подтвердил отмену исходной операции');
  }
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.epoch !== expectedEpoch || current.schemaVersion !== 2 ||
      !Array.isArray(current.outbox) || !Array.isArray(current.conflicts)) hold('Очередь изменилась');
  const cloud = current.snapshot?.cloudFinance;
  if (!plain(cloud) || cloud.scope !== scope || cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch) hold('Финансовый профиль изменился');
  existingQueue(current.outbox, scope, identity);
  const head = current.outbox[0];
  const conflicts = current.conflicts.filter(item => plain(item) && item.kind === 'finance_sync_hold' &&
    item.mutationId === mutationId && item.scope === scope && item.profileId === identity.profileId);
  if (!head || head.mutationId !== mutationId || conflicts.length !== 1 ||
      ![409, 410].includes(conflicts[0].httpStatus) ||
      head.command.schema_version !== ack.schema_version || head.command.base_revision !== ack.base_revision) {
    hold('Отмена не соответствует ожидающей операции');
  }
  const digest = await fingerprint(scope, identity.profileId, head.ifMatch, head.command);
  active(scope, session, identity);
  if (digest !== head.fingerprint) hold('Исходная операция изменилась');
  if (conflicts[0].verifiedCancellationFingerprint === digest) {
    return Object.freeze({status:'CANCELLATION_RECORDED', bundleEpoch:expectedEpoch});
  }
  const nextConflicts = current.conflicts.map(item => item === conflicts[0]
    ? {...item, verifiedCancellationFingerprint:digest} : item);
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(scope, session, expectedEpoch, 2,
    {snapshot:current.snapshot, outbox:current.outbox, conflicts:nextConflicts});
  active(scope, session, identity);
  return Object.freeze({status:'CANCELLATION_RECORDED', bundleEpoch:nextEpoch});
}

/** Resolve only a proven stale refusal or a durably fenced original command.
 * Preserve the entire request and fingerprint in encrypted conflict history. */
export async function resolveStaleFinanceConflict({
  scope, session, identity, expectedEpoch, mutationId, observedRevision,
  choice, replacementCommand = null, explicitUserChoice = false,
}) {
  active(scope, session, identity);
  if (!integer(expectedEpoch) || !integer(observedRevision) ||
      !UUID.test(mutationId) || explicitUserChoice !== true ||
      !['ACCEPT_SERVER', 'REAPPLY'].includes(choice) ||
      (choice === 'ACCEPT_SERVER' && replacementCommand !== null)) {
    hold('Не подтверждено решение финансового конфликта');
  }
  // Pin and validate the replacement before any asynchronous operation.
  const replacement = choice === 'REAPPLY' ? validateCommand(replacementCommand) : null;
  const current = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!current || current.epoch !== expectedEpoch || current.schemaVersion !== 2 ||
      current.snapshot?.version !== 2 || !Array.isArray(current.conflicts)) {
    hold('Зашифрованное состояние конфликта изменилось');
  }
  const cloud = current.snapshot.cloudFinance;
  const tag = typeof cloud?.serverEtag === 'string'
    ? /^"fh\.1\.(0|[1-9]\d*)\.[a-f0-9]{16}"$/.exec(cloud.serverEtag) : null;
  if (!plain(cloud) || cloud.schemaVersion !== 1 || cloud.scope !== scope ||
      cloud.profileId !== identity.profileId || cloud.epoch !== identity.epoch ||
      cloud.revision !== observedRevision || !Array.isArray(cloud.entities) ||
      !tag || tag[1] !== String(observedRevision)) {
    hold('Нужен актуальный подтверждённый серверный снимок');
  }
  existingQueue(current.outbox, scope, identity);
  const head = current.outbox[0];
  const matches = current.conflicts.filter(x => plain(x) &&
    x.kind === 'finance_sync_hold' && x.mutationId === mutationId);
  if (!head || head.mutationId !== mutationId || matches.length !== 1 ||
      matches[0].scope !== scope || matches[0].profileId !== identity.profileId ||
      matches[0].baseRevision !== head.command.base_revision) {
    hold('Нет подтверждённого финансового конфликта');
  }
  const originalFingerprint = await fingerprint(scope, identity.profileId, head.ifMatch, head.command);
  active(scope, session, identity);
  if (originalFingerprint !== head.fingerprint) hold('Исходная операция изменилась');
  const stale = matches[0].httpStatus === 412 && matches[0].decision === 'CONFLICT_HOLD' &&
    matches[0].source === 'command' &&
    integer(matches[0].verifiedStaleRevision, head.command.base_revision + 1) &&
    observedRevision >= matches[0].verifiedStaleRevision && observedRevision > head.command.base_revision;
  const cancelled = [409, 410].includes(matches[0].httpStatus) &&
    matches[0].verifiedCancellationFingerprint === originalFingerprint &&
    observedRevision >= head.command.base_revision;
  if (!stale && !cancelled) hold('Исходная операция не отменена и не доказан отказ');
  let nextItem = null;
  if (replacement) {
    if (replacement.client_mutation_id === mutationId ||
        replacement.action !== head.command.action || replacement.base_revision !== cloud.revision ||
        current.outbox.some(x => x.mutationId === replacement.client_mutation_id) ||
        !Array.isArray(cloud.appliedReceipts) ||
        cloud.appliedReceipts.some(x => x?.mutationId === replacement.client_mutation_id) ||
        current.conflicts.some(x => x?.mutationId === replacement.client_mutation_id)) {
      hold('Новая команда не соответствует решению конфликта');
    }
    for (const [id, rev] of Object.entries(replacement.expected_entity_revisions)) {
      if (cloud.entities.filter(x => x?.id === id && x.entity_revision === rev).length !== 1) {
        hold('Ревизия изменённой сущности не подтверждена');
      }
    }
    if (replacement.action === 'account.create' &&
        cloud.entities.some(x => x?.id === replacement.payload.id)) {
      hold('Новый счёт уже существует');
    }
    verifySettlementDependencies(replacement, cloud.entities);
    verifyLoanDependencies(replacement, cloud.entities);
    verifyCashMovementDependencies(replacement, cloud.entities);
    verifyReversalDependencies(replacement, cloud.entities);
    verifyTransferDependencies(replacement, cloud.entities);
    const digest = await fingerprint(scope, identity.profileId, cloud.serverEtag, replacement);
    active(scope, session, identity);
    nextItem = {scope, profileId: identity.profileId, generation: identity.generation,
      epoch: identity.epoch, mutationId: replacement.client_mutation_id,
      fingerprint: digest, ifMatch: cloud.serverEtag, command: replacement,
      status: 'pending', attempts: 0};
  }
  const resolution = {...matches[0], kind: 'finance_sync_resolution',
    original: structuredClone(head), choice, observedRevision,
    replacementMutationId: nextItem?.mutationId ?? null};
  const conflicts = current.conflicts.map(x => x === matches[0] ? resolution : x);
  const outbox = nextItem ? [nextItem, ...current.outbox.slice(1)] : current.outbox.slice(1);
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(scope, session, expectedEpoch, 2,
    {snapshot: current.snapshot, outbox, conflicts});
  active(scope, session, identity);
  return Object.freeze({status: 'CONFLICT_RESOLVED', bundleEpoch: nextEpoch,
    pending: outbox.length, sent: false, originalPreserved: true});
}
