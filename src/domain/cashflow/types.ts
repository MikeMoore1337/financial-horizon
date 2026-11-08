/** Cashflow projection v1: pure DTOs, RUB only, integer kopecks. */
export type HorizonMonths = 1 | 3 | 6 | 12;
export type PlanKind = 'income' | 'obligation' | 'irregular' | 'loan';

export interface PlannedFlowDto {
  id: string;
  kind: PlanKind;
  dueDate: string; // YYYY-MM-DD, original recurrence anchor
  amountCents: number; // >= 0, always positive magnitude
  /** Monthly interval anchored to dueDate, never chained from the prior clamped date. */
  everyMonths?: number; // 1..60
  untilDate?: string; // inclusive original recurrence date
  confidence?: 'confirmed' | 'estimated'; // future income defaults to estimated
  cancelled?: boolean; // entire plan is no longer active
}

export interface OccurrenceOverrideDto {
  planId: string;
  occurrenceDate: string; // original recurrence date, not rescheduled date
  /** Replacement effective due date; cancellation takes precedence. */
  date?: string;
  /** Replacement total (not residual) amount. */
  amountCents?: number;
  cancelled?: boolean;
}

export interface BookedFlowDto {
  id: string; // stable identity; duplicates are rejected
  date: string;
  kind: 'income' | 'expense' | 'transfer';
  amountCents: number; // absolute value of one confirmed cash movement
  /** Both must be specified for a booked part-payment of a planned occurrence. */
  planId?: string;
  occurrenceDate?: string;
  /** Canonicalized logical void: adapter must NOT also send the reversing posting. */
  voided?: boolean;
}

export interface ReserveMovementDto {
  id: string;
  date: string;
  kind: 'allocate' | 'release';
  amountCents: number;
  status: 'actual' | 'planned';
  voided?: boolean;
}

export interface CashflowInputDto {
  /** Explicit confirmed consolidated opening balance at START of openingDate. */
  openingDate: string;
  openingBalanceCents: number;
  /** Subset of the opening account balance already earmarked, not additional cash. */
  openingReservedCents: number;
  /** Facts are only accepted up to this explicit calendar day, never system time. */
  asOfDate: string;
  horizonMonths: HorizonMonths;
  plans: readonly PlannedFlowDto[];
  actuals: readonly BookedFlowDto[];
  overrides?: readonly OccurrenceOverrideDto[];
  reserves?: readonly ReserveMovementDto[];
}

export interface CashflowDay {
  date: string;
  plannedIncomeCents: number;
  plannedExpenseCents: number;
  actualIncomeCents: number;
  actualExpenseCents: number;
  projectedIncomeCents: number;
  projectedExpenseCents: number;
  overdueExpenseCents: number;
  unrealizedIncomeCents: number;
  /** Net signed earmarking movement; positive allocates, negative releases. */
  actualReserveDeltaCents: number;
  plannedReserveDeltaCents: number;
  projectedReserveDeltaCents: number;
  /** Only populated through asOfDate; authoritative IF supplied facts are complete. */
  confirmedBalanceCents: number | null;
  confirmedReservedCents: number | null;
  /** Hypothetical future bank cash, NOT a confirmed banking balance. */
  expectedBalanceCents: number;
  expectedReservedCents: number;
  /** Expected bank cash minus earmarked money; NOT the bank balance. */
  expectedAvailableCents: number;
  plannedBalanceCents: number;
  planVsActualVarianceCents: number | null;
  estimatedIncomeCents: number;
  eventIds: string[];
}

export interface CashflowPlanVsActual {
  plannedIncomeCents: number;
  plannedExpenseCents: number;
  actualIncomeCents: number;
  actualExpenseCents: number;
  plannedNetCents: number;
  actualNetCents: number;
  varianceCents: number; // actual net minus planned net
}

export interface CashflowOccurrence {
  planId: string;
  occurrenceDate: string; // immutable recurrence anchor
  date: string; // effective due date
  kind: PlanKind;
  amountCents: number;
  settledCents: number;
  remainingCents: number;
  confidence: 'confirmed' | 'estimated';
  overdue: boolean;
}

export interface CashflowResult {
  openingDate: string;
  asOfDate: string;
  endDate: string;
  horizonMonths: HorizonMonths;
  days: CashflowDay[]; // one item per calendar day, inclusive
  occurrences: CashflowOccurrence[]; // explicit calendar events for later read-only UI adapters
  confirmedAsOfBalanceCents: number;
  confirmedAsOfReservedCents: number;
  expectedClosingBalanceCents: number;
  expectedClosingReservedCents: number;
  expectedClosingAvailableCents: number;
  minimumExpectedBalanceCents: number; // between asOfDate and endDate
  minimumExpectedAvailableCents: number;
  firstCashGap: { date: string; shortfallCents: number } | null;
  totalOverdueExpenseCents: number;
  totalUnrealizedIncomeCents: number;
  totalEstimatedFutureIncomeCents: number;
  planVsActual: CashflowPlanVsActual;
  /** Fixed accounting/forecast assumptions, not a bank guarantee. */
  assumptions: readonly string[];
}

/** Neutral external DTOs. Adapters do not import #33/#6/#39 before contract stabilization. */
export interface CashflowSourcesDto {
  openingDate: string;
  asOfDate: string;
  horizonMonths: HorizonMonths;
  accounts: readonly { id: string; currency: 'RUB'; openingBalanceCents: number }[];
  reserves: readonly { id: string; accountId: string; openingReservedCents: number }[];
  plans: readonly PlannedFlowDto[];
  actuals: readonly BookedFlowDto[];
  overrides?: readonly OccurrenceOverrideDto[];
  reserveMovements?: readonly ReserveMovementDto[];
}
