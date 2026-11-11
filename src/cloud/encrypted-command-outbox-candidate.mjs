/**
 * #68 - INACTIVE, account-scoped encrypted offline command queue.
 *
 * No HTTP calls, automatic replay, optimistic cash postings, feature flag,
 * local-first migration or exposed browser entrypoint. Queue operations are
 * encrypted with the existing #34 snapshot/outbox/conflict native IDB CAS.
 * The server remains authoritative for confirmed account balances.
 */
import {
  readAtomicEncryptedCandidate,
  compareAndSwapAtomicEncryptedCandidate,
} from '../security/protected-atomic-candidate.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPE = /^account:[a-f0-9]{32}$/;
const EPOCH = /^[a-f0-9]{32}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_BYTES = 32768;
const MAX_QUEUE = 1000;
const ACTION_FIELDS = Object.freeze({
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
const OPTIONAL_FIELDS = Object.freeze({'transaction.record': ['note']});

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
    result = Object.create(null);
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
function validateCommand(command) {
  const dto = safeJson(command);
  keysExactly(dto, [
    'schema_version', 'client_mutation_id', 'base_revision',
    'action', 'expected_entity_revisions', 'payload',
  ]);
  if (dto.schema_version !== 2 || !UUID.test(dto.client_mutation_id) ||
      !integer(dto.base_revision) ||
      typeof dto.action !== 'string' ||
      !Object.hasOwn(ACTION_FIELDS, dto.action)) {
    hold('Недопустимая версия или действие команды');
  }
  keysExactly(dto.payload, ACTION_FIELDS[dto.action], OPTIONAL_FIELDS[dto.action] || []);
  if (!plain(dto.expected_entity_revisions) ||
      Object.keys(dto.expected_entity_revisions).length > 100 ||
      Object.entries(dto.expected_entity_revisions).some(([id, rev]) =>
        !UUID.test(id) || !integer(rev, 1))) hold('Неверные ревизии сущностей');
  for (const [name, value] of Object.entries(dto.payload)) {
    if ((name === 'opening_minor' || name === 'signed_minor') &&
        !integer(value, -1_000_000_000_000, 1_000_000_000_000)) {
      hold('Недопустимая сумма');
    }
    if (name === 'amount_minor' && !integer(value, 1, 1_000_000_000_000)) {
      hold('Недопустимая сумма');
    }
    if ((name === 'account_id' || name === 'obligation_id' ||
         name === 'loan_id' || name === 'transaction_id' ||
         name === 'fact_id' || name === 'id') && !UUID.test(value)) {
      hold('Недопустимый идентификатор');
    }
  }
  return dto;
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
      !integer(cloud.revision) ||
      cloud.revision !== pinned.base_revision) hold('Серверная версия изменилась');
  // The old in-memory unlock generation is not a durable credential.
  // It may differ after a real browser restart. A fresh FH session and
  // currently unlocked keyset are checked above; queue identity is fenced
  // by the persistent account scope, owner profile and cutover epoch.
  existingQueue(current.outbox, scope, identity);
  const duplicate = current.outbox.find(x => x.mutationId === pinned.client_mutation_id);
  if (duplicate) {
    if (duplicate.fingerprint !== digest || duplicate.ifMatch !== ifMatch) {
      hold('Повторно использован идентификатор другой операции');
    }
    return Object.freeze({status: 'ALREADY_QUEUED', bundleEpoch: expectedEpoch,
      pending: current.outbox.length, serverBalanceChanged: false, sent: false});
  }
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
