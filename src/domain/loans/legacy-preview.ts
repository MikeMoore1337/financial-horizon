/**
 * Financial Horizon #39: read-only boundary between legacy APR/12 records
 * and a separately chosen exact daily loan model.
 *
 * Never infer bank day-count/rounding, a valuation date or a real payment
 * event from a legacy saved loan. This module performs NO storage writes.
 */
import type { FinanceLoan } from '../../types/finance.ts';
import { assertMoney, assertRate, calendarDays, parseDate } from './math.ts';
import type { DayCount, LoanTerms, Rounding, ScheduleType } from './types.ts';

export type StoredLoanSnapshot = Pick<
  FinanceLoan,
  'openingCents' | 'paymentCents' | 'termMonths' | 'dueDay' | 'asOfDate'
>;

export interface ExplicitLoanTermsSelection {
  /** User confirmed which bank contract/version applies to the preview. */
  agreementConfirmed?: true;
  /**
   * Confirm the stored openingCents is the principal (without arrears or
   * capitalized fees) at stored asOfDate. Never assume this implicitly.
   */
  openingBalanceDateConfirmed?: true;
  /** Bank-provided next due date. Never synthesize it from dueDay. */
  firstDueDate?: string;
  /** Bank-confirmed nominal rate in integer millionths of percent. */
  annualRateMicroPercent?: number;
  dayCount?: DayCount;
  rounding?: Rounding;
  scheduleType?: ScheduleType;
  /**
   * fixed-contractual: use persisted paymentCents only after confirmation.
   * recalculate: derive a new amount independently without overwriting it.
   */
  installmentBasis?: 'fixed-contractual' | 'recalculate';
}

export type MissingLoanAcceptance =
  | 'agreementConfirmed'
  | 'openingBalanceDateConfirmed'
  | 'firstDueDate'
  | 'annualRateMicroPercent'
  | 'dayCount'
  | 'rounding'
  | 'scheduleType'
  | 'installmentBasis';

export interface LegacyLoanPreviewGate {
  status: 'needs-confirmation' | 'ready';
  missing: MissingLoanAcceptance[];
  terms: LoanTerms | null;
  /** Never claim bank matching from a guessed or synthetic preview. */
  bankParityVerified: false;
  /** The caller must not write the candidate into existing IndexedDB. */
  storedDataChanged: false;
  /** Existing facts and CSV rows must be preserved as separate source data. */
  historicalPaymentsImported: false;
}

const DAYS: readonly DayCount[] = ['ACT/365F', 'ACT/360', 'ACT/ACT-ISDA', '30E/360'];
const ROUNDING: readonly Rounding[] = ['HALF_UP', 'HALF_EVEN'];
const SCHEDULES: readonly ScheduleType[] = ['annuity', 'differentiated'];
const BASES = ['fixed-contractual', 'recalculate'] as const;

function validateLegacySnapshot(snapshot: StoredLoanSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Legacy loan snapshot is required');
  }
  assertMoney(snapshot.openingCents, 'openingCents', true);
  assertMoney(snapshot.paymentCents, 'paymentCents', true);
  if (!Number.isInteger(snapshot.termMonths) ||
      snapshot.termMonths < 1 || snapshot.termMonths > 1200) {
    throw new RangeError('Invalid legacy loan term');
  }
  if (!Number.isInteger(snapshot.dueDay) ||
      snapshot.dueDay < 1 || snapshot.dueDay > 31) {
    throw new RangeError('Invalid legacy loan due day');
  }
  parseDate(snapshot.asOfDate);
}

/** Pure preflight; no legacy payment or account posting is ever inferred. */
export function prepareLegacyLoanPreview(
  snapshot: StoredLoanSnapshot,
  accepted: ExplicitLoanTermsSelection = {},
): LegacyLoanPreviewGate {
  validateLegacySnapshot(snapshot);
  if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
    throw new TypeError('Explicit confirmation object is required');
  }
  // Inherited defaults cannot stand in for explicit approval of a bank
  // agreement or its financial parameters. Accept only own supplied fields.
  const provided = (key: keyof ExplicitLoanTermsSelection): boolean =>
    Object.hasOwn(accepted, key);
  const missing: MissingLoanAcceptance[] = [];
  if (!provided('agreementConfirmed') || accepted.agreementConfirmed !== true) {
    missing.push('agreementConfirmed');
  }
  if (!provided('openingBalanceDateConfirmed') ||
      accepted.openingBalanceDateConfirmed !== true) {
    missing.push('openingBalanceDateConfirmed');
  }
  if (!provided('firstDueDate') ||
      accepted.firstDueDate == null || accepted.firstDueDate === '') {
    missing.push('firstDueDate');
  }
  if (!provided('annualRateMicroPercent') ||
      accepted.annualRateMicroPercent == null) {
    missing.push('annualRateMicroPercent');
  }
  if (!provided('dayCount') || accepted.dayCount == null) missing.push('dayCount');
  if (!provided('rounding') || accepted.rounding == null) missing.push('rounding');
  if (!provided('scheduleType') || accepted.scheduleType == null) {
    missing.push('scheduleType');
  }
  if (!provided('installmentBasis') || accepted.installmentBasis == null) {
    missing.push('installmentBasis');
  }

  const safeBase = {
    status: 'needs-confirmation' as const,
    missing,
    terms: null,
    bankParityVerified: false as const,
    storedDataChanged: false as const,
    historicalPaymentsImported: false as const,
  };
  if (missing.length !== 0) return safeBase;

  const dueDate = accepted.firstDueDate!;
  parseDate(dueDate);
  const elapsed = calendarDays(snapshot.asOfDate, dueDate);
  if (elapsed < 1 || elapsed > 366) {
    throw new RangeError('Confirmed first due date must follow the opening snapshot within a year');
  }
  assertRate(accepted.annualRateMicroPercent!);
  if (!DAYS.includes(accepted.dayCount!)) throw new RangeError('Unrecognized day-count');
  if (!ROUNDING.includes(accepted.rounding!)) throw new RangeError('Unrecognized rounding');
  if (!SCHEDULES.includes(accepted.scheduleType!)) throw new RangeError('Unrecognized schedule type');
  if (!BASES.includes(accepted.installmentBasis!)) {
    throw new RangeError('Unknown installment basis');
  }
  if (accepted.scheduleType === 'differentiated' &&
      accepted.installmentBasis === 'fixed-contractual') {
    throw new RangeError('Differentiated schedule cannot use a fixed annuity installment');
  }
  const terms: LoanTerms = {
    principalCents: snapshot.openingCents,
    startDate: snapshot.asOfDate,
    firstDueDate: dueDate,
    termMonths: snapshot.termMonths,
    annualRateMicroPercent: accepted.annualRateMicroPercent!,
    dayCount: accepted.dayCount!,
    rounding: accepted.rounding!,
    scheduleType: accepted.scheduleType!,
    // Do not silently extend original contractual term. A non-amortizing
    // model must report incomplete, not manufacture more banking dates.
    maxExtensionMonths: 0,
    ...(accepted.installmentBasis === 'fixed-contractual' ?
      { paymentCents: snapshot.paymentCents } : {}),
  };
  return {
    status: 'ready', missing: [], terms,
    bankParityVerified: false,
    storedDataChanged: false,
    historicalPaymentsImported: false,
  };
}
