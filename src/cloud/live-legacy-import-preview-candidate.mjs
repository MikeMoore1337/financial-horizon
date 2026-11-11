/**
 * #69 INACTIVE, READ-ONLY bridge from the actual legacy browser database
 * and independently encrypted v1 backup to the deterministic import preview.
 *
 * Neither source verification nor this preview sends HTTP, writes IndexedDB,
 * creates a cloud transaction or activates another finance account.
 */
import {verifyLiveLegacyBackup} from '../security/live-legacy-preflight.ts';
import {planVerifiedLegacyImportCandidate} from './legacy-import-manifest-candidate.mjs';

function reject() {
  throw new Error('IMPORT_HOLD: Невозможно подтвердить неизменность источника переноса');
}
function live(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || signal.aborted) reject();
}
/**
 * Must be called only after a host has verified the *current* FH session
 * and obtained a server-owned finance profile UUID/revision via authenticated
 * /state. The target argument is NOT user-supplied identity proof.
 *
 * The second real backup comparison detects a different-tab writer between
 * the first full read and the SHA-256 preview. This still does NOT fence a
 * writer during any future cloud upload; #68 must enforce native CAS first.
 */
export async function planLiveLegacyImportPreviewCandidate({
  selection, backupText, backupPassword, consent, target, signal,
}) {
  live(signal);
  // Freeze scalar input values before IndexedDB/backup PBKDF awaits.
  const chosen = selection?.kind === 'account'
    ? {kind: 'account', verifiedUserId: selection.verifiedUserId}
    : {kind: 'guest', guestNamespace: selection?.guestNamespace};
  const pinnedBackup = backupText;
  const pinnedPassword = backupPassword;
  const verifiedConsent = {
    savedEncryptedBackupOutsideThisBrowser:
      consent?.savedEncryptedBackupOutsideThisBrowser === true,
    confirmedReadOnlyPreflight: consent?.confirmedReadOnlyPreflight === true,
  };
  const previewConsent = {
    externalEncryptedBackupVerified:
      consent?.externalEncryptedBackupVerified === true,
    confirmedTargetAccount: consent?.confirmedTargetAccount === true,
    previewRequested: consent?.previewRequested === true,
    explicitGuestTransfer: consent?.explicitGuestTransfer === true,
  };
  const pinnedTarget = {
    accountScope: target?.accountScope,
    profileId: target?.profileId,
    serverRevision: target?.serverRevision,
    hasRemoteRecords: target?.hasRemoteRecords,
  };
  const original = await verifyLiveLegacyBackup({
    selection: chosen, backupText: pinnedBackup,
    backupPassword: pinnedPassword, consent: verifiedConsent,
  });
  live(signal);
  const preview = await planVerifiedLegacyImportCandidate({
    verified: original, target: pinnedTarget, consent: previewConsent, signal,
  });
  live(signal);
  const again = await verifyLiveLegacyBackup({
    selection: chosen, backupText: pinnedBackup,
    backupPassword: pinnedPassword, consent: verifiedConsent,
  });
  live(signal);
  const matched = await planVerifiedLegacyImportCandidate({
    verified: again, target: pinnedTarget, consent: previewConsent, signal,
  });
  if (original.scope !== again.scope ||
      original.sourceKey !== again.sourceKey ||
      original.sourceRevision !== again.sourceRevision ||
      preview.sourceSha256 !== matched.sourceSha256 ||
      preview.sourceScope !== matched.sourceScope ||
      preview.sourceRevision !== matched.sourceRevision ||
      preview.recordCount !== matched.recordCount ||
      JSON.stringify(preview.counts) !== JSON.stringify(matched.counts)) {
    reject();
  }
  // This is a review artifact only; never return a commit-capable command.
  return preview;
}
