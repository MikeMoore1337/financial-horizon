/** Standalone, read-only analytics contract. All money values are integer kopecks (RUB). */
export type TransactionKind = 'income' | 'expense' | 'payment' | 'transfer' | 'adjustment' | 'reservation' | 'reversal';
export type CashflowDirection = 'income' | 'expense';

export interface AnalyticsTransaction {
  id: string;
  date: string; // Valid YYYY-MM-DD; transaction effective date, not write timestamp.
  kind: TransactionKind;
  /** Net signed journal effect across own accounts. Transfers and reservations are zero. */
  signedMinor: number;
  categoryId?: string | null;
  /** A logical void without a compensating journal entry; never combine with a reversal. */
  voidedAt?: string | null;
  /** Mandatory for reversals; the original transaction remains in history. */
  reversedTransactionId?: string | null;
}

export interface AnalyticsCategory {
  id: string;
  name: string;
  archived?: boolean; // Archived categories must remain in historical reports.
}

export interface AnalyticsPlan {
  id: string;
  month: string; // YYYY-MM
  direction: CashflowDirection;
  scope: 'total' | 'category';
  categoryId?: string; // Mandatory for category plan; forbidden for overall plan.
  amountMinor: number;
}

export interface AnalyticsSnapshot {
  date: string;
  balanceMinor: number; // Verified outstanding debt or total accumulated savings as of this date.
}

export interface AnalyticsInput {
  from: string; // Inclusive YYYY-MM-DD.
  to: string; // Inclusive YYYY-MM-DD.
  transactions: readonly AnalyticsTransaction[];
  categories?: readonly AnalyticsCategory[];
  plans?: readonly AnalyticsPlan[];
  /** Already-aggregated, verified TOTAL balances; not individual loan/goal rows. */
  debtSnapshots?: readonly AnalyticsSnapshot[];
  savingsSnapshots?: readonly AnalyticsSnapshot[];
}

export interface MonthlySummary {
  month: string;
  hasActual: boolean;
  incomeMinor: number;
  expenseMinor: number; // Net of reversals; can be negative.
  netMinor: number;
  plannedIncomeMinor: number | null;
  plannedExpenseMinor: number | null;
  expenseVarianceMinor: number | null; // actual - plan; > 0 means overspend.
}

export interface CategorySummary {
  categoryId: string | null;
  name: string;
  archived: boolean;
  hasActual: boolean;
  incomeMinor: number;
  expenseMinor: number;
  plannedExpenseMinor: number | null;
  /** Share of positive net category expenses, basis points (10_000 = 100%). */
  expenseShareBps: number | null;
}

export interface PeriodTotals {
  hasActual: boolean;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  plannedIncomeMinor: number | null;
  plannedExpenseMinor: number | null;
  expenseVarianceMinor: number | null;
}

export interface AnalyticsReport {
  period: { from: string; to: string };
  totals: PeriodTotals;
  monthly: MonthlySummary[];
  categories: CategorySummary[];
  topExpenses: CategorySummary[];
  /** Explicit snapshots only: gaps are unknown, not zero or interpolated. */
  debt: AnalyticsSnapshot[];
  savings: AnalyticsSnapshot[];
  hasDebtHistory: boolean;
  hasSavingsHistory: boolean;
  charts: {
    cashflow: Array<{ month: string; incomeMinor: number | null; expenseMinor: number | null; netMinor: number | null }>;
    expenseShares: Array<{ name: string; categoryId: string | null; amountMinor: number; shareBps: number }>;
    debt: AnalyticsSnapshot[];
    savings: AnalyticsSnapshot[];
  };
}

export interface ChangeSummary {
  previousMinor: number;
  currentMinor: number;
  deltaMinor: number;
  /** null when the previous period has zero base or either period has no actual data. */
  changeBps: number | null;
}

export interface PeriodComparison {
  hasComparableHistory: boolean;
  income: ChangeSummary;
  expense: ChangeSummary;
  net: ChangeSummary;
}
