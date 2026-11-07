/**
 * Staging-only encrypted IndexedDB. Deliberately not imported by storage.js, UI,
 * auth, sync or the Service Worker. It NEVER reads, modifies or deletes legacy DBs.
 *
 * A caller MUST first validate the financial schema, decrypt & independently
 * verify the user's saved legacy backup, and obtain explicit opt-in. Those gates
 * cannot be inferred or enforced by a standalone persistence adapter.
 */
import {
  createLocalKeyset, unlockLocalKeyset,
  type LocalKeysetV1, type LocalScope, type RecordContext,
  type EncryptedLocalRecordV1,
} from './local-vault.ts';

export const PROTECTED_STAGING_DB = 'financial-horizon-protected-staging-v1';
const KEYSETS = 'keysets', RECORDS = 'records';
const VERSION = 1;
const FORMAT = 'financial-horizon.staged-snapshot';

type StagedRow = {
  format: typeof FORMAT;
  version: 1;
  scope: LocalScope;
  record: EncryptedLocalRecordV1;
};

type Stored = { keyset: LocalKeysetV1; row: StagedRow };
export type StagedSnapshot = Readonly<{
  state: unknown;
  context: RecordContext;
}>;
export type StagingResult = Readonly<
  {status: 'created'; recoveryKey: string} | {status: 'already-staged'; recoveryKey: null}
>;

function validateScope(value: unknown): asserts value is LocalScope {
  if (typeof value !== 'string' ||
    !/^(?:account:[a-f0-9]{32}|guest:[A-Za-z0-9_-]{4,64})$/.test(value)) {
    throw Error('Некорректный финансовый профиль');
  }
}
function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function readContext(row: StagedRow, scope: LocalScope): RecordContext {
  if (!row || row.format !== FORMAT || row.version !== VERSION || row.scope !== scope ||
    !row.record || row.record.scope !== scope || row.record.kind !== 'snapshot' ||
    row.record.recordId !== 'state') {
    throw Error('Повреждён защищённый контейнер');
  }
  return {
    kind: row.record.kind,
    recordId: row.record.recordId,
    schemaVersion: row.record.schemaVersion,
    revision: row.record.revision,
  };
}

async function openDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw Error('IndexedDB недоступна');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROTECTED_STAGING_DB, VERSION);
    let finished = false;
    const fail = (reason: Error) => {
      if (finished) return;
      finished = true;
      reject(reason);
    };
    request.onblocked = () => fail(Error('Закройте другие вкладки для обновления защищённого хранилища'));
    request.onerror = () => fail(request.error || Error('Не удалось открыть защищённое хранилище'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEYSETS)) db.createObjectStore(KEYSETS);
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
    };
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true;
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function readRaw(scope: LocalScope): Promise<Stored | null> {
  validateScope(scope);
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([KEYSETS, RECORDS], 'readonly');
      let keyset: LocalKeysetV1 | undefined;
      let row: StagedRow | undefined;
      tx.objectStore(KEYSETS).get(scope).onsuccess = event => {
        keyset = (event.target as IDBRequest<LocalKeysetV1>).result;
      };
      tx.objectStore(RECORDS).get(scope).onsuccess = event => {
        row = (event.target as IDBRequest<StagedRow>).result;
      };
      tx.oncomplete = () => {
        if (keyset === undefined && row === undefined) { resolve(null); return; }
        if (!keyset || !row || keyset.scope !== scope || row.scope !== scope ||
          keyset.keyId !== row.record?.keyId) {
          reject(Error('Повреждено защищённое хранилище'));
          return;
        }
        resolve({keyset, row});
      };
      tx.onerror = () => reject(tx.error || Error('Ошибка чтения защищённых данных'));
      tx.onabort = () => reject(tx.error || Error('Чтение защищённых данных прервано'));
    });
  } finally { db.close(); }
}

