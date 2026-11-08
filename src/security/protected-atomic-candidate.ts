/**
 * Candidate encrypted local snapshot + offline queues. Never imported by the
 * active app; no migration, auth, remote sync, or deletion side effects.
 */
import {
  createLocalKeyset,
  type EncryptedLocalRecordV1,
  type LocalKeysetV1,
  type LocalScope,
  type RecordContext,
} from './local-vault.ts';
import type {LocalBudgetSession} from './local-budget-session.ts';

export const ATOMIC_ENCRYPTED_DB = 'financial-horizon-encrypted-atomic-candidate-v1';
const VERSION = 1;
const FORMAT = 'financial-horizon.atomic-encrypted-bundle';
const KEYSETS = 'keysets';
const BUNDLES = 'bundles';
const SCOPE = /^(?:account:[a-f0-9]{32}|guest:[A-Za-z0-9_-]{4,64})$/;
const ITEMS = [
  ['snapshot', 'state'],
  ['outbox', 'pending'],
  ['conflicts', 'inbox'],
] as const;

export type ProtectedAtomicContents = Readonly<{
  snapshot: Record<string, unknown>;
  outbox: unknown[];
  conflicts: unknown[];
}>;
type BundlePart = (typeof ITEMS)[number][0];
type ProtectedAtomicBundle = {
  format: typeof FORMAT;
  version: 1;
  scope: LocalScope;
  keyId: string;
  epoch: number;
  schemaVersion: number;
  snapshot: EncryptedLocalRecordV1;
  outbox: EncryptedLocalRecordV1;
  conflicts: EncryptedLocalRecordV1;
};
type StoredPair = {keyset: LocalKeysetV1; bundle: ProtectedAtomicBundle};
type Encryptor = {
  encrypt(value: unknown, context: RecordContext): Promise<EncryptedLocalRecordV1>;
};

