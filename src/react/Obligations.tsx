import { Fragment } from 'react';
import { Icon, type CalendarProps } from './Calendar';

export type ObligationFilter = 'all' | 'regular' | 'once' | 'income';
export interface ObligationPayment {
  id: string;
  amountCents: number;
  date: string;
}
export interface ObligationItem {
  id: string;
  title: string;
  kind: 'expense' | 'income';
  recurrence: 'once' | 'monthly' | 'yearly';
  category: string;
  amountCents: number;
  date: string;
  paidCents: number;
  payments: readonly ObligationPayment[];
}
export interface ObligationsProps {
  rows: readonly ObligationItem[];
  month: string;
  monthTitle: string;
  filter: ObligationFilter;
  expandedEntry: string | null;
  currentDate: string;
  expenseCents: number;
  expensePaidCents: number;
  rubles: CalendarProps['rubles'];
  formatDate: CalendarProps['formatDate'];
}

function Recurrence({ value }: { value: ObligationItem['recurrence'] }) {
  if (value === 'once') return null;
  return <> · {value === 'monthly' ? 'Каждый месяц' : 'Ежегодно'}</>;
}

function ItemActions({
  row,
  month,
  mobile = false,
}: {
  row: ObligationItem;
  month: string;
  mobile?: boolean;
}) {
  return (
    <div className={mobile ? 'record-mobile-actions' : 'record-actions'}>
      <button
        className="mini-action"
        data-action="settle"
        data-id={row.id}
        data-month={month}
        aria-label={mobile ? 'Отметить оплату' : 'Отметить сумму'}
      >
        <Icon name="check" />
      </button>
      <button
        className="mini-action"
        data-action="edit-entry"
        data-id={row.id}
        aria-label="Изменить"
      >
        <Icon name="edit" />
      </button>
      <button
        className="mini-action"
        data-action="archive-entry"
        data-id={row.id}
        aria-label="Удалить"
      >
        <Icon name="trash" />
      </button>
    </div>
  );
}

