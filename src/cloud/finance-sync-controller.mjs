/** Authenticated lifecycle for the encrypted finance cache and command queue.
 * A host must close this controller on logout/account switch and clear its UI.
 * No legacy or guest records are read, imported, overwritten or uploaded. */
import {LocalBudgetSession} from '../security/local-budget-session.ts';
import {createAtomicEncryptedCandidate, getAtomicEncryptedKeyset,
  readAtomicEncryptedCandidate, rotateAtomicEncryptedRecoveryKey} from '../security/protected-atomic-candidate.ts';
import {downloadVerifiedFinanceSnapshotCandidate} from './authenticated-snapshot-pull-candidate.mjs';
import {initializeEncryptedCloudCacheCandidate, refreshEncryptedCloudSnapshot} from './encrypted-cloud-cache-candidate.mjs';
import {enqueueEncryptedFinanceCommandCandidate, recordVerifiedFinanceCancellation,
  resolveStaleFinanceConflict} from './encrypted-command-outbox-candidate.mjs';
import {dispatchOneEncryptedFinanceCommandCandidate, downloadPendingFinanceJournalCandidate} from './finance-offline-dispatch-candidate.mjs';
import {rememberOfflineActor, readOfflineActor, forgetOfflineActor} from './offline-access-hint.mjs';

const USER = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EPOCH = /^[a-f0-9]{32}$/;
const LIMIT = 16_384;
function fail(message) { throw Error('SYNC_HOLD: ' + message); }

export class FinanceSyncController {
  #actor; #scope; #origin; #fetch; #session; #identity = null;
  #abort = new AbortController(); #generation = 0; #busy = false; #closed = false; #channel = null; #onClose;
  #cancelSupported = false; #budgetAllowed = false;
  #offlineStart = false; #onlineVerified = false;
  #connectivityGeneration = 0;

