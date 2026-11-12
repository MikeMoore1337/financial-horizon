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
function cloudImage(verified, appliedReceipts = []) {
  return {
    schemaVersion: 1, scope: verified.scope,
    profileId: verified.profileId,
    generation: verified.generation,
    epoch: verified.epoch,
    revision: verified.revision,
    entities: verified.entities,
    // A delta may arrive after an earlier durable ACK was reconciled.
    // Never erase those encrypted idempotency proofs by overwriting the
    // cloud sidecar with only the latest server image.
    appliedReceipts,
  };
}
/**
 * Explicit **read-only cloud cache** initialization. Refuses existing cloud
 * images, pending local changes or conflicts. Never modifies active legacy
 * entries/loans/payment history, uploads money or enables a sync loop.
 */
export async function initializeEncryptedCloudCacheCandidate({
  scope, session, identity, pages, expectedEpoch,
  confirmedAccountCacheInitialization,
}) {
  if (confirmedAccountCacheInitialization !== true) {
    hold('Не подтверждена локальная подготовка облачного снимка');
  }
  active(scope, session, identity);
  // Fail-closed verification occurs before any IDB write or encryption.
  const verified = verifyFinanceSnapshotPagesCandidate(pages, identity);
  const bundle = await readAtomicEncryptedCandidate(scope, session);
  active(scope, session, identity);
  assertBundle(bundle, expectedEpoch);
  if (Object.hasOwn(bundle.snapshot, 'cloudFinance') ||
      bundle.outbox.length !== 0 || bundle.conflicts.length !== 0) {
    hold('Уже существует облачная копия или неподтверждённые локальные правки');
  }
  const snapshot = structuredClone(bundle.snapshot);
  snapshot.cloudFinance = cloudImage(verified);
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
  const proofs = before.appliedReceipts || [];
  if (!Array.isArray(proofs) || proofs.length > 2000 ||
      proofs.some(x => !x || typeof x !== 'object' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.mutationId) ||
        !/^[a-f0-9]{64}$/.test(x.fingerprint) ||
        !Number.isSafeInteger(x.revision) || x.revision < 1)) {
    hold('История подтверждённых операций повреждена');
  }
  snapshot.cloudFinance = cloudImage(checked, structuredClone(proofs));
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
