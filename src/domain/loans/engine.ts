import { assertMoney, assertRate, calendarDays, interestNumerator, INTEREST_DENOMINATOR, MAX_CENTS, monthDueDate, parseDate, roundFraction, toSafeMoney } from './math.ts';
import type { DueDateChangeEvent, LoanEvent, LoanHistoryRecord, LoanResult, LoanRow, LoanRunOptions, LoanTerms } from './types.ts';

interface Ledger {
  balance: number;
  unpaid: number;
  fraction: bigint; // Exact unrounded fractional interest, may carry a negative rounding residue.
  date: string;
  rate: number;
}

function validate(terms: LoanTerms, events: readonly LoanEvent[], options: LoanRunOptions): void {
  assertMoney(terms.principalCents, 'principalCents', true);
  assertRate(terms.annualRateMicroPercent);
  parseDate(terms.startDate);
  parseDate(terms.firstDueDate);
  if (terms.firstDueDate <= terms.startDate || calendarDays(terms.startDate, terms.firstDueDate) > 366) {
    throw new RangeError('firstDueDate must be after startDate and no more than 366 days later');
  }
  if (!Number.isInteger(terms.termMonths) || terms.termMonths < 1 || terms.termMonths > 1200) {
    throw new RangeError('termMonths must be 1-1200');
  }
  if (!['ACT/365F', 'ACT/360', 'ACT/ACT-ISDA', '30E/360'].includes(terms.dayCount)) {
    throw new RangeError('Invalid dayCount');
  }
  if (!['HALF_UP', 'HALF_EVEN'].includes(terms.rounding)) throw new RangeError('Invalid rounding');
  if (terms.scheduleType !== 'annuity' && terms.scheduleType !== 'differentiated') {
    throw new RangeError('Invalid scheduleType');
  }
  if (terms.paymentCents !== undefined) {
    if (terms.scheduleType !== 'annuity') throw new RangeError('paymentCents requires annuity');
    assertMoney(terms.paymentCents, 'paymentCents', true);
  }
  if (terms.rateChangePolicy !== undefined && !['recalculate', 'keep-payment'].includes(terms.rateChangePolicy)) {
    throw new RangeError('Invalid rateChangePolicy');
  }
  const extra = terms.maxExtensionMonths ?? Math.min(240, 1200 - terms.termMonths);
  if (!Number.isInteger(extra) || extra < 0 || terms.termMonths + extra > 1200) {
    throw new RangeError('termMonths + maxExtensionMonths must not exceed 1200');
  }
  if (!['plan', 'actual', 'forecast'].includes(options.mode)) throw new RangeError('Invalid loan mode');
  if (options.mode !== 'plan') {
    if (!options.asOfDate || parseDate(options.asOfDate) < parseDate(terms.startDate)) {
      throw new RangeError('asOfDate must be on or after startDate');
    }
  }
  if (!Array.isArray(events) || events.length > 10000) throw new RangeError('Too many loan events');
  const ids = new Set<string>();
  const rateDates = new Set<string>();
  const changedMonths = new Set<string>();
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 128 || ids.has(event.id)) {
      throw new RangeError('Loan event IDs must be unique nonempty strings (max 128)');
    }
    ids.add(event.id);
    parseDate(event.date);
    if (event.date < terms.startDate) throw new RangeError('Loan event precedes startDate');
    if (event.voidedAt !== undefined && event.voidedAt !== null &&
        (typeof event.voidedAt !== 'string' || !event.voidedAt.trim())) {
      throw new RangeError('Invalid voidedAt');
    }
    if (event.type === 'payment') {
      assertMoney(event.amountCents, 'payment.amountCents', true);
      if (event.paymentKind !== 'regular' && event.paymentKind !== 'extra') throw new RangeError('Invalid paymentKind');
      if (event.paymentKind === 'regular' && event.strategy !== undefined) {
        throw new RangeError('Only an extra payment can change repayment strategy');
      }
      if (event.strategy !== undefined && event.strategy !== 'shorten-term' && event.strategy !== 'reduce-payment') {
        throw new RangeError('Invalid repayment strategy');
      }
    } else if (event.type === 'rate-change') {
      assertRate(event.annualRateMicroPercent);
      if (!event.voidedAt && rateDates.has(event.date)) throw new RangeError('Two active rate changes on the same date');
      if (!event.voidedAt) rateDates.add(event.date);
    } else if (event.type === 'due-date-change') {
      if (!Number.isInteger(event.dayOfMonth) || event.dayOfMonth < 1 || event.dayOfMonth > 31) {
        throw new RangeError('dayOfMonth must be 1-31');
      }
      const month = event.date.slice(0, 7);
      if (!event.voidedAt && changedMonths.has(month)) throw new RangeError('Two active due-day changes in one month');
      if (!event.voidedAt) changedMonths.add(month);
    } else {
      throw new RangeError('Invalid loan event type');
    }
  }
}

