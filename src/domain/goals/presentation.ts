/**
 * Read-only screen-facing projection for the approved goals mockup (#37).
 * It does not own persistence, account cash, bank operations or React rendering.
 * A real UI must treat savings as earmarked funds, NEVER as a bank balance.
 */
import { calculateGoal, goalInstallments, goalJournal, goalLedgerLinks } from './engine.ts';
import { assertGoalDate } from './calendar.ts';
import type {
  GoalCategory, GoalEvent, GoalInstallment, GoalRecord, GoalSnapshot, GoalStatus,
} from './types.ts';

export type GoalDeadlineIndicator = 'reached' | 'on-time' | 'late' | 'unknown';

export interface GoalCardModel {
  id: string;
  title: string;
  category: GoalCategory;
  status: GoalStatus;
  targetCents: number;
  savedCents: number;
  remainingCents: number;
  progressBasisPoints: number;
  targetDate: string;
  monthlyCents: number;
  nextInstallmentOn: string | null;
  projectedCompletionDate: string | null;
  deadline: GoalDeadlineIndicator;
  /** A voluntary allocation, not a confirmed bank balance or an expense. */
  earmarkedNotCash: true;
}

export interface GoalHistoryModel {
  eventId: string;
  on: string;
  type: GoalEvent['type'];
  amountCents: number | null;
  /** Always 0: goal journal events never write account postings. */
  ledgerMutationCents: 0;
  reversed: boolean;
  voidedOn: string | null;
}

export interface GoalDetailModel {
  card: GoalCardModel;
  snapshot: GoalSnapshot;
  installments: GoalInstallment[];
  history: GoalHistoryModel[];
}

export interface GoalsScreenModel {
  asOf: string;
  cards: GoalCardModel[];
  selected: GoalDetailModel | null;
  activeCount: number;
  completedCount: number;
  archivedCount: number;
  /** Sum of explicitly earmarked allocations, not a claim of funds available in accounts. */
  earmarkedCents: number;
  /** The screen must not silently interpret goal contributions as spending. */
  accountMutations: 0;
}

const MAX_DISPLAY_GOALS = 500;
const STATUS_ORDER: Record<GoalStatus, number> = { active: 0, completed: 1, archived: 2 };

function addCents(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Total earmarked funds exceed safe integer kopecks');
  return result;
}

function indicator(snapshot: GoalSnapshot): GoalDeadlineIndicator {
  if (snapshot.reached) return 'reached';
  if (snapshot.projectedOnTime === true) return 'on-time';
  if (snapshot.projectedOnTime === false || (snapshot.monthlyDeficitCents ?? 0) > 0 ||
      (snapshot.targetDate < snapshot.asOf && snapshot.remainingCents > 0)) return 'late';
  return 'unknown';
}

function toCard(snapshot: GoalSnapshot, installments: readonly GoalInstallment[]): GoalCardModel {
  const next = snapshot.status !== 'active' || snapshot.reached
    ? undefined
    : installments.find((row) => row.dueOn > snapshot.asOf &&
        (row.status === 'upcoming' || row.status === 'partial'));
  return {
    id: snapshot.id,
    title: snapshot.title,
    category: snapshot.category,
    status: snapshot.status,
    targetCents: snapshot.targetCents,
    savedCents: snapshot.savedCents,
    remainingCents: snapshot.remainingCents,
    progressBasisPoints: snapshot.progressBasisPoints,
    targetDate: snapshot.targetDate,
    monthlyCents: snapshot.monthlyCents,
    nextInstallmentOn: next?.dueOn ?? null,
    projectedCompletionDate: snapshot.projectedCompletionDate,
    deadline: indicator(snapshot),
    earmarkedNotCash: true,
  };
}

function toHistory(goal: GoalRecord, asOf: string): GoalHistoryModel[] {
  return goalJournal(goal)
    .filter((row) => row.event.on <= asOf)
    .map((row, index) => {
      const event = row.event;
      const voidedOn = row.voidedOn !== null && row.voidedOn <= asOf ? row.voidedOn : null;
      return {
        eventId: event.id,
        on: event.on,
        type: event.type,
        amountCents: event.type === 'contribution' || event.type === 'use'
          ? event.amountCents : null,
        ledgerMutationCents: 0 as const,
        reversed: voidedOn !== null,
        voidedOn,
        insertionOrder: index,
      };
    })
    .sort((a, b) => b.on.localeCompare(a.on) || b.insertionOrder - a.insertionOrder)
    .map(({ insertionOrder: _index, ...row }) => row);
}

/**
 * Materializes a consistent as-of view. This is not a bank/account adapter.
 * Cross-goal account ownership and allocation limits remain integration gates.
 */
export function buildGoalsScreenModel(
  goals: readonly GoalRecord[],
  asOf: string,
  selectedGoalId?: string | null,
): GoalsScreenModel {
  assertGoalDate(asOf);
  if (!Array.isArray(goals) || goals.length > MAX_DISPLAY_GOALS) {
    throw new RangeError('Invalid or excessive goal list');
  }
  const ids = new Set<string>();
  const entries: Array<{ goal: GoalRecord; snapshot: GoalSnapshot; card: GoalCardModel }> = [];
  let earmarkedCents = 0;
  let activeCount = 0;
  let completedCount = 0;
  let archivedCount = 0;
  for (const goal of goals) {
    if (!goal || ids.has(goal.id)) throw new Error('Duplicate or missing goal ID');
    ids.add(goal.id);
    const snapshot = calculateGoal(goal, asOf);
    const installments = goalInstallments(goal, asOf);
    const card = toCard(snapshot, installments);
    entries.push({ goal, snapshot, card });
    earmarkedCents = addCents(earmarkedCents, snapshot.savedCents);
    if (snapshot.status === 'active') activeCount += 1;
    else if (snapshot.status === 'completed') completedCount += 1;
    else archivedCount += 1;
  }
  // Ensure the same already-posted ledger movement is not represented in two goals.
  goalLedgerLinks(goals);
  entries.sort((a, b) => STATUS_ORDER[a.card.status] - STATUS_ORDER[b.card.status] ||
    a.card.targetDate.localeCompare(b.card.targetDate) || a.card.id.localeCompare(b.card.id));
  const found = (selectedGoalId == null ? null : entries.find((x) => x.card.id === selectedGoalId)) ??
    entries.find((x) => x.card.status !== 'archived') ?? entries[0];
  const selected = found ? {
    card: found.card,
    snapshot: found.snapshot,
    installments: goalInstallments(found.goal, asOf),
    history: toHistory(found.goal, asOf),
  } : null;
  return {
    asOf,
    cards: entries.map((x) => x.card),
    selected,
    activeCount,
    completedCount,
    archivedCount,
    earmarkedCents,
    accountMutations: 0,
  };
}
