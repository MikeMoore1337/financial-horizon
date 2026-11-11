/**
 * Financial Horizon #68 - PURE, INACTIVE cloud snapshot/delta validator.
 *
 * Only the authenticated server can provide profileId. The caller must
 * atomically persist the returned value with the encrypted outbox, cursor
 * and applied receipts under the same active account generation.
 * This module NEVER opens IndexedDB, requests a URL, or writes to the PWA.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scopePattern = /^account:[0-9a-f]{32}$/;
const epochPattern = /^[0-9a-f]{32}$/;
const moneyLimit = 1_000_000_000_000;
// /state pages are ordered by kind and then by UUID (PostgreSQL ordering).
// A cursor must name the actual last entity; a fabricated forward jump would
// hide financial records despite an apparently complete set of pages.
const kindOrder = ['account', 'obligation', 'loan', 'reserve',
  'transaction', 'settlement', 'loan_payment'];
const kinds = new Set(kindOrder);
const changes = new Set(['upsert', 'tombstone', 'ledger_posted']);

function reject(message) {
  throw new Error('SYNC_HOLD: ' + message);
}
function safeInt(x, low = 0, high = Number.MAX_SAFE_INTEGER) {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= low && x <= high;
}
function exactObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    Object.getPrototypeOf(x) === Object.prototype;
}
function validateIdentity({scope, profileId, generation, epoch, signal}) {
  if (!scopePattern.test(scope) || !uuid.test(profileId) ||
      !safeInt(generation, 1) || !epochPattern.test(epoch) ||
      !signal || typeof signal.aborted !== 'boolean' || signal.aborted) {
    reject('Нет действующего подтверждённого финансового профиля');
  }
}
function noPrototypeKeys(value, depth = 0) {
  if (depth > 24) reject('Слишком глубокая финансовая структура');
  if (Array.isArray(value)) {
    if (value.length > 100_000) reject('Слишком много вложенных записей');
    for (const item of value) noPrototypeKeys(item, depth + 1);
  } else if (value && typeof value === 'object') {
    if (!exactObject(value) || Object.keys(value).length > 200) {
      reject('Неоднозначная финансовая структура');
    }
    for (const [name, item] of Object.entries(value)) {
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        reject('Небезопасный ключ финансовых данных');
      }
      noPrototypeKeys(item, depth + 1);
    }
  }
}
function validEntity(entity) {
  if (!exactObject(entity) || !uuid.test(entity.id) ||
      !safeInt(entity.entity_revision, 1) || !kinds.has(entity.kind) ||
      !exactObject(entity.data)) reject('Повреждена серверная сущность');
  noPrototypeKeys(entity.data);
  if (entity.kind === 'account') {
    const data = entity.data;
    if (data.currency !== 'RUB' ||
        !safeInt(data.opening_minor, -moneyLimit, moneyLimit) ||
        !safeInt(data.balance_minor, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
        !safeInt(data.reserved_minor, 0) ||
        !safeInt(data.available_minor, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
        data.balance_minor - data.reserved_minor !== data.available_minor) {
      reject('Неверный подтверждённый остаток счёта');
    }
  }
  if (entity.kind === 'transaction') {
    const p = entity.data.postings;
    if (!Array.isArray(p) || ![1, 2].includes(p.length)) {
      reject('Неверное число финансовых проводок');
    }
    const seen = new Set();
    let sum = 0;
    for (const x of p) {
      if (!exactObject(x) || !uuid.test(x.account_id) ||
          !safeInt(x.signed_minor, -moneyLimit, moneyLimit) ||
          x.signed_minor === 0 || seen.has(x.account_id)) {
        reject('Повреждённая проводка');
      }
      seen.add(x.account_id);
      sum += x.signed_minor;
    }
    if (entity.data.kind === 'transfer' && (p.length !== 2 || sum !== 0)) {
      reject('Перевод не сбалансирован');
    }
    if (entity.data.kind !== 'transfer' && p.length === 2 &&
        entity.data.kind !== 'reversal') {
      reject('Лишняя финансовая проводка');
    }
  }
  return structuredClone(entity);
}

function validateVersion(value, name) {
  if (!safeInt(value, 0)) reject('Некорректная ' + name);
}
function validateSnapshotBody(body, profileId) {
  if (!exactObject(body) || body.schema_version !== 1 ||
      body.currency !== 'RUB' || body.profile_id !== profileId ||
      !Array.isArray(body.entities) || body.entities.length > 5_000) {
    reject('Несовместимый серверный финансовый снимок');
  }
  validateVersion(body.revision, 'ревизия');
}

/**
 * Only accepts a COMPLETE, explicitly cursor-linked set of HTTP 200/206
 * snapshot pages. A partial snapshot cannot overwrite an existing cache.
 * Every page belongs to exactly the same authenticated server profile/rev.
 */