function dueDatesFor(terms: LoanTerms, changes: readonly DueDateChangeEvent[]): string[] {
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date));
  const result: string[] = [];
  let day = Number(terms.firstDueDate.slice(-2));
  let changed = 0;
  const count = terms.termMonths + (terms.maxExtensionMonths ?? Math.min(240, 1200 - terms.termMonths));
  for (let i = 0; i < count; i++) {
    // Due-day changes only affect *subsequent* calendar months, never a due date
    // that could already have been paid in the month of the change.
    const month = monthDueDate(terms.firstDueDate, i, 1).slice(0, 7);
    if (i > 0) {
      while (changed < sorted.length && sorted[changed]!.date.slice(0, 7) < month) {
        day = sorted[changed]!.dayOfMonth;
        changed++;
      }
    }
    const due = i === 0 ? terms.firstDueDate : monthDueDate(terms.firstDueDate, i, day);
    if (result.length && due <= result[result.length - 1]!) throw new RangeError('Non-increasing due dates');
    result.push(due);
  }
  return result;
}

function accrue(state: Ledger, date: string, terms: LoanTerms): void {
  if (date < state.date) throw new RangeError('Event order runs backwards');
  state.fraction += interestNumerator(state.balance, state.rate, state.date, date, terms.dayCount);
  state.date = date;
}

/** Round/bill only at payment and due boundaries; never capitalize arrears. */
function bill(state: Ledger, terms: LoanTerms): number {
  const rounded = roundFraction(state.fraction, INTEREST_DENOMINATOR, terms.rounding);
  const cents = rounded > 0n ? toSafeMoney(rounded) : 0;
  if (cents) {
    if (state.unpaid + cents > MAX_CENTS) throw new RangeError('Accrued interest exceeds supported limit');
    state.unpaid += cents;
    state.fraction -= BigInt(cents) * INTEREST_DENOMINATOR;
  }
  return cents;
}

function settle(state: Ledger, amount: number, strict: boolean): { interest: number; principal: number; amount: number } {
  const remaining = state.unpaid + state.balance;
  if (strict && amount > remaining) throw new RangeError('Payment exceeds outstanding principal and interest');
  const applied = Math.min(amount, remaining);
  const interest = Math.min(applied, state.unpaid);
  const principal = applied - interest;
  state.unpaid -= interest;
  state.balance -= principal;
  if (state.balance === 0 && state.unpaid === 0) state.fraction = 0n;
  return { interest, principal, amount: applied };
}

/** Exact cent-level bisection, no floating-point APR or approximate monthly annuity. */
function minimumInstallment(state: Ledger, futureDues: readonly string[], terms: LoanTerms): number {
  if (state.balance === 0 && state.unpaid === 0) return 0;
  if (!futureDues.length) return 0;
  const canClose = (installment: number): boolean => {
    const trial = { ...state };
    for (const date of futureDues) {
      if (trial.balance === 0 && trial.unpaid === 0) return true;
      accrue(trial, date, terms);
      bill(trial, terms);
      settle(trial, installment, false);
    }
    return trial.balance === 0 && trial.unpaid === 0;
  };
  let upper = Math.max(1, state.balance);
  while (!canClose(upper)) {
    if (upper >= MAX_CENTS) throw new RangeError('Installment exceeds supported limit');
    upper = Math.min(MAX_CENTS, upper * 2);
  }
  let lower = 0;
  while (lower + 1 < upper) {
    const mid = Math.floor((lower + upper) / 2);
    if (canClose(mid)) upper = mid;
    else lower = mid;
  }
  return upper;
}

