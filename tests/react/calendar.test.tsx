import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Calendar, type CalendarProps } from '../../src/react/Calendar';

const sample: CalendarProps = {
  events: [
    {
      id: 'entry-one',
      title: 'Зарплата',
      kind: 'income',
      source: 'entry',
      date: '2026-11-15',
      category: 'Доход',
      plannedCents: 100500,
      paidCents: 100500,
    },
    {
      id: 'loan-one',
      title: 'Кредит',
      kind: 'expense',
      source: 'loan',
      date: '2026-11-15',
      category: 'Кредиты',
      plannedCents: 23100,
      paidCents: 0,
    },
  ],
  month: '2026-11',
  selectedDate: '2026-11-15',
  currentDate: '2026-11-07',
  monthTitle: 'ноябрь 2026',
  netPlanCents: 77400,
  netFactCents: 100500,
  formatDate: (date) => date,
  rubles: (amount) => (amount / 100).toFixed(2),
};
afterEach(cleanup);

describe('Calendar React island (read-only presentation)', () => {
  it('renders financial figures from props without altering cents', () => {
    const initial = structuredClone(sample.events);
    render(<Calendar {...sample} />);
    expect(screen.getByRole('heading', { name: 'Календарь платежей' })).toBeTruthy();
    expect(screen.getByText('774.00')).toBeTruthy();
    expect(screen.getAllByText(/1005.00/).length).toBeGreaterThan(0);
    expect(sample.events).toEqual(initial);
    const selected = document.querySelector('.cal-day.selected');
    expect(selected?.getAttribute('data-date')).toBe('2026-11-15');
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps calendar date accessible and dispatches one delegated action in StrictMode', () => {
    const received: string[] = [];
    const onClick = (event: MouseEvent) => {
      const el = (event.target as Element).closest('[data-action]');
      if (el) received.push(el.getAttribute('data-action')!);
    };
    document.addEventListener('click', onClick);
    try {
      render(
        <StrictMode>
          <Calendar {...sample} />
        </StrictMode>,
      );
      const day = document.querySelector<HTMLButtonElement>('[data-date="2026-11-16"]')!;
      expect(day.getAttribute('aria-describedby')).toBe('calendar-day-description-2026-11-16');
      expect(day.getAttribute('aria-labelledby')).toContain('calendar-day-summary-2026-11-16');
      expect(day.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(day);
      expect(received).toEqual(['select-day']);
    } finally {
      document.removeEventListener('click', onClick);
    }
  });

  it('retains loan payment, settlements, month controls and empty-state actions', () => {
    render(<Calendar {...sample} />);
    expect(
      screen.getByRole('button', { name: 'Следующий месяц' }).getAttribute('data-action'),
    ).toBe('next-month');
    const payable = screen.getByRole('button', { name: 'Отметить оплату: Кредит' });
    expect(payable.getAttribute('data-action')).toBe('pay');
    expect(payable.getAttribute('data-id')).toBe('loan-one');
    const income = screen.getByRole('button', { name: 'Отметить поступление: Зарплата' });
    expect(income.getAttribute('data-action')).toBe('settle');
    expect(income.getAttribute('data-month')).toBe('2026-11');
    expect(screen.getByRole('button', { name: /Запись/ }).getAttribute('data-action')).toBe(
      'new-entry',
    );
    cleanup();
    render(<Calendar {...sample} events={[]} />);
    expect(screen.getByText('В этот день ничего не запланировано.')).toBeTruthy();
  });
});
