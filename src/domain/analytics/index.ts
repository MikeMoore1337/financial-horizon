export { buildAnalyticsTextAlternatives, formatKopecks } from './text-alternatives.ts';
export type { AnalyticsTextAlternatives, BalanceTextRow, CashflowTextRow, CategoryTextRow, ChartTextAlternative } from './text-alternatives.ts';
export { buildAnalyticsReport, percentageChangeBps, compareReportMonths, compareReportPeriods } from './engine.ts';
export { exportAnalyticsCsv } from './csv.ts';
export type {
  AnalyticsCategory, AnalyticsInput, AnalyticsPlan, AnalyticsReport, AnalyticsSnapshot,
  AnalyticsTransaction, CashflowDirection, CategorySummary, ChangeSummary, MonthlySummary,
  PeriodComparison, PeriodTotals, TransactionKind,
} from './types.ts';
export { toAnalyticsTransactions, buildLedgerAnalyticsReport } from './ledger-adapter.ts';
export type { LedgerAnalyticsSnapshot, AnalyticsCategoryAssignment, LedgerAnalyticsInput } from './ledger-adapter.ts';
