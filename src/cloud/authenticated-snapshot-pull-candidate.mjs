/**
 * #68 - INACTIVE, read-only FH-session finance snapshot downloader.
 *
 * Downloads at most 25 cursor-linked pages from the SAME HTTPS origin, then
 * verifies every entity/revision/cursor before returning anything. It never
 * sends a finance command, opens IndexedDB, persists an ETag, starts a timer,
 * changes a Service Worker or enables the PWA sync feature.
 *
 * A separately approved caller may pass the verified pages into
 * initializeEncryptedCloudCacheCandidate() after unlocking the #34 keyset.
 */
import {verifyFinanceSnapshotPagesCandidate} from './verified-delta-candidate.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SCOPE = /^account:[a-f0-9]{32}$/;
const EPOCH = /^[a-f0-9]{32}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_PAGES = 25;
const MAX_PAGE_BYTES = 2_000_000;

function hold(reason) { throw new Error('SYNC_HOLD: ' + reason); }
function current(scope, session, identity) {
  if (!SCOPE.test(scope) || identity?.scope !== scope ||
      !UUID.test(identity?.profileId) || !EPOCH.test(identity?.epoch) ||
      !Number.isSafeInteger(identity?.generation) || identity.generation < 1 ||
      !identity?.signal || identity.signal.aborted ||
      session?.state !== 'unlocked' || session.selectedScope !== scope ||
      session.lifecycleVersion !== identity.generation ||
      !session.lifecycleSignal || session.lifecycleSignal.aborted) {
    hold('Финансовый аккаунт больше не разблокирован');
  }
}
function verifiedOrigin(origin) {
  if (typeof origin !== 'string') hold('Требуется подтверждённый адрес сервера');
  let u;
  try { u = new URL(origin); } catch { hold('Неверный финансовый адрес'); }
  if (u.origin !== origin || u.username || u.password ||
      u.pathname !== '/' || u.search || u.hash ||
      (u.protocol !== 'https:' &&
       !(u.protocol === 'http:' && u.hostname === '127.0.0.1'))) {
    hold('Требуется точный HTTPS origin финансового приложения');
  }
  if (globalThis.location?.origin && globalThis.location.origin !== origin) {
    hold('Данные другого сервера недоступны');
  }
  return origin;
}
async function boundedJson(response) {
  if (response?.redirected || !response?.headers?.get ||
      !response.body?.getReader ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        !== 'application/json') {
    hold('Сервер не подтвердил формат финансового снимка');
  }
  const announced = response.headers.get('content-length');
  if (announced != null && (!/^\d{1,10}$/.test(announced) ||
      Number(announced) > MAX_PAGE_BYTES)) hold('Снимок превышает лимит');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!ArrayBuffer.isView(result.value) ||
          result.value.byteLength !== result.value.length) {
        hold('Повреждена финансовая страница');
      }
      length += result.value.byteLength;
      if (length > MAX_PAGE_BYTES || chunks.length >= 8192) {
        hold('Финансовый снимок слишком большой');
      }
      chunks.push(result.value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(output));
  } catch {
    try { await reader.cancel(); } catch { /* Already closed */ }
    hold('Невозможно проверить серверный финансовый JSON');
  } finally {
    reader.releaseLock();
  }
}

/** Explicit owner-scoped pull: no automatic retry after any unknown outcome. */
export async function downloadVerifiedFinanceSnapshotCandidate({
  scope, session, identity, origin,
  explicitReadConsent = false, fetchImpl = globalThis.fetch,
}) {
  if (explicitReadConsent !== true) hold('Чтение облачного снимка выключено');
  current(scope, session, identity);
  const base = verifiedOrigin(origin);
  if (typeof fetchImpl !== 'function') hold('Финансовый HTTP-транспорт недоступен');

  const pages = [];
  let cursor = null;
  let etag = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    current(scope, session, identity);
    const url = new URL('/api/finance/v1/state', base);
    url.searchParams.set('limit_entities', '5000');
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store',
        referrerPolicy: 'same-origin',
        headers: {Accept:'application/json'},
        signal: session.lifecycleSignal,
      });
    } catch {
      hold('Финансовое состояние не подтверждено после ошибки сети');
    }
    current(scope, session, identity);
    if (response?.redirected || response?.status !== 200 && response?.status !== 206 ||
        (response.url && new URL(response.url).origin !== base)) {
      hold('Сервер отказал в полном финансовом снимке');
    }
    const receivedEtag = response.headers?.get?.('etag');
    if (!STRONG_ETAG.test(receivedEtag || '') ||
        (etag !== null && etag !== receivedEtag)) {
      hold('Сервер изменил ревизию между финансовыми страницами');
    }
    etag = receivedEtag;
    const body = await boundedJson(response);
    current(scope, session, identity);
    const next = body?.next_cursor;
    if (response.status === 206 && (typeof next !== 'string' || !next)) {
      hold('Неполный снимок без подтверждённого курсора');
    }
    if (response.status === 200 && next != null) {
      hold('Последняя страница объявлена неполной');
    }
    pages.push({cursorSent: cursor, body});
    if (next == null) {
      const verified = verifyFinanceSnapshotPagesCandidate(pages, identity);
      current(scope, session, identity);
      return Object.freeze({
        status:'VERIFIED_READ_ONLY', pages, etag,
        serverRevision: verified.revision,
        profileId: verified.profileId, entityCount: verified.entities.length,
        sentCommands:0, cacheModified:false, cloudFeatureEnabled:false,
      });
    }
    if (next === cursor) hold('Повторяющийся финансовый курсор');
    cursor = next;
  }
  hold('Слишком много страниц без полного снимка');
}
