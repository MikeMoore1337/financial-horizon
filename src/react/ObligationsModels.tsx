import type { FinanceEntry, Settlement } from '../types/finance';
import type { ObligationFilter, ObligationItem } from './Obligations';

/** Read-only typed presentation adapter; authoritative mutations remain in the finance runtime. */
export function projectObligationRows(
  entries: readonly FinanceEntry[],
  settlements: readonly Settlement[],
  month: string,
  filter: ObligationFilter,
  dayInMonth: (month: string, day: number) => string,
): ObligationItem[] {
  return entries
    .filter((entry) => !entry.deletedAt)
    .filter(
      (entry) =>
        filter === 'all' ||
        (filter === 'regular' && entry.recurrence !== 'once') ||
        (filter === 'once' && entry.recurrence === 'once') ||
        (filter === 'income' && entry.kind === 'income'),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      const payments = settlements.filter(
        (payment) =>
          payment.entryId === entry.id && payment.occurrence === month && !payment.voidedAt,
      );
      return {
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        recurrence: entry.recurrence,
        category: entry.category,
        amountCents: entry.amountCents,
        date:
          entry.recurrence === 'once'
            ? entry.date
            : dayInMonth(month, Number(entry.date.slice(-2))),
        payments,
        paidCents: payments.reduce((sum, payment) => sum + payment.amountCents, 0),
      };
    });
}
