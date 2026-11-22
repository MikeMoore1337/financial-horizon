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
import {compareLegacyWithServer} from './legacy-merge-comparison.mjs';
import {compareGuestBankHistory} from './legacy-bank-merge-comparison.mjs';
import {sameFinancialJSON} from '../security/protected-staging.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const USER = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const COUNT_KINDS = ['entries','loans','settlements','loanPayments'];

function matchingCounts(actual, expected) {
  return actual && expected && typeof actual === 'object' && !Array.isArray(actual) &&
    Object.keys(actual).length === COUNT_KINDS.length && COUNT_KINDS.every(kind =>
      Number.isSafeInteger(actual[kind]) && actual[kind] >= 0 && actual[kind] === expected[kind]);
}

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
  origin, signal, explicitConsent = false, sourceKind = 'account', explicitGuestTransfer = false,
}) {
  active(signal); safeOrigin(origin);
  if (!USER.test(verifiedActorUserId) ||
      explicitConsent !== true ||
      typeof backupText !== 'string' || backupText.length < 100 ||
      backupText.length > 8_000_000 || typeof backupPassword !== 'string' ||
      backupPassword.length < 12 || typeof fetchImpl !== 'function' ||
      !['account','guest'].includes(sourceKind) || explicitGuestTransfer !== (sourceKind === 'guest')) {
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
      snapshot.entities.length > 5000 || snapshot.next_cursor != null) {
    hold('Сервер содержит записи или вернул неполный финансовый снимок');
  }
  // The only compatible nonempty target is a single untouched 0-RUB account.
  // Its UUID/revision and absence of all other server facts are rechecked by
  // PostgreSQL under profile lock at both stage and commit. Never delete it.
  const existing = snapshot.entities.length === 1 ? snapshot.entities[0] : null;
  const compatible = existing && !(existing.kind !== 'account' || !UUID.test(existing.id) ||
      existing.entity_revision !== 1 ||
      typeof existing.data?.name !== 'string' ||
      existing.data.name.length < 1 || existing.data.name.length > 160 ||
      existing.data.currency !== 'RUB' ||
      existing.data.opening_minor !== 0 ||
      existing.data.balance_minor !== 0 ||
      existing.data.reserved_minor !== 0 ||
      existing.data.available_minor !== 0 ||
      existing.data.archived_at != null);
  const needsComparison = snapshot.entities.length > 0 && !compatible;
  const seen = new Set();
  if (needsComparison) {
    // A bank batch can increment an account multiple times in one profile revision.
    for (const entity of snapshot.entities) {
      if (!entity ||
          !['account', 'obligation', 'loan', 'reserve', 'transaction', 'settlement', 'loan_payment'].includes(entity.kind) ||
          typeof entity.id !== 'string' || !UUID.test(entity.id) || seen.has(entity.id) ||
          !Number.isSafeInteger(entity.entity_revision) || entity.entity_revision < 1 ||
          !entity.data || typeof entity.data !== 'object' || Array.isArray(entity.data)) {
        hold('Повреждён серверный финансовый снимок');
      }
      if (entity.kind === 'loan' && entity.data.imported_schedule !== null &&
          (!Array.isArray(entity.data.imported_schedule) || entity.data.imported_schedule.some(row =>
            !row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(field =>
              !['date','amountCents','balanceCents','interestCents','principalCents'].includes(field))))) {
        hold('Серверный кредитный график нельзя полностью показать для проверки');
      }
      seen.add(entity.id);
    }
    const accounts = new Set(snapshot.entities.filter(entity => entity.kind === 'account').map(entity => entity.id));
    for (const entity of snapshot.entities.filter(entity => entity.kind === 'transaction')) {
      if (!Array.isArray(entity.data.postings) || entity.data.postings.length === 0 ||
          entity.data.postings.some(posting => !posting || !accounts.has(posting.account_id) ||
            !Number.isSafeInteger(posting.signed_minor))) {
        hold('Нельзя полностью показать проводки серверной операции');
      }
    }
  }
  active(signal);
  const selection = sourceKind === 'guest' ? {kind:'guest',guestNamespace:'local-guest-v1'} :
    {kind:'account',verifiedUserId:verifiedActorUserId};
  const consent = {
    savedEncryptedBackupOutsideThisBrowser: true, confirmedReadOnlyPreflight: true,
    externalEncryptedBackupVerified: true, confirmedTargetAccount: true,
    previewRequested: true, explicitGuestTransfer,
    // This only prepares a proposal; the SECOND explicit checkbox is still
    // required before HTTP stage/commit.
    confirmPreserveZeroAccount: Boolean(compatible),
  };
  const target = {
    accountScope: 'account:' + verifiedActorUserId,
    profileId: session.profile_id, serverRevision: snapshot.revision,
    hasRemoteRecords: snapshot.entities.length > 0,
    preserveZeroAccountId: compatible ? existing.id : null,
  };
  const bankSource = await verifyLiveLegacyBackup({selection,backupText,backupPassword,consent});
  const ledger=bankSource.snapshot.bankStatements;
  if (ledger && (ledger.accounts.length || ledger.operations.length || ledger.batches.length)) {
    const historyResponse=await request(fetchImpl,origin,'/api/finance/v1/import/bank/rows','GET',null,signal);
    const bankHistory=await responseJson(historyResponse);
    const bankComparison=compareGuestBankHistory({ledger,sourceRevision:bankSource.sourceRevision,snapshot,bankHistory,
      snapshotEtag:etag,bankEtag:historyResponse.headers.get('etag')});
    const again=await verifyLiveLegacyBackup({selection,backupText,backupPassword,consent});
    if (bankSource.sourceKey!==again.sourceKey || bankSource.guestClaim!==again.guestClaim ||
        !sameFinancialJSON(bankSource.snapshot,again.snapshot)) hold('Исходная банковская история изменилась');
    active(signal);
    const preview=await planLiveLegacyImportPreviewCandidate({selection,backupText,backupPassword,consent,
      target:{...target,hasRemoteRecords:true,preserveZeroAccountId:null},signal,allowBank:true});
    const checked=await verifyLiveLegacyBackup({selection,backupText,backupPassword,consent});
    if (bankSource.sourceKey!==checked.sourceKey || bankSource.guestClaim!==checked.guestClaim ||
        !sameFinancialJSON(bankSource.snapshot,checked.snapshot)) hold('Исходная банковская история изменилась');
    return Object.freeze({actor:verifiedActorUserId,origin,etag,profileId:session.profile_id,
      revision:snapshot.revision,snapshot:checked.snapshot,serverEntities:snapshot.entities,
      bankHistory,bankComparison,preview,
      ...(sourceKind==='guest'?{guestSource:Object.freeze({sourceKey:checked.sourceKey,claim:checked.guestClaim})}:{}),
      comparison:compareLegacyWithServer(checked.snapshot,snapshot.entities)});
  }
  const preview = await planLiveLegacyImportPreviewCandidate({
    selection, backupText, backupPassword, consent, target, signal,
  });
  // Re-read actual browser IndexedDB and verify the saved encrypted file
  // against the source even after the SHA-256 preview has completed.
  const source = await verifyLiveLegacyBackup({
    selection, backupText, backupPassword, consent,
  });
  if (preview.sourceKey !== source.sourceKey || preview.guestClaim !== source.guestClaim)
    hold('Исходный профиль изменился во время проверки');
  const guestSource=sourceKind === 'guest' ?
    Object.freeze({sourceKey:source.sourceKey,claim:source.guestClaim}) : null;
  if (needsComparison) {
    active(signal);
    const serverCounts = Object.fromEntries(
      ['account', 'obligation', 'loan', 'reserve', 'transaction', 'settlement', 'loan_payment']
        .map(kind => [kind, snapshot.entities.filter(entity => entity.kind === kind).length]),
    );
    return Object.freeze({actor: verifiedActorUserId, origin, etag,
      profileId: session.profile_id, revision: snapshot.revision,
      snapshot: source.snapshot, preview, serverCounts,guestSource,
      comparison: compareLegacyWithServer(source.snapshot, snapshot.entities),
      serverEntities: snapshot.entities});
  }
  const payload = await prepareVerifiedLegacyImportTransportCandidate({
    verified: source, preview, signal,confirmedGuestTransfer:sourceKind === 'guest',
    confirmedTargetScope:sourceKind === 'guest' ? target.accountScope : null,
  });
  active(signal);
  return Object.freeze({
    actor: verifiedActorUserId, origin, etag,
    profileId: session.profile_id, revision: snapshot.revision,
    snapshot: source.snapshot, preview, payload,guestSource,
    preservedZeroAccountId: existing?.id ?? null,
    preservedZeroAccountName: existing?.data.name ?? null,
  });
}

