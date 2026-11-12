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
import {applyFinanceDeltaCandidate} from './verified-delta-candidate.mjs';

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
  // Mirror the exact account IDs whose revisions the server will lock.
  // Rejecting invalid commands before queueing prevents persistent offline
  // entries that can never succeed after a network reconnect.
  let requiredRevisions;
  if (dto.action === 'account.create') {
    requiredRevisions = [];
  } else if (dto.action === 'settlement.payment.record') {
    requiredRevisions = [dto.payload.account_id, dto.payload.obligation_id];
  } else if (dto.action === 'loan.payment.record') {
    requiredRevisions = [dto.payload.account_id, dto.payload.loan_id];
  } else if (dto.action.endsWith('.payment.void')) {
    requiredRevisions = [dto.payload.account_id,
      dto.payload.fact_id, dto.payload.transaction_id];
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
  for (const name of ['paid_on', 'occurred_on', 'occurrence_on']) {
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
  if (!plain(ack) || ack.schema_version !== 2 ||
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
  if (first.fingerprint !== digest || first.command.schema_version !== 2) {
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
  httpStatus, decision, source,
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