export function verifyFinanceSnapshotPagesCandidate(
  pages, {scope, profileId, generation, epoch, signal},
) {
  validateIdentity({scope, profileId, generation, epoch, signal});
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 500) {
    reject('Нет полного снимка');
  }
  let revision = null;
  let expectedCursor = null;
  let lastEntity = null;
  const entities = new Map();
  for (let i = 0; i < pages.length; i++) {
    if (signal.aborted) reject('Сессия отозвана');
    const page = pages[i];
    if (!exactObject(page) || page.cursorSent !== expectedCursor) {
      reject('Пропущена страница серверного снимка');
    }
    const body = page.body;
    validateSnapshotBody(body, profileId);
    if (revision === null) revision = body.revision;
    if (body.revision !== revision) reject('Снимок изменился во время чтения');
    for (const item of body.entities) {
      const entity = validEntity(item);
      if (lastEntity) {
        const previousKind = kindOrder.indexOf(lastEntity.kind);
        const currentKind = kindOrder.indexOf(entity.kind);
        if (currentKind < previousKind ||
            (currentKind === previousKind && entity.id <= lastEntity.id)) {
          reject('Страницы финансового снимка перепутаны или повторены');
        }
      }
      if (entities.has(entity.id)) reject('Повторяющаяся серверная сущность');
      entities.set(entity.id, entity);
      lastEntity = entity;
    }
    if (entities.size > 100_000) reject('Слишком большой снимок');
    const next = body.next_cursor;
    if (next !== undefined && next !== null) {
      const actualCursor = lastEntity
        ? revision + ':' + lastEntity.kind + ':' + lastEntity.id : null;
      if (i === pages.length - 1 || typeof next !== 'string' ||
          next !== actualCursor || body.entities.length === 0) {
        reject('Снимок обрывается или курсор не соответствует записям');
      }
      expectedCursor = next;
    } else {
      if (i !== pages.length - 1) reject('Лишняя страница серверного снимка');
      expectedCursor = null;
    }
  }
  return {scope, profileId, generation, epoch, revision,
    entities: [...entities.values()], pending: [], conflicts: []};
}

/**
 * Returns a new verified remote state, with pending local operations untouched.
 * This is NOT durable: #68 must persist its result in an encrypted IndexedDB
 * CAS transaction alongside cursor, verified applied proof and outbox.
 */