/** Build a local review artifact; this does not send or authorize any write. */
export async function preparePersonalMergeReviewCandidate({
  prepared, verifiedActorUserId, currentLocalSnapshotMatches, decisions, bankDecisions = null, signal,
}) {
  active(signal);
  if (!prepared || prepared.actor !== verifiedActorUserId || !USER.test(verifiedActorUserId) ||
      currentLocalSnapshotMatches !== true || prepared.preview?.status !== 'NEEDS_CONFLICT_DECISION' ||
      prepared.comparison?.status !== 'NEEDS_OWNER_DECISIONS' ||
      !STRONG_ETAG.test(prepared.etag || '') || !Array.isArray(decisions)) {
    hold('Нужны неизменённый источник и решения для всех записей');
  }
  const payload = await prepareVerifiedLegacyImportTransportCandidate({
    verified: {scope:prepared.preview.sourceScope,sourceKey:prepared.preview.sourceKey,
      ...(prepared.guestSource ? {guestClaim:prepared.guestSource.claim} : {}),
      sourceRevision:prepared.preview.sourceRevision,snapshot:prepared.snapshot,backupVersion:1},
    preview:prepared.preview, signal, mergeDecisions:decisions,
    comparison:prepared.comparison,confirmedGuestTransfer:Boolean(prepared.guestSource),
    confirmedTargetScope:prepared.guestSource ? 'account:'+verifiedActorUserId : null,
    bankDecisions,bankComparison:prepared.bankComparison??null,
    bankServerEntities:prepared.bankComparison ? prepared.serverEntities : null,
    bankHistory:prepared.bankComparison ? prepared.bankHistory : null,
  });
  active(signal);
  const counts = {};
  for (const action of ['add', 'link']) {
    counts[action] = Object.fromEntries(COUNT_KINDS
      .map(kind => [kind, payload.manifest.rows.filter(row =>
        row.record_type === kind && row.decision === action).length]));
  }
  let bankCounts=null;
  if (prepared.preview.bankTransfer) {
    const accounts=payload.manifest.bank_accounts,operations=payload.manifest.bank_operations;
    const source=new Map(prepared.snapshot.bankStatements.operations.map(x=>[x.sourceKey,x]));
    const batches=new Map(prepared.snapshot.bankStatements.batches.map(x=>[x.batchKey,x]));
    let postings=0,cancelled=false,cancelledOperations=0;
    for (const choice of operations.filter(x=>x.decision==='add')) {
      const row=source.get(choice.source_key),isCancelled=batches.get(row.batchKey).cancelledStateRevision!==null;
      postings+=(row.kind==='transfer'?2:1)*(isCancelled?2:1);
      cancelled ||= isCancelled;
      if(isCancelled)cancelledOperations++;
    }
    bankCounts={accountsAdded:accounts.filter(x=>x.decision==='add').length,
      accountsLinked:accounts.filter(x=>x.decision==='link').length,
      operationsAdded:operations.filter(x=>x.decision==='add').length,
      operationsLinked:operations.filter(x=>x.decision==='link').length,
      postings,reversalTransactions:cancelledOperations,revisionIncrement:cancelled?2:1};
    const addedPlanner=Object.values(counts.add).reduce((a,b)=>a+b,0);
    if (prepared.serverEntities.length+addedPlanner+bankCounts.accountsAdded+
        bankCounts.operationsAdded+cancelledOperations>5000 ||
        prepared.bankHistory.rows.length+bankCounts.operationsAdded>5000)
      hold('После переноса полный снимок превысит предел безопасной проверки');
  }
  return Object.freeze({...prepared, payload, mergeCounts:counts,bankCounts,
    preview:Object.freeze({...prepared.preview, status:'MERGE_PREVIEW_ONLY'})});
}

