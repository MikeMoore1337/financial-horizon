import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Loans, type LoansProps } from '../../src/react/Loans';

const blank: LoansProps = {
  loans: [],
  selected: null,
  currentDate: '2026-11-07',
  formatDate: (date) => date,
  rubles: (amount) => (amount / 100).toFixed(2),
};
const sample: LoansProps = {
  ...blank,
  loans: [
    {
      id: 'first',
      title: 'Ипотека',
      outstandingCents: 750000,
      monthlyCents: 20000,
      months: 20,
      paidPercent: 25,
    },
    {
      id: 'second',
      title: 'Новый кредит',
      outstandingCents: 70000,
      monthlyCents: 7000,
      months: null,
      paidPercent: 0,
    },
  ],
  selected: {
    id: 'first',
    title: 'Ипотека',
    outstandingCents: 750000,
    monthlyCents: 20000,
    months: 20,
    paidPercent: 25,
    apr: 13.5,
    dueDay: 15,
    projectedEnd: '2028-01-15',
    scheduleCount: 1,
    scheduleSource: '<schedule.csv>',
    schedule: [{ date: '2026-12-15', amountCents: 20000, balanceCents: 730000 }],
    history: [
      { id: 'p1', date: '2026-11-15', amountCents: 20000 },
      { id: 'p2', date: '2026-10-15', amountCents: 20000, voidedAt: '2026-10-16T00:00:00Z' },
    ],
  },
};
afterEach(cleanup);
describe('Loans React screen (pure presentation)', () => {
  it('keeps empty state and financial action buttons accessible', () => {
    render(
      <StrictMode>
        <Loans {...blank} />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { name: 'Кредиты и ипотека' })).toBeTruthy();
    expect(screen.getByText('Кредитов пока нет')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: /Добавить ипотеку или кредит/ })
        .getAttribute('data-action'),
    ).toBe('new-loan');
  });
  it('renders ledger balance, schedule and history without injecting source names', () => {
    const original = structuredClone(sample.loans);
    render(<Loans {...sample} />);
    expect(screen.getAllByText('7500.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/<schedule\.csv>/)).toBeTruthy();
    expect(document.querySelector('schedule')).toBeNull();
    expect(document.querySelectorAll('.loan-card')).toHaveLength(2);
    expect(document.querySelector('.loan-card.selected')?.getAttribute('data-id')).toBe('first');
    expect(
      document.querySelector('.loan-history [data-action="void-payment"][data-id="p1"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('.loan-history [data-action="void-payment"][data-id="p2"]'),
    ).toBeNull();
    expect(document.querySelector('[data-action="schedule-import"][data-id="first"]')).toBeTruthy();
    expect(document.querySelector('[data-action="clear-schedule"][data-id="first"]')).toBeTruthy();
    expect(sample.loans).toEqual(original);
  });
  it('dispatches exactly one select-loan action under StrictMode', () => {
    const events: string[] = [];
    const listener = (event: MouseEvent) => {
      const el = (event.target as Element).closest('[data-action]');
      if (el) events.push(el.getAttribute('data-action')!);
    };
    document.addEventListener('click', listener);
    try {
      render(
        <StrictMode>
          <Loans {...sample} />
        </StrictMode>,
      );
      fireEvent.click(document.querySelector('.loan-card[data-id="second"]')!);
      expect(events).toEqual(['select-loan']);
    } finally {
      document.removeEventListener('click', listener);
    }
  });
});
