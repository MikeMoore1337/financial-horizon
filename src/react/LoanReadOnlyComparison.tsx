import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { prepareReadOnlyLoanComparison, type ReadOnlyLoanComparison } from '../domain/loans/read-only-comparison.ts';
import type { ExplicitLoanTermsSelection, StoredLoanSnapshot } from '../domain/loans/legacy-preview.ts';
import type { BankScheduleRow, DayCount, Rounding, ScheduleDifference, ScheduleType } from '../domain/loans/types.ts';
import { parseSchedule } from '../../schedule.js';
import './loan-comparison.css';

export interface LoanReadOnlyComparisonProps {
  snapshot: StoredLoanSnapshot;
  bankSchedule: readonly BankScheduleRow[];
  rubles: (cents: number) => string;
  formatDate: (date: string) => string;
}

/** Financial contract rates are integer millionths of a percent, never a JS float. */
export function parseNominalRate(value: string): number {
  const normalized = value.trim().replace(',', '.');
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(normalized)) {
    throw new RangeError('Номинальная ставка должна содержать не более шести знаков после запятой');
  }
  const [whole, fractional = ''] = normalized.split('.');
  const microPercent = Number(whole) * 1_000_000 + Number(fractional.padEnd(6, '0'));
  if (!Number.isSafeInteger(microPercent) || microPercent > 100_000_000) {
    throw new RangeError('Номинальная ставка должна быть от 0 до 100 процентов');
  }
  return microPercent;
}

const DAY_COUNTS: readonly DayCount[] = ['ACT/365F', 'ACT/360', 'ACT/ACT-ISDA', '30E/360'];
const ROUNDINGS: readonly Rounding[] = ['HALF_UP', 'HALF_EVEN'];
const SCHEDULE_TYPES: readonly ScheduleType[] = ['annuity', 'differentiated'];
const INSTALLMENT_BASES = ['fixed-contractual', 'recalculate'] as const;

function selectedValue<T extends string>(source: FormData, name: string, choices: readonly T[]): T {
  const value = source.get(name);
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new RangeError('Укажите подтверждённые правила банка');
  }
  return value as T;
}

function approvedRules(form: HTMLFormElement): ExplicitLoanTermsSelection {
  const fields = new FormData(form);
  const dueDay = fields.get('dueDayAnchor');
  if (typeof dueDay !== 'string' || !/^(?:[1-9]|[12][0-9]|3[01])$/.test(dueDay)) {
    throw new RangeError('Укажите договорный день платежа от 1 до 31');
  }
  const rate = fields.get('annualRate');
  if (typeof rate !== 'string') throw new RangeError('Укажите номинальную ставку');
  if (fields.get('agreementConfirmed') !== 'on' || fields.get('openingBalanceDateConfirmed') !== 'on') {
    throw new RangeError('Подтвердите условия договора и дату чистого основного долга');
  }
  return {
    agreementConfirmed: true,
    openingBalanceDateConfirmed: true,
    firstDueDate: String(fields.get('firstDueDate') ?? ''),
    dueDayAnchor: Number(dueDay),
    annualRateMicroPercent: parseNominalRate(rate),
    dayCount: selectedValue(fields, 'dayCount', DAY_COUNTS),
    rounding: selectedValue(fields, 'rounding', ROUNDINGS),
    scheduleType: selectedValue(fields, 'scheduleType', SCHEDULE_TYPES),
    installmentBasis: selectedValue(fields, 'installmentBasis', INSTALLMENT_BASES),
  };
}

function Delta({ value, rubles }: { value: number | null; rubles: (cents: number) => string }) {
  return value === null ? <span className="loan-comparison-unknown">Нет данных</span>
    : <span className={value === 0 ? '' : 'loan-comparison-delta'}>
        {value < 0 ? '−' : value > 0 ? '+' : ''}{rubles(Math.abs(value))}
      </span>;
}

function DifferenceRow({ row, rubles, formatDate }: {
  row: ScheduleDifference;
  rubles: LoanReadOnlyComparisonProps['rubles'];
  formatDate: LoanReadOnlyComparisonProps['formatDate'];
}) {
  return <tr>
    <td>{row.period}</td>
    <td>{row.imported?.date ? formatDate(row.imported.date) : row.calculated?.date ? formatDate(row.calculated.date) : 'Нет данных'}</td>
    <td>{row.dateDifferenceDays === null ? 'Нет данных' : row.dateDifferenceDays === 0 ? '0' : String(row.dateDifferenceDays)}</td>
    <td><Delta value={row.amountDeltaCents} rubles={rubles} /></td>
    <td><Delta value={row.interestDeltaCents} rubles={rubles} /></td>
    <td><Delta value={row.principalDeltaCents} rubles={rubles} /></td>
    <td><Delta value={row.balanceDeltaCents} rubles={rubles} /></td>
    <td><Delta value={row.bankUnallocatedCents} rubles={rubles} /></td>
  </tr>;
}