function sortedEvents(events: readonly LoanEvent[], options: LoanRunOptions): LoanEvent[] {
  const precedence = (e: LoanEvent): number => e.type === 'rate-change' ? 0 :
    e.type === 'payment' && e.paymentKind === 'regular' ? 1 : 2;
  return events.filter(e => !e.voidedAt &&
    (options.mode !== 'plan' || e.type !== 'payment') &&
    (options.mode !== 'actual' || e.date <= options.asOfDate! ) &&
    (e.type !== 'payment' || e.date <= options.asOfDate!))
    .sort((a, b) => a.date.localeCompare(b.date) || precedence(a) - precedence(b) || a.id.localeCompare(b.id));
}

/**
 * Pure event-sourced simulation; factual payments are NEVER inferred from a due date.
 * No legacy IndexedDB record is read, mutated, or converted here.
 */
export function calculateLoan(terms: LoanTerms, events: readonly LoanEvent[], options: LoanRunOptions): LoanResult {
  validate(terms, events, options);
  const dues = dueDatesFor(terms, events.filter((e): e is DueDateChangeEvent =>
    e.type === 'due-date-change' && !e.voidedAt));
  const state: Ledger = {
    balance: terms.principalCents, unpaid: 0, fraction: 0n,
    date: terms.startDate, rate: terms.annualRateMicroPercent,
  };
  const originalDues = dues.slice(0, terms.termMonths);
  let scheduled = terms.scheduleType === 'annuity'
    ? (terms.paymentCents ?? minimumInstallment(state, originalDues, terms))
    : Math.ceil(terms.principalCents / terms.termMonths);
  const timeline = sortedEvents(events, options);
  const rows: LoanRow[] = [];
  const history: LoanHistoryRecord[] = [];
  let cursor = 0;
  let paidOffDate: string | null = null;
  let actualOpenPeriod: LoanResult['actualOpenPeriod'] = null;
  let periodAmount = 0;
  let periodInterest = 0;
  let periodInterestPaid = 0;
  let periodPrincipal = 0;
  let periodExtra = 0;
  const asOf = options.asOfDate;

  function recalculatePayment(date: string): void {
    const remainingDues = originalDues.filter(d => d > date);
    if (!remainingDues.length || (state.balance === 0 && state.unpaid === 0)) return;
    scheduled = terms.scheduleType === 'annuity'
      ? minimumInstallment(state, remainingDues, terms)
      : Math.ceil(state.balance / remainingDues.length);
  }

  function applyEvent(event: LoanEvent): void {
    accrue(state, event.date, terms);
    if (event.type === 'rate-change') {
      state.rate = event.annualRateMicroPercent;
      if (terms.scheduleType === 'annuity' && (terms.rateChangePolicy ?? 'recalculate') === 'recalculate') {
        recalculatePayment(event.date);
      }
      history.push({ id: event.id, date: event.date, type: event.type,
        balanceCents: state.balance, unpaidInterestCents: state.unpaid,
        annualRateMicroPercent: state.rate });
    } else if (event.type === 'due-date-change') {
      history.push({ id: event.id, date: event.date, type: event.type,
        balanceCents: state.balance, unpaidInterestCents: state.unpaid,
        dayOfMonth: event.dayOfMonth });
    } else if (event.type === 'payment') {
      periodInterest += bill(state, terms);
      const paid = settle(state, event.amountCents, true);
      periodAmount += paid.amount;
      periodInterestPaid += paid.interest;
      periodPrincipal += paid.principal;
      if (event.paymentKind === 'extra') {
        periodExtra += paid.amount;
        if ((event.strategy ?? 'shorten-term') === 'reduce-payment') recalculatePayment(event.date);
      }
      if (state.balance === 0 && state.unpaid === 0) paidOffDate = event.date;
      history.push({ id: event.id, date: event.date, type: event.type,
        amountCents: paid.amount, interestPaidCents: paid.interest,
        principalPaidCents: paid.principal, balanceCents: state.balance,
        unpaidInterestCents: state.unpaid });
    }
  }

  let crossedAsOf = false;
  const captureOpenPeriod = (): void => {
    if (options.mode === 'plan') return;
    if (periodAmount || periodInterestPaid || periodPrincipal || periodExtra) {
      actualOpenPeriod = { asOfDate: asOf!, amountCents: periodAmount,
        interestPaidCents: periodInterestPaid, principalCents: periodPrincipal,
        extraPaidCents: periodExtra };
    }
    periodAmount = 0;
    periodInterest = 0;
    periodInterestPaid = 0;
    periodPrincipal = 0;
    periodExtra = 0;
  };
  for (let i = 0; i < dues.length; i++) {
    const due = dues[i]!;
    if (options.mode === 'actual' && due > asOf!) break;
    if (options.mode === 'forecast' && !crossedAsOf && due > asOf!) {
      while (cursor < timeline.length && timeline[cursor]!.date <= asOf!) {
        applyEvent(timeline[cursor]!);
        cursor++;
      }
      accrue(state, asOf!, terms);
      captureOpenPeriod();
      crossedAsOf = true;
    }
    while (cursor < timeline.length && timeline[cursor]!.date <= due) {
      applyEvent(timeline[cursor]!);
      cursor++;
    }
    if (state.balance === 0 && state.unpaid === 0) break;
    accrue(state, due, terms);
    periodInterest += bill(state, terms);
    const isProjected = options.mode === 'plan' || (options.mode === 'forecast' && due > asOf!);
    const plannedPayment = terms.scheduleType === 'annuity' ? scheduled :
      state.unpaid + Math.min(state.balance, scheduled);
    if (isProjected) {
      const paid = settle(state, plannedPayment, false);
      periodAmount += paid.amount;
      periodInterestPaid += paid.interest;
      periodPrincipal += paid.principal;
      if (state.balance === 0 && state.unpaid === 0) paidOffDate = due;
    }
    rows.push({ period: i + 1, date: due,
      kind: options.mode === 'plan' ? 'planned' : isProjected ? 'forecast' : 'actual',
      plannedPaymentCents: plannedPayment, amountCents: periodAmount,
      interestCents: periodInterest, interestPaidCents: periodInterestPaid,
      principalCents: periodPrincipal, balanceCents: state.balance,
      unpaidInterestCents: state.unpaid, extraPaidCents: periodExtra });
    periodAmount = 0;
    periodInterest = 0;
    periodInterestPaid = 0;
    periodPrincipal = 0;
    periodExtra = 0;
    if (state.balance === 0 && state.unpaid === 0) break;
  }

  if (options.mode === 'actual') {
    while (cursor < timeline.length && timeline[cursor]!.date <= asOf!) {
      applyEvent(timeline[cursor]!);
      cursor++;
    }
    accrue(state, asOf!, terms);
    captureOpenPeriod();
  } else if (options.mode === 'forecast' && !crossedAsOf && state.date <= asOf!) {
    // Factual events beyond the last modeled installment still belong to the
    // actual period, never to a synthetic forecast installment.
    while (cursor < timeline.length && timeline[cursor]!.date <= asOf!) {
      applyEvent(timeline[cursor]!);
      cursor++;
    }
    accrue(state, asOf!, terms);
    captureOpenPeriod();
  }
  const accrued = roundFraction(state.fraction, INTEREST_DENOMINATOR, terms.rounding);
  const accruedInterestCents = accrued > 0n ? toSafeMoney(accrued) : 0;
  const remaining = state.balance + state.unpaid + accruedInterestCents;
  if (!Number.isSafeInteger(remaining) || remaining > MAX_CENTS) throw new RangeError('Total debt exceeds supported limit');
  const complete = state.balance === 0 && state.unpaid === 0;
  const nextDueDate = complete ? null : dues.find(d => d > state.date) ?? null;
  return { rows, history, actualOpenPeriod, principalBalanceCents: state.balance,
    unpaidInterestCents: state.unpaid, accruedInterestCents,
    remainingDebtCents: remaining, scheduledPaymentCents: scheduled,
    paidOffDate, nextDueDate, complete, bankParityVerified: false };
}
