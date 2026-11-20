/**
 * #37 -> #36 read-only reservation bridge.
 * Accepts already-authorized, single-profile account DTOs; DOES NOT verify a
 * session, post a transaction, allocate actual funds or mutate any state.
 * #33/#67 must enforce account ownership and atomic cross-goal/#6 limits.
 */
import { assertGoalDate } from './calendar.ts';
import { calculateGoal, goalForecastReservations, goalJournal, goalLedgerLinks } from './engine.ts';
import type { GoalEvent, GoalRecord } from './types.ts';
import type { CashflowSourcesDto, ReserveMovementDto } from '../cashflow/types.ts';

export interface GoalAccountBinding {
  goalId: string;
  accountId: string;
}

export interface GoalCashflowBundle {
  /** One distinct #36 opening-reserve source per goal, never a new account. */
  openingReserves: CashflowSourcesDto['reserves'];
  /** Confirmed earmarking changes and future proposals, never bank transactions. */
  movements: readonly ReserveMovementDto[];
  /** No income, expenses, internal transfers, or side effects originate here. */
  externalCashFlows: readonly [];
}

function prevDay(date: string): string | null {
  if (date === '1900-01-01') return null;
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000)
    .toISOString().slice(0, 10);
}

// Length-prefix fields to prevent collisions even with separator-like IDs.
function idFor(goalId: string, kind: string, suffix: string): string {
  if (goalId.includes('\0') || suffix.includes('\0')) {
    throw new RangeError('Goal and event identifiers must not contain NUL');
  }
  return `goals:${goalId.length}:${goalId}:${kind}:${suffix.length}:${suffix}`;
}

function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Invalid reservation amount in kopecks');
  }
  return value;
}

function eventAmount(event: GoalEvent, byId: ReadonlyMap<string, GoalEvent>): {
  kind: 'allocate' | 'release'; amountCents: number;
} | null {
  switch (event.type) {
    case 'create': return event.openingCents > 0
      ? { kind: 'allocate', amountCents: event.openingCents } : null;
    case 'contribution': return { kind: 'allocate', amountCents: event.amountCents };
    case 'use': return { kind: 'release', amountCents: event.amountCents };
    case 'void': {
      const prior = byId.get(event.eventId);
      if (prior?.type === 'contribution') return {
        kind: 'release', amountCents: prior.amountCents,
      };
      if (prior?.type === 'use') return {
        kind: 'allocate', amountCents: prior.amountCents,
      };
      return null; // Voided missed installment has no financial effect.
    }
    default: return null; // Edit, skip, archive and completion never spend or release funds.
  }
}

/**
 * Creates only candidate DTOs. In particular, account-transfer and expense
 * references are already-booked #33 facts, never an instruction to book again.
 */
export function buildGoalCashflowBundle(
  goals: readonly GoalRecord[], source: CashflowSourcesDto,
  bindings: readonly GoalAccountBinding[],
): GoalCashflowBundle {
  if (!Array.isArray(goals) || !Array.isArray(bindings) || !source ||
    !Array.isArray(source.accounts)) throw new TypeError('Explicit goal/account snapshot required');
  assertGoalDate(source.openingDate);
  assertGoalDate(source.asOfDate);
  if (source.asOfDate < source.openingDate) throw new RangeError('Snapshot date precedes opening');

  // A matching ID is not itself proof of authorization. The caller must supply
  // a trusted same-profile snapshot from #33/#67, not user-provided account IDs.
  const accounts = new Set<string>();
  for (const account of source.accounts) {
    if (!account || typeof account.id !== 'string' || !account.id ||
      accounts.has(account.id) || account.id.includes('\0') || account.currency !== 'RUB') {
      throw new TypeError('Invalid or duplicated RUB account');
    }
    accounts.add(account.id);
  }
  if (!accounts.size) throw new TypeError('Confirmed account snapshot is missing');

  const goalIds = new Set<string>();
  for (const goal of goals) {
    if (!goal || !goal.id || goalIds.has(goal.id)) throw new TypeError('Duplicated or invalid goal ID');
    goalIds.add(goal.id);
  }
  const bound = new Map<string, string>();
  for (const mapping of bindings) {
    if (!mapping || !goalIds.has(mapping.goalId) || bound.has(mapping.goalId) ||
        !accounts.has(mapping.accountId)) throw new TypeError('Unrecognized or duplicated account binding');
    bound.set(mapping.goalId, mapping.accountId);
  }
  if (bound.size !== goalIds.size) throw new TypeError('Every goal requires one verified account binding');
  goalLedgerLinks(goals); // Validate immutable history + cross-goal duplicated #33 references.

  const openingReserves: Array<{id: string; accountId: string; openingReservedCents: number}> = [];
  const movements: ReserveMovementDto[] = [];
  const beforeOpening = prevDay(source.openingDate);
  for (const goal of goals) {
    const first = goal.events[0];
    if (!first || first.type !== 'create') {
      throw new TypeError('Malformed goal creation');
    }
    const accountId = bound.get(goal.id);
    if (!accountId) throw new TypeError('Missing goal account binding');
    // A full-journal validation above still applies, but a goal that did not
    // exist at this historical as-of date must not create factual or planned
    // reservations. This matches the shared #37/#6 capacity snapshot semantics.
    if (first.on > source.asOfDate) continue;
    const prior = beforeOpening && first.on <= beforeOpening
      ? calculateGoal(goal, beforeOpening).savedCents : 0;
    openingReserves.push({
      id: idFor(goal.id, 'opening', 'v1'), accountId,
      openingReservedCents: cents(prior),
    });
    const journal = goalJournal(goal);
    const byId = new Map(journal.map(({event}) => [event.id, event]));
    for (const { event } of journal) {
      if (event.on < source.openingDate || event.on > source.asOfDate) continue;
      const amount = eventAmount(event, byId);
      if (!amount) continue;
      movements.push({
        id: idFor(goal.id, 'actual', event.id), date: event.on,
        kind: amount.kind, amountCents: cents(amount.amountCents), status: 'actual',
      });
    }
    for (const proposal of goalForecastReservations(goal, source.asOfDate)) {
      movements.push({
        id: idFor(goal.id, 'planned', proposal.dueOn), date: proposal.dueOn,
        kind: 'allocate', amountCents: cents(proposal.plannedCents), status: 'planned',
      });
    }
  }
  openingReserves.sort((a, b) => a.id.localeCompare(b.id));
  movements.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { openingReserves, movements, externalCashFlows: [] };
}

/** Adds goal reservations to an existing #36 source without changing its booked facts. */
export function withGoalCashflowSources(
  source: CashflowSourcesDto, goals: readonly GoalRecord[],
  bindings: readonly GoalAccountBinding[],
): CashflowSourcesDto {
  if (!Array.isArray(source.reserves) || !Array.isArray(source.actuals) ||
      !Array.isArray(source.plans)) throw new TypeError('A complete base cashflow source is required');
  const additions = buildGoalCashflowBundle(goals, source, bindings);
  const openingIds = new Set(source.reserves.map((x) => x.id));
  const movementIds = new Set((source.reserveMovements ?? []).map((x) => x.id));
  for (const reserve of additions.openingReserves) {
    if (openingIds.has(reserve.id)) throw new Error('Goal opening reserve already included');
    openingIds.add(reserve.id);
  }
  for (const movement of additions.movements) {
    if (movementIds.has(movement.id)) throw new Error('Goal reserve movement already included');
    movementIds.add(movement.id);
  }
  return {
    ...source,
    reserves: [...source.reserves, ...additions.openingReserves],
    reserveMovements: [...(source.reserveMovements ?? []), ...additions.movements],
  };
}
