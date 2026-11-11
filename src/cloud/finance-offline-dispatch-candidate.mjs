/**
 * #68 - INACTIVE explicit one-command sync candidate.
 *
 * No automatic timers, Service Worker interception, background uploads or
 * PWA entrypoint import. Each invocation sends at most ONE persisted command
 * to the strictly same-origin, authenticated FH v2 candidate. On uncertain
 * outcomes it leaves the encrypted outbox unchanged for safe idempotent retry.
 */
import {readAtomicEncryptedCandidate} from '../security/protected-atomic-candidate.ts';
import {
  persistAuthenticatedFinanceReceiptCandidate,
  classifyFinanceOutboxResponseCandidate,
  recordEncryptedFinanceRetryCandidate,
} from './encrypted-command-outbox-candidate.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPE = /^account:[0-9a-f]{32}$/;
const EPOCH = /^[0-9a-f]{32}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const LIMIT = 512 * 1024;
function hold(message) { throw new Error('SYNC_HOLD: ' + message); }
function safeRevision(x) { return Number.isSafeInteger(x) && x >= 0; }
function active(scope, session, identity) {
  if (!SCOPE.test(scope) || identity?.scope !== scope ||
      !UUID.test(identity?.profileId) || !EPOCH.test(identity?.epoch) ||
      !Number.isSafeInteger(identity?.generation) ||
      identity.generation < 1 ||
      session?.state !== 'unlocked' || session.selectedScope !== scope ||
      session.lifecycleVersion !== identity.generation ||
      session.lifecycleSignal?.aborted || identity.signal?.aborted) {
    hold('Финансовая сессия истекла');
  }
}
function authority(origin) {
  if (typeof origin !== 'string') hold('Нет подтверждённого HTTPS origin');
  let host;
  try { host = new URL(origin); }
  catch { hold('Неверный адрес финансового сервера'); }
  if (host.protocol !== 'https:' || host.origin !== origin ||
      host.username || host.password || host.pathname !== '/' ||
      host.search || host.hash) {
    hold('Требуется точный HTTPS origin без учётных данных');
  }
  // Browser users must be same-origin; a supplied URL must never become an
  // open relay to exfiltrate encrypted or plaintext financial commands.
  if (globalThis.location?.origin && globalThis.location.origin !== origin) {
    hold('Запрещена отправка команд на чужой сервер');
  }
  return origin;
}
async function jsonResponse(response) {
  if (response?.redirected || !response?.headers?.get ||
      response.headers.get('content-type')?.split(';')[0]?.trim()?.toLowerCase()
        !== 'application/json' ||
      !response.body?.getReader) {
    hold('Некорректный финансовый ответ');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]{1,10}$/.test(length) ||
      Number(length) > LIMIT)) hold('Ответ слишком большой');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) hold('Неверный формат ответа');
      size += part.value.byteLength;
      if (size > LIMIT) hold('Ответ слишком большой');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let i = 0;
    for (const chunk of chunks) {bytes.set(chunk, i); i += chunk.byteLength;}
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return JSON.parse(raw);
  } finally { reader.releaseLock(); }
}
function control(action, delay = null, bundleEpoch = null) {
  return Object.freeze({status: action, retryDelayMs: delay,
    bundleEpoch, sentByThisCall: true, queuePreserved: true,
    serverCommitNotYetReconciled: true});
}
async function retryAfterTransientFailure({
  scope, session, identity, expectedEpoch, item, httpStatus,
}) {
  const policy = classifyFinanceOutboxResponseCandidate(
    httpStatus, item.attempts,
  );
  if (policy.decision !== 'RETRY_SAME_UUID') {
    return control(policy.decision, policy.retryDelayMs);
  }
  // Retry count persists in the SAME encrypted account outbox. No
  // unbounded loop, timer or automatic network request is scheduled.
  const saved = await recordEncryptedFinanceRetryCandidate({
    scope, session, identity, expectedEpoch, mutationId: item.mutationId,
  });
  return control(policy.decision, policy.retryDelayMs, saved.bundleEpoch);
}

/**
 * Opt-in one-shot dispatcher. The selected first mutation ID, body and original
 * strong ETag are reused verbatim on network retry. Both HTTP responses are
 * parsed with bounded memory; no amount, key or identity is logged.
 *
 * A POST 200/201 is *not* a local success. Only an independently downloaded
 * /changes event matching the complete receipt may trigger the encrypted CAS
 * in persistAuthenticatedFinanceReceiptCandidate.
 */
