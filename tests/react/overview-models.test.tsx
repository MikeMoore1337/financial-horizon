import { describe, expect, it } from 'vitest';
import { projectOverviewCategories, projectOverviewLoan } from '../../src/react/OverviewModels';

describe('Pure typed overview presentation adapter', () => {
  it('matches the previous category sorting, top-five and small percentage semantics', () => {
    const events = [
      { kind: 'expense', category: 'Аренда', plannedCents: 40000 },
      { kind: 'expense', category: 'Интернет', plannedCents: 1000 },
      { kind: 'income', category: 'Работа', plannedCents: 80000 },
      { kind: 'expense', category: 'Аренда', plannedCents: 15000 },
      { kind: 'expense', category: 'Прочее', plannedCents: 1 },
      { kind: 'expense', category: 'Бензин', plannedCents: 5000 },
      { kind: 'expense', category: 'Здоровье', plannedCents: 2000 },
      { kind: 'expense', category: 'Досуг', plannedCents: 3000 },
    ] as const;
    const before = structuredClone(events);
    const result = projectOverviewCategories(events);
    expect(result.map((item) => item.name)).toEqual([
      'Аренда',
      'Бензин',
      'Досуг',
      'Здоровье',
      'Интернет',
    ]);
    expect(result[0]).toEqual({ name: 'Аренда', amountCents: 55000, percent: 100 });
    expect(result[4]?.percent).toBe(2);
    expect(events).toEqual(before);
    expect(projectOverviewCategories([])).toEqual([]);
    expect(projectOverviewCategories([{ kind: 'income', category: 'Только доход', plannedCents: 1 }])).toEqual([]);
  });

  it('keeps the exact legacy loan projection and clamps percentage', () => {
    const loan = { id: 'synthetic-loan', title: 'Ипотека', openingCents: 100000 };
    expect(projectOverviewLoan(null, null)).toBeNull();
    expect(projectOverviewLoan(loan, { outstandingCents: 50000, monthlyCents: 1000, months: 10 })).toEqual({
      id: 'synthetic-loan',
      title: 'Ипотека',
      outstandingCents: 50000,
      monthlyCents: 1000,
      months: 10,
      percent: 50,
    });
    expect(projectOverviewLoan(loan, { outstandingCents: 120000, monthlyCents: 1000, months: null })?.percent).toBe(0);
    expect(projectOverviewLoan(loan, { outstandingCents: 0, monthlyCents: 0, months: 0 })?.percent).toBe(100);
    expect(() => projectOverviewLoan(loan, null)).toThrow('Missing calculated loan ledger');
  });
});
