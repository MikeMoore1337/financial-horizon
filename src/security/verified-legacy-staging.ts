/**
 * Explicit, non-destructive offline staging preflight for legacy v1/v2 finance.
 * This module does not read the live legacy IndexedDB; callers must freeze writes
 * and revalidate the live snapshot before any later activation/cutover.
 */
import {decryptBackup} from '../../backup.js';
import {migrateState} from '../../state-migrations.ts';
import {stageProtectedSnapshot, type StagingResult} from './protected-staging.ts';
import type {LocalScope} from './local-vault.ts';

export type VerifiedLegacyStagingConsent = Readonly<{
  savedEncryptedBackupOutsideThisBrowser: true;
  confirmedSeparateStaging: true;
}>;

export async function stageVerifiedLegacyBackup(input: {
  scope: LocalScope;
  source: unknown;
  backupText: string;
  backupPassword: string;
  localPassphrase: string;
  consent: VerifiedLegacyStagingConsent;
}): Promise<StagingResult> {
  // Check human-initiated gates before opening even the isolated destination DB.
  if (!input || input.consent?.savedEncryptedBackupOutsideThisBrowser !== true ||
      input.consent?.confirmedSeparateStaging !== true) {
    throw Error('Не подтверждены внешняя резервная копия и согласие на перенос');
  }
  // Freeze mutable caller data before the asynchronous decryption/KDF.
  const original = structuredClone(input.source);
  const checkedSource = migrateState(original);
  const recovered = await decryptBackup(input.backupText, input.backupPassword);
  const restored = migrateState(recovered);
  if (JSON.stringify(checkedSource) !== JSON.stringify(restored)) {
    throw Error('Резервная копия не совпадает с выбранным состоянием');
  }
  // This is an isolated, inactive copy. The original DB is not even opened.
  return stageProtectedSnapshot(input.scope, checkedSource, {
    kind: 'snapshot', recordId: 'state',
    schemaVersion: checkedSource.version,
    revision: checkedSource.revision,
  }, input.localPassphrase);
}
