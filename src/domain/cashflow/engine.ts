import { addCents, cents } from './adapters.ts';
import { addMonthsAnchored, dayNumber, isoDay } from './calendar.ts';
import type {
  CashflowInputDto, CashflowDay, CashflowOccurrence, CashflowResult, OccurrenceOverrideDto,
  PlannedFlowDto, CashflowPlanVsActual,
} from './types.ts';

interface Bucket {
  plannedIncome: number;
  plannedExpense: number;
  actualIncome: number;
  actualExpense: number;
  actualAdjustment: number;
  forecastIncome: number;
  forecastExpense: number;
  overdueExpense: number;
  unrealizedIncome: number;
  actualReserve: number;
  plannedReserve: number;
  forecastReserve: number;
  estimatedIncome: number;
  ids: string[];
}
const blank = (): Bucket => ({
  plannedIncome: 0, plannedExpense: 0, actualIncome: 0, actualExpense: 0,
  actualAdjustment: 0, forecastIncome: 0, forecastExpense: 0,
  overdueExpense: 0, unrealizedIncome: 0,
  actualReserve: 0, plannedReserve: 0, forecastReserve: 0, estimatedIncome: 0, ids: [],
});
const keyed = (id: string, date: string) => `${id}\0${date}`;
const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
function mustId(id: string, what: string): void {
  if (typeof id !== 'string' || !id.trim() || id.includes('\0')) {
    throw new RangeError(`${what} ID must be nonempty and contain no NUL`);
  }
}
function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new RangeError(`${name} must be boolean when provided`);
  }
}
function isIncome(plan: PlannedFlowDto): boolean { return plan.kind === 'income'; }

function validOccurrence(plan: PlannedFlowDto, occurrenceDate: string): boolean {
  const n = dayNumber(occurrenceDate);
  const start = dayNumber(plan.dueDate);
  if (n < start || (plan.untilDate !== undefined && n > dayNumber(plan.untilDate))) return false;
  if (n === start) return true;
  if (!plan.everyMonths) return false;
  const months = (Number(occurrenceDate.slice(0, 4)) - Number(plan.dueDate.slice(0, 4))) * 12
    + Number(occurrenceDate.slice(5, 7)) - Number(plan.dueDate.slice(5, 7));
  return months >= 0 && months % plan.everyMonths === 0
    && addMonthsAnchored(plan.dueDate, months) === occurrenceDate;
}

