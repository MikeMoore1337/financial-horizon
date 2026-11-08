/**
 * Non-destructive bridge from an independently VERIFIED live backup to an
 * INACTIVE encrypted atomic candidate. It never changes active storage.
 *
 * Important: return a recovery receipt even if verification fails AFTER the
 * new encrypted bundle committed, or the one-time recovery key would be lost.
 */
import {
  verifyLiveLegacyBackup, type ExplicitLegacySelection, type LegacyPreflightConsent,
} from './live-legacy-preflight.ts';
import {
  createAtomicEncryptedCandidate, getAtomicEncryptedKeyset,
  readAtomicEncryptedCandidate,
} from './protected-atomic-candidate.ts';
import {LocalBudgetSession} from './local-budget-session.ts';
import {sameFinancialJSON} from './protected-staging.ts';
import type {LocalScope} from './local-vault.ts';

export type InactiveCandidateConsent = LegacyPreflightConsent & Readonly<{
  confirmedSeparateEncryptedCandidate: true;
  acknowledgedOneTimeRecovery: true;
}>;

export type CandidateReceipt = Readonly<{
  status: 'prepared' | 'stale-source' | 'unverified';
  scope: LocalScope;
  sourceKey: string;
  sourceRevision: number;
  recoveryKey: string;
  active: false;
}>;

/**
 * Invoked only after UI consent and an externally saved, encrypted v1 backup.
 * The backup password is not the local unlock passphrase.
 */
export async function prepareVerifiedAtomicCandidate(input: {
  selection: ExplicitLegacySelection;
  backupText: string;
  backupPassword: string;
  localPassphrase: string;
  consent: InactiveCandidateConsent;
}): Promise<CandidateReceipt> {
  if (!input || input.consent?.savedEncryptedBackupOutsideThisBrowser !== true ||
    input.consent?.confirmedReadOnlyPreflight !== true ||
    input.consent?.confirmedSeparateEncryptedCandidate !== true ||
    input.consent?.acknowledgedOneTimeRecovery !== true) {
    throw Error('Нет подтверждения внешней копии и отдельной подготовки зашифрованных данных');
  }

  // Pin all scalar inputs synchronously, prior to IndexedDB and KDF awaits.
  // A caller mutating input between KDF operations cannot change the owner.
  const selection: ExplicitLegacySelection = input.selection?.kind === 'account'
    ? {kind:'account',verifiedUserId:input.selection.verifiedUserId}
    : {kind:'guest',guestNamespace:input.selection?.kind === 'guest'
      ? input.selection.guestNamespace : ''};
  const backupText = input.backupText;
  const backupPassword = input.backupPassword;
  const localPassphrase = input.localPassphrase;
  const consent: LegacyPreflightConsent = {
    savedEncryptedBackupOutsideThisBrowser: true,
    confirmedReadOnlyPreflight: true,
  };

  // This checks claim/source key, decrypts the independently saved v1 backup
  // and reads the real original DB a second time after backup PBKDF2.
  const verified = await verifyLiveLegacyBackup({
    selection, backupText, backupPassword, consent,
  });

  // Never overwrite a previously-created keyset or drop a previous recovery
  // secret: createAtomicEncryptedCandidate's transaction fails on duplicates.
  const prepared = await createAtomicEncryptedCandidate(
    verified.scope, localPassphrase, {
      snapshot: verified.snapshot, outbox: [], conflicts: [],
    }, verified.snapshot.version,
  );
  const base = {
    scope: verified.scope,
    sourceKey: verified.sourceKey,
    sourceRevision: verified.sourceRevision,
    recoveryKey: prepared.recoveryKey,
    active: false as const,
  };

  // After a successful commit, NEVER throw away the one-time recovery key.
  // A verification or legacy source failure becomes an explicit inert receipt.
  const session = new LocalBudgetSession();
  try {
    const keyset = await getAtomicEncryptedKeyset(verified.scope);
    if (!keyset) return {...base, status:'unverified'};
    session.selectScope(verified.scope);
    await session.unlock(keyset, {passphrase:localPassphrase});
    const restored = await readAtomicEncryptedCandidate(verified.scope, session);
    if (!restored || restored.epoch !== 0 ||
      restored.schemaVersion !== verified.snapshot.version ||
      !sameFinancialJSON(restored.snapshot, verified.snapshot) ||
      restored.outbox.length !== 0 || restored.conflicts.length !== 0) {
      return {...base, status:'unverified'};
    }
    // Expensive but safe final source check; current active writers are NOT
    // coordinated, so no cutover is authorized after this comparison.
    let latest: Awaited<ReturnType<typeof verifyLiveLegacyBackup>>;
    try {
      latest = await verifyLiveLegacyBackup({
        selection, backupText, backupPassword, consent,
      });
    } catch (error) {
      // A changed source must not be mistaken for an approved candidate.
      // Preserve the already-committed recovery key in either case.
      const message = error instanceof Error ? error.message : '';
      if (message.includes('не совпадает с локальными финансовыми данными') ||
        message.includes('изменились во время проверки') ||
        message.includes('нет исходных финансовых данных')) {
        return {...base, status:'stale-source'};
      }
      return {...base, status:'unverified'};
    }
    if (latest.sourceKey !== verified.sourceKey ||
      latest.sourceRevision !== verified.sourceRevision ||
      !sameFinancialJSON(latest.snapshot, verified.snapshot)) {
      return {...base, status:'stale-source'};
    }
    return {...base, status:'prepared'};
  } catch {
    return {...base, status:'unverified'};
  } finally {
    session.logout();
  }
}
