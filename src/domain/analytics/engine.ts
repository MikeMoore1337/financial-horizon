import type {
  AnalyticsCategory, AnalyticsInput, AnalyticsPlan, AnalyticsReport, AnalyticsSnapshot,
  AnalyticsTransaction, CategorySummary, ChangeSummary, MonthlySummary, PeriodComparison,
} from './types.ts';

const MAX_TRANSACTION_MINOR = 1_000_000_000_000; // #33 / ADR #65.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const key = (id: string | null): string => id ?? '';

function safeAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('Переполнение суммы финансового отчёта');
  return sum;
}
/** Never reject a valid net sum merely because temporary credits precede reversals. */
function fromBigint(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Переполнение суммы финансового отчёта');
  }
  return Number(value);
}
interface AggregatedAmounts { income: bigint; expense: bigint }
function accumulate<K>(totals: Map<K, AggregatedAmounts>, key: K,
  direction: 'income' | 'expense', signedMinor: number): void {
  let values = totals.get(key);
  if (!values) {
    values = { income: 0n, expense: 0n };
    totals.set(key, values);
  }
  if (direction === 'income') values.income += BigInt(signedMinor);
  else values.expense -= BigInt(signedMinor);
}
function money(value: number, allowNegative: boolean, max = MAX_TRANSACTION_MINOR): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > max || (!allowNegative && value < 0)) {
    throw new RangeError('Ожидается целая сумма копеек в допустимых пределах');
  }
}
function isoDate(value: string): void {
  if (typeof value !== 'string' || !DATE.test(value) || value.startsWith('0000-')) {
    throw new RangeError('Неверная календарная дата');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError('Несуществующая календарная дата');
  }
}
function isoMonth(value: string): void {
  if (typeof value !== 'string' || !MONTH.test(value) || value.startsWith('0000-')) {
    throw new RangeError('Неверный календарный месяц');
  }
}
function isoInstant(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError('Неверная дата отмены финансовой операции');
  }
}
function nonempty(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Не указан идентификатор или название');
}
function monthsBetween(from: string, to: string): string[] {
  const first = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  const last = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - 1;
  if (last - first > 1199) throw new RangeError('Период отчёта превышает 100 лет');
  const months: string[] = [];
  for (let x = first; x <= last; x += 1) {
    months.push(`${String(Math.floor(x / 12)).padStart(4, '0')}-${String(x % 12 + 1).padStart(2, '0')}`);
  }
  return months;
}
function fullCalendarMonth(month: string, from: string, to: string): boolean {
  const last = new Date(`${month}-01T00:00:00.000Z`);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  return from <= `${month}-01` && to >= `${month}-${String(last.getUTCDate()).padStart(2, '0')}`;
}
function requireUniqueTransactions(input: readonly AnalyticsTransaction[]): Map<string, AnalyticsTransaction> {
  const transactions = new Map<string, AnalyticsTransaction>();
  const reversed = new Set<string>();
  for (const tx of input) {
    if (!tx || typeof tx !== 'object') throw new TypeError('Неверная финансовая операция');
    nonempty(tx.id);
    isoDate(tx.date);
    money(tx.signedMinor, true);
    if (tx.categoryId !== undefined && tx.categoryId !== null) nonempty(tx.categoryId);
    if (tx.voidedAt !== undefined && tx.voidedAt !== null) isoInstant(tx.voidedAt);
    if (transactions.has(tx.id)) throw new RangeError('Двойной учёт: повторяющийся идентификатор');
    switch (tx.kind) {
      case 'income':
        if (tx.signedMinor <= 0) throw new RangeError('Неверный знак дохода');
        break;
      case 'expense':
        if (tx.signedMinor >= 0) throw new RangeError('Неверный знак расхода');
        break;
      case 'payment':
        if (tx.signedMinor === 0) throw new RangeError('Нулевая оплата');
        break;
      case 'transfer':
      case 'reservation':
        if (tx.signedMinor !== 0) throw new RangeError('Перевод/резервирование не является доходом или расходом');
        break;
      case 'adjustment':
      case 'reversal':
        break;
      default:
        throw new TypeError('Неизвестный вид финансовой операции');
    }
    if (tx.kind !== 'reversal' && tx.reversedTransactionId != null) {
      throw new TypeError('Ссылка на компенсацию у обычной операции');
    }
    transactions.set(tx.id, tx);
  }
  for (const tx of input) {
    if (tx.kind !== 'reversal') continue;
    if (tx.voidedAt != null) throw new RangeError('Компенсирующую операцию нельзя отменять логически');
    nonempty(tx.reversedTransactionId as string);
    const original = transactions.get(tx.reversedTransactionId!);
    if (!original || original.kind === 'reversal' || original.voidedAt != null || reversed.has(original.id)) {
      throw new RangeError('Отсутствует исходная операция или двойная компенсация');
    }
    if (tx.signedMinor !== -original.signedMinor ||
        (tx.categoryId != null && tx.categoryId !== (original.categoryId ?? null))) {
      throw new RangeError('Компенсация не соответствует исходной операции');
    }
    reversed.add(original.id);
  }
  return transactions;
}
function validatePlans(plans: readonly AnalyticsPlan[]): Map<string, AnalyticsPlan> {
  const result = new Map<string, AnalyticsPlan>();
  const ids = new Set<string>();
  for (const plan of plans) {
    nonempty(plan.id);
    isoMonth(plan.month);
    money(plan.amountMinor, false);
    if (plan.direction !== 'income' && plan.direction !== 'expense') throw new TypeError('Неверное направление плана');
    if (plan.scope !== 'total' && plan.scope !== 'category') throw new TypeError('Неверный уровень плана');
    if (plan.scope === 'category') nonempty(plan.categoryId!);
    if (plan.scope === 'total' && plan.categoryId != null) throw new TypeError('У общего плана не может быть категории');
    const planKey = `${plan.month}|${plan.direction}|${plan.scope}|${plan.categoryId ?? ''}`;
    if (ids.has(plan.id) || result.has(planKey)) throw new RangeError('Повторяющийся план');
    ids.add(plan.id);
    result.set(planKey, plan);
  }
  return result;
}
function validateSnapshots(input: readonly AnalyticsSnapshot[]): AnalyticsSnapshot[] {
  const seen = new Set<string>();
  const output = input.map(point => {
    isoDate(point.date);
    money(point.balanceMinor, false);
    if (seen.has(point.date)) throw new RangeError('Дублированный снимок остатка');
    seen.add(point.date);
    return { date: point.date, balanceMinor: point.balanceMinor };
  });
  return output.sort((a, b) => compare(a.date, b.date));
}
function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some(x => x === null) ? null : values.reduce<number>((acc, x) => safeAdd(acc, x!), 0);
}
function categoryName(id: string | null, catalog: Map<string, AnalyticsCategory>): string {
  return id === null ? 'Без категории' : catalog.get(id)?.name ?? 'Неизвестная категория';
}
function positiveShares(rows: CategorySummary[]): void {
  const positive = rows.filter(x => x.expenseMinor > 0);
  const denominator = positive.reduce<bigint>((sum, x) => sum + BigInt(x.expenseMinor), 0n);
  if (denominator === 0n) return;
  const shares = positive.map(item => {
    const numerator = BigInt(item.expenseMinor) * 10_000n;
    const units = numerator / denominator;
    return { item, units: Number(units), remainder: numerator % denominator };
  });
  let remainder = 10_000 - shares.reduce((sum, value) => sum + value.units, 0);
  shares.sort((a, b) => a.remainder === b.remainder
    ? compare(key(a.item.categoryId), key(b.item.categoryId))
    : a.remainder > b.remainder ? -1 : 1);
  for (const share of shares) share.item.expenseShareBps = share.units + (remainder-- > 0 ? 1 : 0);
}

