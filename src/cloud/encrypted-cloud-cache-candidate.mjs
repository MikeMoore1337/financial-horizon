/**
 * #68 INACTIVE encrypted finance cloud-cache candidate.
 *
 * A verified FH session and separately unlocked #34 local keyset are REQUIRED.
 * The active PWA does not import this module; its local-first finance data is
 * preserved byte-for-byte within the encrypted bundle. Nothing uploads here.
 *
 * The protected atomic adapter encrypts snapshot+outbox+conflicts before a
 * single native IndexedDB CAS transaction; any stale writer/session fails.
 */
import {
  readAtomicEncryptedCandidate,
  compareAndSwapAtomicEncryptedCandidate,
} from '../security/protected-atomic-candidate.ts';
import {
  verifyFinanceSnapshotPagesCandidate,
  applyFinanceDeltaCandidate,
} from './verified-delta-candidate.mjs';

import {assertGoalSnapshotExtends} from '../domain/goals/server-goals.ts';

function hold(message) {
  throw new Error('SYNC_HOLD: ' + message);
}
function active(scope, session, identity) {
  if (typeof scope !== 'string' || !scope.startsWith('account:') ||
      !identity || identity.scope !== scope ||
      session?.state !== 'unlocked' || session.selectedScope !== scope ||
      identity.generation !== session.lifecycleVersion ||
      session.lifecycleSignal.aborted || identity.signal?.aborted) {
    hold('Сессия аккаунта или локальная разблокировка истекла');
  }
}
function assertBundle(bundle, expectedEpoch) {
  if (!bundle || bundle.schemaVersion !== 2 ||
      !bundle.snapshot || bundle.snapshot.version !== 2 ||
      !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 ||
      bundle.epoch !== expectedEpoch ||
      !Array.isArray(bundle.outbox) || !Array.isArray(bundle.conflicts)) {
    hold('Зашифрованный локальный бюджет изменился');
  }
}
function cloudImage(verified, appliedReceipts = [], serverEtag = null) {
  return {
    schemaVersion: 1, scope: verified.scope,
    profileId: verified.profileId,
    generation: verified.generation,
    epoch: verified.epoch,
    revision: verified.revision,
    entities: verified.entities,
    ...(serverEtag === null ? {} : {serverEtag}),
    // A delta may arrive after an earlier durable ACK was reconciled.
    // Never erase those encrypted idempotency proofs by overwriting the
    // cloud sidecar with only the latest server image.
    appliedReceipts,
  };
}

function checkedSnapshotEtag(etag, revision) {
  // The server implementation encodes the revision in its strong opaque tag.
  // Accepting a tag from a different snapshot would poison offline writes.
  const match = typeof etag === 'string' && /^"fh\.1\.(0|[1-9]\d*)\.[a-f0-9]{16}"$/.exec(etag);
  if (!match || match[1] !== String(revision)) hold('ETag не соответствует ревизии снимка');
  return etag;
}

function validatedReceipts(value) {
  if (!Array.isArray(value) || value.length > 2000 ||
      value.some(x => !x || typeof x !== 'object' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.mutationId) ||
        !/^[a-f0-9]{64}$/.test(x.fingerprint) ||
        !Number.isSafeInteger(x.revision) || x.revision < 1)) {
    hold('История подтверждённых операций повреждена');
  }
  return structuredClone(value);
}

/** Replace only a confirmed cloud image with a complete newer server image.
 * Pending commands, conflicts and receipt proofs remain in the same CAS.
 * A snapshot alone never proves that an uncertain command was committed.
 * The caller must obtain pages and ETag from the authenticated, same-origin
 * snapshot downloader in the same live session; this function does no HTTP. */
