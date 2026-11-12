/**
 * Financial Horizon #69: INACTIVE read-only cloud migration inventory.
 *
 * Takes the result of verifyLiveLegacyBackup() only after an external encrypted
 * backup was compared with the active v1/v2 browser finance source.
 * This module NEVER reads/writes IndexedDB, sends HTTP, creates an account
 * balance or converts planned obligations into actual posted cash.
 */
import {validateState} from '../../finance.js';

const userScope = /^account:[a-f0-9]{32}$/;
const guestScope = /^guest:[A-Za-z0-9_-]{4,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds = ['entries', 'loans', 'settlements', 'loanPayments'];
const maxBytes = 8_000_000;

function fail(reason) {
  throw new Error('IMPORT_HOLD: ' + reason);
}
function isObject(x) {
  return x !== null && typeof x === 'object' &&
    !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype ||
      Object.getPrototypeOf(x) === null);
}
function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 32) fail('Превышена глубина финансовых данных');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Некорректное число');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') fail('Неподдерживаемое финансовое поле');
  if (seen.has(value)) fail('Циклическая финансовая структура');
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = '[' + value.map(item => canonical(item, seen, depth + 1)).join(',') + ']';
  } else if (isObject(value)) {
    const props = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(props).sort();
    if (names.length > 400) fail('Слишком много финансовых полей');
    output = '{' + names.map(name => {
      if (name === '__proto__' || name === 'prototype' || name === 'constructor' ||
          !Object.hasOwn(props[name], 'value')) fail('Небезопасное поле');
      return JSON.stringify(name) + ':' +
        canonical(props[name].value, seen, depth + 1);
    }).join(',') + '}';
  } else {
    fail('Некорректный тип финансового поля');
  }
  seen.delete(value);
  return output;
}
/**
 * The verified source is an untrusted caller-owned object until pinned.
 * structuredClone() INVOKES accessor getters; check the entire tree before
 * cloning so an import preview never executes a financial-field getter.
 */
function assertSafeJSONBeforeClone(value, seen = new Set(), depth = 0) {
  if (depth > 32) fail('Превышена глубина финансовых данных');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Некорректное число');
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    fail('Некорректная или циклическая финансовая структура');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length ||
        Object.keys(value).length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1) {
      fail('Некорректный массив исходных финансов');
    }
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('Недопустимый элемент массива финансов');
      }
      assertSafeJSONBeforeClone(descriptor.value, seen, depth + 1);
    }
  } else {
    if (!isObject(value) || Object.getOwnPropertySymbols(value).length ||
        Object.keys(value).length !== Object.getOwnPropertyNames(value).length ||
        Object.keys(value).length > 400) {
      fail('Некорректный объект исходных финансов');
    }
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value)
    )) {
      if (name === '__proto__' || name === 'constructor' ||
          name === 'prototype' || !Object.hasOwn(descriptor, 'value')) {
        fail('Небезопасное поле финансовых данных');
      }
      assertSafeJSONBeforeClone(descriptor.value, seen, depth + 1);
    }
  }
  seen.delete(value);
}

async function fingerprint(serialized) {
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > maxBytes) fail('Финансовая база превышает лимит переноса');
  if (!globalThis.crypto?.subtle) fail('Web Crypto недоступна');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function recordIndex(snapshot) {
  const counts = {};
  const sourceKeys = [];
  for (const type of kinds) {
    const group = snapshot[type];
    if (!Array.isArray(group)) fail('Повреждён список финансовых записей');
    const seen = new Set();
    for (const record of group) {
      if (!isObject(record) || typeof record.id !== 'string' ||
          record.id.length < 1 || record.id.length > 128 ||
          seen.has(record.id)) fail('Повторяющийся или недопустимый идентификатор');
      seen.add(record.id);
      // The source record map is keyed by type + original local ID. No
      // guessed UUID, amount, date, or posting is generated by the preflight.
      sourceKeys.push(type + ':' + record.id);
    }
    counts[type] = group.length;
  }
  return {counts, recordCount: sourceKeys.length};
}

/**
 * Staging-only preview. No network operation or data migration is performed.
 * A real importer must first call verifyLiveLegacyBackup using an actual
 * independently saved encrypted file and the selected browser source.
 */
