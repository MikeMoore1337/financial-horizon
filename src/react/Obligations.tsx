import { Fragment } from 'react';
import { Icon, type CalendarProps } from './Calendar';
import { ConnectedReserves } from './Reserves';
import { PaymentCenter, ReserveAlerts } from './PaymentCenter';
import {
  DEFAULT_REMINDER_SETTINGS,
  type ReminderResult,
  type ReminderSettings,
} from '../domain/cashflow/in-app-reminders.ts';
import type { PaymentMethod } from '../types/finance';
import type { XlsxReservePreview } from '../domain/reserves/xlsx-preview.ts';

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
  financeEnabled?: boolean;
  verifiedActorUserId?: string | null;
  reserveSection?: 'payments' | 'due' | 'reserves';
  reminderResult?: ReminderResult | null;
  reminderError?: string | null;
  reminderSettings?: ReminderSettings;
  reminderScopeKey?: string;
  paymentMethods?: Readonly<Record<string, readonly PaymentMethod[]>>;
  onReminderSettingsChange?: (next: ReminderSettings) => Promise<void>;
  focusReserveId?: string | null;
  importSuggestions?: readonly XlsxReservePreview[];
  onReserveSectionChange?: (next: 'payments' | 'due' | 'reserves') => void;
  onPaymentSourceChange?: (source: 'server' | 'local') => void;
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
  financeEnabled = false,
  verifiedActorUserId = null,
  reserveSection = 'payments',
  reminderResult = null,
  reminderError = null,
  reminderSettings = DEFAULT_REMINDER_SETTINGS,
  reminderScopeKey = 'guest-state-v2',
  paymentMethods = {},
  onReminderSettingsChange = async () => {},
  focusReserveId = null,
  importSuggestions = [],
  onReserveSectionChange,
  onPaymentSourceChange,
}: ObligationsProps) {
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{formatDate(currentDate)} · Личные финансы</div>
          <h1>{reserveSection === 'due' ? 'Центр оплат' : 'Обязательства'}</h1>
          <p className="subtitle">
            {reserveSection === 'reserves'
              ? 'Резервы для регулярных обязательств и подтверждённые остатки'
              : reserveSection === 'due'
                ? 'Ближайшие платежи, напоминания и резервы'
                : 'Доходы и расходы. Полный учёт запланированных и фактических сумм'}
          </p>
        </div>
        <div className="header-tools">
          {reserveSection === 'payments' ? (
            <button className="button-primary" data-action="new-entry">
              <Icon name="plus" /> Добавить
            </button>
          ) : (
            <button
              type="button"
              className="button-primary fh-reserve-desktop-create"
              onClick={() => {
                const mobile = document.querySelector<HTMLButtonElement>(
                  '.fh-reserve-mobile-create',
                );
                if (window.matchMedia('(max-width:760px)').matches) mobile?.click();
                else document.querySelector<HTMLElement>('.fh-reserve-editor select')?.focus();
              }}
            >
              <Icon name="plus" /> Создать резерв
            </button>
          )}
        </div>
      </header>
      <div className="segment fh-reserve-tabs" role="group" aria-label="Разделы обязательств">
        <button
          type="button"
          className={reserveSection === 'payments' ? 'selected' : ''}
          aria-pressed={reserveSection === 'payments'}
          onClick={() => onReserveSectionChange?.('payments')}
        >
          Платежи
        </button>
        <button
          type="button"
          className={reserveSection === 'due' ? 'selected' : ''}
          aria-pressed={reserveSection === 'due'}
          onClick={() => onReserveSectionChange?.('due')}
        >
          К оплате
          {reminderResult?.totalAlerts ? (
            <span
              className="fh-center-count"
              aria-label={`Напоминаний: ${reminderResult.totalAlerts}`}
            >
              {reminderResult.totalAlerts}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={reserveSection === 'reserves' ? 'selected' : ''}
          aria-pressed={reserveSection === 'reserves'}
          onClick={() => onReserveSectionChange?.('reserves')}
        >
          Накопления
        </button>
      </div>
      {reserveSection === 'due' ? (
        <PaymentCenter
          result={reminderResult}
          error={reminderError}
          settings={reminderSettings}
          currentDate={currentDate}
          scopeKey={reminderScopeKey}
          verifiedActorUserId={verifiedActorUserId}
          financeEnabled={financeEnabled}
          paymentMethods={paymentMethods}
          rubles={rubles}
          formatDate={formatDate}
          onSettingsChange={onReminderSettingsChange}
          onSourceChange={onPaymentSourceChange}
        />
      ) : reserveSection === 'reserves' ? (
        financeEnabled ? (
          <>
            <ReserveAlerts
              actor={verifiedActorUserId}
              currentDate={currentDate}
              scopeKey={reminderScopeKey}
              settings={reminderSettings}
              rubles={rubles}
              formatDate={formatDate}
            />
            <ConnectedReserves
              verifiedActorUserId={verifiedActorUserId}
              currentDate={currentDate}
              focusReserveId={focusReserveId}
              importSuggestions={importSuggestions}
            />
          </>
        ) : (
          <div className="surface fh-reserve-empty" role="status">
            <h2>Накопления недоступны</h2>
            <p>Для работы с накоплениями необходим подтверждённый финансовый аккаунт.</p>
          </div>
        )
      ) : (
        <>
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
      )}
    </>
  );
}