// Verify the actual server projection, not only the receipt and recovered source.
// Bank-specific postings/balances have an additional independent verification.
function plannerProjection(kind,row,targets) {
  const utc=value=>{
    if(value==null)return null;
    const time=Date.parse(value);
    if(!Number.isFinite(time))hold('Невозможно проверить дату перенесённой записи');
    return new Date(time).toISOString();
  };
  if(kind==='entries')return {
    title:row.title,direction:row.kind,amount_minor:row.amountCents,starts_on:row.date,
    timezone:'UTC',recurrence_unit:{once:'none',monthly:'month',yearly:'year'}[row.recurrence],
    recurrence_every:1,category:row.category??null,deleted_at:utc(row.deletedAt),
  };
  if(kind==='loans')return {
    title:row.title,opening_minor:row.openingCents,payment_minor:row.paymentCents,
    apr_basis_points:Math.round(row.apr*100),term_months:row.termMonths,
    due_day:row.dueDay,as_of_date:row.asOfDate,calculation_version:1,
    imported_schedule:row.schedule??null,deleted_at:utc(row.deletedAt),
  };
  if(kind==='settlements')return {
    obligation_id:targets.get(JSON.stringify(['entries',row.entryId])),
    occurrence_on:row.occurrence+'-01',paid_on:row.date,
    amount_minor:row.amountCents,voided_at:utc(row.voidedAt),
  };
  return {
    loan_id:targets.get(JSON.stringify(['loans',row.loanId])),
    paid_on:row.date,amount_minor:row.amountCents,
    strategy:row.strategy,voided_at:utc(row.voidedAt),
  };
}

