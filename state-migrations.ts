import { validateState } from './finance.js';
import type { FinanceStateV1, FinanceStateV2, PersistedFinanceState } from './src/types/finance.ts';

// The IndexedDB database itself remains schema version 1; this is payload v2.
export const CURRENT_STATE_VERSION = 2 as const;
type MutableState = Omit<FinanceStateV2, 'version' | 'revision'> & {
  version: 1 | 2;
  revision?: number;
};

const steps = new Map<number, (state: MutableState) => void>([
  [
    1,
    (state) => {
      state.version = 2;
      state.revision = 0; // Concurrency marker; never a money field.
    },
  ],
]);

export function migrateState(source: unknown): FinanceStateV2 {
  const checked = validateState(source) as PersistedFinanceState;
  // Optional entry sub-schema v1: old records without methods stay byte-for-byte intact.
  // Only records already carrying methods but missing their marker require a rewrite.
  const needsMethodsMarker = checked.entries.some(
    (entry) => entry.paymentMethods !== undefined && entry.paymentMethodsVersion === undefined,
  );
  if (checked.version === CURRENT_STATE_VERSION && !needsMethodsMarker) return checked;
  const result = structuredClone(checked) as MutableState;
  while (result.version < CURRENT_STATE_VERSION) {
    const step = steps.get(result.version);
    if (!step) throw Error('Для этой версии финансовой базы нет безопасной миграции');
    step(result);
    validateState(result);
  }
  for (const entry of result.entries) {
    if (entry.paymentMethods !== undefined && entry.paymentMethodsVersion === undefined)
      entry.paymentMethodsVersion = 1;
  }
  validateState(result);
  return result as FinanceStateV2;
}

// Only for an explicitly authorized, quiesced rollback, never normal startup.
export function downgradeStateForRollback(source: unknown): PersistedFinanceState {
  const checked = validateState(source) as PersistedFinanceState;
  const previous = structuredClone(checked) as MutableState;
  if (previous.version === 2) {
    delete previous.revision;
    previous.version = 1;
  }
  return validateState(previous) as FinanceStateV1 | FinanceStateV2;
}
