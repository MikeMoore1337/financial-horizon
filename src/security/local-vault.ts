/** Standalone at-rest cryptography. No browser storage, auth, network or UI side effects. */
const FORMAT = 'financial-horizon.local-keyset';
const RECORD_FORMAT = 'financial-horizon.local-record';
const VERSION = 1;
const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_PLAINTEXT = 4_000_000;
const MAX_CIPHERTEXT = MAX_PLAINTEXT + 16;

export type LocalScope = `account:${string}` | `guest:${string}`;
export type RecordContext = Readonly<{
  kind: string;
  recordId: string;
  schemaVersion: number;
  revision: number;
}>;
type PassphraseSlot = {
  kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; ciphertext: string;
};
type RecoverySlot = {
  kdf: 'HKDF-SHA256'; salt: string; iv: string; ciphertext: string;
};
export type LocalKeysetV1 = {
  format: typeof FORMAT; version: 1; scope: LocalScope; keyId: string;
  passphrase: PassphraseSlot; recovery: RecoverySlot;
};
export type EncryptedLocalRecordV1 = {
  format: typeof RECORD_FORMAT; version: 1; algorithm: 'AES-256-GCM';
  scope: LocalScope; keyId: string; kind: string; recordId: string;
  schemaVersion: number; revision: number; iv: string; ciphertext: string;
};

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('Web Crypto API недоступен в защищённом контексте');
  }
  return globalThis.crypto;
}
function random(length: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(length);
  webCrypto().getRandomValues(result);
  return result;
}
function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(value: unknown, size?: number, max = 6_000_000): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('Некорректное кодирование защищённых данных');
  }
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  } catch {
    throw new Error('Некорректное кодирование защищённых данных');
  }
  if (b64(decoded) !== value || (size !== undefined && decoded.length !== size)) {
    throw new Error('Некорректная длина защищённых данных');
  }
  return decoded;
}
function scopeValid(value: unknown): asserts value is LocalScope {
  if (typeof value !== 'string' || !(/^(?:account:[a-f0-9]{32}|guest:[A-Za-z0-9_-]{4,64})$/.test(value))) {
    throw new Error('Некорректная область локального бюджета');
  }
}
function keyIdValid(value: unknown): asserts value is string {
  unb64(value, 16, 40);
}
function contextValid(value: RecordContext): void {
  exactFields(value, ['kind', 'recordId', 'schemaVersion', 'revision']);
  if (!value || typeof value.kind !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.kind) ||
    typeof value.recordId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.recordId) ||
    !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 65535 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('Некорректные метаданные финансовой записи');
  }
}
function exactFields(value: unknown, names: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    Object.keys(value).some(name => !names.includes(name))) {
    throw Error('Некорректная структура защищённых данных');
  }
}
function passphraseValid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.normalize('NFC').length < 12 || value.length > 1024) {
    throw new Error('Нужна отдельная парольная фраза длиной от 12 до 1024 символов');
  }
}
function encode(value: unknown): Uint8Array<ArrayBuffer> { return encoder.encode(JSON.stringify(value)); }
function aadSlot(scope: LocalScope, keyId: string, slot: 'passphrase' | 'recovery', salt: string, iterations: number | null): Uint8Array<ArrayBuffer> {
  return encode([FORMAT, VERSION, scope, keyId, slot, salt, iterations]);
}
function aadRecord(value: Pick<EncryptedLocalRecordV1, 'scope' | 'keyId' | 'kind' | 'recordId' | 'schemaVersion' | 'revision'>): Uint8Array<ArrayBuffer> {
  return encode([RECORD_FORMAT, VERSION, 'AES-256-GCM', value.scope, value.keyId, value.kind, value.recordId, value.schemaVersion, value.revision]);
}
async function passwordKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const passwordBytes = encoder.encode(passphrase.normalize('NFC'));
  let material: CryptoKey;
  try { material = await webCrypto().subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']); }
  finally { passwordBytes.fill(0); }
  return webCrypto().subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function recoveryKey(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, scope: LocalScope, keyId: string): Promise<CryptoKey> {
  const material = await webCrypto().subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return webCrypto().subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info: encode(['FH-local-recovery-v1', scope, keyId])}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function wrap(raw: Uint8Array<ArrayBuffer>, key: CryptoKey, aad: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>): Promise<string> {
  return b64(new Uint8Array(await webCrypto().subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad, tagLength: 128}, key, raw)));
}
async function newPassphraseSlot(raw: Uint8Array<ArrayBuffer>, passphrase: string, scope: LocalScope, keyId: string): Promise<PassphraseSlot> {
  passphraseValid(passphrase);
  const salt = random(16), iv = random(12), encodedSalt = b64(salt);
  const key = await passwordKey(passphrase, salt, ITERATIONS);
  return {kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: encodedSalt, iv: b64(iv), ciphertext: await wrap(raw, key, aadSlot(scope, keyId, 'passphrase', encodedSalt, ITERATIONS), iv)};
}
async function newRecoverySlot(raw: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>, scope: LocalScope, keyId: string): Promise<RecoverySlot> {
  const salt = random(16), iv = random(12), encodedSalt = b64(salt);
  const key = await recoveryKey(secret, salt, scope, keyId);
  return {kdf: 'HKDF-SHA256', salt: encodedSalt, iv: b64(iv), ciphertext: await wrap(raw, key, aadSlot(scope, keyId, 'recovery', encodedSalt, null), iv)};
}
function validateKeyset(value: LocalKeysetV1): void {
  if (!value || value.format !== FORMAT || value.version !== VERSION) throw new Error('Неподдерживаемая версия ключей');
  exactFields(value, ['format', 'version', 'scope', 'keyId', 'passphrase', 'recovery']);
  scopeValid(value.scope); keyIdValid(value.keyId);
  exactFields(value.passphrase, ['kdf', 'iterations', 'salt', 'iv', 'ciphertext']);
  exactFields(value.recovery, ['kdf', 'salt', 'iv', 'ciphertext']);
  if (!value.passphrase || value.passphrase.kdf !== 'PBKDF2-SHA256' ||
    !Number.isSafeInteger(value.passphrase.iterations) || value.passphrase.iterations < ITERATIONS || value.passphrase.iterations > 2_000_000 ||
    !value.recovery || value.recovery.kdf !== 'HKDF-SHA256') throw new Error('Неподдерживаемые параметры ключей');
  for (const slot of [value.passphrase, value.recovery]) {
    unb64(slot.salt, 16, 32); unb64(slot.iv, 12, 24); unb64(slot.ciphertext, 48, 80);
  }
}
async function unlockRaw(keyset: LocalKeysetV1, credential: {passphrase: string} | {recoveryKey: string}): Promise<Uint8Array<ArrayBuffer>> {
  validateKeyset(keyset);
  if (!credential || typeof credential !== 'object' ||
    (('passphrase' in credential) === ('recoveryKey' in credential))) {
    throw Error('Требуется один локальный ключ разблокирования');
  }
  const slotName = 'passphrase' in credential ? 'passphrase' : 'recovery';
  if (slotName === 'passphrase') {
    const supplied = (credential as {passphrase: string}).passphrase;
    // Reject oversized/unusable inputs before running an expensive PBKDF2 derivation.
    if (typeof supplied !== 'string' || supplied.length > 1024 || supplied.normalize('NFC').length < 12) {
      throw Error('Неверный ключ или повреждённые данные');
    }
  }
  const slot = keyset[slotName];
  const salt = unb64(slot.salt, 16, 32);
  let key: CryptoKey;
  if (slotName === 'passphrase') {
    key = await passwordKey((credential as {passphrase: string}).passphrase, salt, keyset.passphrase.iterations);
  } else {
    const secret = unb64((credential as {recoveryKey: string}).recoveryKey, 32, 50);
    try { key = await recoveryKey(secret, salt, keyset.scope, keyset.keyId); }
    finally { secret.fill(0); }
  }
  try {
    const raw = new Uint8Array(await webCrypto().subtle.decrypt({name: 'AES-GCM', iv: unb64(slot.iv, 12, 24),
      additionalData: aadSlot(keyset.scope, keyset.keyId, slotName, slot.salt, slotName === 'passphrase' ? keyset.passphrase.iterations : null), tagLength: 128}, key, unb64(slot.ciphertext, 48, 80)));
    if (raw.length !== 32) { raw.fill(0); throw Error('invalid key'); }
    return raw;
  } catch {
    throw new Error('Неверный ключ или повреждённые данные');
  }
}

