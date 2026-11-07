import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Obligations, type ObligationsProps } from '../../src/react/Obligations';

const blank: ObligationsProps = {
  rows: [],
  month: '2026-11',
  monthTitle: 'ноябрь 2026',
  filter: 'all',
  expandedEntry: null,
  currentDate: '2026-11-07',
  expenseCents: 0,
  expensePaidCents: 0,
  rubles: (cents) => (cents / 100).toFixed(2),
  formatDate: (date) => date,
};
afterEach(cleanup);

describe('React Obligations', () => {
  it('shows empty states and all filter action contracts', () => {
    render(
      <StrictMode>
        <Obligations {...blank} />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { name: 'Обязательства' })).toBeTruthy();
    expect(screen.getByText('Здесь пока нет записей')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Добавить запись' }).getAttribute('data-action'),
    ).toBe('new-entry');
    for (const filter of ['all', 'regular', 'once', 'income'])
      expect(document.querySelector('[data-filter="' + filter + '"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Все' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('preserves table/mobile action IDs and settlement history without injecting markup', () => {
    const props: ObligationsProps = {
      ...blank,
      expenseCents: 21030,
      expensePaidCents: 5000,
      expandedEntry: 'e1',
      rows: [
        {
          id: 'e1',
          title: '<img src=x onerror=alert(1)>',
          kind: 'expense',
          category: 'Прочее',
          recurrence: 'monthly',
          amountCents: 21030,
          date: '2026-11-15',
          paidCents: 5000,
          payments: [{ id: 'p1', date: '2026-11-15', amountCents: 5000 }],
        },
      ],
    };
    const original = structuredClone(props.rows);
    render(<Obligations {...props} />);
    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelectorAll('.records-table tbody tr').length).toBe(2);
    expect(document.querySelectorAll('.record-mobile-row').length).toBe(1);
    expect(document.querySelectorAll('[data-action="settle"][data-id="e1"]').length).toBe(2);
    expect(document.querySelectorAll('[data-action="void-settlement"][data-id="p1"]').length).toBe(
      2,
    );
    expect(document.querySelector('.records-mobile [data-action="expand-entry"]')).toBeTruthy();
    expect(props.rows).toEqual(original);
  });
  it('delegates a financial action only once under StrictMode', () => {
    const props: ObligationsProps = {
      ...blank,
      rows: [
        {
          id: 'i1',
          title: 'Зарплата',
          kind: 'income',
          category: 'Доход',
          recurrence: 'once',
          amountCents: 10000,
          date: '2026-11-07',
          paidCents: 0,
          payments: [],
        },
      ],
    };
    const events: string[] = [];
    const handler = (event: MouseEvent) => {
      const btn = (event.target as Element).closest('[data-action]');
      if (btn) events.push(btn.getAttribute('data-action')!);
    };
    document.addEventListener('click', handler);
    try {
      render(
        <StrictMode>
          <Obligations {...props} />
        </StrictMode>,
      );
      const edit = document.querySelector<HTMLButtonElement>(
        '.records-table [data-action="edit-entry"]',
      )!;
      fireEvent.click(edit);
      expect(events).toEqual(['edit-entry']);
    } finally {
      document.removeEventListener('click', handler);
    }
  });
});
