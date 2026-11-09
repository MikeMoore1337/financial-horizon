/**
 * Read-only migration preflight for the existing browser finance database.
 * This file NEVER writes, changes active scopes, imports new storage or cuts over.
 * It cannot authenticate a user: callers must verify their actual login session.
 */
import {decryptBackup} from '../../backup.js';
import {migrateState} from '../../state-migrations.ts';
import {sameFinancialJSON} from './protected-staging.ts';
import type {LocalScope} from './local-vault.ts';

const LEGACY_DATABASE = 'financial-horizon-browser-v1';
const LEGACY_STORE = 'finance';
const KEY = 'state';
const CLAIM_KEY = 'legacy-account-claim-v2';
const GUEST_KEY = 'guest-state-v2';
const ACCOUNT_KEY = 'account-state-v2:';

export type ExplicitLegacySelection =
  | Readonly<{kind: 'account'; verifiedUserId: string}>
  | Readonly<{kind: 'guest'; guestNamespace: string}>;

export type LegacyPreflightConsent = Readonly<{
  savedEncryptedBackupOutsideThisBrowser: true;
  confirmedReadOnlyPreflight: true;
}>;

export type VerifiedLegacySnapshot = Readonly<{
  scope: LocalScope;
  sourceKey: string;
  sourceRevision: number;
  snapshot: ReturnType<typeof migrateState>;
  backupVersion: 1;
}>;

function selectedScope(selection: ExplicitLegacySelection): LocalScope {
  if (!selection || typeof selection !== 'object') {
    throw Error('Не выбран финансовый профиль');
  }
  if (selection.kind === 'account' && typeof selection.verifiedUserId === 'string' &&
    /^[a-f0-9]{32}$/.test(selection.verifiedUserId)) {
    return `account:${selection.verifiedUserId}`;
  }
  if (selection.kind === 'guest' && typeof selection.guestNamespace === 'string' &&
    /^[A-Za-z0-9_-]{4,64}$/.test(selection.guestNamespace)) {
    return `guest:${selection.guestNamespace}`;
  }
  throw Error('Некорректный финансовый профиль');
}

/** Opening an absent legacy database must not create an empty one. */
async function openLegacy(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw Error('IndexedDB недоступна');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      fail(Error('Исходная финансовая база не найдена'));
    };
    request.onerror = () => fail(request.error || Error('Невозможно открыть исходную базу'));
    request.onblocked = () => fail(Error('Закройте другие вкладки перед проверкой данных'));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      const db = request.result;
      if (db.version !== 1 || !db.objectStoreNames.contains(LEGACY_STORE)) {
        db.close();
        fail(Error('Неподдерживаемая версия исходной финансовой базы'));
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

type LegacyRead = {sourceKey: string; claim: string | null; state: unknown};
async function readLegacy(scope: LocalScope): Promise<LegacyRead> {
  const db = await openLegacy();
  try {
    return await new Promise((resolve, reject) => {
      // One readonly transaction binds the claim and possible source keys to
      // the same database snapshot. No calls to storage.js or its activeKey.
      const tx = db.transaction(LEGACY_STORE, 'readonly');
      const store = tx.objectStore(LEGACY_STORE);
      const claimReq = store.get(CLAIM_KEY);
      const exactAccountKey = scope.startsWith('account:') ? ACCOUNT_KEY + scope.slice(8) : null;
      const accountReq = exactAccountKey ? store.get(exactAccountKey) : null;
      const legacyReq = exactAccountKey ? null : store.get(KEY);
      const guestReq = exactAccountKey ? null : store.get(GUEST_KEY);
      tx.oncomplete = () => {
        try {
          const rawClaim: unknown = claimReq.result;
          if (rawClaim !== undefined &&
            (typeof rawClaim !== 'string' || !/^[a-f0-9]{32}$/.test(rawClaim))) {
            throw Error('Повреждена привязка исходного аккаунта');
          }
          const claim = rawClaim === undefined ? null : rawClaim as string;
          const sourceKey = exactAccountKey || (claim ? GUEST_KEY : KEY);
          const state: unknown = exactAccountKey ? accountReq?.result :
            claim ? guestReq?.result : legacyReq?.result;
          if (state === undefined) throw Error('Для выбранного профиля нет исходных финансовых данных');
          resolve({sourceKey, claim, state: structuredClone(state)});
        } catch (error) { reject(error); }
      };
      tx.onerror = () => reject(tx.error || Error('Не удалось прочитать исходную базу'));
      tx.onabort = () => reject(tx.error || Error('Чтение исходной базы было прервано'));
    });
  } finally { db.close(); }
}

/**
 * Explicit read-only verification, never a migration or encrypted cutover.
 * A fresh backup file and password must be supplied from outside the browser.
 * Re-reads source after expensive PBKDF2 and refuses a stale snapshot.
 */
export async function verifyLiveLegacyBackup(input: {
  selection: ExplicitLegacySelection;
  backupText: string;
  backupPassword: string;
  consent: LegacyPreflightConsent;
}): Promise<VerifiedLegacySnapshot> {
  if (!input || input.consent?.savedEncryptedBackupOutsideThisBrowser !== true ||
    input.consent?.confirmedReadOnlyPreflight !== true) {
    throw Error('Не подтверждены внешняя резервная копия и проверка источника');
  }
  // Snapshot scalar arguments before any await. Never infer account identity
  // from a password, cookie, localStorage key, or an untrusted record.
  const scope = selectedScope(input.selection);
  const backupText = input.backupText;
  const backupPassword = input.backupPassword;
  if (typeof backupText !== 'string' || typeof backupPassword !== 'string' ||
    backupPassword.length < 12 || backupText.length > 8_000_000) {
    throw Error('Некорректный файл или пароль резервной копии');
  }
  const first = await readLegacy(scope);
  const source = migrateState(first.state);
  const restored = migrateState(await decryptBackup(backupText, backupPassword));
  if (!sameFinancialJSON(source, restored)) {
    throw Error('Резервная копия не совпадает с локальными финансовыми данными');
  }
  // A different tab may have edited a settlement during the backup KDF.
  // This is a snapshot proof, NOT a cross-tab writer lock or final cutover.
  const second = await readLegacy(scope);
  if (second.sourceKey !== first.sourceKey || second.claim !== first.claim ||
    !sameFinancialJSON(source, migrateState(second.state))) {
    throw Error('Исходные финансовые данные изменились во время проверки');
  }
  return {
    scope,
    sourceKey: first.sourceKey,
    sourceRevision: source.revision,
    snapshot: structuredClone(source),
    backupVersion: 1,
  };
}
