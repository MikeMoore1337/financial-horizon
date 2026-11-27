/**
 * Read-only reserve highlights for Overview and Calendar.
 * Planned balances stay separate from authoritative bank-account balances.
 */
import { useEffect, useMemo, useState } from 'react';
import { formatRubMinor } from './accounts-view-model';
import {
  ReservesFinanceGateway,
  type ReserveViewRow,
  type ReservesServerView,
} from './reserves-finance-gateway';

export interface ReserveHighlightsProps {
  readonly verifiedActorUserId: string;
  readonly currentDate: string;
  readonly month?: string;
  readonly providedView?: ReservesServerView | null;
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value + 'T12:00:00Z'));
}

function label(row: ReserveViewRow): string {
  const p = row.projection;
  if (p.cyclePaid) return 'Оплачено';
  if (p.overdue) return 'Просрочено';
  if (p.fundingGapCents === 0) return 'Накоплено';
  return 'К накоплению';
}

export function ReserveHighlights({
  verifiedActorUserId,
  currentDate,
  month,
  providedView,
}: ReserveHighlightsProps) {
  const gateway = useMemo(() => new ReservesFinanceGateway(), [verifiedActorUserId]);
  const [view, setView] = useState<ReservesServerView | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (providedView !== undefined) return;
    const abort = new AbortController();
    setView(null);
    setError(false);
    void gateway
      .open(verifiedActorUserId, currentDate, abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setView(next);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => {
      abort.abort();
      gateway.invalidate();
    };
  }, [gateway, verifiedActorUserId, currentDate, providedView]);

  const visibleView = providedView === undefined ? view : providedView;
  if (providedView === undefined && error) {
    return (
      <div className="surface fh-reserve-highlight-error" role="status">
        Информация о накоплениях сейчас недоступна.
      </div>
    );
  }
  if (!visibleView)
    return (
      <div className="surface fh-reserve-highlight-loading" role="status">
        Загрузка накоплений…
      </div>
    );

  const entries = visibleView.reserves
    .filter((row) => !row.archived && (!month || row.projection.dueDate.startsWith(month)))
    .sort((a, b) => a.projection.dueDate.localeCompare(b.projection.dueDate))
    .slice(0, 6);
  return (
    <section className="fh-reserve-highlights" aria-label="Накопления к платежам">
      <div className="section-title">
        <h2>{month ? 'Накопления в этом месяце' : 'Накопления к обязательствам'}</h2>
        <button type="button" className="button-text" data-action="open-reserves">
          Все накопления{' '}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href="#ico-chevron" />
          </svg>
        </button>
      </div>
      <div className="surface fh-reserve-highlights-list">
        {entries.length ? (
          entries.map((row) => {
            const p = row.projection;
            const progress =
              p.targetCents > 0
                ? Math.min(100, Math.max(0, Math.round((p.reservedCents / p.targetCents) * 100)))
                : 0;
            return (
              <button
                type="button"
                className="fh-reserve-highlight-row"
                data-action="open-reserves"
                data-id={row.id}
                key={row.id}
                aria-label={'Открыть накопление ' + row.source.definition.title}
              >
                <span className="fh-reserve-highlight-title">
                  <strong>{row.source.definition.title}</strong>
                  <small>
                    {displayDate(p.dueDate)} · {label(row)}
                  </small>
                </span>
                <span className="fh-reserve-highlight-numbers">
                  <strong>
                    {formatRubMinor(p.reservedCents)} / {formatRubMinor(p.targetCents)}
                  </strong>
                  <small>
                    {progress} % · Следующий взнос:{' '}
                    {p.nextContribution
                      ? formatRubMinor(p.nextContribution.amountCents)
                      : 'не нужен'}
                  </small>
                  {p.projectedShortfallCents > 0 ? (
                    <small className="fh-reserve-error">
                      Не хватит: {formatRubMinor(p.projectedShortfallCents)}
                    </small>
                  ) : null}
                </span>
              </button>
            );
          })
        ) : (
          <p className="small-hint">В выбранном периоде резервов нет.</p>
        )}
      </div>
    </section>
  );
}
