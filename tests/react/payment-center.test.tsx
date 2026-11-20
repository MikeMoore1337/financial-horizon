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
    expect(screen.getAllByText('40.00 ₽')).toHaveLength(2);
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

  it('shows a saved primary QR with same-phone alternatives, accessible close and Escape focus restore', () => {
    const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO++0QAAAABJRU5ErkJggg==';
    const props = {
      ...base,
      paymentMethods: {
        internet: [
          { id: 'qr', type: 'qr_image' as const, label: 'QR', primary: true, imageData: qr },
          {
            id: 'sbp',
            type: 'sbp_link' as const,
            label: 'СБП',
            primary: false,
            value: 'https://qr.nspk.ru/example',
          },
          {
            id: 'requisites',
            type: 'requisites' as const,
            label: 'Реквизиты',
            primary: false,
            value: 'Банк Пример, счёт 40817',
          },
        ],
      },
    };
    render(<PaymentCenter {...props} />);
    const trigger = screen.getByRole('button', { name: 'Показать QR' });
    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Просмотр QR-кода' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Перейти к оплате СБП' }).getAttribute('rel'))
      .toContain('noreferrer');
    const copy = screen.getByRole('button', { name: 'Скопировать реквизиты' });
    expect(copy.getAttribute('data-method-id')).toBe('requisites');
    const close = screen.getByRole('button', { name: 'Закрыть QR' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Просмотр QR-кода' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(screen.getByText('Другие способы оплаты (2)'));
    expect(screen.getByRole('link', { name: 'Перейти к оплате СБП' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Изменить' }).getAttribute('data-id')).toBe('internet');
  });

  it('handles unavailable methods, invalid HTTPS, missing QR and image decoding failures', () => {
    const { rerender } = render(<PaymentCenter {...base} />);
    expect(screen.getByRole('button', { name: 'Настроить оплату' }).getAttribute('data-action'))
      .toBe('edit-entry');
    rerender(<PaymentCenter {...base} paymentMethods={{
      internet: [{ id: 'bad', type: 'payment_url', label: 'Ошибка', primary: true, value: 'javascript:alert(1)' }],
    }} />);
    expect(screen.queryByRole('link', { name: 'Открыть личный кабинет' })).toBeNull();
    expect(screen.getByText(/Ссылка недоступна/)).toBeTruthy();
    rerender(<PaymentCenter {...base} paymentMethods={{
      internet: [{ id: 'bad-qr', type: 'qr_image', label: 'QR', primary: true, imageData: 'broken' }],
    }} />);
    expect(screen.getByText(/QR повреждён/)).toBeTruthy();
    const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO++0QAAAABJRU5ErkJggg==';
    rerender(<PaymentCenter {...base} paymentMethods={{
      internet: [{ id: 'qr', type: 'qr_image', label: 'QR', primary: true, imageData: qr }],
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Показать QR' }));
    fireEvent.error(screen.getByRole('img', { name: 'Сохранённый QR-код для оплаты' }));
    expect(screen.getByRole('alert').textContent).toContain('Не удалось открыть изображение QR');
    expect(screen.getByText(/Другой способ оплаты с этого телефона не настроен/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть QR' }));
    expect(screen.queryByRole('region', { name: 'Просмотр QR-кода' })).toBeNull();
  });

  it('keeps overdue, today and upcoming rows sorted without showing fully paid items', () => {
    const template = result.duePayments[0];
    render(<PaymentCenter {...base} result={{
      ...result,
      duePayments: [
        { ...template, key: 'soon', recordId: 'soon', title: 'Скоро', dueDate: '2026-11-22', daysUntilDue: 3, status: 'upcoming' },
        { ...template, key: 'overdue', recordId: 'overdue', title: 'Опоздание', dueDate: '2026-11-17', daysUntilDue: -2, status: 'overdue' },
        { ...template, key: 'today', recordId: 'today', title: 'Сегодня', dueDate: '2026-11-19', daysUntilDue: 0, status: 'today' },
      ],
    }} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent))
      .toEqual(['Просрочено', 'Сегодня', 'Скоро']);
    expect(screen.getAllByRole('button', { name: 'Отметить оплату' })).toHaveLength(3);
    expect(screen.getAllByText(/Полная сумма:/)).toHaveLength(3);
  });
});
