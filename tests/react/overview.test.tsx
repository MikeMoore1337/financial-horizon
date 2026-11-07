import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Overview, type OverviewProps } from '../../src/react/Overview';
import { createScreenRoot } from '../../src/react/ScreenRoot';

const empty: OverviewProps = {
  currentDate: '2026-11-07',
  monthTitle: 'ноябрь 2026',
  hasData: false,
  totals: {
    netPlanCents: 0,
    incomeCents: 0,
    incomePaidCents: 0,
    expenseCents: 0,
    expensePaidCents: 0,
  },
  categories: [],
  upcoming: [],
  loan: null,
  formatDate: (date) => date,
  rubles: (cents) => (cents / 100).toFixed(2),
};
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});
describe('React Overview screen', () => {
  it('keeps empty guest calls-to-action delegated once in StrictMode', () => {
    const actions: string[] = [];
    const listener = (event: MouseEvent) => {
      const target = (event.target as Element).closest('[data-action]');
      if (target) actions.push(target.getAttribute('data-action')!);
    };
    document.addEventListener('click', listener);
    try {
      render(
        <StrictMode>
          <Overview {...empty} />
        </StrictMode>,
      );
      expect(screen.getByRole('heading', { name: 'Обзор месяца' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Показать пример' }));
      expect(actions).toEqual(['sample']);
      expect(screen.getByRole('button', { name: 'Добавить доход' }).getAttribute('data-kind')).toBe(
        'income',
      );
    } finally {
      document.removeEventListener('click', listener);
    }
  });
  it('shows readonly cents, loan, category and upcoming actions without HTML injection', () => {
    const data: OverviewProps = {
      ...empty,
      hasData: true,
      totals: {
        netPlanCents: 12345,
        incomeCents: 50000,
        incomePaidCents: 25000,
        expenseCents: 37655,
        expensePaidCents: 17000,
      },
      categories: [{ name: '<img src=x onerror=alert(1)>', amountCents: 37655, percent: 100 }],
      upcoming: [
        {
          id: 'item',
          kind: 'expense',
          title: 'Интернет',
          date: '2026-11-15',
          source: 'entry',
          category: 'Связь',
          plannedCents: 995,
          paidCents: 0,
        },
      ],
      loan: {
        id: 'loan',
        title: 'Ипотека',
        outstandingCents: 10000000,
        monthlyCents: 300000,
        months: 120,
        percent: 35,
      },
    };
    const snapshot = structuredClone(data.totals);
    render(<Overview {...data} />);
    expect(screen.getByText('123.45')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Отметить оплату: Интернет' }).getAttribute('data-id'),
    ).toBe('item');
    expect(screen.getByRole('button', { name: /Внести платёж/ }).getAttribute('data-id')).toBe(
      'loan',
    );
    expect(data.totals).toEqual(snapshot);
  });
  it('reuses one React root when switching between migrated screens', () => {
    const host = document.createElement('main');
    document.body.append(host);
    const root = createScreenRoot(host);
    const calendar = {
      events: [],
      month: '2026-11',
      selectedDate: '2026-11-15',
      currentDate: '2026-11-07',
      monthTitle: 'ноябрь 2026',
      netPlanCents: 0,
      netFactCents: 0,
      formatDate: empty.formatDate,
      rubles: empty.rubles,
    };
    root.render({ view: 'overview', props: empty });
    expect(host.querySelectorAll('h1').length).toBe(1);
    root.render({ view: 'calendar', props: calendar });
    expect(host.querySelectorAll('h1').length).toBe(1);
    expect(host.querySelector('h1')?.textContent).toBe('Календарь платежей');
    root.render({ view: 'overview', props: empty });
    expect(host.querySelectorAll('h1').length).toBe(1);
    root.unmount();
    expect(host.childElementCount).toBe(0);
  });
});
