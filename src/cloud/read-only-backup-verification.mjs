/**
 * #69 - offline verification of a user-saved AES-GCM Financial Horizon backup.
 *
 * Does not access a network, IndexedDB, cookies, or server-side finance.
 * Decrypting with AES-GCM proves file authenticity under the supplied password;
 * comparing against the current scope proves the saved snapshot is still current.
 * A successful check is NOT equivalent to a separate-browser restore drill.
 */
import {decryptBackup} from '../../backup.js';
import {validateState} from '../../finance.js';
import {sameFinancialJSON} from '../security/protected-staging.ts';

const MAX_FILE_CHARS = 8_000_000;

export async function verifySavedFinancialBackupReadOnly({
  backupText, password, currentSnapshot,
}) {
  if (typeof backupText !== 'string' || backupText.length < 1 ||
      backupText.length > MAX_FILE_CHARS ||
      typeof password !== 'string' || password.length < 12 ||
      currentSnapshot === null || typeof currentSnapshot !== 'object') {
    throw Error('Нужны сохранённый зашифрованный файл и пароль резервной копии');
  }

  // Both inputs are validated; no finance schema fields are silently repaired.
  // This module cannot persist, upload, or merge the decrypted source.
  validateState(currentSnapshot);
  const restored = await decryptBackup(backupText, password);
  const matchesCurrent = sameFinancialJSON(restored, currentSnapshot);

  return Object.freeze({
    status: matchesCurrent ? 'BACKUP_MATCHES_CURRENT' : 'BACKUP_VALID_BUT_DIFFERENT',
    authenticatedDecryption: true,
    validFinancialSchema: true,
    matchesCurrent,
    recordCounts: Object.freeze({
      entries: restored.entries.length,
      loans: restored.loans.length,
      settlements: restored.settlements.length,
      loanPayments: restored.loanPayments.length,
    }),
    noWritePerformed: true,
  });
}
