/**
 * In-memory local unlock lifecycle for the approved #34 user flow.
 * This module does not load/save storage, select the authenticated account,
 * hook logout, change UI, or enable protected-storage cutover.
 */
import {
  unlockLocalKeyset,
  type EncryptedLocalRecordV1,
  type LocalKeysetV1,
  type LocalScope,
  type RecordContext,
  type LocalVault,
} from './local-vault.ts';

export type LocalUnlockCredential = Readonly<{passphrase: string}> | Readonly<{recoveryKey: string}>;
export type LocalBudgetLockState = 'unselected' | 'locked' | 'unlocked';

const LOCKED = 'Локальный бюджет заблокирован';
const VALID_SCOPE = /^(?:account:[a-f0-9]{32}|guest:[A-Za-z0-9_-]{4,64})$/;

/** An explicit account/guest selection is required before every unlock. */
export class LocalBudgetSession {
  #scope: LocalScope | null = null;
  #vault: LocalVault | null = null;
  #generation = 0;

  get state(): LocalBudgetLockState {
    if (this.#scope === null) return 'unselected';
    return this.#vault?.unlocked ? 'unlocked' : 'locked';
  }

  get selectedScope(): LocalScope | null { return this.#scope; }
  /** Public fencing counter, not an auth credential. It changes on every lock/unlock. */
  get lifecycleVersion(): number { return this.#generation; }

  /** Must be called with a verified session user ID or an explicit guest scope. */
  selectScope(scope: LocalScope): void {
    // An invalid *new* identity must not leave the previous account unlocked.
    // Always revoke the old identity before validating the replacement.
    this.lock();
    this.#scope = null;
    if (typeof scope !== 'string' || !VALID_SCOPE.test(scope)) {
      throw Error('Некорректная область локального бюджета');
    }
    // Even reselecting the same scope requires a fresh local unlock. Do not
    // infer encryption-key possession from a refreshed server auth cookie.
    this.#scope = scope;
  }

  /** Drop the active key and invalidate all in-flight crypto operations. */
  lock(): void {
    this.#generation++;
    this.#vault?.lock();
    this.#vault = null;
  }

  /** The host must clear its financial state/DOM and stop sync separately. */
  logout(): void {
    this.lock();
    this.#scope = null;
  }

  /**
   * Never persists keys or a remembered-unlocked flag. If a later account
   * selection, logout, lock, or unlock occurs during KDF, discard the result.
   */
  async unlock(keyset: LocalKeysetV1, credential: LocalUnlockCredential): Promise<void> {
    const scope = this.#scope;
    if (scope === null) throw Error(LOCKED);
    this.lock();
    const generation = this.#generation;
    let opened: LocalVault;
    try {
      opened = await unlockLocalKeyset(keyset, credential, scope);
    } catch (error) {
      if (generation !== this.#generation || this.#scope !== scope) throw Error(LOCKED);
      throw error;
    }
    if (generation !== this.#generation || this.#scope !== scope) {
      opened.lock();
      throw Error(LOCKED);
    }
    this.#vault = opened;
  }

  async decrypt(record: EncryptedLocalRecordV1, context: RecordContext): Promise<unknown> {
    const vault = this.#vault, generation = this.#generation;
    if (!vault?.unlocked) throw Error(LOCKED);
    const result = await vault.decrypt(record, context);
    if (generation !== this.#generation || vault !== this.#vault) throw Error(LOCKED);
    return result;
  }

  async encrypt(value: unknown, context: RecordContext): Promise<EncryptedLocalRecordV1> {
    const vault = this.#vault, generation = this.#generation;
    if (!vault?.unlocked) throw Error(LOCKED);
    const result = await vault.encrypt(value, context);
    if (generation !== this.#generation || vault !== this.#vault) throw Error(LOCKED);
    return result;
  }
}