/** Read-only cashflow projection. Explicit date input: never reads Date.now or mutates records. */
export function forecastCashflow(input: CashflowInputDto): CashflowResult {
  const opening = dayNumber(input.openingDate);
  const asOf = dayNumber(input.asOfDate);
  if (asOf < opening) throw new RangeError('asOfDate must not precede openingDate');
  if (![1, 3, 6, 12].includes(input.horizonMonths)) {
    throw new RangeError('horizonMonths must be 1, 3, 6 or 12');
  }
  const endDate = addMonthsAnchored(input.asOfDate, input.horizonMonths);
  const end = dayNumber(endDate);
  if (end - opening > 2_000) throw new RangeError('Opening snapshot is too old for a daily projection');
  cents(input.openingBalanceCents, 'openingBalanceCents');
  cents(input.openingReservedCents, 'openingReservedCents', true);

  const buckets = new Map<string, Bucket>();
  const dayBucket = (date: string): Bucket => {
    const existing = buckets.get(date);
    if (existing) return existing;
    const value = blank();
    buckets.set(date, value);
    return value;
  };

  const plans = new Map<string, PlannedFlowDto>();
  for (const plan of input.plans) {
    mustId(plan.id, 'Plan');
    optionalBoolean(plan.cancelled, 'plan.cancelled');
    if (plans.has(plan.id)) throw new RangeError('Duplicate plan ID');
    if (!['income', 'obligation', 'irregular', 'loan'].includes(plan.kind)) {
      throw new RangeError('Unknown plan kind');
    }
    dayNumber(plan.dueDate);
    cents(plan.amountCents, 'plan.amountCents', true);
    if (plan.everyMonths !== undefined && (!Number.isSafeInteger(plan.everyMonths)
      || plan.everyMonths < 1 || plan.everyMonths > 60)) {
      throw new RangeError('everyMonths must be 1..60');
    }
    if (plan.untilDate !== undefined && dayNumber(plan.untilDate) < dayNumber(plan.dueDate)) {
      throw new RangeError('untilDate must not precede dueDate');
    }
    if (plan.confidence !== undefined && !['confirmed', 'estimated'].includes(plan.confidence)) {
      throw new RangeError('Unknown confidence');
    }
    plans.set(plan.id, plan);
  }

  const overrides = new Map<string, OccurrenceOverrideDto>();
  let anchorLimit = end;
  for (const edit of input.overrides ?? []) {
    optionalBoolean(edit.cancelled, 'override.cancelled');
    const plan = plans.get(edit.planId);
    if (!plan || !validOccurrence(plan, edit.occurrenceDate)) {
      throw new RangeError('Override references an unknown plan occurrence');
    }
    const key = keyed(edit.planId, edit.occurrenceDate);
    if (overrides.has(key)) throw new RangeError('Duplicate occurrence override');
    if (edit.date !== undefined) dayNumber(edit.date);
    if (edit.amountCents !== undefined) cents(edit.amountCents, 'override.amountCents', true);
    overrides.set(key, edit);
    anchorLimit = Math.max(anchorLimit, dayNumber(edit.occurrenceDate));
  }

  const settlementTotals = new Map<string, number>();
  const actualIds = new Set<string>();
  for (const actual of input.actuals) {
    mustId(actual.id, 'Actual');
    optionalBoolean(actual.voided, 'actual.voided');
    if (actualIds.has(actual.id)) throw new RangeError('Duplicate actual ID');
    actualIds.add(actual.id);
    const date = dayNumber(actual.date);
    if (date > asOf) throw new RangeError('Future actual movement is not confirmed');
    cents(actual.amountCents, 'actual.amountCents', true);
    if (!['income', 'expense', 'transfer', 'adjustment-credit', 'adjustment-debit']
      .includes(actual.kind)) {
      throw new RangeError('Unknown actual kind');
    }
    if ((actual.planId === undefined) !== (actual.occurrenceDate === undefined)) {
      throw new RangeError('Both planId and occurrenceDate are required for a linked actual');
    }
    if (actual.planId !== undefined && actual.occurrenceDate !== undefined) {
      const plan = plans.get(actual.planId);
      if (!plan || !validOccurrence(plan, actual.occurrenceDate)
        || !['income', 'expense'].includes(actual.kind)
        || (isIncome(plan) !== (actual.kind === 'income'))) {
        throw new RangeError('Actual references an incompatible plan occurrence');
      }
      if (!actual.voided) {
        const key = keyed(actual.planId, actual.occurrenceDate);
        settlementTotals.set(key, addCents(settlementTotals.get(key) ?? 0, actual.amountCents));
      }
    }
    if (actual.voided || actual.kind === 'transfer' || date < opening || date > end) continue;
    const bucket = dayBucket(actual.date);
    if (actual.kind === 'income') bucket.actualIncome = addCents(bucket.actualIncome, actual.amountCents);
    else if (actual.kind === 'expense') {
      bucket.actualExpense = addCents(bucket.actualExpense, actual.amountCents);
    } else {
      // Ledger `adjustment` postings change the bank balance without becoming
      // income, expense, a planned settlement or a reserve movement.
      const signed = actual.kind === 'adjustment-credit' ? actual.amountCents : -actual.amountCents;
      bucket.actualAdjustment = addCents(bucket.actualAdjustment, signed);
    }
    bucket.ids.push(`actual:${actual.id}`);
  }

  // Validate every linked settlement, even when its occurrence lies beyond this horizon.
  for (const [key, total] of settlementTotals) {
    const separator = key.indexOf('\0');
    const planId = key.slice(0, separator);
    const occurrenceDate = key.slice(separator + 1);
    const plan = plans.get(planId);
    if (!plan) throw new Error('Internal plan index invariant failed');
    const edit = overrides.get(key);
    if (!plan.cancelled && !edit?.cancelled && total > (edit?.amountCents ?? plan.amountCents)) {
      throw new RangeError(`Booked settlement exceeds planned occurrence ${planId}@${occurrenceDate}`);
    }
  }

  const reservedIds = new Set<string>();
  for (const reserve of input.reserves ?? []) {
    mustId(reserve.id, 'Reserve movement');
    optionalBoolean(reserve.voided, 'reserve.voided');
    if (reservedIds.has(reserve.id)) throw new RangeError('Duplicate reserve movement ID');
    reservedIds.add(reserve.id);
    const day = dayNumber(reserve.date);
    cents(reserve.amountCents, 'reserve.amountCents', true);
    if (!['allocate', 'release'].includes(reserve.kind) || !['actual', 'planned'].includes(reserve.status)) {
      throw new RangeError('Invalid reserve movement kind or status');
    }
    // Validate facts even if they fall outside the selected forecast horizon.
    // A caller must not be able to hide a future factual reserve booking by
    // choosing a shorter horizon (the same rule already applies to cash facts).
    if (!reserve.voided && reserve.status === 'actual' && day > asOf) {
      throw new RangeError('Future reserve movement cannot be factual');
    }
    if (reserve.voided || day < opening || day > end) continue;
    const delta = reserve.kind === 'allocate' ? reserve.amountCents : -reserve.amountCents;
    const bucket = dayBucket(reserve.date);
    if (reserve.status === 'actual') bucket.actualReserve = addCents(bucket.actualReserve, delta);
    else bucket.plannedReserve = addCents(bucket.plannedReserve, delta);
    if (reserve.status === 'planned' && day >= asOf) {
      bucket.forecastReserve = addCents(bucket.forecastReserve, delta);
    }
    bucket.ids.push(`reserve:${reserve.id}`);
  }

  const occurrences: CashflowOccurrence[] = [];
  let generated = 0;
  for (const plan of plans.values()) {
    if (plan.cancelled) continue;
    const limit = plan.untilDate !== undefined ? Math.min(anchorLimit, dayNumber(plan.untilDate)) : anchorLimit;
    const initial = dayNumber(plan.dueDate);
    for (let index = 0; ; index++) {
      const anchor = index === 0 ? plan.dueDate
        : addMonthsAnchored(plan.dueDate, index * (plan.everyMonths ?? 1));
      const anchorNumber = dayNumber(anchor);
      if (anchorNumber > limit) break;
      if (++generated > 20_000) throw new RangeError('Too many plan occurrences');
      const key = keyed(plan.id, anchor);
      const edit = overrides.get(key);
      if (edit?.cancelled) {
        if (!plan.everyMonths) break;
        continue;
      }
      const due = edit?.date ?? anchor;
      const dueNumber = dayNumber(due);
      const amount = edit?.amountCents ?? plan.amountCents;
      const settled = settlementTotals.get(key) ?? 0;
      if (settled > amount) throw new RangeError('Booked settlement exceeds planned occurrence');
      const remaining = addCents(amount, -settled);
      if (dueNumber >= opening && dueNumber <= end) {
        occurrences.push({
          planId: plan.id, occurrenceDate: anchor, date: due, kind: plan.kind,
          amountCents: amount, settledCents: settled, remainingCents: remaining,
          confidence: plan.confidence ?? 'estimated', overdue: dueNumber <= asOf && remaining > 0,
        });
        const scheduled = dayBucket(due);
        if (isIncome(plan)) scheduled.plannedIncome = addCents(scheduled.plannedIncome, amount);
        else scheduled.plannedExpense = addCents(scheduled.plannedExpense, amount);
        scheduled.ids.push(`plan:${plan.id}@${anchor}`);
      }
      // Older occurrences pre-dating the opening snapshot are NOT inferred as debt.
      if (dueNumber >= opening && dueNumber <= asOf && remaining > 0) {
        if (isIncome(plan)) {
          const bucket = dayBucket(due);
          bucket.unrealizedIncome = addCents(bucket.unrealizedIncome, remaining);
        } else {
          const bucket = dayBucket(input.asOfDate);
          bucket.forecastExpense = addCents(bucket.forecastExpense, remaining);
          bucket.overdueExpense = addCents(bucket.overdueExpense, remaining);
          bucket.ids.push(`overdue:${plan.id}@${anchor}`);
        }
      } else if (dueNumber > asOf && dueNumber <= end && remaining > 0) {
        const bucket = dayBucket(due);
        if (isIncome(plan)) {
          bucket.forecastIncome = addCents(bucket.forecastIncome, remaining);
          if (plan.confidence !== 'confirmed') {
            bucket.estimatedIncome = addCents(bucket.estimatedIncome, remaining);
          }
        } else bucket.forecastExpense = addCents(bucket.forecastExpense, remaining);
      }
      if (!plan.everyMonths) break;
      // Bound recurrence to the end range, even for dates many decades in the past.
      if (index >= 20_000) throw new RangeError('Too many plan occurrences');
      if (initial > limit) break;
    }
  }

  let confirmedBalance = input.openingBalanceCents;
  let confirmedReserved = input.openingReservedCents;
  let expectedBalance = input.openingBalanceCents;
  let expectedReserved = input.openingReservedCents;
  let plannedBalance = input.openingBalanceCents;
  const planVsActual: CashflowPlanVsActual = {
    plannedIncomeCents: 0, plannedExpenseCents: 0,
    actualIncomeCents: 0, actualExpenseCents: 0,
    plannedNetCents: 0, actualNetCents: 0, varianceCents: 0,
  };
  let totalOverdueExpenseCents = 0;
  let totalUnrealizedIncomeCents = 0;
  let totalEstimatedFutureIncomeCents = 0;
  let minimumExpectedBalanceCents: number | null = null;
  let minimumExpectedAvailableCents: number | null = null;
  let firstCashGap: CashflowResult['firstCashGap'] = null;
  let confirmedAsOfBalanceCents: number | null = null;
  let confirmedAsOfReservedCents: number | null = null;
  let confirmedAdjustmentCents = 0;
  const days: CashflowDay[] = [];
  for (let number = opening; number <= end; number++) {
    const date = isoDay(number);
    const b = buckets.get(date) ?? blank();
    plannedBalance = addCents(plannedBalance, addCents(b.plannedIncome, -b.plannedExpense));
    if (number <= asOf) {
      confirmedBalance = addCents(confirmedBalance,
        addCents(addCents(b.actualIncome, -b.actualExpense), b.actualAdjustment));
      confirmedAdjustmentCents = addCents(confirmedAdjustmentCents, b.actualAdjustment);
      confirmedReserved = addCents(confirmedReserved, b.actualReserve);
      if (confirmedReserved < 0) throw new RangeError(`Actual reserves negative on ${date}`);
      expectedBalance = confirmedBalance;
      expectedReserved = confirmedReserved;
      if (number === asOf) {
        confirmedAsOfBalanceCents = confirmedBalance;
        confirmedAsOfReservedCents = confirmedReserved;
      }
      planVsActual.plannedIncomeCents = addCents(planVsActual.plannedIncomeCents, b.plannedIncome);
      planVsActual.plannedExpenseCents = addCents(planVsActual.plannedExpenseCents, b.plannedExpense);
      planVsActual.actualIncomeCents = addCents(planVsActual.actualIncomeCents, b.actualIncome);
      planVsActual.actualExpenseCents = addCents(planVsActual.actualExpenseCents, b.actualExpense);
    }
    if (number >= asOf) {
      expectedBalance = addCents(expectedBalance, addCents(b.forecastIncome, -b.forecastExpense));
      expectedReserved = addCents(expectedReserved, b.forecastReserve);
      if (expectedReserved < 0) throw new RangeError(`Forecast reserves negative on ${date}`);
      totalOverdueExpenseCents = addCents(totalOverdueExpenseCents, b.overdueExpense);
      totalEstimatedFutureIncomeCents = addCents(totalEstimatedFutureIncomeCents, b.estimatedIncome);
    }
    totalUnrealizedIncomeCents = addCents(totalUnrealizedIncomeCents, b.unrealizedIncome);
    const available = addCents(expectedBalance, -expectedReserved);
    if (number >= asOf) {
      minimumExpectedBalanceCents = minimumExpectedBalanceCents === null ? expectedBalance
        : Math.min(minimumExpectedBalanceCents, expectedBalance);
      minimumExpectedAvailableCents = minimumExpectedAvailableCents === null ? available
        : Math.min(minimumExpectedAvailableCents, available);
      if (available < 0 && firstCashGap === null) {
        firstCashGap = { date, shortfallCents: -available };
      }
    }
    days.push({
      date,
      plannedIncomeCents: b.plannedIncome,
      plannedExpenseCents: b.plannedExpense,
      actualIncomeCents: b.actualIncome,
      actualExpenseCents: b.actualExpense,
      actualAdjustmentCents: b.actualAdjustment,
      projectedIncomeCents: number >= asOf ? b.forecastIncome : 0,
      projectedExpenseCents: number >= asOf ? b.forecastExpense : 0,
      overdueExpenseCents: b.overdueExpense,
      unrealizedIncomeCents: b.unrealizedIncome,
      actualReserveDeltaCents: b.actualReserve,
      plannedReserveDeltaCents: b.plannedReserve,
      projectedReserveDeltaCents: number >= asOf ? b.forecastReserve : 0,
      confirmedBalanceCents: number <= asOf ? confirmedBalance : null,
      confirmedReservedCents: number <= asOf ? confirmedReserved : null,
      expectedBalanceCents: expectedBalance,
      expectedReservedCents: expectedReserved,
      expectedAvailableCents: available,
      plannedBalanceCents: plannedBalance,
      planVsActualVarianceCents: number <= asOf
        ? addCents(addCents(confirmedBalance, -plannedBalance), -confirmedAdjustmentCents) : null,
      estimatedIncomeCents: b.estimatedIncome,
      eventIds: b.ids.slice().sort(),
    });
  }
  planVsActual.plannedNetCents = addCents(planVsActual.plannedIncomeCents,
    -planVsActual.plannedExpenseCents);
  planVsActual.actualNetCents = addCents(planVsActual.actualIncomeCents,
    -planVsActual.actualExpenseCents);
  planVsActual.varianceCents = addCents(planVsActual.actualNetCents,
    -planVsActual.plannedNetCents);
  if (confirmedAsOfBalanceCents === null || confirmedAsOfReservedCents === null
    || minimumExpectedBalanceCents === null || minimumExpectedAvailableCents === null) {
    throw new Error('Internal projection invariant failed');
  }
  const closing = days[days.length - 1];
  if (!closing) throw new Error('Projection has no days');
  occurrences.sort((a, b) => compareString(a.date, b.date)
    || compareString(a.planId, b.planId) || compareString(a.occurrenceDate, b.occurrenceDate));
  return {
    openingDate: input.openingDate, asOfDate: input.asOfDate, endDate, horizonMonths: input.horizonMonths,
    days, occurrences, confirmedAsOfBalanceCents, confirmedAsOfReservedCents,
    confirmedAdjustmentCents,
    expectedClosingBalanceCents: closing.expectedBalanceCents,
    expectedClosingReservedCents: closing.expectedReservedCents,
    expectedClosingAvailableCents: closing.expectedAvailableCents,
    minimumExpectedBalanceCents, minimumExpectedAvailableCents,
    firstCashGap, totalOverdueExpenseCents, totalUnrealizedIncomeCents,
    totalEstimatedFutureIncomeCents, planVsActual,
    assumptions: [
      'Opening balances are confirmed at the start of openingDate; facts on that date are not yet included.',
      'Only facts dated on or before asOfDate change the confirmed balance.',
      'Unpaid due expenses are modeled as immediate asOfDate exposure; missed income is not carried forward.',
      'Future planned income is a forecast, and is estimated unless explicitly marked confirmed.',
      'An allocation only earmarks existing cash; a real payment debits the bank balance once.',
      'Internal transfers are ignored; account balance corrections affect cash, never plan-vs-fact income/expense.',
      'Dates and amounts are deterministic; no bank-specific payment or posting is inferred.',
    ],
  };
}
