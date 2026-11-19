import { useEffect, useMemo, useRef, useState } from 'react';
import { safePaymentUrl, validQrData } from '../../finance.js';
import {
  buildInAppReminders,
  type DuePayment,
  type PaymentReminder,
  type ReminderResult,
  type ReminderSettings,
  type ReserveReminder,
} from '../domain/cashflow/in-app-reminders.ts';
import type { PaymentMethod } from '../types/finance';
import { ReservesFinanceGateway } from './reserves-finance-gateway';
import type { ReserveProjection } from '../domain/reserves/index.ts';
import './payment-center.css';

export interface PaymentCenterProps {
  readonly result: ReminderResult | null;
  readonly error?: string | null;
  readonly settings: ReminderSettings;
  readonly currentDate: string;
  readonly scopeKey: string;
  readonly verifiedActorUserId?: string | null;
  readonly financeEnabled?: boolean;
  readonly paymentMethods: Readonly<Record<string, readonly PaymentMethod[]>>;
  readonly rubles: (value: number) => string;
  readonly formatDate: (date: string) => string;
  readonly onSettingsChange: (settings: ReminderSettings) => Promise<void>;
}

function statusLabel(item: DuePayment): string {
  if (item.status === 'overdue') return 'Просрочено';
  if (item.status === 'today') return 'Сегодня';
  return item.partial ? 'Частично оплачено' : 'Ожидает';
}

function relativeDate(date: string, days: number, formatDate: (date: string) => string): string {
  if (days < 0) return `Срок ${formatDate(date)} · просрочено на ${-days} дн.`;
  if (days === 0) return `Срок ${formatDate(date)} · сегодня`;
  return `Срок ${formatDate(date)} · осталось ${days} дн.`;
}

function statusClass(item: DuePayment): string {
  if (item.status === 'overdue') return ' overdue';
  if (item.status === 'today') return ' today';
  return item.partial ? ' partial' : '';
}

function mainMethod(methods: readonly PaymentMethod[]): PaymentMethod | null {
  const preferred = methods.find((m) => m.primary) ?? methods[0];
  return preferred ?? null;
}

