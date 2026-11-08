import { Icon, type CalendarProps } from './Calendar';

export interface LoanSummary {
  id: string;
  title: string;
  outstandingCents: number;
  monthlyCents: number;
  months: number | null;
  paidPercent: number;
}
export interface LoanHistoryItem {
  id: string;
  date: string;
  amountCents: number;
  voidedAt?: string | null;
}
export interface LoanScheduleItem {
  date: string;
  amountCents: number;
  balanceCents: number;
}
export interface LoanDetails extends LoanSummary {
  apr: number;
  dueDay: number;
  projectedEnd: string | null;
  schedule: readonly LoanScheduleItem[];
  scheduleSource: string;
  scheduleCount: number;
  history: readonly LoanHistoryItem[];
}
export interface LoansProps {
  loans: readonly LoanSummary[];
  selected: LoanDetails | null;
  currentDate: string;
  rubles: CalendarProps['rubles'];
  formatDate: CalendarProps['formatDate'];
}

function LoanHistory({
  rows,
  rubles,
  formatDate,
}: {
  rows: readonly LoanHistoryItem[];
  rubles: LoansProps['rubles'];
  formatDate: LoansProps['formatDate'];
}) {
  if (!rows.length)
    return (
      <p className="small-hint">
        Фактических платежей пока нет. Они появятся здесь после внесения.
      </p>
    );
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="compact-table">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Сумма</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDate(row.date)}</td>
              <td>{rubles(row.amountCents)}</td>
              <td>
                {row.voidedAt ? (
                  <span className="pill">Отменён</span>
                ) : (
                  <span className="pill pill-paid">Учтён</span>
                )}
              </td>
              <td>
                {row.voidedAt ? null : (
                  <button className="button-text" data-action="void-payment" data-id={row.id}>
                    Отменить
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Loans({ loans, selected, currentDate, rubles, formatDate }: LoansProps) {
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{formatDate(currentDate)} · Личные финансы</div>
          <h1>Кредиты и ипотека</h1>
          <p className="subtitle">
            Остатки долга, реальные платежи и приблизительный прогноз погашения
          </p>
        </div>
        <div className="header-tools">
          <button className="button-primary" data-action="new-loan">
            <Icon name="plus" /> Кредит
          </button>
        </div>
      </header>
      {loans.length && selected ? (
        <div className="loan-grid">
          <div>
            {loans.map((loan) => (
              <button
                key={loan.id}
                className={'loan-card ' + (loan.id === selected.id ? 'selected' : '')}
                data-action="select-loan"
                data-id={loan.id}
                aria-pressed={loan.id === selected.id}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span className="title">{loan.title}</span>
                  <span className="pill">{loan.paidPercent}% закрыто</span>
                </div>
                <div className="balance">{rubles(loan.outstandingCents)}</div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: loan.paidPercent + '%' }} />
                </div>
                <div className="small-hint" style={{ marginTop: 10 }}>
                  {rubles(loan.monthlyCents)} / мес. · {loan.months ?? '—'} мес. приблизительно
                </div>
              </button>
            ))}
          </div>
          <div className="surface loan-detail">
            <div className="section-title" style={{ marginTop: 0 }}>
              <h2>{selected.title}</h2>
              <span className="pill">{selected.apr}% годовых</span>
            </div>
            <div className="eyebrow">Текущий расчётный долг</div>
            <div className="hero-amount" style={{ fontSize: 39 }}>
              {rubles(selected.outstandingCents)}
            </div>
            <div className="loan-stats">
              <div>
                <span>Плановый платёж</span>
                <strong>{rubles(selected.monthlyCents)}</strong>
              </div>
              <div>
                <span>Осталось ориентировочно</span>
                <strong>
                  {selected.months === null ? 'Нет расчёта' : selected.months + ' мес.'}
                </strong>
              </div>
              <div>
                <span>Предполагаемая дата</span>
                <strong>
                  {selected.projectedEnd ? formatDate(selected.projectedEnd) : 'Не определена'}
                </strong>
              </div>
              <div>
                <span>День платежа</span>
                <strong>{selected.dueDay}-е число</strong>
              </div>
            </div>
            <div className="loan-actions">
              <button className="button-primary" data-action="pay" data-id={selected.id}>
                <Icon name="plus" /> Внести платёж
              </button>
              <button className="button-secondary" data-action="edit-loan" data-id={selected.id}>
                <Icon name="edit" /> Изменить
              </button>
              <button
                className="button-secondary"
                data-action="schedule-import"
                data-id={selected.id}
              >
                Импорт графика CSV
              </button>
              <button className="button-secondary" data-action="archive-loan" data-id={selected.id}>
                В архив
              </button>
            </div>
            <div className="info-card" style={{ marginTop: 14 }}>
              <strong style={{ fontSize: 13 }}>Расчёт по аннуитетной модели</strong>
              <p className="small-hint" style={{ margin: '7px 0 0' }}>
                Не учитывает индивидуальные банковские правила, ежедневные проценты, комиссии и
                просрочки. Итоговые даты проверяйте по официальному графику.
              </p>
            </div>
            {selected.scheduleCount ? (
              <>
                <div className="section-title">
                  <h2>Импортированный график</h2>
                  <button
                    className="button-text"
                    data-action="clear-schedule"
                    data-id={selected.id}
                  >
                    Удалить график
                  </button>
                </div>
                <span className="pill">{selected.scheduleCount} строк</span>
                <p className="small-hint">
                  Источник: {selected.scheduleSource}. График хранится на устройстве для сверки с
                  прогнозом; автоматически не подменяет факты.
                </p>
                <div style={{ overflow: 'auto' }}>
                  <table className="compact-table">
                    <tbody>
                      <tr>
                        <th>Дата</th>
                        <th>Платёж</th>
                        <th>Остаток</th>
                      </tr>
                      {selected.schedule.map((item, index) => (
                        <tr key={item.date + '-' + index}>
                          <td>{formatDate(item.date)}</td>
                          <td>{rubles(item.amountCents)}</td>
                          <td>{rubles(item.balanceCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            <div className="loan-history">
              <h3>История оплат</h3>
              <LoanHistory rows={selected.history} rubles={rubles} formatDate={formatDate} />
            </div>
          </div>
        </div>
      ) : (
        <div className="surface empty-panel">
          <Icon name="credit" />
          <h3>Кредитов пока нет</h3>
          <p>
            Можно добавить ипотеку, остаток и параметры платежа. График обновится после каждого
            сохранённого фактического платежа.
          </p>
          <button className="button-primary" data-action="new-loan">
            Добавить ипотеку или кредит
          </button>
        </div>
      )}
    </>
  );
}
