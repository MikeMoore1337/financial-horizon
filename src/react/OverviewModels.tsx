import type { CalendarEvent } from './Calendar';
import type { OverviewCategory, OverviewLoan } from './Overview';

/**
 * Pure, read-only JS-to-TypeScript presentation boundary. Financial calculations,
 * authoritative state and account scoping stay in the existing domain runtime.
 */
export function projectOverviewCategories(
  events: readonly Pick<CalendarEvent, 'kind' | 'category' | 'plannedCents'>[],
): OverviewCategory[] {
  const groups = new Map<string, number>();
  for (const event of events.filter((event) => event.kind !== 'income')) {
    groups.set(event.category, (groups.get(event.category) || 0) + event.plannedCents);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const highest = Math.max(...ordered.map(([, sum]) => sum), 1);
  return ordered.map(([name, amountCents]) => ({
    name,
    amountCents,
    percent: Math.max(2, Math.round((amountCents / highest) * 100)),
  }));
}

export interface OverviewSourceLoan {
  id: string;
  title: string;
  openingCents: number;
}

export interface OverviewLoanLedger {
  outstandingCents: number;
  monthlyCents: number;
  months: number | null;
}

export function projectOverviewLoan(
  loan: OverviewSourceLoan | null,
  ledger: OverviewLoanLedger | null,
): OverviewLoan | null {
  if (!loan) return null;
  if (!ledger) throw new TypeError('Missing calculated loan ledger');
  return {
    id: loan.id,
    title: loan.title,
    outstandingCents: ledger.outstandingCents,
    monthlyCents: ledger.monthlyCents,
    months: ledger.months,
    percent: Math.max(
      0,
      Math.min(100, Math.round((1 - ledger.outstandingCents / loan.openingCents) * 100)),
    ),
  };
}
