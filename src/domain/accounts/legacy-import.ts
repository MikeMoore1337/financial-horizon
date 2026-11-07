import type { PersistedFinanceState } from '../../types/finance.ts';

/**
 * A non-destructive, versioned staging manifest, NOT a database/IndexedDB migration.
 * The explicit import workflow in #69 must verify backup and consent, map legacy IDs
 * to UUIDs, then ask for account opening balances. No legacy obligation or loan
 * payment is silently turned into a posted debit.
 */
export interface LegacyLedgerImportManifest {
  schemaVersion: 1;
  sourceVersion: 1 | 2;
  sourceRevision: number | null;
  plannedAccounts: readonly [];
  plannedTransactions: readonly [];
  requiresExplicitOpeningBalances: true;
  entriesCount: number;
  loansCount: number;
  settlementsCount: number;
  loanPaymentsCount: number;
}
export function planLegacyLedgerImport(state: PersistedFinanceState): LegacyLedgerImportManifest {
  if (!state || (state.version !== 1 && state.version !== 2)) throw new Error('Неизвестная версия финансовой базы');
  if (state.version === 2 && (!Number.isSafeInteger(state.revision) || state.revision < 0)) {
    throw new Error('Некорректная ревизия');
  }
  const names = ['entries', 'loans', 'settlements', 'loanPayments'] as const;
  for (const name of names) if (!Array.isArray(state[name])) throw new Error('Повреждённая финансовая база');
  return {
    schemaVersion: 1,
    sourceVersion: state.version,
    sourceRevision: state.version === 2 ? state.revision : null,
    plannedAccounts: [],
    plannedTransactions: [],
    requiresExplicitOpeningBalances: true,
    entriesCount: state.entries.length,
    loansCount: state.loans.length,
    settlementsCount: state.settlements.length,
    loanPaymentsCount: state.loanPayments.length,
  };
}