export function applyFinanceDeltaCandidate(
  local, page, {scope, profileId, generation, epoch, signal},
) {
  validateIdentity({scope, profileId, generation, epoch, signal});
  if (!exactObject(local) || local.scope !== scope ||
      local.profileId !== profileId || local.generation !== generation ||
      local.epoch !== epoch || !safeInt(local.revision, 0) ||
      !Array.isArray(local.entities) || !Array.isArray(local.pending) ||
      !Array.isArray(local.conflicts)) {
    reject('Локальный сеанс и облачный профиль не совпадают');
  }
  if (!exactObject(page) || page.schema_version !== 1 ||
      page.from_revision !== local.revision ||
      !safeInt(page.to_revision, local.revision) ||
      !safeInt(page.next_since_revision, local.revision, page.to_revision) ||
      typeof page.has_more !== 'boolean' || !Array.isArray(page.changes) ||
      page.changes.length > 2_000) {
    reject('Неверные границы журнала изменений');
  }
  const byId = new Map();
  for (const item of local.entities) {
    const e = validEntity(item);
    if (byId.has(e.id)) reject('Повторяющаяся локальная сущность');
    byId.set(e.id, e);
  }
  let next = local.revision, ordinal = 0;
  const requiredPaymentFacts = new Map();
  const observedFactEvents = new Set();
  for (const change of page.changes) {
    if (signal.aborted) reject('Сессия отозвана');
    if (!exactObject(change) || !changes.has(change.kind) ||
        !uuid.test(change.entity_id) || change.revision <= local.revision ||
        !safeInt(change.entity_revision, 1) ||
        !safeInt(change.revision, local.revision + 1, page.to_revision) ||
        !safeInt(change.ordinal, 0) || !exactObject(change.payload)) {
      reject('Повреждена запись журнала');
    }
    if (change.revision === next + 1 && ordinal > 0) {
      next++; ordinal = 0;
    } else if (change.revision !== next + 1 && change.revision !== next) {
      reject('В журнале пропущена ревизия');
    }
    if (change.revision === next + 1) next++;
    if (change.ordinal !== ordinal++) reject('Пропущен номер события');
    const payload = change.payload;
    noPrototypeKeys(payload);
    if (change.kind === 'tombstone') {
      if (!byId.has(change.entity_id)) reject('Удаляется неизвестная сущность');
      byId.delete(change.entity_id);
      continue;
    }
    const entity = validEntity(payload.entity);
    if (entity.id !== change.entity_id ||
        entity.entity_revision !== change.entity_revision ||
        (change.kind === 'ledger_posted' && entity.kind !== 'transaction')) {
      reject('Событие не соответствует исходной сущности');
    }
    const old = byId.get(entity.id);
    if (entity.kind === 'settlement' || entity.kind === 'loan_payment') {
      observedFactEvents.add(change.revision + ':' + entity.id);
    }
    // Linked payment and its fact must advance together. A truncated page
    // missing the fact event must never make a local account appear paid.
    let relatedPayment = null;
    if (entity.kind === 'transaction' && entity.data.kind === 'payment') {
      relatedPayment = entity;
    }
    if (entity.kind === 'transaction' && entity.data.kind === 'reversal') {
      const original = byId.get(entity.data.reversed_transaction_id);
      if (!original && entity.data.reversed_transaction_id) {
        reject('Отмена неизвестной финансовой операции');
      }
      if (original?.kind === 'transaction' && original.data.kind === 'payment') {
        relatedPayment = original;
      }
    }
    if (relatedPayment) {
      const link = relatedPayment.data.payment_link;
      const factId = link &&
        (link.settlement_id || link.loan_payment_id);
      if (!uuid.test(factId)) reject('Не указан связанный факт оплаты');
      requiredPaymentFacts.set(change.revision + ':' + factId, true);
    }
    if (old && old.entity_revision >= entity.entity_revision) {
      reject('Сервер прислал неувеличенную ревизию');
    }
    byId.set(entity.id, entity);
    if (change.kind === 'ledger_posted') {
      if (!Array.isArray(payload.accounts)) reject('Не указаны затронутые счета');
      const postingIds = new Set(entity.data.postings.map(x => x.account_id));
      const seen = new Set();
      for (const account of payload.accounts) {
        const updated = validEntity(account);
        if (updated.kind !== 'account' || seen.has(updated.id) ||
            !postingIds.has(updated.id)) reject('Неверный счёт проводки');
        const previous = byId.get(updated.id);
        if (!previous || previous.kind !== 'account' ||
            previous.entity_revision >= updated.entity_revision) {
          reject('Неувеличенная ревизия счёта');
        }
        byId.set(updated.id, updated);
        seen.add(updated.id);
      }
      if (seen.size !== postingIds.size) reject('Не все счета обновлены');
    }
  }
  for (const factKey of requiredPaymentFacts.keys()) {
    if (!observedFactEvents.has(factKey)) {
      reject('Оплата и подтверждённый факт разорваны между страницами');
    }
  }
  if (page.changes.length === 0 &&
      (page.next_since_revision !== local.revision || page.has_more)) {
    reject('Нет подтверждения новой ревизии');
  }
  if (page.changes.length && next !== page.next_since_revision) {
    reject('Не совпадает курсор журнала');
  }
  if ((!page.has_more && next !== page.to_revision) ||
      (page.has_more && next >= page.to_revision)) {
    reject('Страница журнала не полная');
  }
  return {...local, revision: next, entities: [...byId.values()],
    pending: structuredClone(local.pending), conflicts: structuredClone(local.conflicts)};
}