export function LoanReadOnlyComparison({ snapshot, bankSchedule, rubles, formatDate }: LoanReadOnlyComparisonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [accepted, setAccepted] = useState<ExplicitLoanTermsSelection | null>(null);
  const [result, setResult] = useState<ReadOnlyLoanComparison | null>(null);
  const [localRows, setLocalRows] = useState<readonly BankScheduleRow[] | null>(null);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [rowsVisible, setRowsVisible] = useState(25);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!dialogOpen && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
    };
  }, [dialogOpen]);

  const rows = localRows ?? (bankSchedule.length ? bankSchedule : null);
  const sourceLabel = localRows ? 'Выбранный локальный CSV' :
    bankSchedule.length ? 'Ранее импортированный полный CSV' : 'Нет банковского графика';

  const close = () => {
    setDialogOpen(false);
    openButtonRef.current?.focus();
  };

  const run = (rules: ExplicitLoanTermsSelection, bankRows: readonly BankScheduleRow[] | null) => {
    const comparison = prepareReadOnlyLoanComparison(snapshot, rules, bankRows);
    setResult(comparison);
    setRowsVisible(25);
    return comparison;
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const rules = approvedRules(event.currentTarget);
      const comparison = run(rules, rows);
      if (comparison.status === 'needs-confirmation') throw new Error('Недостаточно договорных условий');
      setAccepted(rules);
      setError('');
      close();
    } catch {
      // Validation messages must never echo private banking inputs or CSV cells.
      setError('Проверьте условия договора, дату первого платежа, ставку и подтверждения.');
    }
  }

  async function onCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // Fail closed: a rejected file must not leave the last bank result visible.
    setLocalRows(null);
    setResult(null);
    setRowsVisible(25);
    setFileError('');
    if (!/\.csv$/i.test(file.name) || file.size === 0 || file.size > 1_000_000) {
      setFileError('Нужен CSV размером от 1 байта до 1 МБ.');
      return;
    }
    try {
      const parsed = parseSchedule(await file.text(), { allowMissingBalance: true }) as BankScheduleRow[];
      if (parsed.length > 1499) throw new RangeError('Too many bank rows');
      const next = accepted ? prepareReadOnlyLoanComparison(snapshot, accepted, parsed) : null;
      setLocalRows(parsed);
      setResult(next);
      setRowsVisible(25);
    } catch {
      setFileError('Не удалось разобрать CSV. Проверьте даты и заголовки столбцов.');
    }
  }

  const comparison = result?.bankComparison ?? null;
  const status = result?.status;
  const message = status === 'numerical-match'
    ? 'Числовое совпадение по заданным параметрам - правила банка отдельно не подтверждены.'
    : status === 'incomplete-bank-evidence'
      ? 'Известные поля совпали, но банковских данных недостаточно для полной сверки.'
      : status === 'differences'
        ? 'Обнаружены расхождения между расчётом и банковским графиком.'
        : status === 'no-bank-schedule'
          ? 'План рассчитан. Загрузите полный банковский CSV для сверки.'
          : 'Правила банка не подтверждены. Действует прежний приблизительный прогноз.';
  const statusClass = status === 'differences' ? 'is-different' :
    status === 'incomplete-bank-evidence' || status === 'no-bank-schedule' ? 'is-incomplete' :
      status === 'numerical-match' ? 'is-matching' : '';

  return <>
    <section className="loan-comparison" aria-labelledby="loan-comparison-heading">
      <div className="loan-comparison-head">
        <div>
          <h3 id="loan-comparison-heading">Сверка графика по договору</h3>
          <p className="small-hint">Отдельный расчёт без изменения кредита, истории платежей и счетов.</p>
        </div>
        <span className="pill">{status ? 'Предварительный план' : 'Условия не подтверждены'}</span>
      </div>
      <p className="small-hint">Подтвердите банковские правила и сравните рассчитанные суммы с полным CSV. Совпадение цифр само по себе не подтверждает точность модели для банка.</p>
      <div className="loan-comparison-actions">
        <button ref={openButtonRef} type="button" className="button-primary" onClick={() => { setError(''); setDialogOpen(true); }}>Уточнить условия банка</button>
        <button type="button" className="button-secondary" onClick={() => fileRef.current?.click()}>Выбрать CSV для сверки</button>
        {localRows ? <button type="button" className="button-text" onClick={() => {
          const fallback = bankSchedule.length ? bankSchedule : null;
          setLocalRows(null);
          setResult(accepted ? prepareReadOnlyLoanComparison(snapshot, accepted, fallback) : null);
          setRowsVisible(25);
        }}>Сбросить локальный CSV</button> : null}
      </div>
      <input ref={fileRef} type="file" accept=".csv,text/csv" aria-label="Локальный банковский CSV для сверки" hidden onChange={onCsv} />
      <p className="small-hint" data-testid="loan-comparison-source">Источник: {sourceLabel}. Полный график используется только для расчёта на устройстве.</p>
      {fileError ? <p role="alert" className="loan-comparison-error">{fileError}</p> : null}
      <div className={'loan-comparison-status ' + statusClass} role="status" aria-live="polite">{message}</div>
      {result?.plan ? <>
        <div className="loan-comparison-metrics">
          <div><span>Периодов рассчитано</span><strong>{result.plan.rows.length}</strong></div>
          <div><span>Строк с расхождением</span><strong>{comparison ? comparison.mismatchedRows : 'Нет CSV'}</strong></div>
          <div><span>Полнота банковских данных</span><strong>{comparison?.comparisonComplete ? 'Полная' : 'Не подтверждена'}</strong></div>
        </div>
        {comparison ? <>
          <div className="loan-comparison-table-scroll" role="region" aria-label="Разницы рассчитанного и банковского графиков" tabIndex={0}>
            <table className="compact-table">
              <caption>Δ = расчёт минус банковский график, суммы в копейках через формат рублей</caption>
              <thead><tr>
                <th>Взнос</th><th>Дата банка</th><th>Δ дней</th><th>Δ платёж</th><th>Δ проценты</th><th>Δ тело</th><th>Δ остаток</th><th>Прочее банка</th>
              </tr></thead>
              <tbody>{comparison.rows.slice(0, rowsVisible).map(row =>
                <DifferenceRow key={row.period} row={row} rubles={rubles} formatDate={formatDate} />)}</tbody>
            </table>
          </div>
          {comparison.rows.length > rowsVisible ? <button type="button" className="button-secondary" onClick={() => setRowsVisible(count => count + 25)}>Показать ещё строки</button> : null}
          <p className="small-hint">Сравнено {comparison.rows.length} строк, отображено {Math.min(rowsVisible, comparison.rows.length)}. Нет данных - не ноль; комиссии не списываются повторно.</p>
        </> : null}
        <p className="small-hint">Фактические платежи не переносились в новый расчёт. Банковская идентичность не подтверждена.</p>
      </> : null}
    </section>

    <dialog ref={dialogRef} className="loan-comparison-dialog" aria-labelledby="loan-comparison-dialog-title" onCancel={() => setDialogOpen(false)}>
      <div className="loan-comparison-dialog-head">
        <div><span className="eyebrow">Только предварительный расчёт</span><h2 id="loan-comparison-dialog-title">Условия банка</h2></div>
        <button className="button-secondary" type="button" aria-label="Закрыть условия банка" onClick={close}>Закрыть</button>
      </div>
      <form onSubmit={onSubmit}>
        <div className="loan-comparison-dialog-body">
          <p className="small-hint">Укажите только подтверждённые договором значения. Сохранённая дата и сумма долга не изменяются; при неверной дате сперва исправьте исходный кредит отдельно.</p>
          <div className="loan-comparison-fields">
            <label>Дата чистого основного долга<input type="date" value={snapshot.asOfDate} readOnly aria-readonly="true" /></label>
            <label>Дата первого платежа<input type="date" name="firstDueDate" required /></label>
            <label>День платежа по договору<input type="number" name="dueDayAnchor" min="1" max="31" step="1" required placeholder="1-31" /></label>
            <label>Номинальная ставка, %<input type="text" name="annualRate" inputMode="decimal" required placeholder="Например, 9,5" /></label>
            <label>Начисление дней<select name="dayCount" defaultValue="" required><option value="" disabled>Выберите правило</option>{DAY_COUNTS.map(x => <option key={x} value={x}>{x}</option>)}</select></label>
            <label>Округление<select name="rounding" defaultValue="" required><option value="" disabled>Выберите правило</option><option value="HALF_UP">Половина вверх</option><option value="HALF_EVEN">Банковское округление</option></select></label>
            <label>Тип графика<select name="scheduleType" defaultValue="" required><option value="" disabled>Выберите тип</option><option value="annuity">Аннуитетный</option><option value="differentiated">Дифференцированный</option></select></label>
            <label>Основа платежа<select name="installmentBasis" defaultValue="" required><option value="" disabled>Выберите вариант</option><option value="fixed-contractual">Договорный фиксированный</option><option value="recalculate">Пересчитать платёж</option></select></label>
          </div>
          <label className="loan-comparison-confirm"><input type="checkbox" name="agreementConfirmed" required />Я проверил эти правила по договору.</label>
          <label className="loan-comparison-confirm"><input type="checkbox" name="openingBalanceDateConfirmed" required />Сохранённый исходный остаток - чистый основной долг на указанную дату, без комиссий и просроченных процентов.</label>
          {error ? <p className="loan-comparison-error" role="alert">{error}</p> : null}
          <p className="small-hint">Проверка работает только в памяти браузера: без запросов в банк, записи в IndexedDB и изменения истории платежей.</p>
        </div>
        <div className="loan-comparison-dialog-actions">
          <button className="button-secondary" type="button" onClick={close}>Отмена</button>
          <button className="button-primary" type="submit">Рассчитать и сравнить</button>
        </div>
      </form>
    </dialog>
  </>;
}