export async function planVerifiedLegacyImportCandidate({
  verified, target, consent, signal,
}) {
  if (!signal || typeof signal.aborted !== 'boolean' || signal.aborted) {
    fail('Сеанс переноса недоступен');
  }
  if (!verified || !isObject(verified) || verified.backupVersion !== 1 ||
      typeof verified.scope !== 'string' ||
      !(userScope.test(verified.scope) || guestScope.test(verified.scope)) ||
      typeof verified.sourceKey !== 'string' ||
      !Number.isSafeInteger(verified.sourceRevision) || verified.sourceRevision < 0 ||
      !isObject(verified.snapshot)) fail('Не подтверждён источник копии');
  if (!target || !isObject(target) || !userScope.test(target.accountScope) ||
      !uuid.test(target.profileId) ||
      !Number.isSafeInteger(target.serverRevision) || target.serverRevision < 0 ||
      typeof target.hasRemoteRecords !== 'boolean') {
    fail('Не подтверждён серверный финансовый профиль');
  }
  if (verified.scope.startsWith('account:') &&
      verified.scope !== target.accountScope) {
    fail('Запрещён перенос между чужими аккаунтами');
  }
  if (!consent || consent.externalEncryptedBackupVerified !== true ||
      consent.confirmedTargetAccount !== true || consent.previewRequested !== true ||
      (verified.scope.startsWith('guest:') && consent.explicitGuestTransfer !== true)) {
    fail('Не получены обязательные подтверждения переноса');
  }
  // Always work on a frozen copy of the verified source: no callers can
  // change account scope, money or source IDs while awaiting SHA-256.
  let pinned;
  try {
    assertSafeJSONBeforeClone(verified.snapshot);
    pinned = structuredClone(verified.snapshot);
    validateState(pinned);
  } catch {
    fail('Повреждены исходные финансовые данные');
  }
  const index = recordIndex(pinned);
  const canonicalSnapshot = canonical(pinned);
  const sourceSha256 = await fingerprint(canonicalSnapshot);
  if (signal.aborted) fail('Сеанс отменён во время проверки');
  const expectedRevision = pinned.version === 2 ? pinned.revision : 0;
  if (verified.sourceRevision !== expectedRevision) {
    fail('Исходные данные изменились во время подготовки');
  }

  return Object.freeze({
    schemaVersion: 1,
    status: target.hasRemoteRecords ? 'NEEDS_CONFLICT_DECISION' : 'PREVIEW_ONLY',
    sourceScope: verified.scope,
    targetScope: target.accountScope,
    targetProfileId: target.profileId,
    sourceVersion: pinned.version,
    sourceRevision: expectedRevision,
    expectedServerRevision: target.serverRevision,
    sourceSha256,
    ...index,
    requiresExplicitOpeningBalances: true,
    plannedAccounts: Object.freeze([]),
    plannedLedgerPostings: Object.freeze([]),
    sendAllowed: false,
    originalPreserved: true,
  });
}


/**
 * Explicit account-only personal import payload. This DOES NOT send HTTP,
 * change IndexedDB or authorize migration. The caller must have independently
 * verified an externally saved AES-GCM backup and confirmed the owner account.
 * It rechecks the canonical bytes against the read-only preview's SHA so no
 * source records can be substituted between preflight and SQL staging.
 *
 * The plaintext is ephemeral and must never be logged or persisted locally.
 */
export async function prepareVerifiedLegacyImportTransportCandidate({
  verified, preview, signal,
}) {
  if (!signal || signal.aborted || !verified || !isObject(verified) ||
      verified.backupVersion !== 1 || !isObject(verified.snapshot) ||
      !preview || !isObject(preview) || preview.status !== 'PREVIEW_ONLY' ||
      preview.sendAllowed !== false || preview.originalPreserved !== true ||
      !userScope.test(preview.sourceScope) ||
      preview.sourceScope !== verified.scope ||
      preview.targetScope !== verified.scope ||
      !uuid.test(preview.targetProfileId) ||
      !Number.isSafeInteger(preview.expectedServerRevision) ||
      preview.expectedServerRevision < 0 ||
      !/^[0-9a-f]{64}$/.test(preview.sourceSha256)) {
    fail('Не подтверждён безопасный перенос в собственный пустой профиль');
  }
  let pinned;
  try {
    assertSafeJSONBeforeClone(verified.snapshot);
    pinned = structuredClone(verified.snapshot);
    validateState(pinned);
  } catch {
    fail('Финансовые данные изменились после подтверждения копии');
  }
  if (verified.sourceRevision !== preview.sourceRevision ||
      pinned.version !== preview.sourceVersion ||
      (pinned.version === 2 ? pinned.revision : 0) !== preview.sourceRevision) {
    fail('Ревизия исходных данных изменилась');
  }
  const index = recordIndex(pinned);
  if (index.recordCount !== preview.recordCount ||
      !isObject(preview.counts) ||
      JSON.stringify(index.counts) !== JSON.stringify(preview.counts)) {
    fail('Список исходных записей изменился');
  }
  const canonicalSnapshot = canonical(pinned);
  const hash = await fingerprint(canonicalSnapshot);
  if (signal.aborted || hash !== preview.sourceSha256) {
    fail('Суммы или исходные данные изменились перед отправкой');
  }
  const rows = [];
  for (const kind of kinds) {
    for (const record of pinned[kind]) {
      rows.push({record_type: kind, source_record_id: record.id});
    }
  }
  return Object.freeze({
    manifest: Object.freeze({
      schema_version: 1,
      source_scope: preview.sourceScope,
      source_revision: preview.sourceRevision,
      source_sha256: hash,
      expected_server_revision: preview.expectedServerRevision,
      external_encrypted_backup_checked: true,
      explicit_owner_consent: true,
      explicit_guest_transfer: false,
      rows,
    }),
    source_canonical_json: canonicalSnapshot,
  });
}