/** Exact, pure financial aggregation; no IndexedDB, network, time-zone or UI dependencies. */
export function buildAnalyticsReport(input: AnalyticsInput): AnalyticsReport {
  if (!input || !Array.isArray(input.transactions) || (input.categories && !Array.isArray(input.categories))
      || (input.plans && !Array.isArray(input.plans)) || (input.debtSnapshots && !Array.isArray(input.debtSnapshots))
      || (input.savingsSnapshots && !Array.isArray(input.savingsSnapshots))) {
    throw new TypeError('Неверный набор финансовых данных');
  }
  isoDate(input.from);
  isoDate(input.to);
  if (input.from > input.to) throw new RangeError('Дата начала позже окончания периода');
  const months = monthsBetween(input.from, input.to);
  const transactions = requireUniqueTransactions(input.transactions);
  const plans = validatePlans(input.plans ?? []);
  const catalog = new Map<string, AnalyticsCategory>();
  for (const category of input.categories ?? []) {
    nonempty(category.id);
    nonempty(category.name);
    if (catalog.has(category.id)) throw new RangeError('Повторяющаяся категория');
    catalog.set(category.id, category);
  }
  const debt = validateSnapshots(input.debtSnapshots ?? []).filter(x => x.date >= input.from && x.date <= input.to);
  const savings = validateSnapshots(input.savingsSnapshots ?? []).filter(x => x.date >= input.from && x.date <= input.to);
  const monthMap = new Map<string, MonthlySummary>(months.map(month => [month, {
    month, hasActual: false, incomeMinor: 0, expenseMinor: 0, netMinor: 0,
    plannedIncomeMinor: fullCalendarMonth(month, input.from, input.to)
      ? plans.get(`${month}|income|total|`)?.amountMinor ?? null : null,
    plannedExpenseMinor: fullCalendarMonth(month, input.from, input.to)
      ? plans.get(`${month}|expense|total|`)?.amountMinor ?? null : null,
    expenseVarianceMinor: null,
  }]));
  const catMap = new Map<string | null, CategorySummary>();
  const monthAmounts = new Map<string, AggregatedAmounts>();
  const categoryAmounts = new Map<string | null, AggregatedAmounts>();
  const getCategory = (id: string | null): CategorySummary => {
    const existing = catMap.get(id);
    if (existing) return existing;
    const value: CategorySummary = {
      categoryId: id, name: categoryName(id, catalog), archived: id !== null && catalog.get(id)?.archived === true,
      hasActual: false, incomeMinor: 0, expenseMinor: 0, plannedExpenseMinor: null, expenseShareBps: null,
    };
    catMap.set(id, value);
    return value;
  };
  for (const tx of transactions.values()) {
    if (tx.date < input.from || tx.date > input.to || tx.voidedAt != null) continue;
    const source = tx.kind === 'reversal' ? transactions.get(tx.reversedTransactionId!)! : tx;
    const direction = source.kind === 'income' || (source.kind === 'payment' && source.signedMinor > 0)
      ? 'income' : source.kind === 'expense' || (source.kind === 'payment' && source.signedMinor < 0)
        ? 'expense' : null;
    if (!direction) continue; // Exclude transfers, reservations and pure balance adjustments.
    const row = monthMap.get(tx.date.slice(0, 7))!;
    const category = getCategory(source.categoryId ?? null);
    row.hasActual = true;
    category.hasActual = true;
    accumulate(monthAmounts, row.month, direction, tx.signedMinor);
    accumulate(categoryAmounts, category.categoryId, direction, tx.signedMinor);
  }
  const monthly = [...monthMap.values()];
  for (const row of monthly) {
    const amounts = monthAmounts.get(row.month);
    row.incomeMinor = fromBigint(amounts?.income ?? 0n);
    row.expenseMinor = fromBigint(amounts?.expense ?? 0n);
    row.netMinor = safeAdd(row.incomeMinor, -row.expenseMinor);
    if (row.hasActual && row.plannedExpenseMinor !== null) {
      row.expenseVarianceMinor = safeAdd(row.expenseMinor, -row.plannedExpenseMinor);
    }
  }
  for (const plan of plans.values()) {
    if (plan.scope === 'category' && plan.direction === 'expense' && monthMap.has(plan.month)) {
      getCategory(plan.categoryId!);
    }
  }
  const categories = [...catMap.values()];
  for (const row of categories) {
    const amounts = categoryAmounts.get(row.categoryId);
    row.incomeMinor = fromBigint(amounts?.income ?? 0n);
    row.expenseMinor = fromBigint(amounts?.expense ?? 0n);
    const values = months.map(month => fullCalendarMonth(month, input.from, input.to)
      ? plans.get(`${month}|expense|category|${row.categoryId ?? ''}`)?.amountMinor ?? null : null);
    row.plannedExpenseMinor = sumKnown(values);
  }
  // A category may have a positive income and a negative expense (historic refund).
  // Reject a net value that cannot be represented in integer kopecks, even when
  // totals across other categories happen to cancel the overflow.
  for (const row of categories) safeAdd(row.incomeMinor, -row.expenseMinor);
  positiveShares(categories);
  categories.sort((a, b) => b.expenseMinor - a.expenseMinor || compare(key(a.categoryId), key(b.categoryId)));
  const topExpenses = categories.filter(x => x.expenseMinor > 0).slice(0, 5).map(x => ({ ...x }));
  const incomeMinor = fromBigint(monthly.reduce((acc, item) => acc + BigInt(item.incomeMinor), 0n));
  const expenseMinor = fromBigint(monthly.reduce((acc, item) => acc + BigInt(item.expenseMinor), 0n));
  const plannedIncomeMinor = sumKnown(monthly.map(x => x.plannedIncomeMinor));
  const plannedExpenseMinor = sumKnown(monthly.map(x => x.plannedExpenseMinor));
  const totals = {
    hasActual: monthly.some(x => x.hasActual), incomeMinor, expenseMinor,
    netMinor: safeAdd(incomeMinor, -expenseMinor), plannedIncomeMinor, plannedExpenseMinor,
    expenseVarianceMinor: !monthly.every(row => row.hasActual) || plannedExpenseMinor === null
      ? null : safeAdd(expenseMinor, -plannedExpenseMinor),
  };
  return {
    period: { from: input.from, to: input.to }, totals, monthly, categories, topExpenses,
    debt, savings, hasDebtHistory: debt.length > 0, hasSavingsHistory: savings.length > 0,
    charts: {
      cashflow: monthly.map(row => ({ month: row.month, incomeMinor: row.hasActual ? row.incomeMinor : null,
        expenseMinor: row.hasActual ? row.expenseMinor : null, netMinor: row.hasActual ? row.netMinor : null })),
      expenseShares: categories.filter(x => x.expenseShareBps !== null).map(row => ({
        name: row.name, categoryId: row.categoryId, amountMinor: row.expenseMinor, shareBps: row.expenseShareBps!,
      })),
      debt: debt.map(x => ({ ...x })), savings: savings.map(x => ({ ...x })),
    },
  };
}

