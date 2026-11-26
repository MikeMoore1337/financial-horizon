/**
 * Russian plain-text and table alternatives for every analytics chart.
 * No DOM, HTML, browser locale, third-party service, or financial storage access.
 * Render values as text nodes; never interpolate user category names into HTML.
 */
import type { AnalyticsReport } from './types.ts';

export interface CashflowTextRow {
  month: string;
  income: string;
  expense: string;
  result: string;
  status: string;
}
export interface CategoryTextRow {
  category: string;
  amount: string;
  share: string;
}
export interface BalanceTextRow {
  date: string;
  balance: string;
}
export interface ChartTextAlternative<Row> {
  title: string;
  description: string;
  emptyMessage: string | null;
  rows: Row[];
}
export interface AnalyticsTextAlternatives {
  summary: string;
  planFact: string;
  cashflow: ChartTextAlternative<CashflowTextRow>;
  expenseShares: ChartTextAlternative<CategoryTextRow>;
  debt: ChartTextAlternative<BalanceTextRow>;
  savings: ChartTextAlternative<BalanceTextRow>;
}

/** Format *only* safe integer kopecks; never round or use runtime locale state. */
export function formatKopecks(value: number | null): string {
  if (value === null) return 'Нет данных';
  if (!Number.isSafeInteger(value)) throw new RangeError('Неверная сумма для текстового отчёта');
  const negative = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const integer = String(Math.trunc(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative}${integer},${String(absolute % 100).padStart(2, '0')} ₽`;
}
function shareText(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError('Неверная доля категории');
  }
  return `${Math.trunc(bps / 100)},${String(bps % 100).padStart(2, '0')} %`;
}

/** Pure accessible view model; UI tables and charts must use the same report. */
export function buildAnalyticsTextAlternatives(report: AnalyticsReport): AnalyticsTextAlternatives {
  const hasActual = report.totals.hasActual;
  const summary = hasActual
    ? `За период ${report.period.from} - ${report.period.to}: доходы ${formatKopecks(report.totals.incomeMinor)}, расходы ${formatKopecks(report.totals.expenseMinor)}, финансовый результат ${formatKopecks(report.totals.netMinor)}.`
    : `За период ${report.period.from} - ${report.period.to} нет подтверждённых доходов и расходов. Отсутствие записей не означает нулевые расходы.`;
  const planFact = report.totals.expenseVarianceMinor === null
    ? 'Сравнение движения расходов с планом недоступно: отсутствует полный помесячный план или подтверждённая история.'
    : `Отклонение движения расходов от плана: ${formatKopecks(report.totals.expenseVarianceMinor)}. Это не расходование лимита бюджета.`;

  const cashflow = report.charts.cashflow.map(row => ({
    month: row.month,
    income: formatKopecks(row.incomeMinor),
    expense: formatKopecks(row.expenseMinor),
    result: formatKopecks(row.netMinor),
    status: row.incomeMinor === null ? 'Нет подтверждённых операций' : 'Есть подтверждённые операции',
  }));
  const shares = report.charts.expenseShares.map(item => ({
    category: item.name,
    amount: formatKopecks(item.amountMinor),
    share: shareText(item.shareBps),
  }));
  const debt = report.charts.debt.map(item => ({
    date: item.date, balance: formatKopecks(item.balanceMinor),
  }));
  const savings = report.charts.savings.map(item => ({
    date: item.date, balance: formatKopecks(item.balanceMinor),
  }));
  return {
    summary, planFact,
    cashflow: {
      title: 'Доходы, расходы и результат по месяцам',
      description: 'Суммы по датам фактических проводок; компенсации могут давать отрицательный расход. Пустые значения - отсутствие подтверждённой истории.',
      emptyMessage: hasActual ? null : 'Нет подтверждённых доходов и расходов за выбранный период.',
      rows: cashflow,
    },
    expenseShares: {
      title: 'Доли статей расходов',
      description: 'Доли рассчитаны только среди категорий с положительным итоговым расходом. Отрицательные суммы возвратов не изображаются отрицательными секторами.',
      emptyMessage: shares.length ? null : 'Нет положительных итоговых расходов для диаграммы.',
      rows: shares,
    },
    debt: {
      title: 'Фактическая задолженность',
      description: 'Только подтверждённые снимки остатка долга. Отсутствующие даты не интерполируются.',
      emptyMessage: debt.length ? null : 'Нет подтверждённой истории задолженности за период.',
      rows: debt,
    },
    savings: {
      title: 'Добровольные накопления',
      description: 'Только подтверждённые снимки добровольных целей; обязательные резервы исключены.',
      emptyMessage: savings.length ? null : 'Нет подтверждённой истории добровольных накоплений за период.',
      rows: savings,
    },
  };
}
