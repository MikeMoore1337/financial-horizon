import type { AnalyticsReport } from './types.ts';

/** Escapes formulas even after leading whitespace/zero-width characters. */
function textCell(value: string): string {
  const escaped = /^[\p{White_Space}\p{Cf}\p{Cc}]*[=+@-]/u.test(value) ? `'${value}` : value;
  return `"${escaped.replaceAll('"', '""')}"`;
}
function amountCell(value: number | null): string {
  if (value === null) return '';
  if (!Number.isSafeInteger(value)) throw new RangeError('CSV содержит нецелую денежную сумму');
  return String(value);
}
function netCell(income: number, expense: number): number {
  if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) {
    throw new RangeError('CSV содержит нецелую денежную сумму');
  }
  const result = BigInt(income) - BigInt(expense);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('CSV: переполнение финансового результата');
  }
  return Number(result);
}
/** An explicit local export; never stores, uploads or logs financial records. */
export function exportAnalyticsCsv(report: AnalyticsReport): string {
  const rows: string[][] = [[
    'Дата', 'Тип', 'Категория', 'Доход, коп.', 'Расход, коп.', 'Результат, коп.',
    'План дохода, коп.', 'План расхода, коп.', 'Остаток, коп.', 'Наличие факта',
  ]];
  const add = (date: string, type: string, category: string, income: number | null,
    expense: number | null, net: number | null, plannedIncome: number | null,
    plannedExpense: number | null, balance: number | null, hasActual: string): void => {
    rows.push([textCell(date), textCell(type), textCell(category),
      amountCell(income), amountCell(expense), amountCell(net),
      amountCell(plannedIncome), amountCell(plannedExpense), amountCell(balance), textCell(hasActual)]);
  };
  for (const item of report.monthly) {
    add(item.month, 'месяц', '', item.hasActual ? item.incomeMinor : null,
      item.hasActual ? item.expenseMinor : null, item.hasActual ? item.netMinor : null,
      item.plannedIncomeMinor, item.plannedExpenseMinor, null, item.hasActual ? 'да' : 'нет');
  }
  for (const item of report.categories) {
    add(`${report.period.from}/${report.period.to}`, 'категория', item.name,
      item.hasActual ? item.incomeMinor : null, item.hasActual ? item.expenseMinor : null,
      item.hasActual ? netCell(item.incomeMinor, item.expenseMinor) : null,
      null, item.plannedExpenseMinor, null, item.hasActual ? 'да' : 'нет');
  }
  for (const item of report.debt) add(item.date, 'долг', '', null, null, null, null, null, item.balanceMinor, 'да');
  for (const item of report.savings) add(item.date, 'накопления', '', null, null, null, null, null, item.balanceMinor, 'да');
  return '\uFEFF' + rows.map((cells, index) => index === 0 ? cells.map(textCell).join(';') : cells.join(';')).join('\r\n') + '\r\n';
}
