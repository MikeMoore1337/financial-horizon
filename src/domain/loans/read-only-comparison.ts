/**
 * #39: pure read-only loan comparison model for the future approved React UI.
 * No IO, no real-payment import, no ledger writes, no migration, no bank parity claim.
 */
import { calculateLoan } from './engine.ts';
import { prepareLegacyLoanPreview } from './legacy-preview.ts';
import { reconcileLoanSchedule } from './reconcile.ts';
import type {
  ExplicitLoanTermsSelection,
  LegacyLoanPreviewGate,
  StoredLoanSnapshot,
} from './legacy-preview.ts';
import type { BankScheduleRow, LoanResult, ScheduleReconciliation } from './types.ts';

export type LoanComparisonStatus =
  | 'needs-confirmation'
  | 'no-bank-schedule'
  | 'incomplete-bank-evidence'
  | 'numerical-match'
  | 'differences';

export type ReadOnlyLoanComparison =
  | {
      status: 'needs-confirmation';
      missing: LegacyLoanPreviewGate['missing'];
      plan: null;
      bankComparison: null;
      bankParityVerified: false;
      historicalPaymentsImported: false;
      storedDataChanged: false;
    }
  | {
      status: Exclude<LoanComparisonStatus, 'needs-confirmation'>;
      missing: [];
      plan: LoanResult;
      bankComparison: ScheduleReconciliation | null;
      bankParityVerified: false;
      historicalPaymentsImported: false;
      storedDataChanged: false;
    };

/**
 * Produces a contract-confirmed *plan*, not a factual loan statement.
 *
 * `bankRows` must contain the FULL imported CSV, not the four display rows
 * used by the current Loans screen. Without the full bank schedule or without
 * confirmed terms, no numerical comparison is advertised.
 *
 * No legacy LoanPayment event is transformed into a model payment here:
 * immutable payment/link semantics belong to #33/#67/#68/#69.
 */
export function prepareReadOnlyLoanComparison(
  snapshot: StoredLoanSnapshot,
  approved: ExplicitLoanTermsSelection = {},
  bankRows: readonly BankScheduleRow[] | null = null,
): ReadOnlyLoanComparison {
  const gate = prepareLegacyLoanPreview(snapshot, approved);
  if (gate.status !== 'ready' || gate.terms === null) {
    return {
      status: 'needs-confirmation',
      missing: gate.missing,
      plan: null,
      bankComparison: null,
      bankParityVerified: false,
      historicalPaymentsImported: false,
      storedDataChanged: false,
    };
  }

  // Mode plan does not interpret stored ledger history as verified bank payments.
  const plan = calculateLoan(gate.terms, [], { mode: 'plan' });
  if (bankRows === null || bankRows.length === 0) {
    return {
      status: 'no-bank-schedule',
      missing: [],
      plan,
      bankComparison: null,
      bankParityVerified: false,
      historicalPaymentsImported: false,
      storedDataChanged: false,
    };
  }
  const bankComparison = reconcileLoanSchedule(plan, bankRows);
  const status: Exclude<LoanComparisonStatus, 'needs-confirmation'> =
    bankComparison.exactMatch ? 'numerical-match'
    : bankComparison.matchingKnownFields
      ? 'incomplete-bank-evidence'
      : 'differences';

  return {
    status,
    missing: [],
    plan,
    bankComparison,
    bankParityVerified: false,
    historicalPaymentsImported: false,
    storedDataChanged: false,
  };
}
