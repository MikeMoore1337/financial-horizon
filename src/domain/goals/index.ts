export {
  createGoal,
  applyGoalEvent,
  calculateGoal,
  goalInstallments,
  goalJournal,
  goalLedgerLinks,
  goalForecastReservations,
  MAX_GOAL_CENTS,
} from './engine.ts';
export { monthDue, goalDueDates } from './calendar.ts';
export type {
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
  GoalUsage,
  GoalVoided,
} from './types.ts';
export { goalNextInstallmentOn } from './engine.ts';
export { buildGoalsScreenModel } from './presentation.ts';
export type {
  GoalCardModel, GoalDeadlineIndicator, GoalDetailModel, GoalHistoryModel,
  GoalsScreenModel,
} from './presentation.ts';
export { buildGoalCashflowBundle, withGoalCashflowSources } from './cashflow-bridge.ts';
export type { GoalAccountBinding, GoalCashflowBundle } from './cashflow-bridge.ts';
