import { useEffect, useMemo, useState } from 'react';
import { getMonthEvents, monthTotals } from '../../finance.js';
import { Calendar, type CalendarProps } from './Calendar';
import { ReservesFinanceGateway, type ReservesServerView } from './reserves-finance-gateway';

function ServerCalendar(props: CalendarProps & { actor: string }) {
  const gateway = useMemo(() => new ReservesFinanceGateway(), [props.actor]);
  const [view, setView] = useState<ReservesServerView | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let ready = false;
    let seq = 0;
    const load = async (initial = false) => {
      if (!initial && !ready) return;
      const current = ++seq;
      try {
        const next = initial
          ? await gateway.open(props.actor, props.currentDate, controller.signal)
          : await gateway.refresh(props.actor, props.currentDate, controller.signal);
        if (!controller.signal.aborted && current === seq) {
          ready = true;
          setView(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted && current === seq) setError(true);
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
      seq++;
      controller.abort();
      gateway.invalidate();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [gateway, props.actor, props.currentDate]);
  if (error)
    return <p role="alert">Не удалось загрузить календарь аккаунта. Проверьте подключение.</p>;
  if (!view) return <p role="status">Загрузка календаря аккаунта…</p>;
  try {
    const events = getMonthEvents(view.planner, props.month);
    const totals = monthTotals(events, view.planner, props.month);
    return (
      <>
        <p className="small-hint">
          Обязательства и оплаты из аккаунта. Локальные записи доступны отдельно.
        </p>
        {view.planner.serverLoanCount > 0 && (
          <p className="small-hint">Серверные кредиты пока не показаны в календаре.</p>
        )}
        <Calendar
          {...props}
          events={events}
          netPlanCents={totals.netPlanCents}
          netFactCents={totals.netFactCents}
          financeEnabled
          serverReserveView={view}
          serverView
        />
      </>
    );
  } catch {
    return <p role="alert">Не удалось рассчитать календарь аккаунта.</p>;
  }
}

export function ConnectedCalendar(props: CalendarProps) {
  const available = Boolean(props.financeEnabled && props.verifiedActorUserId);
  const [source, setSource] = useState<'server' | 'local'>(available ? 'server' : 'local');
  useEffect(() => {
    setSource(available ? 'server' : 'local');
  }, [available, props.verifiedActorUserId]);
  return (
    <>
      {available && (
        <div className="fh-reserve-tabs" role="group" aria-label="Источник календаря">
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
        <ServerCalendar {...props} actor={props.verifiedActorUserId} />
      ) : (
        <Calendar {...props} />
      )}
    </>
  );
}