export async function refreshEncryptedCloudSnapshot({
  scope, session, identity, pages, etag, expectedEpoch, pendingJournalPage = null,
  budgetCommandsV1, goalCommandsV1,
}) {
  active(scope, session, identity);
  const verified = verifyFinanceSnapshotPagesCandidate(pages, identity);
  const serverEtag = checkedSnapshotEtag(etag, verified.revision);
  const bundle = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  assertBundle(bundle, expectedEpoch);
  const before = bundle.snapshot.cloudFinance;
  if (!before || before.schemaVersion !== 1 || before.scope !== scope ||
      before.profileId !== identity.profileId || before.epoch !== identity.epoch ||
      !Number.isSafeInteger(before.revision) || before.revision < 0 ||
      verified.revision < before.revision) {
    hold('Серверный финансовый снимок устарел или не совпадает с профилем');
  }
  assertGoalSnapshotExtends(before.entities, verified.entities);
  const proofs = validatedReceipts(before.appliedReceipts || []);
  if (verified.revision === before.revision && before.serverEtag !== undefined &&
      before.serverEtag !== serverEtag) {
    hold('ETag изменился без новой ревизии');
  }
  // A revision identifies one authoritative state. Do not replace the
  // existing encrypted image at the same revision with an unproven variant.
  // Persist only the last authenticated capability inside the sealed snapshot.
  // It authorizes local queueing, never network access. Absence means false.
  if (budgetCommandsV1 !== undefined && typeof budgetCommandsV1 !== 'boolean') hold('Неверная возможность бюджета');
  if (goalCommandsV1 !== undefined && typeof goalCommandsV1 !== 'boolean') hold('Неверная возможность целей');
  const capabilityChanged = (budgetCommandsV1 !== undefined &&
    (bundle.snapshot.budgetCommandsV1 === true) !== budgetCommandsV1) ||
    (goalCommandsV1 !== undefined && (bundle.snapshot.goalCommandsV1 === true) !== goalCommandsV1);
  if (verified.revision === before.revision && before.serverEtag === serverEtag && pendingJournalPage === null && !capabilityChanged) {
    return Object.freeze({status: 'NO_NEW_REVISION', bundleEpoch: expectedEpoch,
      serverRevision: verified.revision, pending: bundle.outbox.length});
  }
  const snapshot = structuredClone(bundle.snapshot);
  if (budgetCommandsV1 !== undefined) {
    if (budgetCommandsV1) snapshot.budgetCommandsV1 = true;
    else delete snapshot.budgetCommandsV1;
  }
  if (goalCommandsV1 !== undefined) {
    if (goalCommandsV1) snapshot.goalCommandsV1 = true;
    else delete snapshot.goalCommandsV1;
  }
  snapshot.cloudFinance = verified.revision === before.revision
    ? {...before, serverEtag}
    : cloudImage(verified, proofs, serverEtag);
  // Keep the exact pre-command image when replacing it. It is encrypted in
  // the same CAS and remains tied to the original head UUID and If-Match.
  // It is useful only for a bounded, independently checked snapshot comparison; it
  // never settles the command or replaces missing journal events.
  const outbox = structuredClone(bundle.outbox);
  const head = outbox[0];
  const proofBase = head?.command?.base_revision === before.revision && head?.ifMatch === before.serverEtag
    ? before : head?.recoveryBase;
  if (pendingJournalPage !== null && head && !head.recoveryJournal &&
      head.status === 'pending' && proofBase && head.command?.base_revision === proofBase.revision &&
      typeof proofBase.serverEtag === 'string' && head.ifMatch === proofBase.serverEtag &&
      (proofBase === before || proofBase.fingerprint === head.fingerprint) &&
      Array.isArray(proofBase.entities) && verified.revision > proofBase.revision &&
      pendingJournalPage.from_revision === proofBase.revision &&
      pendingJournalPage.next_since_revision === proofBase.revision + 1 &&
      Array.isArray(pendingJournalPage.changes) && pendingJournalPage.changes.length > 0 &&
      pendingJournalPage.changes.length <= 100) {
    // The caller supplies a bounded, independently fetched authenticated page.
    // Validation is read-only; a bad page cannot affect the new snapshot.
    try {
      applyFinanceDeltaCandidate({...before, revision:proofBase.revision, entities:proofBase.entities,
        generation:identity.generation,
        pending:bundle.outbox, conflicts:bundle.conflicts}, pendingJournalPage, identity);
      head.recoveryJournal = {fingerprint:head.fingerprint, ifMatch:head.ifMatch,
        page:structuredClone(pendingJournalPage)};
    } catch { active(scope, session, identity); /* Refresh without unverified evidence. */ }
  }
  if (verified.revision > before.revision && verified.revision <= before.revision + 9 &&
      head && !head.recoveryBase &&
      ['account.create', 'account.update', 'account.archive', 'account.unarchive',
        'transaction.record', 'transaction.reverse', 'account.transfer', 'obligation.create',
        'settlement.payment.record', 'settlement.payment.void', 'loan.payment.record', 'loan.payment.void',
        'reserve.create', 'reserve.update', 'reserve.allocate', 'reserve.archive',
        'reserve.skip', 'reserve.event.void', 'reserve.cycle.close', 'reserve.cycle.void',
        'budget.create','budget.amend','budget.archive','budget.category.create',
        'budget.category.rename','budget.category.archive','budget.category.assign','goal.append']
        .includes(head.command?.action) &&
      head.status === 'pending' && head.command?.base_revision === before.revision &&
      typeof before.serverEtag === 'string' && head.ifMatch === before.serverEtag) {
    head.recoveryBase = {revision:before.revision, serverEtag:before.serverEtag,
      fingerprint:head.fingerprint, entities:structuredClone(before.entities)};
  }
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2,
    {snapshot, outbox, conflicts: bundle.conflicts},
  );
  active(scope, session, identity);
  return Object.freeze({status: 'ENCRYPTED_SNAPSHOT_REFRESHED', bundleEpoch: nextEpoch,
    serverRevision: verified.revision, pending: bundle.outbox.length});
}
/**
 * Explicit **read-only cloud cache** initialization. Refuses existing cloud
 * images, pending local changes or conflicts. Never modifies active legacy
 * entries/loans/payment history, uploads money or enables a sync loop.
 */