/** An ephemeral, non-extractable DEK. Calls after lock() always fail closed. */
export class LocalVault {
  #key: CryptoKey | null;
  #generation = 0;
  readonly scope: LocalScope;
  readonly keyId: string;
  constructor(key: CryptoKey, scope: LocalScope, keyId: string) {
    scopeValid(scope); keyIdValid(keyId);
    const algorithm = key.algorithm as AesKeyAlgorithm;
    if (key.type !== 'secret' || key.extractable || algorithm.name !== 'AES-GCM' || algorithm.length !== 256 ||
      !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) {
      throw Error('Допустим только неизвлекаемый ключ AES-256-GCM');
    }
    this.#key = key;
    this.scope = scope;
    this.keyId = keyId;
    // `readonly` has no runtime meaning in JavaScript; isolate the scope binding.
    // Private #key/#generation fields remain mutable so lock() still works.
    Object.freeze(this);
  }
  get unlocked(): boolean { return this.#key !== null; }
  lock(): void { this.#generation++; this.#key = null; }
  async encrypt(value: unknown, context: RecordContext): Promise<EncryptedLocalRecordV1> {
    const key = this.#key, generation = this.#generation;
    if (!key) throw Error('Локальный бюджет заблокирован');
    contextValid(context);
    const plain = JSON.stringify(value);
    if (typeof plain !== 'string') throw Error('Нельзя зашифровать пустое значение');
    const bytes = encoder.encode(plain);
    let iv: Uint8Array<ArrayBuffer>;
    let encrypted: ArrayBuffer;
    const header = {format: RECORD_FORMAT, version: VERSION, algorithm: 'AES-256-GCM', scope: this.scope, keyId: this.keyId, kind: context.kind, recordId: context.recordId, schemaVersion: context.schemaVersion, revision: context.revision} as const;
    try {
      if (bytes.length > MAX_PLAINTEXT) throw Error('Финансовая запись слишком большая');
      iv = random(12);
      encrypted = await webCrypto().subtle.encrypt({name: 'AES-GCM', iv, additionalData: aadRecord(header), tagLength: 128}, key, bytes);
    } finally { bytes.fill(0); }
    if (this.#generation !== generation) throw Error('Локальный бюджет заблокирован');
    return {...header, iv: b64(iv), ciphertext: b64(new Uint8Array(encrypted))};
  }
  async decrypt(record: EncryptedLocalRecordV1, expected: RecordContext): Promise<unknown> {
    const key = this.#key, generation = this.#generation;
    if (!key) throw Error('Локальный бюджет заблокирован');
    contextValid(expected);
    exactFields(record, ['format', 'version', 'algorithm', 'scope', 'keyId', 'kind', 'recordId', 'schemaVersion', 'revision', 'iv', 'ciphertext']);
    if (!record || record.format !== RECORD_FORMAT || record.version !== VERSION || record.algorithm !== 'AES-256-GCM' ||
      record.scope !== this.scope || record.keyId !== this.keyId || record.kind !== expected.kind ||
      record.recordId !== expected.recordId || record.schemaVersion !== expected.schemaVersion || record.revision !== expected.revision) {
      throw Error('Область, версия или метаданные зашифрованной записи не совпадают');
    }
    const iv = unb64(record.iv, 12, 24);
    const ciphertext = unb64(record.ciphertext, undefined, 5_500_000);
    if (ciphertext.length < 16 || ciphertext.length > MAX_CIPHERTEXT) throw Error('Недопустимый размер шифротекста');
    try {
      const plaintext = await webCrypto().subtle.decrypt({name: 'AES-GCM', iv, additionalData: aadRecord(record), tagLength: 128}, key, ciphertext);
      const bytes = new Uint8Array(plaintext);
      try {
        if (this.#generation !== generation) throw Error('Локальный бюджет заблокирован');
        return JSON.parse(decoder.decode(bytes));
      } finally { bytes.fill(0); }
    } catch {
      if (this.#generation !== generation) throw Error('Локальный бюджет заблокирован');
      throw Error('Неверный ключ или повреждённые данные');
    }
  }
}
async function asVault(raw: Uint8Array<ArrayBuffer>, scope: LocalScope, keyId: string): Promise<LocalVault> {
  const key = await webCrypto().subtle.importKey('raw', raw, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  return new LocalVault(key, scope, keyId);
}
/** Caller persists only `keyset` and ciphertext. Display `recoveryKey` once, never persist it. */
export async function createLocalKeyset(scope: LocalScope, passphrase: string): Promise<{keyset: LocalKeysetV1; recoveryKey: string; vault: LocalVault}> {
  scopeValid(scope); passphraseValid(passphrase);
  const raw = random(32), recoverySecret = random(32), keyId = b64(random(16));
  try {
    const [passphraseSlot, recoverySlot] = await Promise.all([
      newPassphraseSlot(raw, passphrase, scope, keyId), newRecoverySlot(raw, recoverySecret, scope, keyId)
    ]);
    const vault = await asVault(raw, scope, keyId);
    return {keyset: {format: FORMAT, version: 1, scope, keyId, passphrase: passphraseSlot, recovery: recoverySlot}, recoveryKey: b64(recoverySecret), vault};
  } finally { raw.fill(0); recoverySecret.fill(0); }
}
export async function unlockLocalKeyset(keyset: LocalKeysetV1, credential: {passphrase: string} | {recoveryKey: string}, expectedScope: LocalScope): Promise<LocalVault> {
  // An untrusted caller may mutate an IndexedDB-sourced object while Web Crypto awaits.
  // Pin the entire envelope (including nested slots) before validation/first await.
  const pinned = structuredClone(keyset);
  validateKeyset(pinned); scopeValid(expectedScope);
  if (pinned.scope !== expectedScope) throw Error('Нельзя открыть бюджет другого пользователя');
  const raw = await unlockRaw(pinned, credential);
  try { return await asVault(raw, pinned.scope, pinned.keyId); }
  finally { raw.fill(0); }
}
/** Changes only the passphrase wrapper; no record re-encryption and no change to recovery material. */
export async function changeLocalPassphrase(keyset: LocalKeysetV1, credential: {passphrase: string} | {recoveryKey: string}, newPassphrase: string, expectedScope: LocalScope): Promise<LocalKeysetV1> {
  const pinned = structuredClone(keyset);
  validateKeyset(pinned); scopeValid(expectedScope); passphraseValid(newPassphrase);
  if (pinned.scope !== expectedScope) throw Error('Нельзя открыть бюджет другого пользователя');
  const raw = await unlockRaw(pinned, credential);
  try { return {...pinned, passphrase: await newPassphraseSlot(raw, newPassphrase, pinned.scope, pinned.keyId)}; }
  finally { raw.fill(0); }
}