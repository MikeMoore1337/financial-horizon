import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { getReminderMonthEvents } from '../../finance.js';
import {
  buildInAppReminders,
  type DuePayment,
  type ReminderSettings,
} from '../domain/cashflow/in-app-reminders.ts';
import type { ReserveProjection } from '../domain/reserves/index.ts';
import { isValidLedgerDate, parseRubMinor } from './accounts-view-model';
import { ReservesFinanceGateway, type ReservesServerView } from './reserves-finance-gateway';

/** Online server records are shown separately from unmigrated local records. */
export function ServerPaymentCenter({
  actor,
  currentDate,
  settings,
  rubles,
  formatDate,
  renderReserves,
}: {
  actor: string;
  currentDate: string;
  settings: ReminderSettings;
  rubles: (value: number) => string;
  formatDate: (value: string) => string;
  renderReserves: (rows: readonly ReserveProjection[] | null, error: boolean) => ReactNode;
}) {
  const gateway = useMemo(() => new ReservesFinanceGateway(), [actor]);
  const [view, setView] = useState<ReservesServerView | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<DuePayment | null>(null);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(currentDate);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newDate, setNewDate] = useState(currentDate);
  const [newRecurrence, setNewRecurrence] = useState<'none' | 'month' | 'year'>('month');
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let ready = false;
    let sequence = 0;
    const load = async (initial = false) => {
      if (inFlight.current || (!initial && !ready)) return;
      const current = ++sequence;
      try {
        const next = initial
          ? await gateway.open(actor, currentDate, controller.signal)
          : await gateway.refresh(actor, currentDate, controller.signal);
        const waiting = await gateway.hasPendingOnlinePayment();
        if (!controller.signal.aborted && current === sequence) {
          ready = true;
          setView(next);
          setPending(waiting);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted && current === sequence) {
          setError('Не удалось получить серверные обязательства. Проверьте подключение.');
        }
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
  }, [actor, currentDate, gateway]);

  let due: readonly DuePayment[] = [];
  let projectionError = '';
  if (view) {
    try {
      due = buildInAppReminders({
        scopeKey: 'account:' + actor,
        currentDate,
        settings,
        payments: getReminderMonthEvents(view.planner, currentDate.slice(0, 7)),
        includeOneTime: true,
      }).duePayments.filter((row) => row.daysUntilDue <= 7);
    } catch {
      projectionError = 'Не удалось рассчитать серверные обязательства.';
    }
  }
  const accounts = view?.accounts.filter((account) => !account.archived) ?? [];
  const openPayment = (row: DuePayment) => {
    setSelected(row);
    setAccountId(accounts[0]?.id ?? '');
    setAmount((row.remainingCents / 100).toFixed(2));
    setPaidOn(currentDate);
    setError('');
  };
  const failed = async (failure: unknown) => {
    let waiting = true;
    try {
      waiting = await gateway.hasPendingOnlinePayment();
    } catch {
      /* Preserve uncertainty. */
    }
    setPending(waiting);
    setError(
      waiting
        ? 'Результат не подтверждён. Сверьте эту операцию перед следующей оплатой.'
        : failure instanceof Error
          ? failure.message
          : 'Не удалось сохранить оплату.',
    );
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || inFlight.current || pending) return;
    let amountMinor: number;
    try {
      amountMinor = parseRubMinor(amount);
      if (
        amountMinor <= 0 ||
        amountMinor > selected.remainingCents ||
        !accountId ||
        !isValidLedgerDate(paidOn) ||
        paidOn > currentDate
      )
        throw Error('Проверьте сумму, дату и счёт.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Проверьте данные.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await gateway.confirmOnlinePayment(
        {
          accountId,
          obligationId: selected.recordId,
          amountMinor,
          paidOn,
          occurrenceOn: selected.dueDate,
        },
        currentDate,
      );
      setView(next);
      setSelected(null);
      setPending(false);
      window.dispatchEvent(new Event('fh-reserves-updated'));
    } catch (failure) {
      await failed(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const reconcile = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setView(await gateway.resumeOnlinePayment(currentDate));
      setPending(false);
      setSelected(null);
      window.dispatchEvent(new Event('fh-reserves-updated'));
    } catch (failure) {
      await failed(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const createObligation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || pending) return;
    let amountMinor: number;
    try {
      amountMinor = parseRubMinor(newAmount);
      if (!newTitle.trim() || amountMinor <= 0 || !isValidLedgerDate(newDate))
        throw Error('Проверьте название, сумму и дату.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Проверьте данные.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const created = await gateway.createPlanningObligation(
        {
          title: newTitle.trim(),
          amountMinor,
          startsOn: newDate,
          recurrenceUnit: newRecurrence,
          recurrenceEvery: 1,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
        currentDate,
      );
      setView(created.view);
      setCreating(false);
      setNewTitle('');
      setNewAmount('');
    } catch {
      setError(
        'Не удалось подтвердить создание. Обновите страницу и проверьте список, прежде чем повторить.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const voidPayment = async (transactionId: string, factId: string, accountId: string) => {
    if (inFlight.current || pending || !window.confirm('Отменить оплату и вернуть сумму на счёт?'))
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setView(await gateway.voidOnlinePayment(transactionId, factId, accountId, currentDate));
      setSelected(null);
      setPending(false);
      window.dispatchEvent(new Event('fh-reserves-updated'));
    } catch (failure) {
      await failed(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="fh-center" aria-label="Оплаты в аккаунте">
      <p className="small-hint">
        Эти обязательства и оплаты хранятся в аккаунте и доступны на других устройствах. Локальные
        записи и их способы оплаты остаются на устройстве. Перенести записи можно в настройках после
        проверки копии.
      </p>
      {view && (
        <div className="fh-center-top">
          <button
            type="button"
            className="button-secondary"
            disabled={pending || busy}
            aria-expanded={creating}
            onClick={() => setCreating(!creating)}
          >
            Добавить обязательство в аккаунт
          </button>
        </div>
      )}
      {creating && (
        <form
          className="surface fh-center-payments"
          onSubmit={(event) => void createObligation(event)}
        >
          <h2>Новое обязательство</h2>
          <label className="field">
            <span>Название</span>
            <input
              value={newTitle}
              maxLength={160}
              onChange={(event) => setNewTitle(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Сумма, ₽</span>
            <input
              value={newAmount}
              inputMode="decimal"
              onChange={(event) => setNewAmount(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Дата первого платежа</span>
            <input
              type="date"
              value={newDate}
              onChange={(event) => setNewDate(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Повторять</span>
            <select
              value={newRecurrence}
              onChange={(event) =>
                setNewRecurrence(event.target.value as 'none' | 'month' | 'year')
              }
            >
              <option value="none">Однократно</option>
              <option value="month">Ежемесячно</option>
              <option value="year">Ежегодно</option>
            </select>
          </label>
          <div className="fh-center-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Отмена
            </button>
            <button type="submit" className="button-primary" disabled={busy || pending}>
              Сохранить обязательство
            </button>
          </div>
        </form>
      )}
      {view && !gateway.supportsPaymentGuard && (
        <p role="status" className="small-hint">
          Сервер обновляется. Подтверждение оплат появится после обновления.
        </p>
      )}
      {error && (
        <p role="alert" className="neg">
          {error}
        </p>
      )}
      {view && view.planner.serverLoanCount > 0 && (
        <p className="small-hint">Серверные кредиты пока не показаны в центре оплат.</p>
      )}
      {projectionError && (
        <p role="alert" className="neg">
          {projectionError}
        </p>
      )}
      {pending && (
        <div className="surface fh-center-empty" role="status">
          <p>Предыдущая оплата ожидает сверки с сервером.</p>
          <button
            type="button"
            className="button-primary"
            disabled={busy || !gateway.supportsPaymentGuard}
            onClick={() => void reconcile()}
          >
            Сверить оплату
          </button>
        </div>
      )}
      {!view && !error && <p role="status">Загрузка обязательств…</p>}
      {view && accounts.length === 0 && (
        <p className="small-hint">
          Для подтверждения оплаты создайте счёт в аккаунте в настройках.
        </p>
      )}
      {view && !projectionError && (
        <section className="surface fh-center-payments" aria-label="Серверные обязательства">
          <div className="fh-center-heading">
            <h2>К оплате в аккаунте</h2>
          </div>
          {due.length === 0 && <p>Нет ближайших неоплаченных обязательств.</p>}
          {due.map((row) => {
            const reserve = view.reserves.find(
              (item) => !item.archived && item.obligationId === row.recordId,
            );
            return (
              <article
                className="fh-center-event"
                key={row.key}
                data-server-payment-id={row.recordId}
              >
                <div className="fh-center-event-main">
                  <strong>{row.title}</strong>
                  <p className="fh-center-meta">
                    Срок: {formatDate(row.dueDate)} ·{' '}
                    {row.status === 'overdue'
                      ? 'Просрочено'
                      : row.status === 'today'
                        ? 'Сегодня'
                        : 'Скоро'}
                    {row.partial ? ' · Частично оплачено' : ''}
                  </p>
                  <p className="fh-center-meta">
                    План: {rubles(row.plannedCents)} · внесено: {rubles(row.paidCents)} · осталось:{' '}
                    {rubles(row.remainingCents)}
                  </p>
                </div>
                {reserve ? (
                  <button
                    type="button"
                    className="button-secondary"
                    data-action="open-reserves"
                    data-id={reserve.id}
                  >
                    Открыть резерв
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button-primary"
                    disabled={pending || busy || !gateway.supportsPaymentGuard}
                    onClick={() => openPayment(row)}
                  >
                    Отметить оплату
                  </button>
                )}
                {selected?.key === row.key && !pending && (
                  <form className="fh-center-event-main" onSubmit={(event) => void submit(event)}>
                    <label className="field">
                      <span>Счёт</span>
                      <select
                        value={accountId}
                        onChange={(event) => setAccountId(event.target.value)}
                        required
                      >
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name} · {rubles(account.balanceMinor)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Сумма, ₽</span>
                      <input
                        value={amount}
                        inputMode="decimal"
                        onChange={(event) => setAmount(event.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>Дата оплаты</span>
                      <input
                        type="date"
                        value={paidOn}
                        onChange={(event) => setPaidOn(event.target.value)}
                        required
                      />
                    </label>
                    <div className="fh-center-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={busy}
                        onClick={() => setSelected(null)}
                      >
                        Отмена
                      </button>
                      <button
                        type="submit"
                        className="button-primary"
                        disabled={busy || !accounts.length}
                      >
                        Подтвердить оплату
                      </button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </section>
      )}
      {view && view.planner.entries.some((item) => !item.deletedAt) && (
        <details className="surface fh-center-payments">
          <summary>Все обязательства аккаунта</summary>
          {view.planner.entries
            .filter((item) => !item.deletedAt && item.kind === 'expense')
            .map((item) => (
              <p className="fh-center-meta" key={item.id}>
                {item.title} · {rubles(item.amountCents)} · с {formatDate(item.date)}
              </p>
            ))}
        </details>
      )}
      {view && view.planner.settlements.length > 0 && (
        <section className="surface fh-center-payments" aria-label="История оплат аккаунта">
          <div className="fh-center-heading">
            <h2>История оплат</h2>
          </div>
          <p className="small-hint">
            Для исправления отмените ошибочную оплату и отметьте её заново.
          </p>
          {[...view.planner.settlements].reverse().map((fact) => {
            const obligation = view.planner.entries.find((item) => item.id === fact.entryId);
            const link = view.ledger.paymentLinks.find((item) => item.settlementId === fact.id);
            const posting =
              link &&
              view.ledger.postings.find((item) => item.transactionId === link.transactionId);
            const reserve =
              link &&
              view.reserves.find((item) =>
                item.history.some(
                  (event) => event.kind === 'payment' && event.transactionId === link.transactionId,
                ),
              );
            return (
              <article className="fh-center-event" key={fact.id}>
                <div className="fh-center-event-main">
                  <strong>{obligation?.title ?? 'Обязательство'}</strong>
                  <p className="fh-center-meta">
                    {formatDate(fact.date)} · период {fact.occurrence} · {rubles(fact.amountCents)}
                    {fact.voidedAt ? ' · Отменено' : ''}
                  </p>
                </div>
                {!fact.voidedAt && reserve && (
                  <button
                    type="button"
                    className="button-secondary"
                    data-action="open-reserves"
                    data-id={reserve.id}
                  >
                    Открыть резерв
                  </button>
                )}
                {!fact.voidedAt && !reserve && link && posting && (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy || pending || !gateway.supportsPaymentGuard}
                    onClick={() => void voidPayment(link.transactionId, fact.id, posting.accountId)}
                  >
                    Отменить оплату
                  </button>
                )}
                {!fact.voidedAt && !link && (
                  <span className="small-hint">Перенесённая запись без проводки счёта</span>
                )}
              </article>
            );
          })}
        </section>
      )}
      {renderReserves(
        view ? view.reserves.filter((item) => !item.archived).map((item) => item.projection) : null,
        Boolean(error && !view),
      )}
    </section>
  );
}
