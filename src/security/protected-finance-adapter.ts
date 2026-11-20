/**
 * Dormant finance-state adapter for an explicitly unlocked encrypted candidate.
 * It intentionally does NOT replace or import legacy storage.js, auth or sync.
 * All writes are atomic encrypted snapshot + outbox + conflict CAS transactions.
 */
import {validateState} from '../../finance.js';
import {migrateState} from '../../state-migrations.ts';
import type {LocalScope} from './local-vault.ts';
import type {LocalBudgetSession} from './local-budget-session.ts';
import {readAtomicEncryptedCandidate, compareAndSwapAtomicEncryptedCandidate} from './protected-atomic-candidate.ts';

export type ProtectedFinanceState = ReturnType<typeof migrateState>;
export type ProtectedFinanceRead = Readonly<{
  state: ProtectedFinanceState;
  epoch: number;
  outbox: unknown[];
  conflicts: unknown[];
}>;

export type ProtectedFinanceUpdateOptions = Readonly<{
  expectedRevision?: number;
  expectedEpoch?: number;
}>;

/**
 * A read-only copy of all encrypted financial data after local unlock.
 * The version check is strict: unknown future schemas cannot be overwritten
 * by a v2-only client. No silent fallback to plaintext legacy IndexedDB.
 */
export async function readProtectedFinance(
  scope: LocalScope,
  session: LocalBudgetSession,
): Promise<ProtectedFinanceRead> {
  const sealed = await readAtomicEncryptedCandidate(scope, session);
  if (!sealed) throw Error('Защищённый локальный бюджет отсутствует');
  if (sealed.schemaVersion !== 2) throw Error('Неподдерживаемая версия защищённого бюджета');
  // Compare the ORIGINAL payload version, before migrateState can upgrade v1
  // in memory. A v1 snapshot mislabeled as a v2 encrypted envelope must not
  // silently become writable under an incorrect schema contract.
  if (sealed.snapshot.version !== sealed.schemaVersion) {
    throw Error('Версия финансового снимка не совпадает с защищённым контейнером');
  }
  const state = migrateState(sealed.snapshot);
  if (state.version !== sealed.schemaVersion) {
    throw Error('Версия финансового снимка не совпадает с защищённым контейнером');
  }
  validateState(state);
  return {
    state: structuredClone(state),
    epoch: sealed.epoch,
    outbox: structuredClone(sealed.outbox),
    conflicts: structuredClone(sealed.conflicts),
  };
}

/**
 * Synchronous user-supplied domain mutation. The callback may edit the finance
 * draft and, explicitly, the pending outbox/conflicts. If no queue mutation is
 * requested they are preserved exactly, in the SAME encrypted IDB commit.
 *
 * This method does not silently retry a CAS conflict. A caller must explicitly
 * refresh/reconcile with the authoritative server as defined by #68.
 */
export async function updateProtectedFinance(
  scope: LocalScope,
  session: LocalBudgetSession,
  change: (state: ProtectedFinanceState, outbox: unknown[], conflicts: unknown[]) => void,
  options: ProtectedFinanceUpdateOptions = {},
): Promise<ProtectedFinanceRead> {
  if (typeof change !== 'function') throw Error('Нужна синхронная финансовая операция');
  const selected = await readProtectedFinance(scope, session);
  if (options.expectedRevision !== undefined &&
    options.expectedRevision !== selected.state.revision) {
    throw Error('Финансовые данные изменились. Обновите страницу и повторите операцию.');
  }
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== selected.epoch) {
    throw Error('Защищённые данные изменились в другой вкладке.');
  }
  if (selected.state.revision === Number.MAX_SAFE_INTEGER) {
    throw Error('Исчерпан счётчик изменений финансовой базы');
  }
  const draft = structuredClone(selected.state);
  const outbox = structuredClone(selected.outbox);
  const conflicts = structuredClone(selected.conflicts);
  const outcome = change(draft, outbox, conflicts) as unknown;
  if (outcome && (typeof outcome === 'object' || typeof outcome === 'function') &&
    'then' in outcome && typeof outcome.then === 'function') {
    // A forbidden async callback may already return a rejected Promise. Attach
    // a rejection handler before refusing the mutation, otherwise an orphaned
    // rejection can crash Node or trigger browser unhandledrejection.
    void Promise.resolve(outcome).catch(() => {});
    throw Error('Асинхронные операции внутри финансового обновления запрещены');
  }
  const updated = migrateState(draft);
  updated.revision = selected.state.revision + 1;
  validateState(updated);
  // Web Crypto encrypts all three parts BEFORE IndexedDB's native write lock.
  // An account switch or stale epoch aborts the entire operation.
  const newEpoch = await compareAndSwapAtomicEncryptedCandidate(scope, session, selected.epoch, 2, {
    snapshot: updated as unknown as Record<string, unknown>, outbox, conflicts,
  });
  return {state: updated, epoch: newEpoch, outbox, conflicts};
}