async function verifyCommittedPlannerMerge(prepared,committed,fetchImpl,origin,signal){
  const response=await request(fetchImpl,origin,'/api/finance/v1/state?limit_entities=5000','GET',null,signal);
  const state=await responseJson(response,10_000_000);
  if(response.status!==200||!STRONG_ETAG.test(response.headers.get('etag')||'')||
     state?.schema_version!==1||state.profile_id!==prepared.profileId||
     state.currency!=='RUB'||state.revision!==committed.revision||
     !Array.isArray(state.entities)||state.next_cursor!=null||
     !Array.isArray(prepared.serverEntities))
    hold('Невозможно проверить полный серверный снимок после объединения');

  const before=new Map(prepared.serverEntities.map(entity=>[entity.id,entity]));
  const after=new Map(state.entities.map(entity=>[entity.id,entity]));
  if(before.size!==prepared.serverEntities.length||after.size!==state.entities.length)
    hold('Обнаружены повторяющиеся идентификаторы серверных записей');
  const bank=prepared.bankCounts;
  const plannerAdded=COUNT_KINDS.reduce((sum,kind)=>sum+prepared.mergeCounts.add[kind],0);
  const extra=bank?bank.accountsAdded+bank.operationsAdded+bank.reversalTransactions:0;
  if(state.entities.length!==before.size+plannerAdded+extra)
    hold('Количество серверных записей после объединения не совпало с планом');
  const serverKind={entries:'obligation',loans:'loan',settlements:'settlement',loanPayments:'loan_payment'};
  const allowedKinds=new Set(Object.values(serverKind));
  for(const [id,prior] of before){
    const current=after.get(id);
    if(!current||(allowedKinds.has(prior.kind)&&!sameFinancialJSON(prior,current)))
      hold('Существующая серверная финансовая запись изменилась');
  }
  const available=new Map(state.entities.filter(entity=>
    !before.has(entity.id)&&allowedKinds.has(entity.kind)).map(entity=>[entity.id,entity]));
  if(available.size!==plannerAdded)hold('Список новых финансовых записей неполон');
  const choices=new Map(prepared.payload.manifest.rows.map(choice=>
    [JSON.stringify([choice.record_type,choice.source_record_id]),choice]));
  if(choices.size!==prepared.preview.recordCount)
    hold('Повторяются решения по исходным финансовым записям');
  const targets=new Map();
  for(const kind of COUNT_KINDS){
    if(!Array.isArray(prepared.snapshot[kind]))hold('Исходный список неполон');
    for(const row of prepared.snapshot[kind]){
      const key=JSON.stringify([kind,row.id]),choice=choices.get(key);
      if(!choice||!['add','link'].includes(choice.decision))
        hold('Решение по исходной записи отсутствует');
      const expected=plannerProjection(kind,row,targets);
      const same=entity=>{
        if(entity?.kind!==serverKind[kind]||!entity.data)return false;
        const actual={...entity.data};
        if(Object.hasOwn(actual,'deleted_at')&&actual.deleted_at!=null){
          const date=Date.parse(actual.deleted_at);
          if(!Number.isFinite(date))return false;
          actual.deleted_at=new Date(date).toISOString();
        }
        if(Object.hasOwn(actual,'voided_at')&&actual.voided_at!=null){
          const date=Date.parse(actual.voided_at);
          if(!Number.isFinite(date))return false;
          actual.voided_at=new Date(date).toISOString();
        }
        return sameFinancialJSON(expected,actual);
      };
      let match;
      if(choice.decision==='link'){
        match=before.get(choice.target_id);
        if(!match||!same(match)||!same(after.get(choice.target_id)))
          hold('Связанная серверная запись не соответствует источнику');
      }else{
        const matches=[...available.values()].filter(entity=>entity.entity_revision===1&&same(entity));
        if(matches.length!==1)hold('Новая серверная запись не соответствует подтверждённому источнику');
        match=matches[0];
        available.delete(match.id);
      }
      targets.set(key,match.id);
    }
  }
  if(available.size!==0)hold('После объединения остались неподтверждённые финансовые записи');
}

