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
  if (snapshot.bankStatements !== undefined) {
    const bank = snapshot.bankStatements;
    if (Object.keys(bank).some(key => !['version', 'accounts', 'operations', 'batches'].includes(key)) ||
        bank.accounts.length || bank.operations.length || bank.batches.length) {
      fail('Локальные банковские счета и операции пока нельзя полностью перенести');
    }
  }
  const counts = {};
  const sourceKeys = [];
  for (const type of kinds) {
    const group = snapshot[type];
    if (!Array.isArray(group)) fail('Повреждён список финансовых записей');
    const seen = new Set();
    for (const record of group) {
      if (!isObject(record) || typeof record.id !== 'string' ||
          record.id.length < 1 || record.id.length > 128 ||
          record.id.trim() !== record.id || /[\u0000-\u001f\u007f]/.test(record.id) ||
          seen.has(record.id)) fail('Повторяющийся или недопустимый идентификатор');
      seen.add(record.id);
      // The source record map is keyed by type + original local ID. No
      // guessed UUID, amount, date, or posting is generated by the preflight.
      sourceKeys.push(type + ':' + record.id);
    }
    counts[type] = group.length;
  }
  if (sourceKeys.length > 10_000) fail('Превышен предел количества записей для переноса');
  validateProjection(snapshot);
  return {counts, recordCount: sourceKeys.length};
}

