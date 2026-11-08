/**
 * #35 - deterministic RUB budget projection. Does not read/write storage or mutate
 * financial history. Money is represented only as integer kopecks.
 */
export const MAX_MINOR = 1_000_000_000_000; // Contract #33/#65; no import until #33 merges.

export type BudgetScope = { kind: 'total' } | { kind: 'category'; categoryId: string };
export type BudgetRecurrence = 'monthly' | 'once';

export interface BudgetRule {
  id: string;
  profileId: string;
  scope: BudgetScope;
  limitMinor: number;
  recurrence: BudgetRecurrence;
  fromMonth: string;
  /** Exclusive YYYY-MM boundary, independent from whether the rule was archived. */
  endsBeforeMonth?: string | null;
  /** First month for which this rule is inactive. Earlier budgets are retained. */
  archivedFromMonth?: string | null;
}

export type BudgetOperationKind =
  | 'expense'
  | 'income'
  | 'payment'
  | 'transfer'
  | 'reserve'
  | 'adjustment'
  | 'reversal';
export type BudgetOperationStatus = 'confirmed' | 'planned' | 'voided';

export interface BudgetOperation {
  id: string;
  profileId: string;
  occurredOn: string;
  kind: BudgetOperationKind;
  status: BudgetOperationStatus;
  /** Signed account effect: expense/payment outflow is negative. */
  signedMinor: number;
  /** Null means uncategorized; it still consumes the total budget. */
  categoryId: string | null;
  /** Used only by append-only reversal rows, not a separate expense. */
  reversedTransactionId?: string | null;
  /** Unique settled fact key for each payment, e.g. settlement:<uuid>. */
  sourceFactId?: string | null;
}

export interface BudgetUsage {
  ruleId: string;
  scope: BudgetScope;
  limitMinor: number;
  spentMinor: number;
  plannedMinor: number;
  remainingMinor: number;
  overrunMinor: number;
  /** Informational display percentage, not a financial amount. Null for zero limit. */
  percentUsed: number | null;
  exceeded: boolean;
}

export interface BudgetReport {
  profileId: string;
  month: string;
  confirmedExpenseMinor: number;
  plannedExpenseMinor: number;
  uncategorizedExpenseMinor: number;
  total: BudgetUsage | null;
  categories: BudgetUsage[];
}

function checkedMoney(value: number, min: number, max = MAX_MINOR): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError('Money must be integer kopecks within the supported range');
  }
}

function checkedString(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) {
    throw new TypeError(`Invalid ${field}`);
  }
}

function checkedMonth(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError('Invalid YYYY-MM month');
  }
}

function checkedDate(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('Invalid YYYY-MM-DD date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('Nonexistent calendar date');
  }
}

function addMinor(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('Budget aggregate overflow');
  return sum;
}

function activeInMonth(rule: BudgetRule, month: string): boolean {
  return month >= rule.fromMonth
    && (rule.recurrence === 'monthly' || month === rule.fromMonth)
    && (rule.endsBeforeMonth == null || month < rule.endsBeforeMonth)
    && (rule.archivedFromMonth == null || month < rule.archivedFromMonth);
}

function usage(rule: BudgetRule, spentMinor: number, plannedMinor: number): BudgetUsage {
  const remainingMinor = addMinor(rule.limitMinor, -spentMinor);
  return {
    ruleId: rule.id,
    scope: rule.scope.kind === 'total'
      ? { kind: 'total' }
      : { kind: 'category', categoryId: rule.scope.categoryId },
    limitMinor: rule.limitMinor,
    spentMinor,
    plannedMinor,
    remainingMinor,
    overrunMinor: Math.max(0, -remainingMinor),
    percentUsed: rule.limitMinor === 0
      ? null
      : Math.round((spentMinor / rule.limitMinor) * 10_000) / 100,
    exceeded: remainingMinor < 0,
  };
}

/**
 * Pure projection of the *current* confirmed ledger. Reversals remove the
 * original expense from its original month; replacement entries use their own
 * dates/categories. Cash-flow by reversal posting date belongs to ledger #33.
 */
