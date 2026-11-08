/** Self-contained, serializable finance-goal contract. All monetary fields are integer kopecks. */
export type GoalCategory = 'emergency' | 'travel' | 'purchase' | 'education' | 'other';
export type GoalFunding = 'virtual' | 'account-transfer';
export type GoalUsage = 'virtual-release' | 'account-transfer' | 'expense';
export type GoalStatus = 'active' | 'completed' | 'archived';

export interface GoalCreateInput {
  id: string;
  eventId: string;
  on: string;
  title: string;
  category?: GoalCategory;
  targetCents: number;
  targetDate: string;
  /** Explicitly allocated existing savings, not a new bank transaction. */
  openingCents?: number;
  /** null = recalculated automatically, otherwise a fixed monthly plan. */
  monthlyCents?: number | null;
  /** Applies only to planned future installments, not factual account postings. */
  plannedFunding?: GoalFunding;
}

interface GoalEventBase {
  id: string;
  /** Effective local calendar date; supplied by the caller, never the system clock. */
  on: string;
}
export interface GoalCreated extends GoalEventBase {
  type: 'create';
  title: string;
  category: GoalCategory;
  targetCents: number;
  targetDate: string;
  openingCents: number;
  monthlyCents: number | null;
  plannedFunding: GoalFunding;
}
export interface GoalChanges {
  title?: string;
  category?: GoalCategory;
  targetCents?: number;
  targetDate?: string;
  monthlyCents?: number | null;
  plannedFunding?: GoalFunding;
}
export interface GoalUpdated extends GoalEventBase {
  type: 'update';
  changes: GoalChanges;
}
export interface GoalContribution extends GoalEventBase {
  type: 'contribution';
  amountCents: number;
  funding: GoalFunding;
  /** Required for a confirmed #33 internal transfer; never creates a transfer. */
  ledgerMovementId?: string;
  /** Optional explicit monthly installment, including a late payment for an earlier due date. */
  forDueOn?: string;
  idempotencyKey?: string;
}
export interface GoalUse extends GoalEventBase {
  type: 'use';
  amountCents: number;
  usage: GoalUsage;
  /** Required for a confirmed #33 transfer or expense. Virtual release has no ledger ref. */
  ledgerMovementId?: string;
  idempotencyKey?: string;
}
export interface GoalSkipped extends GoalEventBase {
  type: 'skip';
  dueOn: string;
  reason?: string;
}
export interface GoalVoided extends GoalEventBase {
  type: 'void';
  eventId: string;
  reason: string;
  /** Required if the reversed event had a #33 posting; it must exist in #33 already. */
  ledgerReversalId?: string;
}
export interface GoalLifecycle extends GoalEventBase {
  type: 'complete' | 'reopen' | 'archive' | 'restore';
}
export type GoalEvent =
  | GoalCreated
  | GoalUpdated
  | GoalContribution
  | GoalUse
  | GoalSkipped
  | GoalVoided
  | GoalLifecycle;

export interface GoalRecord {
  version: 1;
  id: string;
  /** Append-only audit trail. Financial corrections are new 'void' entries. */
  events: GoalEvent[];
}

export interface GoalSnapshot {
  id: string;
  asOf: string;
  title: string;
  category: GoalCategory;
  createdOn: string;
  targetCents: number;
  targetDate: string;
  openingCents: number;
  savedCents: number;
  remainingCents: number;
  progressBasisPoints: number; // 10_000 = 100%; clamped at target.
  status: GoalStatus;
  reached: boolean;
  monthlyCents: number; // Effective monthly plan (fixed or auto-calculated).
  monthlyPlanIsFixed: boolean;
  requiredMonthlyCents: number | null; // null if no installment can occur before deadline.
  monthlyDeficitCents: number | null;
  remainingInstallments: number;
  projectedCompletionDate: string | null;
  projectedOnTime: boolean | null;
  projectionHorizonLimited: boolean;
  plannedFunding: GoalFunding;
}

export interface GoalInstallment {
  dueOn: string;
  plannedCents: number;
  actualCents: number;
  status: 'upcoming' | 'paid' | 'partial' | 'missed' | 'skipped' | 'unnecessary';
}

export interface GoalJournalEntry {
  event: GoalEvent;
  voidedOn: string | null;
  /** Goal operations do not themselves post to the general ledger. */
  ledgerMutationCents: 0;
}

export interface GoalLedgerLink {
  goalId: string;
  eventId: string;
  ledgerMovementId: string;
  kind: 'contribution' | 'use' | 'reversal';
  amountCents: number;
  /** #33 adapter must verify type, amount and account ownership independently. */
  expectedLedgerKind: 'internal-transfer' | 'expense' | 'reversal';
  /** Existing #33 operation, not a command to perform it again. */
  alreadyPosted: true;
}

export interface GoalForecastReservation {
  goalId: string;
  dueOn: string;
  plannedCents: number;
  funding: GoalFunding;
  /** Never treat earmarking or own-account transfers as external spending. */
  cashFlowCents: 0;
  /** Marked as a proposal, never counted as an actual bank balance change. */
  confirmed: false;
}