async function verifyCommittedBankImport(prepared,committed,fetchImpl,origin,signal){
  const manifest=prepared.payload.manifest,ledger=prepared.snapshot.bankStatements;
  const accountTargets=committed.bank_account_targets,operationTargets=committed.bank_operation_targets;
  const validMap=(map,keys)=>map&&typeof map==='object'&&!Array.isArray(map)&&
    Object.keys(map).length===keys.length&&keys.every(key=>Object.hasOwn(map,key)&&UUID.test(map[key]||''))&&
    new Set(Object.values(map)).size===keys.length;
  if(!validMap(accountTargets,ledger.accounts.map(x=>x.id))||
     !validMap(operationTargets,ledger.operations.map(x=>x.sourceKey)))
    hold('Сервер не подтвердил карту банковских записей');
  const stateResponse=await request(fetchImpl,origin,'/api/finance/v1/state?limit_entities=5000','GET',null,signal);
  const state=await responseJson(stateResponse,10_000_000),tag=stateResponse.headers.get('etag');
  const historyResponse=await request(fetchImpl,origin,'/api/finance/v1/import/bank/rows','GET',null,signal);
  const history=await responseJson(historyResponse,10_000_000);
  if(state.profile_id!==prepared.profileId||state.revision!==committed.revision)
    hold('Не подтверждена серверная ревизия банковского переноса');
  const comparison=compareGuestBankHistory({ledger,sourceRevision:prepared.preview.sourceRevision,
    snapshot:state,bankHistory:history,snapshotEtag:tag,bankEtag:historyResponse.headers.get('etag')});
  const addedPlanner=Object.values(prepared.mergeCounts.add).reduce((a,b)=>a+b,0);
  if(state.entities.length!==prepared.serverEntities.length+addedPlanner+prepared.bankCounts.accountsAdded+
      prepared.bankCounts.operationsAdded+prepared.bankCounts.reversalTransactions ||
     history.rows.length!==prepared.bankHistory.rows.length+prepared.bankCounts.operationsAdded)
    hold('Количество серверных записей не совпало с планом переноса');
  const before=new Map(prepared.serverEntities.map(x=>[x.id,x])),after=new Map(state.entities.map(x=>[x.id,x]));
  const accountChoices=new Map(manifest.bank_accounts.map(x=>[x.source_id,x]));
  const operationChoices=new Map(manifest.bank_operations.map(x=>[x.source_key,x]));
  const targetAccounts=new Set(Object.values(accountTargets)),balances=new Map();
  for(const source of ledger.accounts){
    const choice=accountChoices.get(source.id),target=accountTargets[source.id],prior=before.get(target),now=after.get(target);
    if(!choice||!now||now.kind!=='account'||now.data.name!==source.name||now.data.currency!=='RUB'||
       now.data.opening_minor!==source.openingMinor||now.data.archived_at!=null||
       (choice.decision==='link'&&(!prior||prior.kind!=='account'||choice.target_id!==target||
         now.data.type!==prior.data.type))||
       (choice.decision==='add'&&(prior||now.data.type!==choice.account_kind)))
      hold('Серверный счёт не совпал с планом переноса');
    const balance=choice.decision==='link'?prior.data.balance_minor:source.openingMinor;
    const reserved=choice.decision==='link'?prior.data.reserved_minor:0;
    if(!Number.isSafeInteger(balance)||!Number.isSafeInteger(reserved))hold('Не подтверждён остаток счёта');
    balances.set(source.id,{balance,reserved,target,revision:choice.decision==='link'?prior.entity_revision:1});
  }
  const batches=new Map(ledger.batches.map(x=>[x.batchKey,x]));
  const rows=new Map(history.rows.map(x=>[x.transaction_id,x]));
  for(const source of ledger.operations){
    const choice=operationChoices.get(source.sourceKey),id=operationTargets[source.sourceKey],row=rows.get(id);
    const sourceAccount=balances.get(source.accountId),target=source.targetAccountId?balances.get(source.targetAccountId):null;
    const cancelled=batches.get(source.batchKey).cancelledStateRevision!==null;
    if(!choice||!row||!sourceAccount||(source.targetAccountId&&!target)||
       (choice.decision==='link'&&choice.target_id!==id)||(choice.decision==='add'&&before.has(id))||
       (row.source_key!==source.sourceKey&&(source.externalId===null||row.external_id!==source.externalId))||
       row.fingerprint!==source.fingerprint||row.external_id!==source.externalId||
       row.account_id!==sourceAccount.target||row.target_account_id!==(target?.target??null)||
       row.kind!==source.kind||row.occurred_on!==source.date||row.amount_minor!==source.amountCents||
       row.description!==source.description||row.category!==source.category||
       comparison.serverStatuses[id]!== (cancelled?'cancelled':'committed'))
      hold('Серверная банковская операция не совпала с планом');
    if(choice.decision==='add'){
      const increments=cancelled?2:1;
      sourceAccount.revision+=increments;
      if(target)target.revision+=increments;
      if(!cancelled){
        sourceAccount.balance+=source.kind==='income'?source.amountCents:-source.amountCents;
        if(target)target.balance+=source.amountCents;
      }
      if(!Number.isSafeInteger(sourceAccount.balance)||(target&&!Number.isSafeInteger(target.balance)))
        hold('Не подтверждён итоговый остаток счёта');
    }
  }
  for(const value of balances.values()){
    const data=after.get(value.target).data;
    if(after.get(value.target).entity_revision!==value.revision||
       data.balance_minor!==value.balance||data.reserved_minor!==value.reserved||
       data.available_minor!==value.balance-value.reserved)hold('Остаток после переноса не совпал с планом');
  }
  for(const old of prepared.serverEntities){
    const current=after.get(old.id);
    if(!current||(!targetAccounts.has(old.id)&&!sameFinancialJSON(old,current)))
      hold('Существующая серверная запись изменилась после переноса');
  }
  const oldRows=new Map(history.rows.map(row=>[row.transaction_id,row]));
  for(const row of prepared.bankHistory.rows)
    if(!oldRows.has(row.transaction_id)||!sameFinancialJSON(row,oldRows.get(row.transaction_id)))
      hold('Существующая банковская история изменилась после переноса');
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
  explicitGuestTransfer = false,fetchImpl, signal,
}) {
  active(signal);
  const isMerge = prepared?.preview?.status === 'MERGE_PREVIEW_ONLY';
  const bank = prepared?.preview?.bankTransfer === true;
  if (!prepared || prepared.actor !== verifiedActorUserId ||
      explicitFinalConsent !== true || currentLocalSnapshotMatches !== true ||
      !USER.test(verifiedActorUserId) || !STRONG_ETAG.test(prepared.etag || '') ||
      !HASH.test(prepared.preview?.sourceSha256 || '') ||
      !['PREVIEW_ONLY','MERGE_PREVIEW_ONLY'].includes(prepared.preview?.status) ||
      explicitGuestTransfer !== Boolean(prepared.guestSource) ||
      Boolean(prepared.guestSource) !== Boolean(prepared.payload?.manifest?.explicit_guest_transfer) ||
      (isMerge && (prepared.payload?.manifest?.schema_version !== (bank?3:2) || !prepared.mergeCounts ||
        (bank && !prepared.bankCounts))) ||
      (!isMerge && prepared.payload?.manifest?.schema_version !== 1) ||
      (prepared.preservedZeroAccountId &&
       (explicitPreserveZeroAccountConsent !== true ||
        prepared.payload?.manifest?.preserve_zero_account_id !==
          prepared.preservedZeroAccountId ||
        prepared.payload?.manifest?.confirm_preserve_zero_account !== true)) ||
      typeof fetchImpl !== 'function') {
    hold('Перенос не подтверждён пользователем или исходная база изменилась');
  }
  const origin = safeOrigin(prepared.origin);
  let stage = null;
  if (!isMerge) {
    const stageResponse = await request(fetchImpl, origin,
      '/api/finance/v1/import/manifest', 'POST',
      {manifest: prepared.payload.manifest}, signal, prepared.etag);
    stage = await responseJson(stageResponse);
    if (![200, 202].includes(stageResponse.status) ||
        stage.status !== 'UNVERIFIED_MANIFEST_STAGED' ||
        stage.financial_write !== false || stage.record_count !== prepared.preview.recordCount ||
        !UUID.test(stage.batch_id)) {
      hold('Не совпала серверная подготовка переноса');
    }
  }
  // V2 stages and commits in one server transaction; neither mode retries.
  const committedResponse = await request(fetchImpl, origin,
    '/api/finance/v1/import/commit', 'POST', prepared.payload,
    signal, prepared.etag);
  const committed = await responseJson(committedResponse);
  if (![200, 201].includes(committedResponse.status) ||
      committed.status !== 'COMMITTED' || !UUID.test(committed.batch_id || '') ||
      (!isMerge && committed.batch_id !== stage.batch_id) ||
      committed.source_sha256 !== prepared.preview.sourceSha256 ||
      committed.record_count !== prepared.preview.recordCount ||
      committed.source_original_preserved !== true ||
      committed.cash_postings_created !== (bank?prepared.bankCounts.postings:0) ||
      (bank && (committed.bank_accounts_created!==prepared.bankCounts.accountsAdded ||
        committed.bank_accounts_linked!==prepared.bankCounts.accountsLinked ||
        committed.bank_operations_created!==prepared.bankCounts.operationsAdded ||
        committed.bank_operations_linked!==prepared.bankCounts.operationsLinked)) ||
      (isMerge && (!matchingCounts(committed.created_counts, prepared.mergeCounts.add) ||
        !matchingCounts(committed.linked_counts, prepared.mergeCounts.link))) ||
      !Number.isSafeInteger(committed.revision) ||
      committed.revision !== prepared.revision + (bank?prepared.bankCounts.revisionIncrement:1)) {
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
  // Verify every planner projection, then separately reconcile bank postings and balances.
  if(isMerge)await verifyCommittedPlannerMerge(prepared,committed,fetchImpl,origin,signal);
  if(bank)await verifyCommittedBankImport(prepared,committed,fetchImpl,origin,signal);
  active(signal);
  return Object.freeze({
    status: 'COMMITTED_AND_SOURCE_RESTORED',
    revision: committed.revision, recordCount: committed.record_count,
    sourceSha256: committed.source_sha256,
    localDataPreserved: true, cashPostingsCreated: bank?prepared.bankCounts.postings:0,
    ...(bank ? {bankCounts:prepared.bankCounts} : {}),
    ...(isMerge ? {mergeCounts:prepared.mergeCounts} : {}),
    ...(prepared.preservedZeroAccountId ? {serverZeroAccountPreserved: true} : {}),
  });
}
