import { assertGoalDate, goalDueDates, monthDue, MAX_MONTHS } from './calendar.ts';
import type {
  GoalCategory,
  GoalChanges,
  GoalContribution,
  GoalCreateInput,
  GoalCreated,
  GoalEvent,
  GoalForecastReservation,
  GoalFunding,
  GoalInstallment,
  GoalJournalEntry,
  GoalLedgerLink,
  GoalRecord,
  GoalSnapshot,
  GoalStatus,
  GoalUse,
  GoalVoided,
} from './types.ts';

export const MAX_GOAL_CENTS = 1_000_000_000_000;
const MAX_EVENT_COUNT = 25_000;
const CATEGORIES: readonly GoalCategory[] = ['emergency', 'travel', 'purchase', 'education', 'other'];
const FUNDINGS: readonly GoalFunding[] = ['virtual', 'account-transfer'];
const USE_KINDS = ['virtual-release', 'account-transfer', 'expense'] as const;

function nonBlank(value: unknown, label: string, max = 160): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string (max ${max})`);
  }
}
function money(value: unknown, label: string, positive = false): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > MAX_GOAL_CENTS
  ) {
    throw new RangeError(`${label} must be an integer number of kopecks`);
  }
}
function safeAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_GOAL_CENTS) {
    throw new RangeError('Goal balance is negative or exceeds allowed bounds');
  }
  return result;
}
function category(value: unknown): asserts value is GoalCategory {
  if (!CATEGORIES.includes(value as GoalCategory)) throw new TypeError('Invalid goal category');
}
function funding(value: unknown): asserts value is GoalFunding {
  if (!FUNDINGS.includes(value as GoalFunding)) throw new TypeError('Invalid funding kind');
}
function validateChanges(changes: GoalChanges): void {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('Expected a goal update');
  }
  const permitted = ['title', 'category', 'targetCents', 'targetDate', 'monthlyCents', 'plannedFunding'];
  const keys = Object.keys(changes);
  if (!keys.length || keys.some((key) => !permitted.includes(key))) {
    throw new TypeError('Empty or unknown goal update');
  }
  if ('title' in changes) nonBlank(changes.title, 'Title');
  if ('category' in changes) category(changes.category);
  if ('targetCents' in changes) money(changes.targetCents, 'Target', true);
  if ('targetDate' in changes) assertGoalDate(changes.targetDate as string);
  if ('monthlyCents' in changes && changes.monthlyCents !== null) {
    money(changes.monthlyCents, 'Monthly contribution');
  }
  if ('plannedFunding' in changes) funding(changes.plannedFunding);
}
function knownKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Unexpected field in goal event');
  }
}
function validateNewEvent(event: GoalEvent): void {
  if (!event || typeof event !== 'object') throw new TypeError('Invalid goal event');
  nonBlank(event.id, 'Event ID');
  assertGoalDate(event.on);
  const base = ['id', 'on', 'type'];
  switch (event.type) {
    case 'create':
      knownKeys(event, [...base, 'title', 'category', 'targetCents', 'targetDate',
        'openingCents', 'monthlyCents', 'plannedFunding']);
      nonBlank(event.title, 'Title');
      category(event.category);
      money(event.targetCents, 'Target', true);
      money(event.openingCents, 'Opening allocation');
      assertGoalDate(event.targetDate);
      if (event.monthlyCents !== null) money(event.monthlyCents, 'Monthly contribution');
      funding(event.plannedFunding);
      break;
    case 'update':
      knownKeys(event, [...base, 'changes']);
      validateChanges(event.changes);
      break;
    case 'contribution':
      knownKeys(event, [...base, 'amountCents', 'funding', 'ledgerMovementId',
        'forDueOn', 'idempotencyKey']);
      money(event.amountCents, 'Contribution', true);
      funding(event.funding);
      if (event.forDueOn !== undefined) assertGoalDate(event.forDueOn);
      if (event.idempotencyKey !== undefined) nonBlank(event.idempotencyKey, 'Idempotency key');
      validateMovementReference(event.funding, event.ledgerMovementId);
      break;
    case 'use':
      knownKeys(event, [...base, 'amountCents', 'usage', 'ledgerMovementId',
        'idempotencyKey']);
      money(event.amountCents, 'Amount used', true);
      if (!USE_KINDS.includes(event.usage)) throw new TypeError('Invalid usage kind');
      if (event.idempotencyKey !== undefined) nonBlank(event.idempotencyKey, 'Idempotency key');
      validateMovementReference(event.usage, event.ledgerMovementId);
      break;
    case 'skip':
      knownKeys(event, [...base, 'dueOn', 'reason']);
      assertGoalDate(event.dueOn);
      if (event.reason !== undefined) nonBlank(event.reason, 'Skip reason', 500);
      break;
    case 'void':
      knownKeys(event, [...base, 'eventId', 'reason', 'ledgerReversalId']);
      nonBlank(event.eventId, 'Reversed event ID');
      nonBlank(event.reason, 'Reversal reason', 500);
      if (event.ledgerReversalId !== undefined) nonBlank(event.ledgerReversalId, 'Ledger reversal ID');
      break;
    case 'complete':
    case 'reopen':
    case 'archive':
    case 'restore':
      knownKeys(event, base);
      break;
    default:
      throw new TypeError('Unknown goal event type');
  }
}
function validateMovementReference(kind: string, ref: string | undefined): void {
  if (kind === 'virtual' || kind === 'virtual-release') {
    if (ref !== undefined) throw new TypeError('Virtual allocation cannot have a ledger movement');
  } else {
    nonBlank(ref, 'Confirmed ledger movement ID');
  }
}
function sortedEvents(events: readonly GoalEvent[]): GoalEvent[] {
  // Stable sort: date determines effective order; append position breaks same-day ties.
  return [...events].sort((a, b) => a.on.localeCompare(b.on));
}
function isFinancial(event: GoalEvent): event is GoalContribution | GoalUse {
  return event.type === 'contribution' || event.type === 'use';
}
function sameEvent(a: GoalEvent, b: GoalEvent): boolean {
  // Canonicalize object key order; retries must not depend on serialization order.
  const canonical = (value: GoalEvent): string => JSON.stringify(value, (_key, part: unknown) => {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      return Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)));
    }
    return part;
  });
  return canonical(a) === canonical(b);
}
function sameFinancialIntent(a: GoalContribution | GoalUse, b: GoalContribution | GoalUse): boolean {
  return (
    a.type === b.type &&
    a.on === b.on &&
    a.amountCents === b.amountCents &&
    a.ledgerMovementId === b.ledgerMovementId &&
    (a.type === 'contribution'
      ? a.funding === (b as GoalContribution).funding && a.forDueOn === (b as GoalContribution).forDueOn
      : a.usage === (b as GoalUse).usage)
  );
}

interface InternalState {
  createdOn: string;
  title: string;
  category: GoalCategory;
  targetCents: number;
  targetDate: string;
  openingCents: number;
  monthlyCents: number | null;
  plannedFunding: GoalFunding;
  balance: number;
  reachedOn: string | null;
  status: GoalStatus;
}

interface PreparedJournal {
  created: GoalCreated;
  eventMap: Map<string, GoalEvent>;
  chronologicalEvents: GoalEvent[];
}

/** Validates an immutable journal once before replaying its historical snapshots. */
function prepareJournal(goal: GoalRecord): PreparedJournal {
  if (!goal || goal.version !== 1 || typeof goal.id !== 'string' || !goal.id.trim()) {
    throw new TypeError('Unknown goal record version or ID');
  }
  if (!Array.isArray(goal.events) || goal.events.length === 0 || goal.events.length > MAX_EVENT_COUNT) {
    throw new RangeError('Goal event journal is missing or too large');
  }
  const created = goal.events[0];
  if (!created || created.type !== 'create') throw new TypeError('First goal event must create it');
  const ids = new Set<string>();
  const idempotency = new Set<string>();
  const ledgerRefs = new Set<string>();
  const eventMap = new Map<string, GoalEvent>();
  for (const event of goal.events) {
    validateNewEvent(event);
    if (ids.has(event.id)) throw new Error('Duplicate goal event ID');
    ids.add(event.id);
    eventMap.set(event.id, event);
    if (event.type === 'create' && event !== created) throw new Error('Multiple goal creation events');
    if (event.on < created.on) throw new RangeError('Goal event predates goal creation');
    if (isFinancial(event) && event.idempotencyKey) {
      if (idempotency.has(event.idempotencyKey)) throw new Error('Duplicate idempotency key');
      idempotency.add(event.idempotencyKey);
    }
    const ref = isFinancial(event)
      ? event.ledgerMovementId
      : event.type === 'void'
        ? event.ledgerReversalId
        : undefined;
    if (ref) {
      if (ledgerRefs.has(ref)) throw new Error('Ledger movement linked twice within a goal');
      ledgerRefs.add(ref);
    }
  }
  const voided = new Set<string>();
  for (const event of goal.events) {
    if (event.type !== 'void') continue;
    const target = eventMap.get(event.eventId);
    if (!target || !(isFinancial(target) || target.type === 'skip')) {
      throw new TypeError('Only existing contributions, uses or skips can be voided');
    }
    if (event.on < target.on) throw new RangeError('Reversal predates its movement');
    if (voided.has(event.eventId)) throw new Error('Movement already reversed');
    voided.add(event.eventId);
    const mustReverseLedger = isFinancial(target) && Boolean(target.ledgerMovementId);
    if (mustReverseLedger) {
      nonBlank(event.ledgerReversalId, 'Confirmed ledger reversal ID');
    } else if (event.ledgerReversalId !== undefined) {
      throw new TypeError('Virtual correction cannot contain a ledger reversal');
    }
  }
  return { created: created as GoalCreated, eventMap, chronologicalEvents: sortedEvents(goal.events) };
}

/** Historical replay shares validation, but never shares mutable snapshot state. */
function replay(goal: GoalRecord, asOf: string, prepared = prepareJournal(goal)): InternalState {
  assertGoalDate(asOf);
  const { created: start, eventMap, chronologicalEvents } = prepared;
  if (asOf < start.on) throw new RangeError('Snapshot predates goal creation');
  if (start.targetDate < start.on) throw new RangeError('Goal deadline precedes start');
  let state: InternalState = {
    createdOn: start.on,
    title: start.title,
    category: start.category,
    targetCents: start.targetCents,
    targetDate: start.targetDate,
    openingCents: start.openingCents,
    monthlyCents: start.monthlyCents,
    plannedFunding: start.plannedFunding,
    balance: 0,
    reachedOn: null,
    status: 'active',
  };
  const checkReach = (date: string): void => {
    if (state.balance < state.targetCents) state.reachedOn = null;
    else if (state.reachedOn === null) state.reachedOn = date;
  };
  const skips = new Set<string>();
  for (const event of chronologicalEvents) {
    if (event.on > asOf) break;
    switch (event.type) {
      case 'create':
        state.balance = safeAdd(state.balance, event.openingCents);
        checkReach(event.on);
        break;
      case 'update':
        if (state.status !== 'active') throw new Error('Reopen a closed goal before editing');
        state = { ...state, ...event.changes };
        if (state.targetDate < state.createdOn) throw new RangeError('Deadline precedes start');
        checkReach(event.on);
        break;
      case 'contribution':
        if (state.status !== 'active') throw new Error('Reopen a closed goal before funding');
        if (event.forDueOn && !isAnchorDue(start.on, event.forDueOn)) {
          throw new RangeError('Contribution date is not a monthly due date');
        }
        state.balance = safeAdd(state.balance, event.amountCents);
        checkReach(event.on);
        break;
      case 'use':
        if (state.status !== 'active') throw new Error('Reopen a closed goal before using savings');
        state.balance = safeAdd(state.balance, -event.amountCents);
        checkReach(event.on);
        break;
      case 'skip':
        if (state.status !== 'active') throw new Error('Reopen a closed goal before marking a skip');
        if (!isAnchorDue(start.on, event.dueOn)) throw new RangeError('Skipped date is not a monthly due date');
        if (skips.has(event.dueOn)) throw new Error('Installment already marked skipped');
        skips.add(event.dueOn);
        break;
      case 'void': {
        const original = eventMap.get(event.eventId);
        if (!original) throw new TypeError('Missing reversed movement');
        if (state.status !== 'active') throw new Error('Reopen a closed goal before reversing');
        if (original.type === 'contribution') state.balance = safeAdd(state.balance, -original.amountCents);
        if (original.type === 'use') state.balance = safeAdd(state.balance, original.amountCents);
        if (original.type === 'skip') skips.delete(original.dueOn);
        checkReach(event.on);
        break;
      }
      case 'complete':
        if (state.status !== 'active' || state.balance < state.targetCents) {
          throw new Error('Goal can be completed only after reaching the target');
        }
        state.status = 'completed';
        break;
      case 'reopen':
        if (state.status !== 'completed') throw new Error('Only completed goals can be reopened');
        state.status = 'active';
        break;
      case 'archive':
        if (state.status === 'archived') throw new Error('Goal is already archived');
        state.status = 'archived';
        break;
      case 'restore':
        if (state.status !== 'archived') throw new Error('Only archived goals can be restored');
        state.status = 'active';
        break;
    }
  }
  goalDueDates(state.createdOn, state.targetDate); // Bound calendar complexity and validate edits.
  return state;
}

function isAnchorDue(startDate: string, dueOn: string): boolean {
  const startIndex = Number(startDate.slice(0, 4)) * 12 + Number(startDate.slice(5, 7));
  const dueIndex = Number(dueOn.slice(0, 4)) * 12 + Number(dueOn.slice(5, 7));
  const offset = dueIndex - startIndex;
  return offset > 0 && offset <= MAX_MONTHS && monthDue(startDate, offset) === dueOn;
}
function effectiveVoids(goal: GoalRecord, asOf: string): Set<string> {
  return new Set(goal.events.filter((x): x is GoalVoided => x.type === 'void' && x.on <= asOf)
    .map((x) => x.eventId));
}
function skippedDates(goal: GoalRecord, asOf: string): Set<string> {
  const voids = effectiveVoids(goal, asOf);
  return new Set(goal.events
    .filter((e) => e.type === 'skip' && e.on <= asOf && !voids.has(e.id))
    .map((e) => (e.type === 'skip' ? e.dueOn : '')));
}
function dueAssignment(goal: GoalRecord, date: string, explicit: string | undefined): string | null {
  if (explicit) return explicit;
  const created = goal.events[0] as GoalCreated;
  const startIndex = Number(created.on.slice(0, 4)) * 12 + Number(created.on.slice(5, 7));
  const onIndex = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  const offset = Math.max(1, onIndex - startIndex);
  for (let i = offset; i <= Math.min(offset + 1, MAX_MONTHS); i += 1) {
    const due = monthDue(created.on, i);
    if (due >= date) return due;
  }
  return null;
}

/** Count contributions already assigned to a future installment, not additional future cash. */
function prepaidInstallments(goal: GoalRecord, asOf: string): Map<string, number> {
  const voided = effectiveVoids(goal, asOf);
  const assigned = new Map<string, number>();
  for (const event of goal.events) {
    if (event.type !== 'contribution' || event.on > asOf || voided.has(event.id)) continue;
    const dueOn = dueAssignment(goal, event.on, event.forDueOn);
    if (dueOn && dueOn > asOf) {
      assigned.set(dueOn, safeAdd(assigned.get(dueOn) ?? 0, event.amountCents));
    }
  }
  return assigned;
}

/** Smallest monthly installment level covering the outstanding goal, after prepayments. */
function requiredLevel(remaining: number, dates: readonly string[], assigned: Map<string, number>): number {
  if (remaining === 0) return 0;
  let low = 0;
  let high = MAX_GOAL_CENTS;
  const total = BigInt(remaining);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    let capacity = 0n;
    for (const dueOn of dates) {
      capacity += BigInt(Math.max(0, mid - (assigned.get(dueOn) ?? 0)));
      if (capacity >= total) break;
    }
    if (capacity >= total) high = mid;
    else low = mid + 1;
  }
  return low;
}

function previousUTCDate(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10);
}

export function createGoal(input: GoalCreateInput): GoalRecord {
  nonBlank(input.id, 'Goal ID');
  nonBlank(input.eventId, 'Creation event ID');
  const event: GoalCreated = {
    type: 'create',
    id: input.eventId,
    on: input.on,
    title: input.title,
    category: input.category ?? 'other',
    targetCents: input.targetCents,
    targetDate: input.targetDate,
    openingCents: input.openingCents ?? 0,
    monthlyCents: input.monthlyCents ?? null,
    plannedFunding: input.plannedFunding ?? 'virtual',
  };
  const goal: GoalRecord = { version: 1, id: input.id, events: [event] };
  replay(goal, '2200-12-31');
  return goal;
}

/** Append one immutable event, or return the original for an exact idempotent retry. */
export function applyGoalEvent(goal: GoalRecord, event: Exclude<GoalEvent, GoalCreated>): GoalRecord {
  replay(goal, '2200-12-31');
  validateNewEvent(event);
  const sameId = goal.events.find((existing) => existing.id === event.id);
  if (sameId) {
    if (sameEvent(sameId, event)) return goal;
    throw new Error('Goal event ID reused with a different payload');
  }
  if (isFinancial(event) && event.idempotencyKey) {
    const previous = goal.events.find((existing): existing is GoalContribution | GoalUse =>
      isFinancial(existing) && existing.idempotencyKey === event.idempotencyKey);
    if (previous) {
      if (sameFinancialIntent(previous, event)) return goal;
      throw new Error('Idempotency key reused for a different movement');
    }
  }
  if (goal.events.length >= MAX_EVENT_COUNT) throw new RangeError('Goal journal limit reached');
  const next: GoalRecord = { version: 1, id: goal.id, events: [...goal.events, structuredClone(event)] };
  replay(next, '2200-12-31');
  return next;
}

/** Pure as-of snapshot. Future-dated movements, edits and reversals are not factual. */
function calculateGoalPrepared(
  goal: GoalRecord, asOf: string, prepared: PreparedJournal,
): GoalSnapshot {
  const state = replay(goal, asOf, prepared);
  const due = goalDueDates(state.createdOn, state.targetDate);
  const skipped = skippedDates(goal, asOf);
  const futureDue = due.filter((date) => date > asOf && !skipped.has(date));
  const assigned = prepaidInstallments(goal, asOf);
  const remaining = Math.max(0, state.targetCents - state.balance);
  const required = remaining === 0 ? 0 : futureDue.length
    ? requiredLevel(remaining, futureDue, assigned) : null;
  const monthly = state.monthlyCents ?? required ?? 0;
  const deficit = required === null ? null : Math.max(0, required - monthly);
  let projected: string | null = remaining === 0 ? state.reachedOn : null;
  let remainingProjection = remaining;
  let horizonLimited = false;
  if (remaining > 0 && monthly > 0) {
    const futureSkips = skipped;
    const startIndex = Number(state.createdOn.slice(0, 4)) * 12 + Number(state.createdOn.slice(5, 7));
    const asOfIndex = Number(asOf.slice(0, 4)) * 12 + Number(asOf.slice(5, 7));
    let offset = Math.max(1, asOfIndex - startIndex);
    while (offset <= MAX_MONTHS) {
      // Never extrapolate beyond the supported UTC calendar.
      const projectedIndex = Number(state.createdOn.slice(0, 4)) * 12 +
        Number(state.createdOn.slice(5, 7)) - 1 + offset;
      if (projectedIndex > 2200 * 12 + 11) break;
      const day = monthDue(state.createdOn, offset);
      offset += 1;
      if (day <= asOf || futureSkips.has(day)) continue;
      const additional = Math.max(0, monthly - (assigned.get(day) ?? 0));
      remainingProjection = Math.max(0, remainingProjection - additional);
      if (remainingProjection === 0) { projected = day; break; }
    }
    if (projected === null) horizonLimited = true;
  }
  return {
    id: goal.id, asOf, title: state.title, category: state.category, createdOn: state.createdOn,
    targetCents: state.targetCents, targetDate: state.targetDate,
    openingCents: state.openingCents, savedCents: state.balance, remainingCents: remaining,
    progressBasisPoints: Math.min(10_000, Number(BigInt(state.balance) * 10_000n / BigInt(state.targetCents))),
    status: state.status, reached: remaining === 0, reachedOn: state.reachedOn,
    monthlyCents: monthly, monthlyPlanIsFixed: state.monthlyCents !== null,
    requiredMonthlyCents: required, monthlyDeficitCents: deficit,
    remainingInstallments: futureDue.length, projectedCompletionDate: projected,
    projectedOnTime: projected === null ? null : projected <= state.targetDate,
    projectionHorizonLimited: horizonLimited, plannedFunding: state.plannedFunding,
  };
}

export function calculateGoal(goal: GoalRecord, asOf: string): GoalSnapshot {
  return calculateGoalPrepared(goal, asOf, prepareJournal(goal));
}

/** Historic planned amount is evaluated before the due day, without rerunning projections. */
function historicPlan(
  goal: GoalRecord, beforeDue: string, prepared: PreparedJournal,
): { monthlyCents: number; reached: boolean } {
  const state = replay(goal, beforeDue, prepared);
  const reached = state.balance >= state.targetCents;
  if (state.monthlyCents !== null) return { monthlyCents: state.monthlyCents, reached };
  if (reached) return { monthlyCents: 0, reached };
  const skipped = skippedDates(goal, beforeDue);
  const dates = goalDueDates(state.createdOn, state.targetDate)
    .filter((due) => due > beforeDue && !skipped.has(due));
  const remaining = state.targetCents - state.balance;
  const monthlyCents = dates.length
    ? requiredLevel(remaining, dates, prepaidInstallments(goal, beforeDue)) : 0;
  return { monthlyCents, reached };
}

export function goalInstallments(goal: GoalRecord, asOf: string): GoalInstallment[] {
  const prepared = prepareJournal(goal);
  const snapshot = calculateGoalPrepared(goal, asOf, prepared);
  const dates = goalDueDates(snapshot.createdOn, snapshot.targetDate);
  // A never-edited goal has no payments, skips or reversals. Compute historical
  // automatic plans directly instead of O(months²) replay on long horizons.
  if (goal.events.length === 1) {
    const initial = prepared.created;
    const remainingInitial = Math.max(0, initial.targetCents - initial.openingCents);
    return dates.map((dueOn, index) => {
      const elapsed = dueOn <= asOf;
      const remainingMonths = dates.length - index;
      const historic = initial.monthlyCents ?? (remainingInitial === 0 ? 0 : Number(
        (BigInt(remainingInitial) + BigInt(remainingMonths) - 1n) / BigInt(remainingMonths),
      ));
      return {
        dueOn,
        plannedCents: elapsed ? historic : snapshot.monthlyCents,
        actualCents: 0,
        status: snapshot.reached ? 'unnecessary' : elapsed ? 'missed' : 'upcoming',
      };
    });
  }
  const skipped = skippedDates(goal, asOf);
  const voided = effectiveVoids(goal, asOf);
  const allocated = new Map<string, number>();
  for (const event of goal.events) {
    if (event.type !== 'contribution' || event.on > asOf || voided.has(event.id)) continue;
    const due = dueAssignment(goal, event.on, event.forDueOn);
    if (due) allocated.set(due, safeAdd(allocated.get(due) ?? 0, event.amountCents));
  }
  const reached = snapshot.reached;
  return dates.map((dueOn) => {
    const actualCents = allocated.get(dueOn) ?? 0;
    // Later edits must not retroactively turn a fully paid installment into a missed one.
    const historic = dueOn <= asOf
      ? historicPlan(goal, previousUTCDate(dueOn), prepared) : null;
    const plannedCents = historic?.monthlyCents ?? snapshot.monthlyCents;
    let status: GoalInstallment['status'];
    if (skipped.has(dueOn)) status = 'skipped';
    else if (dueOn > asOf && reached) status = 'unnecessary';
    else if (historic?.reached && actualCents === 0) status = 'unnecessary';
    else if (actualCents >= plannedCents && actualCents > 0) status = 'paid';
    else if (actualCents > 0) status = 'partial';
    else if (dueOn > asOf) status = 'upcoming';
    else status = 'missed';
    return { dueOn, plannedCents, actualCents, status };
  });
}

export function goalJournal(goal: GoalRecord): GoalJournalEntry[] {
  replay(goal, '2200-12-31');
  const voids = new Map<string, string>();
  for (const event of goal.events) if (event.type === 'void') voids.set(event.eventId, event.on);
  return goal.events.map((event) => ({
    event: structuredClone(event), voidedOn: voids.get(event.id) ?? null, ledgerMutationCents: 0,
  }));
}

/** Extract references to already-posted #33 movements; throws on cross-goal duplicate ledger links. */
export function goalLedgerLinks(goals: readonly GoalRecord[]): GoalLedgerLink[] {
  const all: GoalLedgerLink[] = [];
  const refs = new Set<string>();
  for (const goal of goals) {
    replay(goal, '2200-12-31');
    for (const event of goal.events) {
      const ref = isFinancial(event) ? event.ledgerMovementId : event.type === 'void' ? event.ledgerReversalId : undefined;
      if (!ref) continue;
      if (refs.has(ref)) throw new Error('Ledger movement cannot be linked to multiple goals');
      refs.add(ref);
      const kind = event.type === 'void' ? 'reversal' : isFinancial(event) ? event.type : null;
      if (!kind) throw new TypeError('Unexpected ledger reference');
      const original = event.type === 'void'
        ? goal.events.find((entry) => entry.id === event.eventId)
        : event;
      if (!original || !isFinancial(original)) throw new TypeError('Missing linked event');
      all.push({ goalId: goal.id, eventId: event.id, ledgerMovementId: ref,
        kind, amountCents: original.amountCents,
        expectedLedgerKind: event.type === 'void' ? 'reversal'
          : event.type === 'use' && event.usage === 'expense' ? 'expense' : 'internal-transfer',
        alreadyPosted: true });
    }
  }
  return all;
}

/** Efficient next unpaid date for goal cards; does not replay historical installments. */
export function goalNextInstallmentOn(goal: GoalRecord, asOf: string): string | null {
  const snapshot = calculateGoal(goal, asOf);
  if (snapshot.status !== 'active' || snapshot.reached) return null;
  const skips = skippedDates(goal, asOf);
  const assigned = prepaidInstallments(goal, asOf);
  for (const dueOn of goalDueDates(snapshot.createdOn, snapshot.targetDate)) {
    if (dueOn <= asOf || skips.has(dueOn)) continue;
    const paid = assigned.get(dueOn) ?? 0;
    // An installment fully prepaid early should not appear as the next obligation.
    if (paid > 0 && paid >= snapshot.monthlyCents) continue;
    return dueOn;
  }
  return null;
}

/** Informational #36 proposals only: never create an expense or account transaction here. */
export function goalForecastReservations(goal: GoalRecord, asOf: string): GoalForecastReservation[] {
  const snapshot = calculateGoal(goal, asOf);
  if (snapshot.status !== 'active' || snapshot.reached) return [];
  let toAllocate = snapshot.remainingCents;
  return goalInstallments(goal, asOf)
    .filter((row) => row.dueOn > asOf &&
      (row.status === 'upcoming' || row.status === 'partial'))
    .map((row) => {
      const plannedCents = Math.min(toAllocate, Math.max(0, row.plannedCents - row.actualCents));
      toAllocate -= plannedCents;
      return { goalId: goal.id, dueOn: row.dueOn, plannedCents,
        funding: snapshot.plannedFunding, cashFlowCents: 0 as const, confirmed: false as const };
    })
    .filter((row) => row.plannedCents > 0);
}
