/**
 * Read-only bridge between #41 ledger cashflow and #35 budget spending.
 * Both domains use different, intentional reversal-date conventions.
 * This module DOES NOT read a ledger, storage, API or the current time.
 * Callers must supply trusted, complete, same-revision and profile-scoped #35
 * reports; validation here is structural, not proof of session authorization.
 */
import type { AnalyticsReport } from './types.ts';

/** Structural subset of #35 BudgetUsage; no runtime import from its unmerged PR. */
export interface BudgetUsageSnapshot {
  ruleId: string;
  scope: { kind: 'total' } | { kind: 'category'; categoryId: string };
  limitMinor: number;
  spentMinor: number;
  plannedMinor: number;
  remainingMinor: number;
  overrunMinor: number;
  percentUsed: number | null;
  exceeded: boolean;
}
/** Structural subset of #35 BudgetReport, supplied by the verified budget domain. */
export interface MonthlyBudgetSnapshot {
  profileId: string;
  month: string;
  confirmedExpenseMinor: number;
  plannedExpenseMinor: number;
  uncategorizedExpenseMinor: number;
  total: BudgetUsageSnapshot | null;
  categories: readonly BudgetUsageSnapshot[];
}
export interface BudgetCategoryComparison {
  categoryId: string;
  spentMinor: number;
  limitMinor: number;
  plannedMinor: number;
  remainingMinor: number;
  overrunMinor: number;
}
export interface BudgetMonthComparison {
  month: string;
  /** Cash movements by posting date; can be negative after refunds. */
  ledgerCashflowExpenseMinor: number | null;
  /** 'absent' is unknown, not zero; 'partial' excludes an incomplete month. */
  status: 'complete' | 'partial' | 'absent';
  /** Retrospective budget consumption from #35 (not ledger cashflow). */
  budgetSpentMinor: number | null;
  /** #35 planned expense events, which are NOT the budget limit. */
  plannedEventsMinor: number | null;
  limitMinor: number | null;
  remainingMinor: number | null;
  overrunMinor: number | null;
  /** Budget spent minus budget limit; negative means headroom. */
  budgetVarianceMinor: number | null;
  categoryBudgets: BudgetCategoryComparison[];
}
export interface AnalyticsBudgetComparison {
  profileId: string;
  period: { from: string; to: string };
  months: BudgetMonthComparison[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function reject(reason: string): never {
  throw new RangeError(`Некорректная сводка бюджетов #35: ${reason}`);
}
function checkedId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) reject('идентификатор');
}
function nonnegative(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject('нецелые или отрицательные копейки');
}
function signed(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)) reject('некорректные целые копейки');
}
function toSafe(value: bigint): number {
  if (value > MAX || value < -MAX) reject('переполнение копеек');
  return Number(value);
}
function assertUsage(u: BudgetUsageSnapshot, expectedScope: 'total' | 'category'): void {
  if (!u || typeof u !== 'object') reject('отсутствует правило бюджета');
  checkedId(u.ruleId);
  if (!u.scope || u.scope.kind !== expectedScope) reject('неверная область лимита');
  if (expectedScope === 'category') checkedId((u.scope as { categoryId: string }).categoryId);
  nonnegative(u.limitMinor);
  nonnegative(u.spentMinor);
  nonnegative(u.plannedMinor);
  signed(u.remainingMinor);
  nonnegative(u.overrunMinor);
  const remaining = BigInt(u.limitMinor) - BigInt(u.spentMinor);
  if (remaining !== BigInt(u.remainingMinor) ||
      (remaining < 0n ? -remaining : 0n) !== BigInt(u.overrunMinor) ||
      u.exceeded !== (remaining < 0n)) reject('несогласованные план/факт/перерасход');
  // A percentage is auxiliary display metadata, never used for financial math.
  if (u.percentUsed !== null && (!Number.isFinite(u.percentUsed) || u.percentUsed < 0)) {
    reject('неверная доля лимита');
  }
  if (u.limitMinor === 0 && u.percentUsed !== null) reject('процент при нулевом лимите');
}
function assertBudget(snapshot: MonthlyBudgetSnapshot, expectedProfileId: string): void {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.profileId !== expectedProfileId) {
    reject('чужой финансовый профиль');
  }
  if (typeof snapshot.month !== 'string' || !MONTH.test(snapshot.month) ||
      snapshot.month.startsWith('0000-')) reject('неверный месяц');
  nonnegative(snapshot.confirmedExpenseMinor);
  nonnegative(snapshot.plannedExpenseMinor);
  nonnegative(snapshot.uncategorizedExpenseMinor);
  if (snapshot.uncategorizedExpenseMinor > snapshot.confirmedExpenseMinor) {
    reject('расход без категории превышает общий');
  }
  if (!Array.isArray(snapshot.categories)) reject('нет категорий бюджета');
  if (snapshot.total !== null) {
    assertUsage(snapshot.total, 'total');
    if (snapshot.total.spentMinor !== snapshot.confirmedExpenseMinor) {
      reject('общий факт не совпадает с расходованием общего лимита');
    }
  }
  const rules = new Set<string>();
  const categories = new Set<string>();
  let spent = 0n;
  for (const usage of snapshot.categories) {
    assertUsage(usage, 'category');
    const categoryId = (usage.scope as { categoryId: string }).categoryId;
    if (rules.has(usage.ruleId) || categories.has(categoryId)) reject('повторное правило или категория');
    rules.add(usage.ruleId);
    categories.add(categoryId);
    spent += BigInt(usage.spentMinor);
  }
  if (spent + BigInt(snapshot.uncategorizedExpenseMinor) > BigInt(snapshot.confirmedExpenseMinor)) {
    reject('категорийные расходы превышают общие');
  }
}
function fullMonth(month: string, from: string, to: string): boolean {
  const lastDate = new Date(`${month}-01T00:00:00.000Z`);
  lastDate.setUTCMonth(lastDate.getUTCMonth() + 1);
  lastDate.setUTCDate(0);
  const last = lastDate.getUTCDate();
  return from <= `${month}-01` && to >= `${month}-${String(last).padStart(2, '0')}`;
}