/** Percentage in basis points; null means an undefined 0-denominator, not 0%. */
export function percentageChangeBps(current: number, previous: number): number | null {
  money(current, true, Number.MAX_SAFE_INTEGER);
  money(previous, true, Number.MAX_SAFE_INTEGER);
  if (previous === 0) return null;
  const change = (BigInt(current) - BigInt(previous)) * 10_000n;
  const denominator = BigInt(Math.abs(previous));
  const magnitude = (change < 0n ? -change : change);
  const rounded = (magnitude * 2n + denominator) / (2n * denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Переполнение процентного изменения');
  return Number(change < 0n ? -rounded : rounded);
}
function change(currentMinor: number, previousMinor: number, comparable: boolean): ChangeSummary {
  const delta = BigInt(currentMinor) - BigInt(previousMinor);
  if (delta > BigInt(Number.MAX_SAFE_INTEGER) || delta < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Переполнение разницы периодов');
  }
  return { currentMinor, previousMinor, deltaMinor: Number(delta),
    changeBps: comparable ? percentageChangeBps(currentMinor, previousMinor) : null };
}
export function compareReportPeriods(current: AnalyticsReport, previous: AnalyticsReport): PeriodComparison {
  const comparable = current.totals.hasActual && previous.totals.hasActual;
  return {
    hasComparableHistory: comparable,
    income: change(current.totals.incomeMinor, previous.totals.incomeMinor, comparable),
    expense: change(current.totals.expenseMinor, previous.totals.expenseMinor, comparable),
    net: change(current.totals.netMinor, previous.totals.netMinor, comparable),
  };
}
export function compareReportMonths(report: AnalyticsReport, current: string, previous: string): PeriodComparison {
  isoMonth(current);
  isoMonth(previous);
  const a = report.monthly.find(x => x.month === current);
  const b = report.monthly.find(x => x.month === previous);
  if (!a || !b) throw new RangeError('Месяц вне отчётного периода');
  return compareReportPeriods(
    { ...report, totals: { ...report.totals, hasActual: a.hasActual,
      incomeMinor: a.incomeMinor, expenseMinor: a.expenseMinor, netMinor: a.netMinor } },
    { ...report, totals: { ...report.totals, hasActual: b.hasActual,
      incomeMinor: b.incomeMinor, expenseMinor: b.expenseMinor, netMinor: b.netMinor } },
  );
}