// Mirror the server's insertable financial projection before staging metadata.
function validateProjection(snapshot) {
  const invalid = () => fail('Часть записей нельзя безопасно представить на сервере');
  const money = (value, positive = false) => Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0) && value <= 1_000_000_000_000;
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value.slice(0,4) !== '0000' && Number.isFinite(Date.parse(value+'T00:00:00Z')) &&
    new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
  const timestamp = value => value == null || (typeof value === 'string' && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    day(value.slice(0,10)) && Number.isFinite(Date.parse(value)));
  const title = value => typeof value === 'string' && value.length <= 160 && value.trim().length > 0;
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (snapshot.settings?.currency !== 'RUB') invalid();
  const entries = new Set(snapshot.entries.map(x=>x.id));
  const loans = new Set(snapshot.loans.map(x=>x.id));
  for (const row of snapshot.entries) {
    if (!title(row.title) || !['income','expense'].includes(row.kind) ||
        !['once','monthly','yearly'].includes(row.recurrence) || !money(row.amountCents) ||
        !day(row.date) || !timestamp(row.deletedAt) ||
        (row.category != null && (typeof row.category !== 'string' || row.category.length > 100))) invalid();
  }
  for (const row of snapshot.loans) {
    if (!title(row.title) || !money(row.openingCents) || !money(row.paymentCents) ||
        typeof row.apr !== 'number' || !Number.isFinite(row.apr) || row.apr < 0 || row.apr > 1000 ||
        !/^\d+(?:\.\d{1,2})?$/.test(String(row.apr)) || !integer(row.termMonths,1,1200) ||
        !integer(row.dueDay,1,31) || !day(row.asOfDate) || !timestamp(row.deletedAt)) invalid();
    if (row.schedule != null) {
      if (!Array.isArray(row.schedule) || row.schedule.length > 5000) invalid();
      for (const item of row.schedule) {
        if (!isObject(item) || !day(item.date) ||
            Object.keys(item).some(field=>!['date','amountCents','balanceCents','interestCents','principalCents'].includes(field)) ||
            ['amountCents','balanceCents','interestCents','principalCents']
              .some(field=>item[field] != null && !money(item[field]))) invalid();
      }
    }
  }
  for (const row of snapshot.settlements) {
    if (!entries.has(row.entryId) || typeof row.occurrence !== 'string' ||
        !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.occurrence) || row.occurrence.startsWith('0000-') ||
        !day(row.date) || !money(row.amountCents,true) || !timestamp(row.voidedAt)) invalid();
  }
  for (const row of snapshot.loanPayments) {
    if (!loans.has(row.loanId) || !['term','amount'].includes(row.strategy) ||
        !day(row.date) || !money(row.amountCents,true) || !timestamp(row.voidedAt)) invalid();
  }
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
      typeof target.hasRemoteRecords !== 'boolean' ||
      (target.preserveZeroAccountId != null &&
        (!target.hasRemoteRecords || !uuid.test(target.preserveZeroAccountId)))) {
    fail('Не подтверждён серверный финансовый профиль');
  }
  if (verified.scope.startsWith('account:') &&
      verified.scope !== target.accountScope) {
    fail('Запрещён перенос между чужими аккаунтами');
  }
  if (verified.scope.startsWith('guest:') &&
      (!(verified.guestClaim === null || /^[a-f0-9]{32}$/.test(verified.guestClaim || '')) ||
       verified.sourceKey !== (verified.guestClaim ? 'guest-state-v2' : 'state'))) {
    fail('Не подтверждена исходная гостевая область');
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
  const approvedZeroAccount = target.hasRemoteRecords &&
    typeof target.preserveZeroAccountId === 'string' &&
    consent.confirmPreserveZeroAccount === true;
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
    status: target.hasRemoteRecords && !approvedZeroAccount
      ? 'NEEDS_CONFLICT_DECISION' : 'PREVIEW_ONLY',
    preservedZeroAccountId: approvedZeroAccount ? target.preserveZeroAccountId : null,
    sourceScope: verified.scope,
    targetScope: target.accountScope,
    sourceKey: verified.sourceKey,
    ...(verified.scope.startsWith('guest:') ? {guestClaim: verified.guestClaim} : {}),
    guestTransferApproved: verified.scope.startsWith('guest:') && consent.explicitGuestTransfer === true,
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
 * Explicit personal import payload. This DOES NOT send HTTP,
 * change IndexedDB or authorize migration. The caller must have independently
 * verified an externally saved AES-GCM backup and confirmed the owner account.
 * It rechecks the canonical bytes against the read-only preview's SHA so no
 * source records can be substituted between preflight and SQL staging.
 *
 * The plaintext is ephemeral and must never be logged or persisted locally.
 */
export async function prepareVerifiedLegacyImportTransportCandidate({
  verified, preview, signal, mergeDecisions = null, comparison = null,
  confirmedGuestTransfer = false, confirmedTargetScope = null,
}) {
  const merging = preview?.status === 'NEEDS_CONFLICT_DECISION' && Array.isArray(mergeDecisions);
  const guest = guestScope.test(preview?.sourceScope || '');
  const sourceAllowed = guest ?
    (confirmedGuestTransfer === true && preview?.guestTransferApproved === true &&
     userScope.test(preview?.targetScope || '') && confirmedTargetScope === preview.targetScope &&
     preview.sourceKey === verified?.sourceKey && preview.guestClaim === verified?.guestClaim &&
     ['state','guest-state-v2'].includes(verified?.sourceKey)) :
    (confirmedGuestTransfer === false && userScope.test(preview?.sourceScope || '') &&
     preview?.targetScope === verified?.scope);
  if (!signal || signal.aborted || !verified || !isObject(verified) ||
      verified.backupVersion !== 1 || !isObject(verified.snapshot) ||
      !preview || !isObject(preview) || (preview.status !== 'PREVIEW_ONLY' && !merging) ||
      (!merging && mergeDecisions !== null) ||
      preview.sendAllowed !== false || preview.originalPreserved !== true ||
      !sourceAllowed ||
      preview.sourceScope !== verified.scope ||
      !uuid.test(preview.targetProfileId) ||
      !Number.isSafeInteger(preview.expectedServerRevision) ||
      preview.expectedServerRevision < 0 ||
      (preview.preservedZeroAccountId != null &&
       !uuid.test(preview.preservedZeroAccountId)) ||
      !/^[0-9a-f]{64}$/.test(preview.sourceSha256)) {
    fail('Не подтверждён безопасный перенос в собственный пустой профиль');
  }
  let pinnedDecisions, pinnedComparison;
  if (merging) {
    try {
      assertSafeJSONBeforeClone(mergeDecisions);
      assertSafeJSONBeforeClone(comparison);
      pinnedDecisions = structuredClone(mergeDecisions);
      pinnedComparison = structuredClone(comparison);
    } catch {
      fail('Небезопасные решения по записям');
    }
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
  const chosen = new Map(), linked = new Set();
  if (merging) {
    if (preview.preservedZeroAccountId || pinnedComparison?.status !== 'NEEDS_OWNER_DECISIONS' ||
        pinnedDecisions.length !== index.recordCount) fail('Не выбрано решение для каждой записи');
    for (const decision of pinnedDecisions) {
      if (!isObject(decision) || !kinds.includes(decision.kind) ||
          typeof decision.sourceId !== 'string' || !['add', 'link'].includes(decision.action)) {
        fail('Некорректное решение по записи');
      }
      const recordKey = JSON.stringify([decision.kind, decision.sourceId]);
      if (chosen.has(recordKey)) fail('Повторное решение по записи');
      if (decision.action === 'link') {
        if (!uuid.test(decision.targetId || '') ||
            !pinnedComparison.groups?.[decision.kind]?.serverIds?.includes(decision.targetId) ||
            linked.has(JSON.stringify([decision.kind, decision.targetId]))) {
          fail('Выбранная серверная запись недоступна или используется повторно');
        }
        linked.add(JSON.stringify([decision.kind, decision.targetId]));
      } else if (decision.targetId != null) fail('Неожиданная связь для новой записи');
      chosen.set(recordKey, decision);
    }
  }
  for (const kind of kinds) {
    for (const record of pinned[kind]) {
      const row = {record_type: kind, source_record_id: record.id};
      if (merging) {
        const decision = chosen.get(JSON.stringify([kind, record.id]));
        if (!decision) fail('Не выбрано решение для каждой записи');
        row.decision = decision.action;
        if (decision.action === 'link') row.target_id = decision.targetId;
      }
      rows.push(row);
    }
  }
  const payload = {
    manifest: Object.freeze({
      schema_version: merging ? 2 : 1,
      source_scope: preview.sourceScope,
      source_revision: preview.sourceRevision,
      source_sha256: hash,
      expected_server_revision: preview.expectedServerRevision,
      external_encrypted_backup_checked: true,
      explicit_owner_consent: true,
      explicit_guest_transfer: guest,
      ...(preview.preservedZeroAccountId ? {
        preserve_zero_account_id: preview.preservedZeroAccountId,
        confirm_preserve_zero_account: true,
      } : {}),
      rows,
    }),
    source_canonical_json: canonicalSnapshot,
  };
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify({manifest:payload.manifest})).byteLength > 2_000_000 ||
      encoder.encode(JSON.stringify(payload)).byteLength > 10_000_000) {
    fail('Финансовые данные превышают лимит серверного запроса');
  }
  return Object.freeze(payload);
}