/**
 * Never reconstruct #35 budget spending from #41 reversal postings. Only
 * verified full-month #35 results can produce a comparable budget series.
 * A real data layer must authorize the same profile and revision before use.
 */
export function compareAnalyticsToBudgets(
  report: AnalyticsReport,
  expectedProfileId: string,
  budgetSnapshots: readonly MonthlyBudgetSnapshot[],
): AnalyticsBudgetComparison {
  checkedId(expectedProfileId);
  if (!report || !report.period || !Array.isArray(report.monthly) ||
      !Array.isArray(budgetSnapshots)) reject('нет отчёта или бюджетов');
  const reportMonths = new Set<string>();
  for (const month of report.monthly) {
    if (!month || typeof month.month !== 'string' || !MONTH.test(month.month) ||
        reportMonths.has(month.month)) reject('повторный месяц аналитики');
    reportMonths.add(month.month);
  }
  const budgets = new Map<string, MonthlyBudgetSnapshot>();
  for (const snapshot of budgetSnapshots) {
    assertBudget(snapshot, expectedProfileId);
    if (!reportMonths.has(snapshot.month) || budgets.has(snapshot.month)) {
      reject('отсутствующий или повторный месяц бюджета');
    }
    budgets.set(snapshot.month, snapshot);
  }
  return {
    profileId: expectedProfileId,
    period: { ...report.period },
    months: report.monthly.map(month => {
      const snapshot = budgets.get(month.month);
      const complete = fullMonth(month.month, report.period.from, report.period.to);
      const budget = snapshot && complete ? snapshot : null;
      const limit = budget?.total?.limitMinor ?? null;
      return {
        month: month.month,
        ledgerCashflowExpenseMinor: month.hasActual ? month.expenseMinor : null,
        status: !complete ? 'partial' as const : !budget ? 'absent' as const : 'complete' as const,
        budgetSpentMinor: budget?.confirmedExpenseMinor ?? null,
        plannedEventsMinor: budget?.plannedExpenseMinor ?? null,
        limitMinor: limit,
        remainingMinor: budget?.total?.remainingMinor ?? null,
        overrunMinor: budget?.total?.overrunMinor ?? null,
        budgetVarianceMinor: limit === null || !budget ? null
          : toSafe(BigInt(budget.confirmedExpenseMinor) - BigInt(limit)),
        categoryBudgets: (budget?.categories ?? []).map(u => ({
          categoryId: (u.scope as { categoryId: string }).categoryId,
          spentMinor: u.spentMinor,
          limitMinor: u.limitMinor,
          plannedMinor: u.plannedMinor,
          remainingMinor: u.remainingMinor,
          overrunMinor: u.overrunMinor,
        })).sort((a, b) => a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0),
      };
    }),
  };
}