export async function dispatchOneEncryptedFinanceCommandCandidate({
  scope, session, identity, expectedEpoch, origin,
  explicitNetworkCandidateConsent = false,
  fetchImpl = globalThis.fetch,
}) {
  if (explicitNetworkCandidateConsent !== true) {
    hold('Сетевые финансовые команды ещё выключены');
  }
  active(scope, session, identity);
  const server = authority(origin);
  if (typeof fetchImpl !== 'function' || !safeRevision(expectedEpoch)) {
    hold('Недоступен проверенный финансовый транспорт');
  }
  const bundle = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  if (!bundle || bundle.epoch !== expectedEpoch ||
      bundle.schemaVersion !== 2 || bundle.snapshot?.version !== 2 ||
      !Array.isArray(bundle.outbox)) hold('Зашифрованная очередь недоступна');
  const cloud = bundle.snapshot.cloudFinance;
  if (!cloud || cloud.scope !== scope ||
      cloud.profileId !== identity.profileId ||
      cloud.epoch !== identity.epoch ||
      !safeRevision(cloud.revision)) {
    hold('Финансовый профиль не совпадает');
  }
  const item = bundle.outbox[0];
  if (!item) return Object.freeze({
    status: 'EMPTY_OUTBOX', pending: 0, sentByThisCall: false,
    serverCommitNotYetReconciled: false,
  });
  if (item.scope !== scope || item.profileId !== identity.profileId ||
      item.epoch !== identity.epoch || item.status !== 'pending' ||
      !UUID.test(item.mutationId) ||
      !STRONG_ETAG.test(item.ifMatch) ||
      item.command?.schema_version !== 2 ||
      item.command.client_mutation_id !== item.mutationId ||
      !safeRevision(item.command.base_revision)) {
    hold('Повреждена ожидающая финансовая операция');
  }
  // A committed operation may be replayed safely even if the server has
  // since advanced; do not rewrite its persisted ETag/baseRevision.
  const postOptions = {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin',
    redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': item.ifMatch,
      'Idempotency-Key': item.mutationId,
    },
    body: JSON.stringify(item.command),
    signal: session.lifecycleSignal,
  };
  let posted;
  try {
    posted = await fetchImpl(server + '/api/finance/v2/commands', postOptions);
    active(scope, session, identity);
  } catch {
    if (session.lifecycleSignal.aborted || identity.signal?.aborted) {
      return control('AUTH_HOLD');
    }
    return retryAfterTransientFailure({
      scope, session, identity, expectedEpoch, item, httpStatus: null,
    });
  }
  if (posted.status !== 200 && posted.status !== 201) {
    return retryAfterTransientFailure({
      scope, session, identity, expectedEpoch, item,
      httpStatus: posted.status,
    });
  }
  let receipt;
  try { receipt = await jsonResponse(posted); }
  catch { return control('RECOVERY_HOLD'); }
  active(scope, session, identity);
  // A previous sync may have applied the committed server revision before
  // the ACK was durably recorded. Ask the server for exactly that historical
  // revision, not the already-advanced local cursor. The independent ACK
  // reconciliation still validates the complete receipt and delta.
  const committedRevision = Number.isSafeInteger(receipt?.revision) &&
    receipt.revision >= 1 ? receipt.revision : null;
  const sinceRevision = committedRevision !== null &&
    committedRevision <= cloud.revision
    ? committedRevision - 1 : cloud.revision;
  let deltaResponse;
  try {
    deltaResponse = await fetchImpl(
      server + '/api/finance/v1/changes?since_revision=' +
      sinceRevision + '&limit_revisions=1',
      {method: 'GET', credentials: 'same-origin', mode: 'same-origin',
       redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
       headers: {'Accept': 'application/json'},
       signal: session.lifecycleSignal},
    );
    active(scope, session, identity);
  } catch {
    return control(session.lifecycleSignal.aborted ? 'AUTH_HOLD' : 'RECOVERY_HOLD');
  }
  if (deltaResponse.status !== 200) {
    return control(deltaResponse.status === 410
      ? 'SNAPSHOT_REQUIRED_HOLD' : 'RECOVERY_HOLD');
  }
  let deltaPage;
  try { deltaPage = await jsonResponse(deltaResponse); }
  catch { return control('RECOVERY_HOLD'); }
  active(scope, session, identity);
  // This either commits a complete validated server delta and receipt in one
  // IDB transaction or throws with the previous outbox still encrypted.
  const reconciled = await persistAuthenticatedFinanceReceiptCandidate({
    scope, session, identity, expectedEpoch, receipt, deltaPage,
    commandHttpStatus: posted.status, deltaHttpStatus: deltaResponse.status,
  });
  return Object.freeze({...reconciled, sentByThisCall: true});
}
