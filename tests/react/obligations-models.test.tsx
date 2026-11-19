import { describe, expect, it, vi } from 'vitest';
import type { FinanceEntry, Settlement } from '../../src/types/finance';
import { projectObligationRows } from '../../src/react/ObligationsModels';

const entries = [
  {
    id: 'monthly',
    title: 'Интернет',
    kind: 'expense',
    recurrence: 'monthly',
    category: 'Связь',
    amountCents: 25000,
    date: '2026-01-31',
  },
  {
    id: 'single',
    title: 'Покупка',
    kind: 'expense',
    recurrence: 'once',
    category: 'Покупки',
    amountCents: 1200,
    date: '2026-02-03',
  },
  {
    id: 'salary',
    title: 'Доход',
    kind: 'income',
    recurrence: 'monthly',
    category: 'Работа',
    amountCents: 80000,
    date: '2026-01-25',
  },
  {
    id: 'archived',
    title: 'Архив',
    kind: 'expense',
    recurrence: 'monthly',
    category: 'Другое',
    amountCents: 10000,
    date: '2026-01-01',
    deletedAt: '2026-02-01T00:00:00Z',
  },
] as unknown as FinanceEntry[];

const settlements = [
  {
    id: 'pay-one',
    entryId: 'monthly',
    amountCents: 3000,
    occurrence: '2026-02',
    date: '2026-02-10',
  },
  {
    id: 'pay-two',
    entryId: 'monthly',
    amountCents: 2000,
    occurrence: '2026-02',
    date: '2026-02-20',
  },
  {
    id: 'void',
    entryId: 'monthly',
    amountCents: 4000,
    occurrence: '2026-02',
    date: '2026-02-21',
    voidedAt: '2026-02-21T08:00:00Z',
  },
  {
    id: 'other-month',
    entryId: 'monthly',
    amountCents: 9000,
    occurrence: '2026-03',
    date: '2026-03-02',
  },
] as unknown as Settlement[];

describe('Typed obligations presentation adapter', () => {
  it('matches old filters, dates, settlement totals and does not mutate source', () => {
    const originalEntries = structuredClone(entries);
    const originalPayments = structuredClone(settlements);
    const dayInMonth = vi.fn((month: string, day: number) =>
      month + '-' + String(Math.min(28, day)).padStart(2, '0'),
    );
    const result = projectObligationRows(entries, settlements, '2026-02', 'all', dayInMonth);
    expect(result.map((row) => row.id)).toEqual(['salary', 'monthly', 'single']);
    const monthly = result.find((row) => row.id === 'monthly')!;
    expect(monthly.date).toBe('2026-02-28');
    expect(monthly.paidCents).toBe(5000);
    expect(monthly.payments.map((payment) => payment.id)).toEqual(['pay-one', 'pay-two']);
    expect(dayInMonth).toHaveBeenCalledWith('2026-02', 31);
    for (const [filter, count] of [
      ['income', 1],
      ['once', 1],
      ['regular', 2],
    ] as const) {
      expect(projectObligationRows(entries, settlements, '2026-02', filter, dayInMonth))
        .toHaveLength(count);
    }
    expect(entries).toEqual(originalEntries);
    expect(settlements).toEqual(originalPayments);
  });

  it('does not invoke date resolution for an empty state', () => {
    const dayInMonth = vi.fn(() => '2026-02-01');
    expect(projectObligationRows([], [], '2026-02', 'all', dayInMonth)).toEqual([]);
    expect(dayInMonth).not.toHaveBeenCalled();
  });
});
