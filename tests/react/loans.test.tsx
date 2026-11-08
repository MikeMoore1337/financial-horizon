import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { Loans, type LoansProps } from '../../src/react/Loans';
import { parseNominalRate } from '../../src/react/LoanReadOnlyComparison';

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
    legacySnapshot: {
      openingCents: 1_000_000,
      paymentCents: 507_410,
      termMonths: 2,
      dueDay: 1,
      asOfDate: '2026-01-01',
    } as NonNullable<LoansProps['selected']>['legacySnapshot'],
    bankSchedule: [
      {
        date: '2026-02-01',
        amountCents: 507_410,
        interestCents: 10_192,
        principalCents: 497_218,
        balanceCents: 502_782,
      },
      {
        date: '2026-03-01',
        amountCents: 507_410,
        interestCents: 4_628,
        principalCents: 502_782,
        balanceCents: 0,
      },
    ],
    stateRevision: 1,
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

function confirmSyntheticContract(annualRate = '12') {
  fireEvent.click(screen.getByRole('button', { name: 'Уточнить условия банка' }));
  const form = document.querySelector<HTMLFormElement>('.loan-comparison-dialog form')!;
  const change = (name: string, value: string) => {
    fireEvent.change(
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!,
      {
        target: { value },
      },
    );
  };
  change('firstDueDate', '2026-02-01');
  change('dueDayAnchor', '1');
  change('annualRate', annualRate);
  change('dayCount', 'ACT/365F');
  change('rounding', 'HALF_UP');
  change('scheduleType', 'annuity');
  change('installmentBasis', 'fixed-contractual');
  fireEvent.click(form.querySelector<HTMLInputElement>('[name="agreementConfirmed"]')!);
  fireEvent.click(form.querySelector<HTMLInputElement>('[name="openingBalanceDateConfirmed"]')!);
  fireEvent.submit(form);
}