function validScope(scope: unknown): asserts scope is LocalScope {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) {
    throw Error('Некорректный финансовый профиль');
  }
}
function safeInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw Error('Некорректное поле ' + name);
  }
}
function validContents(value: ProtectedAtomicContents): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(key => !['snapshot', 'outbox', 'conflicts'].includes(key)) ||
    !value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot) ||
    !Array.isArray(value.outbox) || !Array.isArray(value.conflicts)) {
    throw Error('Некорректное содержимое защищённой локальной копии');
  }
  assertPureJson(value);
}
/** Reject lossy serialization: undefined, nonfinite values, custom objects or cycles. */
function assertPureJson(value: unknown, depth = 0, visited = new Set<object>()): void {
  if (depth > 96) throw Error('Слишком глубокие финансовые данные');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw Error('Недопустимое значение финансового JSON');
  if (visited.has(value)) throw Error('Циклические ссылки в финансовых данных');
  visited.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length ||
      Object.getOwnPropertySymbols(value).length) throw Error('Некорректный финансовый массив');
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw Error('Пропущенный элемент финансового массива');
      assertPureJson(value[i], depth + 1, visited);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) ||
      Object.keys(value).length !== Object.getOwnPropertyNames(value).length ||
      Object.getOwnPropertySymbols(value).length) {
      throw Error('Финансовые данные должны быть обычным JSON-объектом');
    }
    for (const entry of Object.values(value)) assertPureJson(entry, depth + 1, visited);
  }
  visited.delete(value);
}
function exactKeys(value: unknown, names: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    Object.keys(value).some(key => !names.includes(key))) {
    throw Error('Повреждён защищённый контейнер');
  }
}
function context(part: BundlePart, epoch: number, schemaVersion: number): RecordContext {
  const tuple = ITEMS.find(([name]) => name === part);
  if (!tuple) throw Error('Неизвестная часть защищённого контейнера');
  return {kind: tuple[0], recordId: tuple[1], schemaVersion, revision: epoch};
}
function validateBundle(value: ProtectedAtomicBundle, keyset: LocalKeysetV1, scope: LocalScope): void {
  exactKeys(value, ['format', 'version', 'scope', 'keyId', 'epoch', 'schemaVersion', 'snapshot', 'outbox', 'conflicts']);
  if (value.format !== FORMAT || value.version !== VERSION || value.scope !== scope ||
    keyset.scope !== scope || typeof keyset.keyId !== 'string' || value.keyId !== keyset.keyId) {
    throw Error('Повреждён защищённый контейнер');
  }
  safeInteger(value.epoch, 0, Number.MAX_SAFE_INTEGER, 'epoch');
  safeInteger(value.schemaVersion, 1, 65535, 'schemaVersion');
  for (const [kind, recordId] of ITEMS) {
    const record = value[kind];
    if (!record || record.scope !== scope || record.keyId !== value.keyId ||
      record.kind !== kind || record.recordId !== recordId ||
      record.revision !== value.epoch || record.schemaVersion !== value.schemaVersion) {
      throw Error('Повреждён защищённый контейнер');
    }
  }
}
async function openDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw Error('IndexedDB недоступна');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ATOMIC_ENCRYPTED_DB, VERSION);
    let settled = false;
    request.onblocked = () => {
      if (!settled) { settled = true; reject(Error('Закройте другие вкладки')); }
    };
    request.onerror = () => {
      if (!settled) { settled = true; reject(request.error || Error('Ошибка защищённого хранилища')); }
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEYSETS)) db.createObjectStore(KEYSETS);
      if (!db.objectStoreNames.contains(BUNDLES)) db.createObjectStore(BUNDLES);
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
async function readPair(scope: LocalScope): Promise<StoredPair | null> {
  validScope(scope);
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([KEYSETS, BUNDLES], 'readonly');
      const keyReq = tx.objectStore(KEYSETS).get(scope);
      const bundleReq = tx.objectStore(BUNDLES).get(scope);
      tx.oncomplete = () => {
        const keyset = keyReq.result as LocalKeysetV1 | undefined;
        const bundle = bundleReq.result as ProtectedAtomicBundle | undefined;
        if (keyset === undefined && bundle === undefined) { resolve(null); return; }
        try {
          if (!keyset || !bundle) throw Error('Повреждён защищённый контейнер');
          validateBundle(bundle, keyset, scope);
          resolve({keyset, bundle});
        } catch (error) { reject(error); }
      };
      tx.onerror = () => reject(tx.error || Error('Ошибка чтения защищённой копии'));
      tx.onabort = () => reject(tx.error || Error('Прервано чтение защищённой копии'));
    });
  } finally { db.close(); }
}
function newBundle(scope: LocalScope, keyId: string, epoch: number, schemaVersion: number,
  records: Record<BundlePart, EncryptedLocalRecordV1>): ProtectedAtomicBundle {
  return {format: FORMAT, version: VERSION, scope, keyId, epoch, schemaVersion, ...records};
}
async function sealParts(sealer: Encryptor, contents: ProtectedAtomicContents, epoch: number,
  schemaVersion: number): Promise<Record<BundlePart, EncryptedLocalRecordV1>> {
  validContents(contents);
  const pinned = structuredClone(contents);
  const records = {} as Record<BundlePart, EncryptedLocalRecordV1>;
  for (const [kind] of ITEMS) {
    records[kind] = await sealer.encrypt(pinned[kind], context(kind, epoch, schemaVersion));
  }
  return records;
}
function activeSession(session: LocalBudgetSession, scope: LocalScope, lease: number): void {
  if (session.selectedScope !== scope || session.state !== 'unlocked' || session.lifecycleVersion !== lease) {
    throw Error('Локальный бюджет заблокирован');
  }
}

/**
 * Explicit candidate creation only. This cannot prove an external legacy
 * backup exists and MUST NOT be used as a production cutover authorization.
 */