function DesktopRow({
  row,
  month,
  expandedEntry,
  rubles,
  formatDate,
}: {
  row: ObligationItem;
  month: string;
  expandedEntry: string | null;
  rubles: ObligationsProps['rubles'];
  formatDate: ObligationsProps['formatDate'];
}) {
  return (
    <Fragment>
      <tr>
        <td>
          <div className="record-title">{row.title}</div>
          <div className="record-sub">
            {row.category || 'Без категории'}
            <Recurrence value={row.recurrence} />
          </div>
        </td>
        <td>{formatDate(row.date)}</td>
        <td>
          <span className={'pill ' + (row.payments.length ? 'pill-paid' : '')}>
            {row.payments.length ? 'Внесено ' + rubles(row.paidCents) : 'План'}
          </span>
        </td>
        <td className={'money-cell ' + (row.kind === 'income' ? 'pos' : '')}>
          {row.kind === 'income' ? '+' : '−'}
          {rubles(row.amountCents)}
        </td>
        <td className="record-actions">
          <button
            className="mini-action"
            data-action="settle"
            data-id={row.id}
            data-month={month}
            aria-label="Отметить сумму"
          >
            <Icon name="check" />
          </button>
          <button
            className="mini-action"
            data-action="edit-entry"
            data-id={row.id}
            aria-label="Изменить"
          >
            <Icon name="edit" />
          </button>
          <button
            className="mini-action"
            data-action="archive-entry"
            data-id={row.id}
            aria-label="Удалить"
          >
            <Icon name="trash" />
          </button>
        </td>
      </tr>
      {expandedEntry === row.id && row.payments.length > 0 ? (
        <tr>
          <td colSpan={5}>
            <div style={{ padding: '10px 15px', background: 'var(--soft)', borderRadius: 12 }}>
              {row.payments.map((payment) => (
                <div className="archive-row" key={payment.id}>
                  <div>
                    {formatDate(payment.date)} · {rubles(payment.amountCents)}
                  </div>
                  <span>
                    <button
                      className="button-text"
                      data-action="edit-settlement"
                      data-id={payment.id}
                    >
                      Изменить
                    </button>{' '}
                    <button
                      className="button-text"
                      data-action="void-settlement"
                      data-id={payment.id}
                    >
                      Отменить
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function MobileRow({
  row,
  month,
  expandedEntry,
  rubles,
  formatDate,
}: {
  row: ObligationItem;
  month: string;
  expandedEntry: string | null;
  rubles: ObligationsProps['rubles'];
  formatDate: ObligationsProps['formatDate'];
}) {
  return (
    <Fragment>
      <div className="record-mobile-row">
        <div className="list-icon">
          <Icon name={row.kind === 'income' ? 'download' : 'calendar'} />
        </div>
        <div>
          <strong>{row.title}</strong>
          <small>
            {formatDate(row.date)} · {row.category}
          </small>
          <small>{row.payments.length ? 'Факт ' + rubles(row.paidCents) : 'Ожидается'}</small>
        </div>
        <div>
          <div className={'record-mobile-amount ' + (row.kind === 'income' ? 'pos' : '')}>
            {row.kind === 'income' ? '+' : '−'}
            {rubles(row.amountCents)}
          </div>
          <ItemActions row={row} month={month} mobile />
          {row.payments.length > 0 ? (
            <button
              className="button-text"
              style={{ fontSize: 12 }}
              data-action="expand-entry"
              data-id={row.id}
            >
              История
            </button>
          ) : null}
        </div>
      </div>
      {expandedEntry === row.id
        ? row.payments.map((payment) => (
            <div className="archive-row" key={payment.id} style={{ padding: 10 }}>
              {rubles(payment.amountCents)} · {formatDate(payment.date)}
              <span>
                <button className="button-text" data-action="edit-settlement" data-id={payment.id}>
                  Править
                </button>
                <button className="button-text" data-action="void-settlement" data-id={payment.id}>
                  Отмена
                </button>
              </span>
            </div>
          ))
        : null}
    </Fragment>
  );
}

const filters: { key: ObligationFilter; title: string }[] = [
  { key: 'all', title: 'Все' },
  { key: 'regular', title: 'Регулярные' },
  { key: 'once', title: 'Разовые' },
  { key: 'income', title: 'Доходы' },
];

export function Obligations({
  rows,
  month,
  monthTitle,
  filter,
  expandedEntry,
  currentDate,
  expenseCents,
  expensePaidCents,
  rubles,
  formatDate,
}: ObligationsProps) {
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{formatDate(currentDate)} · Личные финансы</div>
          <h1>Обязательства</h1>
          <p className="subtitle">
            Доходы и расходы. Полный учёт запланированных и фактических сумм
          </p>
        </div>
        <div className="header-tools">
          <button className="button-primary" data-action="new-entry">
            <Icon name="plus" /> Добавить
          </button>
        </div>
      </header>
      <div className="kpi-grid" style={{ maxWidth: 760, margin: '0 0 20px' }}>
        <div className="surface kpi">
          <div className="kpi-label">Расходы по плану</div>
          <div className="kpi-num">{rubles(expenseCents)}</div>
        </div>
        <div className="surface kpi">
          <div className="kpi-label">Оплачено фактически</div>
          <div className="kpi-num pos">{rubles(expensePaidCents)}</div>
        </div>
      </div>
      <div className="filter-bar">
        <div className="segment">
          {filters.map((option) => (
            <button
              key={option.key}
              className={filter === option.key ? 'selected' : ''}
              data-action="filter"
              data-filter={option.key}
              aria-pressed={filter === option.key}
            >
              {option.title}
            </button>
          ))}
        </div>
        <span className="small-hint">
          {rows.length} записей · {monthTitle}
        </span>
      </div>
      <div className="surface">
        {rows.length ? (
          <>
            <table className="records-table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Дата</th>
                  <th>Состояние</th>
                  <th style={{ textAlign: 'right' }}>Сумма</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DesktopRow
                    key={row.id}
                    row={row}
                    month={month}
                    expandedEntry={expandedEntry}
                    rubles={rubles}
                    formatDate={formatDate}
                  />
                ))}
              </tbody>
            </table>
            <div className="records-mobile">
              {rows.map((row) => (
                <MobileRow
                  key={row.id}
                  row={row}
                  month={month}
                  expandedEntry={expandedEntry}
                  rubles={rubles}
                  formatDate={formatDate}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty-panel">
            <Icon name="list" />
            <h3>Здесь пока нет записей</h3>
            <p>
              Добавляйте регулярные платежи, зарплату или разовые расходы. Их можно изменять и
              архивировать.
            </p>
            <button className="button-primary" data-action="new-entry">
              Добавить запись
            </button>
          </div>
        )}
      </div>
      <p className="small-hint" style={{ marginTop: 13 }}>
        Кредиты учитываются в общем финансовом плане и на странице «Кредиты». Архивирование
        сохраняет историю.
      </p>
    </>
  );
}