describe('Approved bank reconciliation UI - opt-in and no financial writes', () => {
  it('only accepts integer millionths of percent with strict decimal parsing', () => {
    expect(parseNominalRate('9,5')).toBe(9_500_000);
    expect(parseNominalRate('0')).toBe(0);
    expect(parseNominalRate('100.000000')).toBe(100_000_000);
    for (const invalid of ['1.1234567', '101', '100.000001', '12e2', '-1', '1,2,3']) {
      expect(() => parseNominalRate(invalid)).toThrow();
    }
  });

  it('does not infer bank terms, dates, or mutate the legacy loan before confirmation', () => {
    const before = structuredClone(sample.selected);
    render(
      <StrictMode>
        <Loans {...sample} />
      </StrictMode>,
    );
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'не подтверждены',
    );
    expect(document.querySelector('.loan-comparison-table-scroll')).toBeNull();
    expect(screen.getByText(/Расчёт по аннуитетной модели/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Уточнить условия банка' }));
    const dialog = document.querySelector<HTMLDialogElement>('.loan-comparison-dialog')!;
    expect(dialog.open).toBe(true);
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    expect(form.querySelector<HTMLInputElement>('input[type="date"][readonly]')?.value).toBe(
      '2026-01-01',
    );
    fireEvent.submit(form);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toMatch(/Проверьте условия/);
    expect(document.querySelector('.loan-comparison-table-scroll')).toBeNull();
    expect(sample.selected).toEqual(before);
  });

  it('compares the full bank schedule to the kopeck but never confirms bank parity', () => {
    render(
      <StrictMode>
        <Loans {...sample} />
      </StrictMode>,
    );
    confirmSyntheticContract();
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'Числовое совпадение',
    );
    expect(document.querySelectorAll('.loan-comparison-table-scroll tbody tr')).toHaveLength(2);
    expect(document.querySelector('.loan-comparison-metrics')?.textContent).toContain('Полная');
    expect(document.querySelector('.loan-comparison')?.textContent).toContain('не подтверждена');
    expect(document.querySelectorAll('[data-action="pay"]')).toHaveLength(1);
  });

  it('flags a one-kopeck bank mismatch and missing breakdown without assigning a zero', () => {
    const mismatch = {
      ...sample,
      selected: {
        ...sample.selected!,
        bankSchedule: sample.selected!.bankSchedule.map((row, index) =>
          index === 1 ? { ...row, amountCents: row.amountCents + 1 } : row,
        ),
      },
    };
    const { rerender } = render(<Loans {...mismatch} />);
    confirmSyntheticContract();
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain('расхождения');
    expect(document.querySelector('.loan-comparison-table-scroll')?.textContent).toContain('−0.01');

    const incomplete = {
      ...sample,
      selected: {
        ...sample.selected!,
        bankSchedule: sample.selected!.bankSchedule.map(({ date, amountCents, balanceCents }) => ({
          date,
          amountCents,
          balanceCents,
        })),
        stateRevision: 2,
      },
    };
    rerender(<Loans {...incomplete} />);
    confirmSyntheticContract();
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'недостаточно',
    );
    expect(document.querySelector('.loan-comparison-metrics')?.textContent).toContain(
      'Не подтверждена',
    );
    expect(document.querySelector('.loan-comparison-table-scroll')?.textContent).toContain(
      'Нет данных',
    );
  });

  it('allows an ephemeral locally selected CSV without persisting it or leaking names', async () => {
    const before = structuredClone(sample.selected);
    render(<Loans {...sample} />);
    confirmSyntheticContract();
    const csv =
      'Date;Payment;Interest;Principal;Balance\n' +
      '2026-02-01;5074,10;101,92;4972,18;5027,82\n' +
      '2026-03-01;5074,11;46,28;5027,82;0,00\n';
    const localFile = new File([csv], 'SENSITIVE_BANK_NAME.csv', { type: 'text/csv' });
    Object.defineProperty(localFile, 'text', { value: async () => csv });
    fireEvent.change(screen.getByLabelText('Локальный банковский CSV для сверки'), {
      target: { files: [localFile] },
    });
    await waitFor(() =>
      expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
        'расхождения',
      ),
    );
    expect(
      document.querySelector('[data-testid="loan-comparison-source"]')?.textContent ?? '',
    ).not.toContain('SENSITIVE');
    expect(sample.selected).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить локальный CSV' }));
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'Числовое совпадение',
    );
  });

  it('completes a pending CSV read with rules confirmed after the file was selected', async () => {
    const csv =
      'Date;Payment;Interest;Principal;Balance\n' +
      '2026-02-01;5074,10;101,92;4972,18;5027,82\n' +
      '2026-03-01;5074,10;46,28;5027,82;0,00\n';
    let finishRead!: (value: string) => void;
    const pendingRead = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const file = new File([csv], 'LOCAL_REFERENCE.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => pendingRead });
    const original = structuredClone(sample.selected);
    render(<Loans {...sample} />);
    fireEvent.change(screen.getByLabelText('Локальный банковский CSV для сверки'), {
      target: { files: [file] },
    });
    confirmSyntheticContract();
    finishRead(csv);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="loan-comparison-source"]')?.textContent).toContain(
        'Выбранный локальный CSV',
      ),
    );
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'Числовое совпадение',
    );
    expect(sample.selected).toEqual(original);
  });

  it('uses newly confirmed bank terms when an earlier CSV read finishes later', async () => {
    const csv =
      'Date;Payment;Interest;Principal;Balance\n' +
      '2026-02-01;5074,10;101,92;4972,18;5027,82\n' +
      '2026-03-01;5074,10;46,28;5027,82;0,00\n';
    let finishRead!: (value: string) => void;
    const pendingRead = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const file = new File([csv], 'IN_FLIGHT_PRIVATE.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => pendingRead });
    render(<Loans {...sample} />);
    confirmSyntheticContract('12');
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'Числовое совпадение',
    );
    fireEvent.change(screen.getByLabelText('Локальный банковский CSV для сверки'), {
      target: { files: [file] },
    });
    confirmSyntheticContract('0');
    finishRead(csv);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="loan-comparison-source"]')?.textContent).toContain(
        'Выбранный локальный CSV',
      ),
    );
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'расхождения',
    );
    expect(screen.queryByText('IN_FLIGHT_PRIVATE.csv')).toBeNull();
  });

  it('discards ephemeral conditions when loan data revision or selected loan changes', () => {
    const { rerender } = render(<Loans {...sample} />);
    confirmSyntheticContract();
    expect(document.querySelector('.loan-comparison-metrics')).not.toBeNull();
    rerender(<Loans {...sample} selected={{ ...sample.selected!, stateRevision: 2 }} />);
    expect(document.querySelector('.loan-comparison-metrics')).toBeNull();
    rerender(
      <Loans {...sample} selected={{ ...sample.selected!, id: 'second', stateRevision: 2 }} />,
    );
    expect(document.querySelector('.loan-comparison-metrics')).toBeNull();
    expect(document.querySelector('.loan-comparison-status')?.textContent).toContain(
      'не подтверждены',
    );
  });
});
