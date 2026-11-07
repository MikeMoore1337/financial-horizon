import type { ReactNode } from 'react';
import { EventRow, Icon, type CalendarEvent, type CalendarProps } from './Calendar';

export interface OverviewTotals {
  netPlanCents: number;
  incomeCents: number;
  incomePaidCents: number;
  expenseCents: number;
  expensePaidCents: number;
}
export interface OverviewCategory {
  name: string;
  amountCents: number;
  percent: number;
}
export interface OverviewLoan {
  id: string;
  title: string;
  outstandingCents: number;
  monthlyCents: number;
  months: number | null;
  percent: number;
}
export interface OverviewProps {
  currentDate: string;
  monthTitle: string;
  hasData: boolean;
  totals: OverviewTotals;
  categories: readonly OverviewCategory[];
  upcoming: readonly CalendarEvent[];
  loan: OverviewLoan | null;
  rubles: CalendarProps['rubles'];
  formatDate: CalendarProps['formatDate'];
}

function PageHeader({
  title,
  subtitle,
  currentDate,
  formatDate,
  children,
}: {
  title: string;
  subtitle: string;
  currentDate: string;
  formatDate: OverviewProps['formatDate'];
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{formatDate(currentDate)} · Личные финансы</div>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      <div className="header-tools">{children}</div>
    </header>
  );
}

export function Overview({
  currentDate,
  monthTitle,
  hasData,
  totals,
  categories,
  upcoming,
  loan,
  rubles,
  formatDate,
}: OverviewProps) {
  if (!hasData) {
    return (
      <>
        <PageHeader
          title="Обзор месяца"
          currentDate={currentDate}
          formatDate={formatDate}
          subtitle="Начните без регистрации. Все записи сохранятся только в этом браузере."
        />
        <div className="surface empty-panel">
          <Icon name="lock" />
          <h3>Ваша бухгалтерия пока пуста</h3>
          <p>
            Добавьте поступления, обязательные платежи и ипотеку. Можно сначала включить вымышленные
            данные, чтобы посмотреть приложение.
          </p>
          <div className="setting-actions" style={{ justifyContent: 'center' }}>
            <button className="button-primary" data-action="new-entry" data-kind="income">
              Добавить доход
            </button>
            <button className="button-secondary" data-action="new-loan">
              Добавить кредит
            </button>
            <button className="button-secondary" data-action="sample">
              Показать пример
            </button>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Обзор месяца"
        currentDate={currentDate}
        formatDate={formatDate}
        subtitle={monthTitle + ' · план и фактически внесённые суммы'}
      >
        <button className="button-secondary" data-action="prev-month" aria-label="Предыдущий месяц">
          <Icon name="chevron" />
        </button>
        <button className="button-secondary" data-action="next-month" aria-label="Следующий месяц">
          <Icon name="chevron" />
        </button>
      </PageHeader>
      <div className="overview-grid">
        <div className="overview-column">
          <div className="surface hero-money">
            <div className="hero-label">Плановый остаток после обязательств</div>
            <div className="hero-amount">{rubles(totals.netPlanCents)}</div>
            <div className="hero-foot">
              Доходы за месяц минус обязательные платежи. Это не остаток на банковском счёте.
            </div>
          </div>
          <div className="kpi-grid">
            <div className="surface kpi">
              <div className="kpi-label">Плановые доходы</div>
              <div className="kpi-num pos">{rubles(totals.incomeCents)}</div>
              <div className="small-hint">Получено: {rubles(totals.incomePaidCents)}</div>
            </div>
            <div className="surface kpi">
              <div className="kpi-label">Обязательства</div>
              <div className="kpi-num">{rubles(totals.expenseCents)}</div>
              <div className="small-hint">Оплачено: {rubles(totals.expensePaidCents)}</div>
            </div>
          </div>
          <div className="section-title">
            <h2>Распределение платежей</h2>
            <button className="button-text" data-view="obligations">
              Все записи <Icon name="chevron" />
            </button>
          </div>
          <div className="surface">
            {categories.length ? (
              categories.map((category) => (
                <div className="allocation-row" key={category.name}>
                  <div className="allocation-label">
                    <span>{category.name}</span>
                    <strong>{rubles(category.amountCents)}</strong>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: category.percent + '%' }} />
                  </div>
                </div>
              ))
            ) : (
              <p className="small-hint">Добавьте расходы для построения распределения.</p>
            )}
          </div>
        </div>
        <div className="overview-column">
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Ближайшие события</h2>
            <button className="button-text" data-view="calendar">
              Календарь <Icon name="chevron" />
            </button>
          </div>
          <div className="surface plain-list">
            {upcoming.length ? (
              upcoming.map((event, index) => (
                <EventRow
                  key={event.source + '-' + event.id + '-' + index}
                  event={event}
                  rubles={rubles}
                  formatDate={formatDate}
                />
              ))
            ) : (
              <div className="empty-mini">В этом месяце больше нет запланированных событий.</div>
            )}
          </div>
          <div className="section-title">
            <h2>{loan ? 'Кредитный горизонт' : 'Кредиты'}</h2>
            <button className="button-text" data-view="loans">
              Подробнее <Icon name="chevron" />
            </button>
          </div>
          <div className="surface loan-spotlight">
            {loan ? (
              <>
                <div className="small-hint">Осталось выплатить · {loan.title}</div>
                <div className="loan-balance">{rubles(loan.outstandingCents)}</div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: loan.percent + '%' }} />
                </div>
                <p className="small-hint" style={{ margin: '10px 0' }}>
                  Ориентировочный срок:{' '}
                  {loan.months === null ? 'не рассчитывается' : loan.months + ' мес.'}. Платёж:{' '}
                  {rubles(loan.monthlyCents)}
                </p>
                <button className="button-primary" data-action="pay" data-id={loan.id}>
                  <Icon name="plus" /> Внести платёж
                </button>
              </>
            ) : (
              <>
                <p className="small-hint">Кредитов пока нет.</p>
                <button className="button-primary" data-action="new-loan">
                  Добавить кредит
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
