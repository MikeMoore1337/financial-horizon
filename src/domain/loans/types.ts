/** Strictly versioned, self-contained loan calculation contract; no storage side effects. */
export type DayCount = 'ACT/365F' | 'ACT/360' | 'ACT/ACT-ISDA' | '30E/360';
export type Rounding = 'HALF_UP' | 'HALF_EVEN';
export type ScheduleType = 'annuity' | 'differentiated';
export type RepaymentStrategy = 'shorten-term' | 'reduce-payment';

export interface LoanTerms {
  principalCents: number;
  startDate: string;
  firstDueDate: string;
  termMonths: number;
  annualRateMicroPercent: number; // 9.5% = 9_500_000. Never pass floating APR.
  dayCount: DayCount;
  rounding: Rounding;
  scheduleType: ScheduleType;
  paymentCents?: number; // Optional contractual fixed annuity payment.
  rateChangePolicy?: 'recalculate' | 'keep-payment';
  maxExtensionMonths?: number; // Default 240, max 1200 total scheduled months.
}

interface BaseEvent {
  id: string;
  date: string;
  voidedAt?: string | null; // Voiding preserves the event's audit trail.
}
export interface PaymentEvent extends BaseEvent {
  type: 'payment';
  paymentKind: 'regular' | 'extra';
  amountCents: number;
  strategy?: RepaymentStrategy; // Only applicable to an extra payment.
}
export interface RateChangeEvent extends BaseEvent {
  type: 'rate-change';
  annualRateMicroPercent: number;
}
export interface DueDateChangeEvent extends BaseEvent {
  type: 'due-date-change';
  dayOfMonth: number; // Takes effect from the following calendar month.
}
export type LoanEvent = PaymentEvent | RateChangeEvent | DueDateChangeEvent;

export interface LoanRow {
  period: number;
  date: string;
  kind: 'planned' | 'actual' | 'forecast';
  plannedPaymentCents: number;
  amountCents: number; // Amount paid, zero for missed actual due dates.
  interestCents: number; // Interest charged in this period, not necessarily paid.
  interestPaidCents: number;
  principalCents: number;
  balanceCents: number;
  unpaidInterestCents: number;
  extraPaidCents: number;
}
export interface LoanHistoryRecord {
  id: string;
  date: string;
  type: LoanEvent['type'];
  amountCents?: number;
  interestPaidCents?: number;
  principalPaidCents?: number;
  balanceCents: number;
  unpaidInterestCents: number;
  annualRateMicroPercent?: number;
  dayOfMonth?: number;
}
export interface LoanResult {
  rows: LoanRow[];
  history: LoanHistoryRecord[];
  /** Factual payments between the last due date and asOfDate, never synthetic. */
  actualOpenPeriod: {
    asOfDate: string;
    amountCents: number;
    interestPaidCents: number;
    principalCents: number;
    extraPaidCents: number;
  } | null;
  principalBalanceCents: number;
  unpaidInterestCents: number;
  accruedInterestCents: number;
  remainingDebtCents: number;
  scheduledPaymentCents: number;
  paidOffDate: string | null;
  nextDueDate: string | null;
  complete: boolean;
  /** Always true: no claim of bank-specific parity without an accepted contract. */
  bankParityVerified: false;
}
export interface LoanRunOptions {
  mode: 'plan' | 'actual' | 'forecast';
  /** Required for actual/forecast; no future payment is treated as factual. */
  asOfDate?: string;
}
export interface BankScheduleRow {
  date: string;
  amountCents: number;
  interestCents?: number | null;
  principalCents?: number | null;
  balanceCents?: number | null;
}
export interface ScheduleDifference {
  period: number;
  calculated: BankScheduleRow | null;
  imported: BankScheduleRow | null;
  dateDifferenceDays: number | null;
  amountDeltaCents: number | null;
  interestDeltaCents: number | null;
  principalDeltaCents: number | null;
  balanceDeltaCents: number | null;
  differs: boolean;
}
export interface ScheduleReconciliation {
  rows: ScheduleDifference[];
  mismatchedRows: number;
  calculatedClosureDate: string | null;
  importedClosureDate: string | null;
  closureDateDifferenceDays: number | null;
  exactMatch: boolean;
}