export function calculateBudgetReport(input: {
  profileId: string;
  month: string;
  rules: readonly BudgetRule[];
  operations: readonly BudgetOperation[];
}): BudgetReport {
  const { profileId, month, rules, operations } = input;
  checkedString(profileId, 'profileId');
  checkedMonth(month);

  const seenRules = new Set<string>();
  const activeScopes = new Set<string>();
  let totalRule: BudgetRule | null = null;
  const categoryRules: BudgetRule[] = [];
  for (const rule of rules) {
    checkedString(rule.id, 'budget rule ID');
    if (seenRules.has(rule.id)) throw new Error('Duplicate budget rule ID');
    seenRules.add(rule.id);
    if (rule.profileId !== profileId) throw new Error('Cross-profile budget rule');
    checkedMoney(rule.limitMinor, 0);
    checkedMonth(rule.fromMonth);
    if (rule.endsBeforeMonth != null) {
      checkedMonth(rule.endsBeforeMonth);
      if (rule.endsBeforeMonth <= rule.fromMonth) throw new RangeError('Invalid rule end month');
    }
    if (rule.archivedFromMonth != null) checkedMonth(rule.archivedFromMonth);
    if (rule.recurrence !== 'monthly' && rule.recurrence !== 'once') {
      throw new TypeError('Invalid recurrence');
    }
    if (rule.scope.kind !== 'total' && rule.scope.kind !== 'category') {
      throw new TypeError('Invalid budget scope');
    }
    if (rule.scope.kind === 'category') checkedString(rule.scope.categoryId, 'category ID');
    if (!activeInMonth(rule, month)) continue;
    const key = rule.scope.kind === 'total' ? 'total' : `category:${rule.scope.categoryId}`;
    if (activeScopes.has(key)) throw new Error('Overlapping active budget rules');
    activeScopes.add(key);
    if (rule.scope.kind === 'total') totalRule = rule;
    else categoryRules.push(rule);
  }

  const operationById = new Map<string, BudgetOperation>();
  const sourceFactIds = new Set<string>();
  for (const op of operations) {
    checkedString(op.id, 'transaction ID');
    if (operationById.has(op.id)) throw new Error('Duplicate transaction ID');
    operationById.set(op.id, op);
    if (op.profileId !== profileId) throw new Error('Cross-profile transaction');
    checkedDate(op.occurredOn);
    checkedMoney(op.signedMinor, -MAX_MINOR);
    if (op.categoryId !== null) checkedString(op.categoryId, 'category ID');
    if (!['confirmed', 'planned', 'voided'].includes(op.status)) throw new TypeError('Invalid transaction status');
    switch (op.kind) {
      case 'expense':
        if (op.signedMinor >= 0) throw new RangeError('Expense must have negative amount');
        break;
      case 'income':
        if (op.signedMinor <= 0) throw new RangeError('Income must have positive amount');
        break;
      case 'payment':
        if (op.signedMinor === 0 || op.status === 'planned') {
          throw new RangeError('Only posted nonzero payments are allowed');
        }
        checkedString(op.sourceFactId as string, 'payment fact ID');
        if (sourceFactIds.has(op.sourceFactId!)) throw new Error('Duplicate payment fact');
        sourceFactIds.add(op.sourceFactId!);
        break;
      case 'transfer':
        if (op.signedMinor !== 0) throw new RangeError('Own transfer must net to zero');
        break;
      case 'reserve':
      case 'adjustment':
        break; // Not consumer spending, even when the account effect is negative.
      case 'reversal':
        if (op.status !== 'confirmed') throw new TypeError('Reversal must be confirmed');
        checkedString(op.reversedTransactionId as string, 'reversed transaction ID');
        break;
      default:
        throw new TypeError('Unknown transaction kind');
    }
  }

  const reversedIds = new Set<string>();
  for (const op of operations) {
    if (op.kind !== 'reversal') continue;
    const original = operationById.get(op.reversedTransactionId!);
    if (!original || original.kind === 'reversal' || original.status !== 'confirmed') {
      throw new Error('Orphan or invalid budget reversal');
    }
    if (reversedIds.has(original.id)) throw new Error('Double reversal');
    if (op.signedMinor !== -original.signedMinor) throw new Error('Reversal amount mismatch');
    reversedIds.add(original.id);
  }

  let confirmedExpenseMinor = 0;
  let plannedExpenseMinor = 0;
  let uncategorizedExpenseMinor = 0;
  const spentByCategory = new Map<string, number>();
  const plannedByCategory = new Map<string, number>();
  for (const op of operations) {
    if (op.occurredOn.slice(0, 7) !== month || op.status === 'voided'
      || op.kind === 'reversal' || reversedIds.has(op.id)) continue;
    if (op.kind !== 'expense' && !(op.kind === 'payment' && op.signedMinor < 0)) continue;
    const amount = -op.signedMinor;
    if (op.status === 'confirmed') {
      confirmedExpenseMinor = addMinor(confirmedExpenseMinor, amount);
      if (op.categoryId == null) uncategorizedExpenseMinor = addMinor(uncategorizedExpenseMinor, amount);
      else spentByCategory.set(op.categoryId, addMinor(spentByCategory.get(op.categoryId) ?? 0, amount));
    } else if (op.status === 'planned') {
      plannedExpenseMinor = addMinor(plannedExpenseMinor, amount);
      if (op.categoryId != null) {
        plannedByCategory.set(op.categoryId, addMinor(plannedByCategory.get(op.categoryId) ?? 0, amount));
      }
    }
  }

  return {
    profileId,
    month,
    confirmedExpenseMinor,
    plannedExpenseMinor,
    uncategorizedExpenseMinor,
    total: totalRule === null ? null : usage(totalRule, confirmedExpenseMinor, plannedExpenseMinor),
    categories: categoryRules
      .sort((a, b) => {
        const left = a.scope.kind === 'category' ? a.scope.categoryId : '';
        const right = b.scope.kind === 'category' ? b.scope.categoryId : '';
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .map(rule => {
        if (rule.scope.kind !== 'category') throw new Error('Unexpected total scope');
        return usage(rule, spentByCategory.get(rule.scope.categoryId) ?? 0,
          plannedByCategory.get(rule.scope.categoryId) ?? 0);
      }),
  };
}