/** Offline unlock after browser restart. Never accesses the old plaintext IDB. */
export async function readStagedSnapshot(
  scope: LocalScope,
  credential: {passphrase: string} | {recoveryKey: string},
  expectedRevision?: number,
): Promise<StagedSnapshot | null> {
  const stored = await readRaw(scope);
  if (!stored) return null;
  const context = readContext(stored.row, scope);
  if (expectedRevision !== undefined && context.revision !== expectedRevision) {
    throw Error('Изменилась ревизия защищённого бюджета');
  }
  const vault = await unlockLocalKeyset(stored.keyset, credential, scope);
  try {
    const state = await vault.decrypt(stored.row.record, context);
    return {state, context};
  } finally { vault.lock(); }
}

async function commitNew(scope: LocalScope, keyset: LocalKeysetV1, row: StagedRow): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([KEYSETS, RECORDS], 'readwrite');
      const getKey = tx.objectStore(KEYSETS).get(scope);
      const getRow = tx.objectStore(RECORDS).get(scope);
      let keyExists = false, rowExists = false;
      let error: Error | null = null;
      getKey.onsuccess = () => { keyExists = getKey.result !== undefined; };
      getRow.onsuccess = () => {
        rowExists = getRow.result !== undefined;
        if (keyExists || rowExists) {
          error = Error('Защищённая копия уже создана в другой вкладке');
          tx.abort();
          return;
        }
        try {
          tx.objectStore(KEYSETS).put(keyset, scope);
          tx.objectStore(RECORDS).put(row, scope);
        } catch (cause) {
          error = cause instanceof Error ? cause : Error('Ошибка атомарной записи');
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(error || tx.error || Error('Ошибка записи защищённой копии'));
      tx.onabort = () => reject(error || tx.error || Error('Атомарная запись защищённой копии прервана'));
    });
  } finally { db.close(); }
}

/**
 * Stage an immutable, validated-by-caller legacy snapshot WITHOUT activating it.
 * The source remains intact for rollback. A retry verifies the exact same data;
 * it never overwrites a previously staged copy or silently rotates its keys.
 *
 * Returning `recoveryKey` happens ONLY after the atomic IDB commit succeeds.
 * The caller must show it once and require an independently saved copy. On retry
 * there is NO NEW recovery key: the original keyset is retained unchanged.
 */
export async function stageProtectedSnapshot(
  scope: LocalScope,
  state: unknown,
  context: RecordContext,
  passphrase: string,
): Promise<StagingResult> {
  validateScope(scope);
  if (!context || context.kind !== 'snapshot' || context.recordId !== 'state') {
    throw Error('Допустим только зашифрованный снимок бюджета');
  }
  // Snapshot the source before any async operation; never trust a mutable caller.
  const source = structuredClone(state);
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw Error('Некорректный финансовый снимок');
  }
  const descriptor = structuredClone(context);
  const prior = await readRaw(scope);
  if (prior) {
    const previousContext = readContext(prior.row, scope);
    if (!sameJSON(previousContext, descriptor)) throw Error('Уже сохранён другой снимок бюджета');
    const vault = await unlockLocalKeyset(prior.keyset, {passphrase}, scope);
    try {
      const actual = await vault.decrypt(prior.row.record, previousContext);
      if (!sameJSON(actual, source)) throw Error('Изменились данные после подготовки копии');
      return {status: 'already-staged', recoveryKey: null};
    } finally {vault.lock();}
  }
  const {keyset, recoveryKey, vault} = await createLocalKeyset(scope, passphrase);
  try {
    const record = await vault.encrypt(source, descriptor);
    if (!sameJSON(await vault.decrypt(record, descriptor), source)) {
      throw Error('Не прошла проверка зашифрованной копии');
    }
    const row: StagedRow = {format: FORMAT, version: VERSION, scope, record};
    await commitNew(scope, structuredClone(keyset), row);
    return {status: 'created', recoveryKey};
  } finally {vault.lock();}
}