  /** @param {{verifiedActorUserId?: string, lastVerifiedActorUserId?: string,
   * origin?: string, fetchImpl?: typeof fetch, onClose?: () => void}} options */
  constructor({verifiedActorUserId, lastVerifiedActorUserId, origin = globalThis.location?.origin, fetchImpl = globalThis.fetch, onClose = () => {}}) {
    const offlineStart = lastVerifiedActorUserId !== undefined;
    const actor = offlineStart ? lastVerifiedActorUserId : verifiedActorUserId;
    if (!USER.test(actor || '') || (offlineStart && (verifiedActorUserId !== undefined ||
        readOfflineActor() !== actor)) ||
        typeof origin !== 'string' || typeof fetchImpl !== 'function' || typeof onClose !== 'function') {
      fail('Нет подтверждённого аккаунта');
    }
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
        (globalThis.location?.origin && globalThis.location.origin !== origin)) fail('Недопустимый сервер');
    this.#actor = actor;
    this.#offlineStart = offlineStart;
    this.#onClose = onClose;
    this.#scope = 'account:' + actor;
    this.#origin = origin;
    this.#fetch = fetchImpl.bind(globalThis);
    this.#session = new LocalBudgetSession();
    if (typeof globalThis.BroadcastChannel === 'function') {
      try {
        this.#channel = new BroadcastChannel('fh-auth-session-v2');
        this.#channel.onmessage = event => {
          if (event.data?.type === 'session-changed' ||
              (event.data?.type === 'logout' && event.data.userId === this.#actor)) this.close();
        };
      } catch { this.#channel = null; }
    }
  }

  #active(generation = this.#generation) {
    if (this.#closed || this.#abort.signal.aborted || generation !== this.#generation) {
      fail('Доступ к аккаунту отозван');
    }
  }
  async #exclusive(operation) {
    this.#active();
    if (this.#busy) throw Object.assign(Error('SYNC_HOLD: Дождитесь завершения синхронизации'),
      {code:'SYNC_BUSY'});
    this.#busy = true;
    const generation = this.#generation;
    try { const result = await operation(generation); this.#active(generation); return result; }
    finally { this.#busy = false; }
  }
  async #json(path, init, generation) {
    this.#active(generation);
    let response;
    try {
      response = await this.#fetch(this.#origin + path, {...init, credentials:'same-origin',
        mode:'same-origin', redirect:'error', cache:'no-store', referrerPolicy:'same-origin',
        signal:this.#abort.signal, headers:{Accept:'application/json', ...(init.headers || {})}});
    } catch {
      this.#active(generation);
      throw Object.assign(Error('SYNC_HOLD: Нет связи с сервером'), {code:'SYNC_NETWORK'});
    }
    this.#active(generation);
    if (response.status === 401 || response.status === 403) {
      forgetOfflineActor(this.#actor); this.close(); fail('Сессия больше не действует');
    }
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      throw Object.assign(Error('SYNC_HOLD: Сервер временно недоступен'), {code:'SYNC_NETWORK'});
    }
    if (!response.ok || response.redirected ||
        (response.url && new URL(response.url).origin !== this.#origin) ||
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
        !response.body?.getReader) fail('Сервер не подтвердил сессию');
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > LIMIT) {
          fail('Ответ сервера слишком велик');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      const body = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
      this.#active(generation);
      return body;
    } finally { reader.releaseLock(); }
  }
  async #assertActor(generation) {
    const me = await this.#json('/api/auth/email/me', {method:'GET'}, generation);
    if (me?.authenticated !== true || me.user?.id !== this.#actor) {
      forgetOfflineActor(this.#actor); this.close(); fail('Сменился аккаунт');
    }
  }
  async #bootstrap(generation) {
    await this.#assertActor(generation);
    const result = await this.#json('/api/auth/email/finance/session', {method:'POST',
      headers:{'Content-Type':'application/json'}, body:'{}'}, generation);
    if (result?.ok !== true || !UUID.test(result.profile_id || '') ||
        result.sync_profile_fence_v1 !== true || result.payment_guard_v1 !== true ||
        result.sync_allowed_v1 !== true) {
      fail('Сервер не поддерживает безопасную синхронизацию');
    }
    await this.#assertActor(generation);
    this.#cancelSupported = result.sync_cancel_fence_v1 === true;
    this.#budgetAllowed = result.budget_commands_v1 === true;
    return result.profile_id;
  }
  /** Explicitly create a separate empty encrypted container. The returned
   * recovery secret must be shown once; a passphrase can reissue it. */
  async createLocal(passphrase, explicitConsent = false) {
    return this.#exclusive(async generation => {
      if (this.#offlineStart) fail('Для создания копии нужен вход в аккаунт');
      if (explicitConsent !== true) fail('Создание локальной копии не подтверждено');
      await this.#bootstrap(generation);
      if (await getAtomicEncryptedKeyset(this.#scope)) fail('Зашифрованная копия уже существует');
      this.#active(generation);
      const epoch = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        x => x.toString(16).padStart(2, '0')).join('');
      const result = await createAtomicEncryptedCandidate(this.#scope, passphrase,
        {snapshot:{version:2, revision:0, syncEpoch:epoch}, outbox:[], conflicts:[]}, 2, this.#abort.signal);
      this.#active(generation);
      // A keyset may have committed during a cross-tab account change. Never
      // reveal its recovery secret until the FH actor is checked again.
      await this.#assertActor(generation);
      return {status:'RECOVERY_KEY', recoveryKey:result.recoveryKey};
    });
  }
  /** A fresh live FH session and server snapshot are mandatory on each open. */
  async unlock(credential) {
    return this.#exclusive(async generation => {
      if (this.#offlineStart) fail('Используйте локальную разблокировку');
      this.#onlineVerified = false;
      const connectivity = this.#connectivityGeneration;
      this.#identity = null;
      this.#session.logout();
      const profileId = await this.#bootstrap(generation);
      const keyset = await getAtomicEncryptedKeyset(this.#scope);
      this.#active(generation);
      if (!keyset) fail('Сначала создайте зашифрованную копию');
      this.#session.selectScope(this.#scope);
      await this.#session.unlock(keyset, credential);
      this.#active(generation);
      const bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
      this.#active(generation);
      const epoch = bundle?.snapshot?.cloudFinance?.epoch ?? bundle?.snapshot?.syncEpoch;
      if (!EPOCH.test(epoch || '')) { this.#session.logout(); fail('Копия не подготовлена для синхронизации'); }
      this.#identity = {scope:this.#scope, profileId, generation:this.#session.lifecycleVersion,
        epoch, signal:this.#session.lifecycleSignal};
      try {
        await this.#refresh(generation); await this.#assertActor(generation);
        if (connectivity !== this.#connectivityGeneration || globalThis.navigator?.onLine === false) {
          fail('Связь прервалась до подтверждения аккаунта');
        }
      }
      catch (error) { this.#identity = null; this.#session.logout(); throw error; }
      this.#onlineVerified = true;
      rememberOfflineActor(this.#actor);
      return this.#read(generation);
    });
  }
  /** Local-key access to a previously verified encrypted snapshot, without
   * claiming a currently valid server session. No network write is allowed. */
  async unlockOffline(credential) {
    return this.#exclusive(async generation => {
      if (!this.#offlineStart || readOfflineActor() !== this.#actor) fail('Локальный аккаунт больше недоступен');
      this.#identity = null; this.#onlineVerified = false; this.#session.logout();
      const keyset = await getAtomicEncryptedKeyset(this.#scope);
      this.#active(generation);
      if (!keyset) fail('Зашифрованная копия не найдена');
      this.#session.selectScope(this.#scope);
      try {
        await this.#session.unlock(keyset, credential);
        this.#active(generation);
        const bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
        this.#active(generation);
        const cloud = bundle?.snapshot?.cloudFinance;
        if (readOfflineActor() !== this.#actor ||
            bundle?.schemaVersion !== 2 || bundle?.snapshot?.version !== 2 ||
            cloud?.schemaVersion !== 1 || cloud.scope !== this.#scope ||
            !UUID.test(cloud.profileId || '') || !EPOCH.test(cloud.epoch || '') ||
            !Number.isSafeInteger(cloud.revision) || cloud.revision < 0 || !Array.isArray(cloud.entities)) {
          fail('Локальная копия не соответствует последнему подтверждённому аккаунту');
        }
        this.#identity = {scope:this.#scope, profileId:cloud.profileId,
          generation:this.#session.lifecycleVersion, epoch:cloud.epoch,
          signal:this.#session.lifecycleSignal};
        return await this.#read(generation);
      } catch (error) { this.#identity = null; this.#session.logout(); throw error; }
    });
  }
  async #read(generation) {
    if (!this.#identity) fail('Локальная копия заблокирована');
    const bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
    this.#active(generation);
    const cloud = bundle?.snapshot?.cloudFinance;
    if (!cloud || cloud.scope !== this.#scope || cloud.profileId !== this.#identity.profileId ||
        cloud.epoch !== this.#identity.epoch) fail('Профиль копии не совпадает');
    return {status:bundle.conflicts.some(x => x?.kind === 'finance_sync_hold') ? 'CONFLICT' :
      bundle.outbox.length ? 'PENDING' : this.#onlineVerified ? 'SYNCHRONIZED' : 'LOCAL',
      cloud:structuredClone(cloud), outbox:structuredClone(bundle.outbox),
      conflicts:structuredClone(bundle.conflicts), bundleEpoch:bundle.epoch,
      canCancel:this.#cancelSupported, canBudget:this.#budgetAllowed, onlineVerified:this.#onlineVerified};
  }
  async read() { return this.#exclusive(generation => this.#read(generation)); }
  async reissueRecovery(passphrase) { return this.#exclusive(async generation => {
    if (!this.#identity) fail('Локальная копия заблокирована');
    await this.#assertActor(generation);
    const result = await rotateAtomicEncryptedRecoveryKey(this.#scope, this.#session, passphrase);
    this.#active(generation);
    await this.#assertActor(generation);
    return {recoveryKey:result.recoveryKey};
  }); }
  async #refresh(generation) {
    const identity = this.#identity;
    if (!identity) fail('Локальная копия заблокирована');
    const transport = async (...args) => {
      const response = await this.#fetch(...args);
      if (response.status === 401 || response.status === 403) {forgetOfflineActor(this.#actor); this.close();}
      return response;
    };
    const pulled = await downloadVerifiedFinanceSnapshotCandidate({scope:this.#scope,
      session:this.#session, identity, origin:this.#origin, fetchImpl:transport, explicitReadConsent:true});
    this.#active(generation);
    const bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
    this.#active(generation);
    const cloud = bundle?.snapshot?.cloudFinance, head = bundle?.outbox?.[0];
    const proofBase = head?.command?.base_revision === cloud?.revision && head?.ifMatch === cloud?.serverEtag
      ? cloud : head?.recoveryBase;
    let pendingJournalPage = null;
    if (head && !head.recoveryJournal && head.status === 'pending' &&
        proofBase && head.command?.base_revision === proofBase.revision && head.ifMatch === proofBase.serverEtag &&
        (proofBase === cloud || proofBase.fingerprint === head.fingerprint) &&
        Number.isSafeInteger(pulled.pages?.[0]?.body?.revision) &&
        pulled.pages[0].body.revision > proofBase.revision) {
      pendingJournalPage = await downloadPendingFinanceJournalCandidate({scope:this.#scope,
        session:this.#session, identity, origin:this.#origin, sinceRevision:proofBase.revision, fetchImpl:transport});
      this.#active(generation);
    }
    const input = {scope:this.#scope, session:this.#session, identity,
      pages:pulled.pages, etag:pulled.etag, expectedEpoch:bundle.epoch, pendingJournalPage};
    if (!Object.hasOwn(bundle.snapshot, 'cloudFinance')) {
      await initializeEncryptedCloudCacheCandidate({...input, confirmedAccountCacheInitialization:true});
    } else await refreshEncryptedCloudSnapshot(input);
    this.#active(generation);
  }
  async #revalidateOnline(generation) {
    if (this.#onlineVerified) return;
    if (!this.#identity || globalThis.navigator?.onLine === false) fail('Нет связи с сервером');
    const connectivity = this.#connectivityGeneration;
    const profile = await this.#bootstrap(generation);
    if (profile !== this.#identity.profileId) {
      forgetOfflineActor(this.#actor); this.close(); fail('Сменился финансовый профиль');
    }
    await this.#refresh(generation);
    await this.#assertActor(generation);
    if (connectivity !== this.#connectivityGeneration || globalThis.navigator?.onLine === false) {
      fail('Связь прервалась до подтверждения аккаунта');
    }
    this.#onlineVerified = true;
    rememberOfflineActor(this.#actor);
  }
  markOffline() { this.#connectivityGeneration++; this.#onlineVerified = false; this.#cancelSupported = false; }
  async refresh() { return this.#exclusive(async generation => {
    if (this.#onlineVerified) await this.#refresh(generation);
    else await this.#revalidateOnline(generation);
    return this.#read(generation);
  }); }
  async enqueue(command) { return this.#exclusive(async generation => {
    if (!this.#identity) fail('Локальная копия заблокирована');
    if (typeof command?.action === 'string' && command.action.startsWith('budget.') && !this.#budgetAllowed)
      fail('Доступ к бюджетам не подтверждён');
    const bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
    this.#active(generation);
    const etag = bundle?.snapshot?.cloudFinance?.serverEtag;
    if (typeof etag !== 'string') fail('Нужен обновлённый серверный снимок');
    const result = await enqueueEncryptedFinanceCommandCandidate({scope:this.#scope,
      session:this.#session, identity:this.#identity, expectedEpoch:bundle.epoch, command, ifMatch:etag});
    this.#active(generation);
    return result;
  }); }
  async dispatchOnce() { return this.#exclusive(async generation => {
    if (!this.#identity) fail('Локальная копия заблокирована');
    await this.#revalidateOnline(generation);
    await this.#assertActor(generation);
    const bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
    this.#active(generation);
    const result = await dispatchOneEncryptedFinanceCommandCandidate({scope:this.#scope,
      session:this.#session, identity:this.#identity, expectedEpoch:bundle.epoch,
      origin:this.#origin, fetchImpl:this.#fetch, explicitNetworkCandidateConsent:true});
    this.#active(generation);
    if (result.status === 'AUTH_HOLD') {forgetOfflineActor(this.#actor); this.close(); fail('Сессия больше не действует');}
    return result;
  }); }
  async resolve(input) { return this.#exclusive(async generation => {
    if (!this.#identity) fail('Локальная копия заблокирована');
    if (input?.explicitUserChoice !== true) fail('Решение конфликта не подтверждено');
    let bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
    this.#active(generation);
    const conflict = bundle.conflicts.find(x => x?.kind === 'finance_sync_hold' && x.mutationId === input.mutationId);
    if (conflict && [409, 410].includes(conflict.httpStatus)) {
      const head = bundle.outbox[0];
      if (!this.#cancelSupported || !head || head.mutationId !== input.mutationId ||
          ![1, 2].includes(head.command?.schema_version)) fail('Сервер не поддерживает безопасную отмену');
      await this.#assertActor(generation);
      const ack = await this.#json('/api/finance/v' + head.command.schema_version + '/commands/cancel',
        {method:'POST', headers:{'Content-Type':'application/json',
          'X-FH-Expected-Profile':this.#identity.profileId,
          'If-Match':head.ifMatch, 'Idempotency-Key':head.mutationId},
          body:JSON.stringify(head.command)}, generation);
      await recordVerifiedFinanceCancellation({scope:this.#scope, session:this.#session,
        identity:this.#identity, expectedEpoch:bundle.epoch, mutationId:head.mutationId,
        cancellationAck:ack});
      this.#active(generation);
      bundle = await readAtomicEncryptedCandidate(this.#scope, this.#session);
      this.#active(generation);
    }
    return resolveStaleFinanceConflict({...input, scope:this.#scope, session:this.#session,
      identity:this.#identity, expectedEpoch:bundle.epoch});
  }); }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.#generation++; this.#abort.abort();
    this.#session.logout(); this.#identity = null;
    this.#cancelSupported = false;
    this.#channel?.close(); this.#channel = null;
    this.#onClose();
  }
}
