import { useEffect, useMemo, useState } from 'react';
import { getMonthEvents, monthTotals } from '../../finance.js';
import { Overview, type OverviewProps } from './Overview';
import { projectOverviewCategories } from './OverviewModels';
import { ReservesFinanceGateway, type ReservesServerView } from './reserves-finance-gateway';

function ServerOverview(props: OverviewProps & { actor: string }) {
  const gateway = useMemo(() => new ReservesFinanceGateway(), [props.actor]);
  const [view, setView] = useState<ReservesServerView | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let ready = false,
      sequence = 0;
    const load = async (initial = false) => {
      if (!initial && !ready) return;
      const current = ++sequence;
      try {
        const next = initial
          ? await gateway.open(props.actor, props.currentDate, controller.signal)
          : await gateway.refresh(props.actor, props.currentDate, controller.signal);
        if (!controller.signal.aborted && current === sequence) {
          ready = true;
          setView(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted && current === sequence) setError(true);
      }
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load(true);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      sequence++;
      controller.abort();
      gateway.invalidate();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [gateway, props.actor, props.currentDate]);
  if (error) return <p role="alert">Не удалось загрузить обзор аккаунта. Проверьте подключение.</p>;
  if (!view) return <p role="status">Загрузка обзора аккаунта…</p>;
  try {
    const month = props.month ?? props.currentDate.slice(0, 7);
    const events = getMonthEvents(view.planner, month);
    const totals = monthTotals(events, view.planner, month);
    return (
      <>
        <p className="small-hint">Обзор данных аккаунта. Локальные записи доступны отдельно.</p>
        {view.planner.serverLoanCount > 0 && (
          <p className="small-hint">Серверные кредиты пока не показаны в обзоре.</p>
        )}
        <Overview
          {...props}
          hasData={view.planner.entries.some((item) => !item.deletedAt)}
          totals={totals}
          categories={projectOverviewCategories(events)}
          upcoming={events.filter((item) => item.date >= props.currentDate).slice(0, 4)}
          loan={null}
          serverView
          serverReserveView={view}
        />
      </>
    );
  } catch {
    return <p role="alert">Не удалось рассчитать обзор аккаунта.</p>;
  }
}

export function ConnectedOverview(props: OverviewProps) {
  const available = Boolean(props.financeEnabled && props.verifiedActorUserId);
  const [source, setSource] = useState<'server' | 'local'>(available ? 'server' : 'local');
  useEffect(() => {
    setSource(available ? 'server' : 'local');
  }, [available, props.verifiedActorUserId]);
  return (
    <>
      {available && (
        <div className="fh-reserve-tabs" role="group" aria-label="Источник обзора">
          <button
            type="button"
            className={source === 'server' ? 'selected' : ''}
            aria-pressed={source === 'server'}
            onClick={() => {
              setSource('server');
              props.onSourceChange?.('server');
            }}
          >
            В аккаунте
          </button>
          <button
            type="button"
            className={source === 'local' ? 'selected' : ''}
            aria-pressed={source === 'local'}
            onClick={() => {
              setSource('local');
              props.onSourceChange?.('local');
            }}
          >
            На устройстве
          </button>
        </div>
      )}
      {available && source === 'server' && props.verifiedActorUserId ? (
        <ServerOverview {...props} actor={props.verifiedActorUserId} />
      ) : (
        <Overview {...props} />
      )}
    </>
  );
}