export async function initializeEncryptedCloudCacheCandidate({
  scope, session, identity, pages, etag = null, expectedEpoch,
  confirmedAccountCacheInitialization, budgetCommandsV1, goalCommandsV1,
}) {
  if (confirmedAccountCacheInitialization !== true) {
    hold('Не подтверждена локальная подготовка облачного снимка');
  }
  active(scope, session, identity);
  // Fail-closed verification occurs before any IDB write or encryption.
  const verified = verifyFinanceSnapshotPagesCandidate(pages, identity);
  const serverEtag = etag === null ? null : checkedSnapshotEtag(etag, verified.revision);
  const bundle = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  assertBundle(bundle, expectedEpoch);
  if (Object.hasOwn(bundle.snapshot, 'cloudFinance') ||
      bundle.outbox.length !== 0 || bundle.conflicts.length !== 0) {
    hold('Уже существует облачная копия или неподтверждённые локальные правки');
  }
  const snapshot = structuredClone(bundle.snapshot);
  if (budgetCommandsV1 !== undefined && typeof budgetCommandsV1 !== 'boolean') hold('Неверная возможность бюджета');
  if (budgetCommandsV1 === true) snapshot.budgetCommandsV1 = true;
  if (goalCommandsV1 !== undefined && typeof goalCommandsV1 !== 'boolean') hold('Неверная возможность целей');
  if (goalCommandsV1 === true) snapshot.goalCommandsV1 = true;
  snapshot.cloudFinance = cloudImage(verified, [], serverEtag);
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2,
    {snapshot, outbox: bundle.outbox, conflicts: bundle.conflicts},
  );
  active(scope, session, identity);
  return Object.freeze({
    status: 'ENCRYPTED_CACHE_ONLY', bundleEpoch: nextEpoch,
    serverRevision: verified.revision, sentCommands: 0,
    sourcePreserved: true, cloudFeatureEnabled: false,
  });
}

/**
 * Persist a validated contiguous remote delta with current encrypted local
 * outbox/conflicts in one CAS. This does not settle any queued command: an
 * independently verified durable applied-proof/receipt protocol is pending.
 */
export async function persistEncryptedCloudDeltaCandidate({
  scope, session, identity, page, expectedEpoch,
}) {
  active(scope, session, identity);
  const bundle = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  assertBundle(bundle, expectedEpoch);
  const before = bundle.snapshot.cloudFinance;
  if (!before || before.schemaVersion !== 1 ||
      before.scope !== scope || before.profileId !== identity.profileId ||
      !Number.isSafeInteger(before.generation) || before.generation < 1 ||
      before.epoch !== identity.epoch) {
    hold('Серверный финансовый снимок не совпадает с сеансом');
  }
  const checked = applyFinanceDeltaCandidate(
    // Session generation fences only work within a live unlock. It can
    // legitimately change across a restart or a fresh local unlock.
    // The persistent account scope, profile and cutover epoch were validated
    // against a fresh authenticated+unlocked session above.
    {...before, generation: identity.generation,
     pending: bundle.outbox, conflicts: bundle.conflicts},
    page, identity,
  );
  if (checked.revision === before.revision && page.changes.length === 0) {
    return Object.freeze({
      status: 'NO_NEW_REVISION', bundleEpoch: expectedEpoch,
      serverRevision: before.revision, outboxPreserved: true,
      cloudFeatureEnabled: false,
    });
  }
  const snapshot = structuredClone(bundle.snapshot);
  const proofs = validatedReceipts(before.appliedReceipts || []);
  snapshot.cloudFinance = cloudImage(checked, proofs);
  const nextEpoch = await compareAndSwapAtomicEncryptedCandidate(
    scope, session, expectedEpoch, 2,
    {snapshot, outbox: bundle.outbox, conflicts: bundle.conflicts},
  );
  active(scope, session, identity);
  return Object.freeze({
    status: 'ENCRYPTED_DELTA_SAVED', bundleEpoch: nextEpoch,
    serverRevision: checked.revision, outboxPreserved: true,
    cloudFeatureEnabled: false,
  });
}
