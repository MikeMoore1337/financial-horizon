import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { PaymentCenter } from '../../src/react/PaymentCenter';
import {
  DEFAULT_REMINDER_SETTINGS,
  type ReminderResult,
} from '../../src/domain/cashflow/in-app-reminders';

afterEach(cleanup);

const result: ReminderResult = {
  duePayments: [
    {
      key: 'entry-internet-2026-11',
      source: 'entry',
      recordId: 'internet',
      occurrence: '2026-11',
      title: '<script>alert(1)</script>',
      dueDate: '2026-11-20',
      plannedCents: 10000,
      paidCents: 6000,
      remainingCents: 4000,
      daysUntilDue: 1,
      partial: true,
      status: 'upcoming',
    },
  ],
  alerts: [
    {
      id: 'scoped-payment',
      kind: 'payment',
      source: 'entry',
      recordId: 'internet',
      occurrence: '2026-11',
      title: '<script>alert(1)</script>',
      dueDate: '2026-11-20',
      plannedCents: 10000,
      paidCents: 6000,
      remainingCents: 4000,
      daysUntilDue: 1,
      trigger: 'advance',
      intervalDays: 1,
      partial: true,
    },
  ],
  totalAlerts: 1,
  hiddenAlerts: 0,
};

const base = {
  result,
  settings: DEFAULT_REMINDER_SETTINGS,
  currentDate: '2026-11-19',
  scopeKey: 'guest-state-v2',
  paymentMethods: {},
  rubles: (value: number) => (value / 100).toFixed(2) + ' ₽',
  formatDate: (value: string) => value,
  onSettingsChange: vi.fn(async () => undefined),
};

describe('#40 approved payment center', () => {
  it('shows exact remaining amount and existing finance action, not duplicate finance ledger', () => {
    render(
      <StrictMode>
        <PaymentCenter {...base} />
      </StrictMode>,
    );
    expect(screen.getByText('40.00 ₽')).toBeTruthy();
    expect(screen.getByText('60.00 ₽', { exact: false })).toBeTruthy();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    const settle = screen.getByRole('button', { name: 'Отметить оплату' });
    expect(settle.getAttribute('data-action')).toBe('settle');
    expect(settle.getAttribute('data-month')).toBe('2026-11');
  });
  it('uses safe explicit URL and local-only QR without marking any payment', () => {
    const pay = vi.fn(async () => undefined);
    const props = {
      ...base,
      onSettingsChange: pay,
      paymentMethods: {
        internet: [
          {
            id: 'url',
            type: 'payment_url' as const,
            label: 'ЛК',
            primary: true,
            value: 'https://billing.example/pay',
          },
        ],
      },
    };
    render(<PaymentCenter {...props} />);
    const link = screen.getByRole('link', { name: 'Открыть личный кабинет' });
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.getAttribute('href')).toBe('https://billing.example/pay');
    expect(pay).not.toHaveBeenCalled();
  });
  it('toggles 1/3/7 reminders through owner save callback without requesting push', async () => {
    const save = vi.fn(async () => undefined);
    render(<PaymentCenter {...base} onSettingsChange={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Настроить напоминания' }));
    expect(screen.getByRole('checkbox', { name: 'За 7 дней' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'За 3 дня' }));
    expect(save).toHaveBeenCalledWith({ enabled: true, daysBefore: [1, 7] });
    expect(screen.getByText(/Системные уведомления не запрашиваются/)).toBeTruthy();
  });
});
