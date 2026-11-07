import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

export interface CalendarEvent {
  id: string;
  title: string;
  kind: 'income' | 'expense';
  source: string;
  date: string;
  category: string;
  plannedCents: number;
  paidCents: number;
}

export interface CalendarProps {
  events: readonly CalendarEvent[];
  month: string;
  selectedDate: string;
  currentDate: string;
  monthTitle: string;
  netPlanCents: number;
  netFactCents: number;
  formatDate: (date: string) => string;
  rubles: (cents: number) => string;
}

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href={'#ico-' + name} />
    </svg>
  );
}

function EventRow({
  event,
  rubles,
  formatDate,
}: {
  event: CalendarEvent;
  rubles: CalendarProps['rubles'];
  formatDate: CalendarProps['formatDate'];
}) {
  const remaining = Math.max(0, event.plannedCents - event.paidCents);
  const status = event.paidCents <= 0 ? 'Ожидается' : remaining === 0 ? 'Оплачено' : 'Частично';
  const isIncome = event.kind === 'income';
  return (
    <div className="list-row">
      <div className="list-icon">
        <Icon name={isIncome ? 'download' : event.source === 'loan' ? 'credit' : 'calendar'} />
      </div>
      <div className="list-row-main">
        <strong>{event.title}</strong>
        <small>
          {formatDate(event.date)} · {event.category}{' '}
          {event.paidCents ? '· факт ' + rubles(event.paidCents) : ''}
        </small>
      </div>
      <div className="list-row-right">
        <strong className={isIncome ? 'pos' : ''}>
          {isIncome ? '+' : '−'}
          {rubles(event.plannedCents)}
        </strong>
        <span
          className={
            'pill ' + (event.paidCents ? (remaining === 0 ? 'pill-paid' : 'pill-partial') : '')
          }
        >
          {status}
        </span>
      </div>
      <button
        className="mini-action"
        aria-label={(isIncome ? 'Отметить поступление: ' : 'Отметить оплату: ') + event.title}
        data-action={event.source === 'loan' ? 'pay' : 'settle'}
        data-id={event.id}
        data-month={event.source === 'loan' ? undefined : event.date.slice(0, 7)}
      >
        <Icon name="check" />
      </button>
    </div>
  );
}

export function Calendar({
  events,
  month,
  selectedDate,
  currentDate,
  monthTitle,
  netPlanCents,
  netFactCents,
  formatDate,
  rubles,
}: CalendarProps) {
  const [year, monthNumber] = month.split('-').map(Number);
  const blanks = (new Date(year!, monthNumber! - 1, 1, 12).getDay() + 6) % 7;
  const daysInMonth = new Date(year!, monthNumber!, 0).getDate();
  const selected = selectedDate.slice(0, 7) === month ? selectedDate : month + '-01';
  const selectedEvents = events.filter((event) => event.date === selected);
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{formatDate(currentDate)} · Личные финансы</div>
          <h1>Календарь платежей</h1>
          <p className="subtitle">
            Поступления, регулярные обязательства и даты оплаты в едином календаре
          </p>
        </div>
        <div className="header-tools">
          <button className="button-primary" data-action="new-entry">
            <Icon name="plus" /> Запись
          </button>
        </div>
      </header>
      <div className="cal-layout">
        <div>
          <div className="surface">
            <div className="filter-bar">
              <div className="month-controls">
                <button data-action="prev-month" aria-label="Предыдущий месяц">
                  <Icon name="chevron" />
                </button>
                <strong>{monthTitle}</strong>
                <button data-action="next-month" aria-label="Следующий месяц">
                  <Icon name="chevron" />
                </button>
              </div>
              <span className="pill">{events.length} событий</span>
            </div>
            <div className="calendar-grid">
              {weekdays.map((day) => (
                <div className="cal-head" key={day}>
                  {day}
                </div>
              ))}
              {Array.from({ length: blanks }, (_, index) => (
                <div className="cal-blank" key={'blank-' + index} />
              ))}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const date = month + '-' + String(index + 1).padStart(2, '0');
                const items = events.filter((event) => event.date === date);
                return (
                  <button
                    key={date}
                    className={
                      'cal-day ' +
                      (date === selected ? 'selected' : '') +
                      ' ' +
                      (date === currentDate ? 'today' : '')
                    }
                    data-action="select-day"
                    data-date={date}
                    aria-labelledby={
                      'calendar-day-number-' + date + ' calendar-day-summary-' + date
                    }
                    aria-describedby={'calendar-day-description-' + date}
                    aria-pressed={date === selected}
                  >
                    <span className="cal-number" id={'calendar-day-number-' + date}>
                      {index + 1}
                    </span>
                    <span className="cal-tokens">
                      {items.slice(0, 4).map((event, i) => (
                        <i
                          key={event.id + '-' + i}
                          className={event.kind === 'income' ? 'income' : 'expense'}
                        />
                      ))}
                    </span>{' '}
                    <span className="cal-summ" id={'calendar-day-summary-' + date}>
                      {items.slice(0, 2).map((event, i) => (
                        <span key={event.id + '-' + i}>{event.title}</span>
                      ))}
                    </span>
                    <span className="visually-hidden" id={'calendar-day-description-' + date}>
                      {formatDate(date)}; {items.length} событий
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="calendar-legend">
              <span>
                <i />
                Поступления
              </span>
              <span>
                <i />
                Платежи
              </span>
            </div>
          </div>
        </div>
        <div>
          <div className="surface">
            <h2 className="cal-selected-title">{formatDate(selected)}</h2>
            <div className="small-hint" style={{ marginBottom: 12 }}>
              Нажмите на дату, чтобы увидеть обязательства и отметить оплату
            </div>
            <div className="plain-list">
              {selectedEvents.length ? (
                selectedEvents.map((event, index) => (
                  <EventRow
                    key={event.source + '-' + event.id + '-' + index}
                    event={event}
                    rubles={rubles}
                    formatDate={formatDate}
                  />
                ))
              ) : (
                <div className="empty-mini">В этот день ничего не запланировано.</div>
              )}
            </div>
          </div>
          <div className="surface" style={{ marginTop: 13 }}>
            <div className="kpi-label">Плановый итог месяца</div>
            <div className="amount-medium">{rubles(netPlanCents)}</div>
            <div className="small-hint" style={{ marginTop: 8 }}>
              Подтверждённый поток: {rubles(netFactCents)}. Суммы не включают начальный остаток на
              счетах.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** React owns only #main while Calendar is visible. StrictMode effects cannot write to storage. */
export function createCalendarRoot(host: HTMLElement) {
  const root = createRoot(host);
  return {
    render(props: CalendarProps) {
      // Preserve focus timing of the pre-React calendar's keyboard navigation.
      flushSync(() =>
        root.render(
          <StrictMode>
            <Calendar {...props} />
          </StrictMode>,
        ),
      );
    },
    unmount() {
      root.unmount();
    },
  };
}
