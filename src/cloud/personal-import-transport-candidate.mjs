/**
 * #69 - private, explicitly user-initiated import through a revocable FH session.
 * No automatic upload or IndexedDB mutation. Never include password, cookies,
 * plaintext or command bodies in logs, URLs or browser storage.
 *
 * Prepare and execute are separate functions: the host MUST present a human
 * review and require a second explicit click before calling execute.
 */
import {verifyLiveLegacyBackup} from '../security/live-legacy-preflight.ts';
import {planLiveLegacyImportPreviewCandidate} from './live-legacy-import-preview-candidate.mjs';
import {prepareVerifiedLegacyImportTransportCandidate} from './legacy-import-manifest-candidate.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const USER = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;

function hold(reason) { throw Error('IMPORT_HOLD: ' + reason); }
function active(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || signal.aborted) {
    hold('Проверка переноса отменена');
  }
}
function safeOrigin(origin) {
  if (typeof origin !== 'string') hold('Не подтверждён адрес приложения');
  let url;
  try { url = new URL(origin); } catch { hold('Не подтверждён адрес приложения'); }
  if (url.origin !== origin || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    hold('Перенос доступен только на защищённом FH-адресе');
  }
  return origin;
}
async function bytes(response, limit) {
  if (!response || response.redirected || response.type === 'opaqueredirect' ||
      !response.body || !response.headers ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    hold('Сервер не подтвердил ответ переноса');
  }
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d{1,10}$/.test(size) || Number(size) > limit)) {
    hold('Превышен размер ответа сервера');
  }
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value)) hold('Повреждён ответ');
      total += part.value.byteLength;
      if (total > limit) hold('Превышен размер ответа сервера');
      chunks.push(new Uint8Array(part.value));
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', {fatal: true}).decode(result);
  } catch {
    try { await reader.cancel(); } catch { /* Aborted stream is not reusable. */ }
    hold('Не удалось получить проверенный ответ сервера');
  } finally { reader.releaseLock(); }
}
async function responseJson(response, limit = 2_000_000) {
  let body;
  try { body = JSON.parse(await bytes(response, limit)); } catch { hold('Повреждён ответ сервера'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    hold('Сервер вернул недопустимый ответ');
  }
  return body;
}
async function request(fetchImpl, origin, path, method, body, signal, etag) {
  active(signal);
  if (!path.startsWith('/api/')) hold('Недопустимый запрос');
  const url = origin + path;
  let result;
  try {
    result = await fetchImpl(url, {
      method, credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', mode: 'same-origin', referrerPolicy: 'same-origin', signal,
      headers: method === 'POST' ? {
        'Content-Type': 'application/json', ...(etag ? {'If-Match': etag} : {}),
      } : {},
      ...(method === 'POST' ? {body: JSON.stringify(body)} : {}),
    });
  } catch {
    hold('Нет подтверждения результата сети. Не повторяйте импорт автоматически');
  }
  active(signal);
  if (result.redirected || (result.url && new URL(result.url).origin !== origin)) {
    hold('Неизвестная переадресация финансового запроса');
  }
  if ([401, 403].includes(result.status)) hold('Сессия завершилась или доступ запрещён');
  if ([409, 410, 412].includes(result.status)) hold('Сервер изменился: нужен новый просмотр без повторной записи');
  if (result.status !== 200 && result.status !== 201 && result.status !== 202) {
    hold('Сервер не подтвердил перенос. Проверьте состояние до повтора');
  }
  return result;
}

/** Only prepares source bytes after actual externally saved backup check. */
export async function prepareLivePersonalImportCandidate({
  verifiedActorUserId, backupText, backupPassword, fetchImpl,
  origin, signal, explicitConsent = false,
}) {
  active(signal); safeOrigin(origin);
  if (!USER.test(verifiedActorUserId) ||
      explicitConsent !== true ||
      typeof backupText !== 'string' || backupText.length < 100 ||
      backupText.length > 8_000_000 || typeof backupPassword !== 'string' ||
      backupPassword.length < 12 || typeof fetchImpl !== 'function') {
    hold('Нужны подтверждённый FH-аккаунт и внешняя шифрованная копия');
  }
  // Reject obviously unprotected or malformed files BEFORE creating a
  // server finance session. Actual AES-GCM authentication follows below.
  let archive;
  try { archive = JSON.parse(backupText); } catch {
    hold('Выбран не зашифрованный файл Financial Horizon');
  }
  if (!archive || typeof archive !== 'object' || Array.isArray(archive) ||
      archive.format !== 'financial-horizon-backup' || archive.version !== 1 ||
      archive.kdf !== 'PBKDF2-SHA256' || archive.iterations !== 310000 ||
      typeof archive.salt !== 'string' || typeof archive.iv !== 'string' ||
      typeof archive.ciphertext !== 'string') {
    hold('Выбран не зашифрованный файл Financial Horizon');
  }
  const bootstrap = await request(fetchImpl, origin, '/api/auth/email/finance/session',
    'POST', {}, signal);
  const session = await responseJson(bootstrap);
  if (bootstrap.status !== 200 || session.ok !== true || !UUID.test(session.profile_id)) {
    hold('Не удалось подтвердить финансовый профиль');
  }
  const snapshotResponse = await request(fetchImpl, origin,
    '/api/finance/v1/state?limit_entities=5000', 'GET', null, signal);
  const snapshot = await responseJson(snapshotResponse);
  const etag = snapshotResponse.headers.get('etag');
  if (snapshotResponse.status !== 200 || !STRONG_ETAG.test(etag || '') ||
      snapshot.profile_id !== session.profile_id || snapshot.currency !== 'RUB' ||
      snapshot.schema_version !== 1 ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      !Array.isArray(snapshot.entities) ||
      snapshot.entities.length > 1 || snapshot.next_cursor != null) {
    hold('Сервер содержит записи или вернул неполный финансовый снимок');
  }
  // The only compatible nonempty target is a single untouched 0-RUB account.
  // Its UUID/revision and absence of all other server facts are rechecked by
  // PostgreSQL under profile lock at both stage and commit. Never delete it.
  const existing = snapshot.entities[0] ?? null;
  if (existing && (existing.kind !== 'account' || !UUID.test(existing.id) ||
      existing.entity_revision !== 1 ||
      typeof existing.data?.name !== 'string' ||
      existing.data.name.length < 1 || existing.data.name.length > 160 ||
      existing.data.currency !== 'RUB' ||
      existing.data.opening_minor !== 0 ||
      existing.data.balance_minor !== 0 ||
      existing.data.reserved_minor !== 0 ||
      existing.data.available_minor !== 0 ||
      existing.data.archived_at != null)) {
    hold('На сервере есть действующие финансовые записи. Автоматическое объединение запрещено');
  }
  active(signal);
  const selection = {kind: 'account', verifiedUserId: verifiedActorUserId};
  const consent = {
    savedEncryptedBackupOutsideThisBrowser: true, confirmedReadOnlyPreflight: true,
    externalEncryptedBackupVerified: true, confirmedTargetAccount: true,
    previewRequested: true, explicitGuestTransfer: false,
    // This only prepares a proposal; the SECOND explicit checkbox is still
    // required before HTTP stage/commit.
    confirmPreserveZeroAccount: existing !== null,
  };
  const target = {
    accountScope: 'account:' + verifiedActorUserId,
    profileId: session.profile_id, serverRevision: snapshot.revision,
    hasRemoteRecords: existing !== null,
    preserveZeroAccountId: existing?.id ?? null,
  };
  const preview = await planLiveLegacyImportPreviewCandidate({
    selection, backupText, backupPassword, consent, target, signal,
  });
  // Re-read actual browser IndexedDB and verify the saved encrypted file
  // against the source even after the SHA-256 preview has completed.
  const source = await verifyLiveLegacyBackup({
    selection, backupText, backupPassword, consent,
  });
  const payload = await prepareVerifiedLegacyImportTransportCandidate({
    verified: source, preview, signal,
  });
  active(signal);
  return Object.freeze({
    actor: verifiedActorUserId, origin, etag,
    profileId: session.profile_id, revision: snapshot.revision,
    snapshot: source.snapshot, preview, payload,
    preservedZeroAccountId: existing?.id ?? null,
    preservedZeroAccountName: existing?.data.name ?? null,
  });
}

/**
 * Must be called ONLY after an independent second confirm button.
 * The caller checks the currently active verified FH user and re-reads live
 * IndexedDB immediately before invoking this function. A network timeout
 * after stage or commit is UNKNOWN, never a reason to retry blindly.
 */
export async function executeConfirmedPersonalImportCandidate({
  prepared, verifiedActorUserId, currentLocalSnapshotMatches,
  explicitFinalConsent, explicitPreserveZeroAccountConsent = false,
  fetchImpl, signal,
}) {
  active(signal);
  if (!prepared || prepared.actor !== verifiedActorUserId ||
      explicitFinalConsent !== true || currentLocalSnapshotMatches !== true ||
      !USER.test(verifiedActorUserId) || !STRONG_ETAG.test(prepared.etag || '') ||
      !HASH.test(prepared.preview?.sourceSha256 || '') ||
      prepared.preview?.status !== 'PREVIEW_ONLY' ||
      (prepared.preservedZeroAccountId &&
       (explicitPreserveZeroAccountConsent !== true ||
        prepared.payload?.manifest?.preserve_zero_account_id !==
          prepared.preservedZeroAccountId ||
        prepared.payload?.manifest?.confirm_preserve_zero_account !== true)) ||
      typeof fetchImpl !== 'function') {
    hold('Перенос не подтверждён пользователем или исходная база изменилась');
  }
  const origin = safeOrigin(prepared.origin);
  const stageResponse = await request(fetchImpl, origin,
    '/api/finance/v1/import/manifest', 'POST',
    {manifest: prepared.payload.manifest}, signal, prepared.etag);
  const stage = await responseJson(stageResponse);
  if (![200, 202].includes(stageResponse.status) ||
      stage.status !== 'UNVERIFIED_MANIFEST_STAGED' ||
      stage.financial_write !== false || stage.record_count !== prepared.preview.recordCount ||
      !UUID.test(stage.batch_id)) {
    hold('Не совпала серверная подготовка переноса');
  }
  // No money was moved in stage. Commit now requires the SAME pinned
  // SHA-256/If-Match and is atomic on PostgreSQL, no automatic retry.
  const committedResponse = await request(fetchImpl, origin,
    '/api/finance/v1/import/commit', 'POST', prepared.payload,
    signal, prepared.etag);
  const committed = await responseJson(committedResponse);
  if (![200, 201].includes(committedResponse.status) ||
      committed.status !== 'COMMITTED' || committed.batch_id !== stage.batch_id ||
      committed.source_sha256 !== prepared.preview.sourceSha256 ||
      committed.record_count !== prepared.preview.recordCount ||
      committed.source_original_preserved !== true ||
      committed.cash_postings_created !== 0 ||
      !Number.isSafeInteger(committed.revision) ||
      committed.revision !== prepared.revision + 1) {
    hold('Результат финансового импорта не подтверждён; не повторяйте операцию');
  }
  // Explicit byte-exact server recovery proves imported source remains
  // retrievable under this FH owner, without writing local IndexedDB.
  const restoreResponse = await request(fetchImpl, origin,
    '/api/finance/v1/import/restore', 'POST', {
      batch_id: committed.batch_id,
      source_sha256: prepared.preview.sourceSha256,
      confirm_restore: true,
    }, signal);
  const restored = await bytes(restoreResponse, 8_000_000);
  if (restoreResponse.status !== 200 ||
      restored !== prepared.payload.source_canonical_json) {
    hold('Не удалось восстановить исходные байты с сервера. Не повторяйте импорт');
  }
  active(signal);
  return Object.freeze({
    status: 'COMMITTED_AND_SOURCE_RESTORED',
    revision: committed.revision, recordCount: committed.record_count,
    sourceSha256: committed.source_sha256,
    localDataPreserved: true, cashPostingsCreated: 0,
    ...(prepared.preservedZeroAccountId ? {serverZeroAccountPreserved: true} : {}),
  });
}