export async function createAtomicEncryptedCandidate(
  scope: LocalScope, passphrase: string, contents: ProtectedAtomicContents,
  schemaVersion = 2,
): Promise<{epoch: 0; recoveryKey: string}> {
  validScope(scope);
  safeInteger(schemaVersion, 1, 65535, 'schemaVersion');
  // Pin everything before the first PBKDF2 await, including array contents.
  const pinnedContents = structuredClone(contents);
  validContents(pinnedContents);
  const {keyset, recoveryKey, vault} = await createLocalKeyset(scope, passphrase);
  try {
    const records = await sealParts(vault, pinnedContents, 0, schemaVersion);
    const bundle = newBundle(scope, keyset.keyId, 0, schemaVersion, records);
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([KEYSETS, BUNDLES], 'readwrite');
        const oldKey = tx.objectStore(KEYSETS).get(scope);
        const oldBundle = tx.objectStore(BUNDLES).get(scope);
        let cause: Error | null = null;
        oldBundle.onsuccess = () => {
          if (oldKey.result !== undefined || oldBundle.result !== undefined) {
            cause = Error('Локальная зашифрованная копия уже существует');
            tx.abort();
            return;
          }
          try {
            tx.objectStore(KEYSETS).put(structuredClone(keyset), scope);
            tx.objectStore(BUNDLES).put(bundle, scope);
          } catch (error) {
            cause = error instanceof Error ? error : Error('Ошибка атомарной записи');
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(cause || tx.error || Error('Ошибка атомарной записи'));
        tx.onabort = () => reject(cause || tx.error || Error('Создание защищённой копии отменено'));
      });
    } finally { db.close(); }
    return {epoch: 0, recoveryKey};
  } finally { vault.lock(); }
}
/** Only a password-wrapped envelope; never returns the raw DEK. */
export async function getAtomicEncryptedKeyset(scope: LocalScope): Promise<LocalKeysetV1 | null> {
  const pair = await readPair(scope);
  return pair ? structuredClone(pair.keyset) : null;
}
/** Access is allowed only through an already-unlocked, scope-bound session. */
export async function readAtomicEncryptedCandidate(
  scope: LocalScope, session: LocalBudgetSession,
): Promise<(ProtectedAtomicContents & {epoch: number; schemaVersion: number}) | null> {
  const lease = session.lifecycleVersion;
  activeSession(session, scope, lease);
  const pair = await readPair(scope);
  activeSession(session, scope, lease);
  if (!pair) return null;
  const {bundle} = pair;
  const data = {} as Record<BundlePart, unknown>;
  for (const [kind] of ITEMS) {
    data[kind] = await session.decrypt(bundle[kind], context(kind, bundle.epoch, bundle.schemaVersion));
  }
  activeSession(session, scope, lease);
  const contents = {snapshot: data.snapshot as Record<string, unknown>,
    outbox: data.outbox as unknown[], conflicts: data.conflicts as unknown[]};
  validContents(contents);
  return {...contents, epoch: bundle.epoch, schemaVersion: bundle.schemaVersion};
}
/**
 * Encrypt all private parts BEFORE starting IDB transaction. Then compare epoch
 * under the native readwrite lock and atomically replace one sealed bundle.
 * A stale caller never overwrites another tab's newer financial work.
 */
export async function compareAndSwapAtomicEncryptedCandidate(
  scope: LocalScope, session: LocalBudgetSession, expectedEpoch: number,
  schemaVersion: number, contents: ProtectedAtomicContents,
): Promise<number> {
  validScope(scope);
  safeInteger(expectedEpoch, 0, Number.MAX_SAFE_INTEGER - 1, 'expectedEpoch');
  safeInteger(schemaVersion, 1, 65535, 'schemaVersion');
  const lease = session.lifecycleVersion;
  activeSession(session, scope, lease);
  const nextEpoch = expectedEpoch + 1;
  const records = await sealParts(session, contents, nextEpoch, schemaVersion);
  activeSession(session, scope, lease);
  const keyId = records.snapshot.keyId;
  const next = newBundle(scope, keyId, nextEpoch, schemaVersion, records);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([KEYSETS, BUNDLES], 'readwrite');
      const keyReq = tx.objectStore(KEYSETS).get(scope);
      const oldReq = tx.objectStore(BUNDLES).get(scope);
      let cause: Error | null = null;
      oldReq.onsuccess = () => {
        try {
          activeSession(session, scope, lease);
          const keyset = keyReq.result as LocalKeysetV1 | undefined;
          const old = oldReq.result as ProtectedAtomicBundle | undefined;
          if (!keyset || !old) throw Error('Защищённая копия отсутствует');
          validateBundle(old, keyset, scope);
          if (old.keyId !== keyId || old.epoch !== expectedEpoch || old.schemaVersion !== schemaVersion) {
            throw Error('Данные изменились в другой вкладке или ключ был заменён');
          }
          tx.objectStore(BUNDLES).put(next, scope);
        } catch (error) {
          cause = error instanceof Error ? error : Error('Ошибка обновления защищённой копии');
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try { activeSession(session, scope, lease); resolve(); }
        catch (error) { reject(error); } // A concurrent logout must not publish success.
      };
      tx.onerror = () => reject(cause || tx.error || Error('Ошибка записи защищённой копии'));
      tx.onabort = () => reject(cause || tx.error || Error('Запись защищённой копии отменена'));
    });
  } finally { db.close(); }
  return nextEpoch;
}