/** Exposes existing #136 metadata, never creates a settlement from a URL or QR. */
function PaymentMethodAction({ method, id }: { method: PaymentMethod | null; id: string }) {
  const [showQr, setShowQr] = useState(false);
  if (!method) {
    return (
      <button
        type="button"
        className="button-secondary fh-center-action"
        data-action="edit-entry"
        data-id={id}
      >
        Настроить оплату
      </button>
    );
  }
  if (method.type === 'payment_url' || method.type === 'sbp_link') {
    let url: { href: string; hostname: string };
    try {
      url = safePaymentUrl(method.value);
    } catch {
      return <span className="small-hint">Ссылка недоступна. Проверьте способ оплаты.</span>;
    }
    return (
      <a
        className="button-secondary fh-center-action"
        href={url.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        aria-label={method.type === 'sbp_link' ? 'Перейти к оплате СБП' : 'Открыть личный кабинет'}
      >
        {method.type === 'sbp_link' ? 'Перейти к оплате' : 'Открыть ЛК'}
      </a>
    );
  }
  if (method.type === 'qr_image') {
    if (!method.imageData || !validQrData(method.imageData)) {
      return <span className="small-hint">QR повреждён. Измените способ оплаты.</span>;
    }
    return (
      <div className="fh-center-qr">
        <button
          type="button"
          className="button-secondary fh-center-action"
          aria-expanded={showQr}
          onClick={() => setShowQr((prev) => !prev)}
        >
          {showQr ? 'Скрыть QR' : 'Показать QR'}
        </button>
        {showQr && (
          <div className="fh-center-qr-content">
            <img src={method.imageData} alt="Сохранённый QR-код для оплаты" />
            <p className="small-hint">
              На том же телефоне используйте другой способ оплаты, если он доступен.
            </p>
          </div>
        )}
      </div>
    );
  }
  if (method.type === 'requisites') {
    return (
      <button
        type="button"
        className="button-secondary fh-center-action"
        data-action="copy-payment-requisites"
        data-id={id}
        data-method-id={method.id}
      >
        Скопировать реквизиты
      </button>
    );
  }
  return (
    <details className="fh-center-instructions">
      <summary className="button-secondary fh-center-action">Инструкция</summary>
      <p>{method.value}</p>
    </details>
  );
}

function PaymentRow({
  payment,
  methods,
  rubles,
  formatDate,
}: {
  payment: DuePayment;
  methods: readonly PaymentMethod[];
  rubles: PaymentCenterProps['rubles'];
  formatDate: PaymentCenterProps['formatDate'];
}) {
  const method = payment.source === 'entry' ? mainMethod(methods) : null;
  return (
    <article
      className="fh-center-event"
      data-payment-source={payment.source}
      data-payment-id={payment.recordId}
      data-payment-occurrence={payment.occurrence}
    >
      <div className="fh-center-event-main">
        <div className="fh-center-event-title">
          <strong>{payment.title}</strong>
          <span className={'fh-center-flag' + statusClass(payment)}>{statusLabel(payment)}</span>
          {payment.partial && payment.status !== 'upcoming' && (
            <span className="fh-center-flag partial">Частично оплачено</span>
          )}
        </div>
        <p className="fh-center-meta">
          {relativeDate(payment.dueDate, payment.daysUntilDue, formatDate)}
        </p>
        <p className="fh-center-meta">
          {payment.partial
            ? `Внесено ${rubles(payment.paidCents)} из ${rubles(payment.plannedCents)}`
            : payment.source === 'loan'
              ? 'Платёж по кредиту'
              : 'Оплата ещё не подтверждена'}
        </p>
      </div>
      <div className="fh-center-event-side">
        <strong className="fh-center-amount">{rubles(payment.remainingCents)}</strong>
        <div className="fh-center-actions">
          {payment.source === 'entry' ? (
            <PaymentMethodAction
              key={payment.recordId + ':' + method?.id}
              method={method}
              id={payment.recordId}
            />
          ) : null}
          <button
            type="button"
            className="button-primary fh-center-action"
            data-action={payment.source === 'loan' ? 'pay' : 'settle'}
            data-id={payment.recordId}
            data-month={payment.occurrence}
          >
            Отметить оплату
          </button>
        </div>
      </div>
    </article>
  );
}

function SettingsPanel({
  value,
  onChange,
}: {
  value: ReminderSettings;
  onChange: PaymentCenterProps['onSettingsChange'];
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const change = async (next: ReminderSettings) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(false);
    try {
      await onChange(next);
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <section className="surface fh-center-settings" aria-label="Настройки напоминаний">
      <h2>Когда напоминать</h2>
      <label className="fh-center-option">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={saving}
          onChange={(e) => void change({ ...value, enabled: e.target.checked })}
        />
        Включить напоминания
      </label>
      <div className="fh-center-leads" role="group" aria-label="Интервалы напоминаний">
        {([7, 3, 1] as const).map((days) => (
          <label className="fh-center-option" key={days}>
            <input
              type="checkbox"
              checked={value.daysBefore.includes(days)}
              disabled={!value.enabled || saving}
              onChange={(e) =>
                void change({
                  ...value,
                  daysBefore: e.target.checked
                    ? ([...value.daysBefore, days].sort((a, b) => a - b) as (1 | 3 | 7)[])
                    : value.daysBefore.filter((lead) => lead !== days),
                })
              }
            />
            За {days} {days === 1 ? 'день' : days === 3 ? 'дня' : 'дней'}
          </label>
        ))}
      </div>
      {error && (
        <p className="neg" role="alert">
          Не удалось сохранить настройки. Повторите действие.
        </p>
      )}
      <p className="small-hint">
        Напоминания отображаются только в открытом приложении. При выключении интервалы не
        действуют, но задолженность остаётся в «К оплате». Системные уведомления не запрашиваются.
      </p>
    </section>
  );
}

interface ReserveAlertsProps {
  readonly actor: string | null;
  readonly currentDate: string;
  readonly scopeKey: string;
  readonly settings: ReminderSettings;
  readonly rubles: PaymentCenterProps['rubles'];
  readonly formatDate: PaymentCenterProps['formatDate'];
}

export function ReserveAlerts({
  actor,
  currentDate,
  scopeKey,
  settings,
  rubles,
  formatDate,
}: ReserveAlertsProps) {
  const [rows, setRows] = useState<readonly ReserveProjection[] | null>(null);
  const [error, setError] = useState(false);
  const gateway = useMemo(() => (actor ? new ReservesFinanceGateway() : null), [actor]);

  useEffect(() => {
    if (!actor || !gateway) {
      setRows(null);
      setError(false);
      return;
    }
    const controller = new AbortController();
    let seq = 0;
    const reload = () => {
      const version = ++seq;
      setRows(null);
      setError(false);
      void gateway
        .open(actor, currentDate, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted && seq === version) {
            setRows(next.reserves.filter((r) => !r.archived).map((r) => r.projection));
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && seq === version) setError(true);
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reload();
    };
    const onOnline = () => reload();
    const onFocus = () => {
      if (document.visibilityState === 'visible') reload();
    };
    reload();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('fh-reserves-updated', reload);
    return () => {
      seq += 1;
      controller.abort();
      gateway.invalidate();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('fh-reserves-updated', reload);
    };
  }, [actor, gateway, currentDate]);

  if (!actor) {
    return (
      <div className="surface fh-center-empty" role="status">
        Резервы доступны после входа в финансовый аккаунт.
      </div>
    );
  }
  if (error) {
    return (
      <div className="surface fh-center-empty" role="status">
        Не удалось получить подтверждённые данные резервов. Проверьте подключение.
      </div>
    );
  }
  if (!rows)
    return (
      <div className="surface fh-center-empty" role="status">
        Загрузка резервов…
      </div>
    );

  const reminders = buildInAppReminders({
    currentDate,
    scopeKey,
    payments: [],
    reserves: rows,
    settings,
  });
  const visible = reminders.alerts.filter(
    (item): item is ReserveReminder => item.kind === 'reserve-shortfall',
  );
  return (
    <section className="surface fh-center-reserves" aria-label="Предупреждения о накоплениях">
      <div className="fh-center-heading">
        <h2>Недостаток резервов</h2>
        <span
          className="fh-center-count"
          aria-label={`Актуальных предупреждений: ${visible.length}`}
        >
          {visible.length}
        </span>
      </div>
      {visible.length ? (
        visible.map((item) => (
          <article className="fh-center-event" key={item.id} data-reserve-id={item.recordId}>
            <div className="fh-center-event-main">
              <div className="fh-center-event-title">
                <strong>{item.title}</strong>
                <span
                  className={'fh-center-flag' + (item.daysUntilDue < 0 ? ' overdue' : ' today')}
                >
                  {item.daysUntilDue < 0
                    ? 'Просрочено'
                    : item.daysUntilDue === 0
                      ? 'Сегодня'
                      : `Осталось ${item.daysUntilDue} дн.`}
                </span>
              </div>
              <p className="fh-center-meta">
                Срок: {formatDate(item.dueDate)} · цикл №{item.cycleNumber}
              </p>
              <p className="fh-center-meta">
                Цель: {rubles(item.targetCents)} · накоплено: {rubles(item.reservedCents)}
              </p>
              <p className="fh-center-meta">
                Текущий дефицит: <strong>{rubles(item.fundingGapCents)}</strong>
                {' · '}прогноз к сроку: {rubles(item.projectedShortfallCents)}
              </p>
            </div>
            <div className="fh-center-event-side">
              <strong className="fh-center-amount">{rubles(item.fundingGapCents)}</strong>
              <button
                type="button"
                className="button-secondary fh-center-action"
                data-action="open-reserves"
                data-id={item.recordId}
              >
                Открыть резерв
              </button>
            </div>
          </article>
        ))
      ) : (
        <div className="fh-center-empty">
          {settings.enabled
            ? 'Актуальных предупреждений о нехватке резервов нет.'
            : 'Напоминания выключены. Состояние резервов доступно ниже.'}
        </div>
      )}
      <p className="small-hint fh-center-note">
        Дефицит - это нехватка накоплений к обязательству, не отрицательный остаток счёта. Прогноз
        учитывает плановые, ещё не подтверждённые взносы.
      </p>
    </section>
  );
}

export function PaymentCenter({
  result,
  error,
  settings,
  currentDate,
  scopeKey,
  verifiedActorUserId,
  financeEnabled = false,
  paymentMethods,
  rubles,
  formatDate,
  onSettingsChange,
}: PaymentCenterProps) {
  const [showSettings, setShowSettings] = useState(false);
  const due = result?.duePayments.filter((row) => row.daysUntilDue <= 7) ?? [];
  const reminders =
    result?.alerts.filter((item): item is PaymentReminder => item.kind === 'payment') ?? [];
  const total = due.reduce((sum, row) => sum + row.remainingCents, 0);

  return (
    <section className="fh-center" aria-label="Центр оплат">
      <div className="fh-center-top">
        <p className="small-hint">Ближайшие и просроченные обязательства</p>
        <button
          type="button"
          className="button-secondary fh-center-action"
          aria-expanded={showSettings}
          aria-controls="fh-center-settings-wrap"
          onClick={() => setShowSettings((value) => !value)}
        >
          Настроить напоминания
        </button>
      </div>
      {showSettings && (
        <div id="fh-center-settings-wrap">
          <SettingsPanel value={settings} onChange={onSettingsChange} />
        </div>
      )}
      {error ? (
        <div className="surface fh-center-empty" role="alert">
          Не удалось рассчитать напоминания из сохранённых платежей.
        </div>
      ) : (
        <div className="fh-center-grid">
          <section className="surface fh-center-payments" aria-label="Список к оплате">
            <div className="fh-center-heading">
              <h2>Напоминания</h2>
              <span
                className="fh-center-count"
                role="status"
                aria-label={`Актуальных напоминаний: ${reminders.length}`}
              >
                {reminders.length}
              </span>
            </div>
            {due.length ? (
              due.map((row) => (
                <PaymentRow
                  key={row.key}
                  payment={row}
                  methods={paymentMethods[row.recordId] ?? []}
                  rubles={rubles}
                  formatDate={formatDate}
                />
              ))
            ) : (
              <div className="fh-center-empty" role="status">
                <strong>Нет ближайших платежей</strong>
                Все обязательства оплачены или на ближайшие семь дней платежей нет.
              </div>
            )}
            {result && result.hiddenAlerts > 0 && (
              <p className="small-hint">
                Других предупреждений: {result.hiddenAlerts}. В списке показаны наиболее актуальные.
              </p>
            )}
          </section>
          <aside className="surface fh-center-summary">
            <h2>Осталось оплатить</h2>
            <strong className="fh-center-total">{rubles(total)}</strong>
            <p className="small-hint">
              Только неоплаченная часть подтверждённых обязательств из показанного списка. Открытие
              ссылки или QR не считается оплатой.
            </p>
          </aside>
        </div>
      )}
      {financeEnabled ? (
        <div className="fh-center-reserve-section">
          <ReserveAlerts
            actor={verifiedActorUserId ?? null}
            currentDate={currentDate}
            scopeKey={scopeKey}
            settings={settings}
            rubles={rubles}
            formatDate={formatDate}
          />
        </div>
      ) : null}
    </section>
  );
}
