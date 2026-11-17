import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from './Calendar';
import { formatRubMinor, isValidLedgerDate, parseRubMinor } from './accounts-view-model';
import {
  addReserveMonths,
  calculateReserve,
  type ReserveDefinition,
} from '../domain/reserves/index.ts';
import { previewReservePaymentImpact } from '../domain/reserves/payment-impact.ts';
import {
  confirmXlsxReservePreview,
  type XlsxReservePreview,
} from '../domain/reserves/xlsx-preview.ts';
import {
  ReservesFinanceError,
  ReservesFinanceGateway,
  type ReserveViewRow,
  type ReservesServerView,
} from './reserves-finance-gateway';
import type { ReserveV2Action } from '../domain/reserves/v2-wire.ts';
import './reserves.css';

export interface ConnectedReservesProps {
  readonly verifiedActorUserId: string | null;
  readonly currentDate: string;
  readonly focusReserveId?: string | null;
  readonly importSuggestions?: readonly XlsxReservePreview[];
}

type Status = 'loading' | 'ready' | 'locked' | 'offline' | 'conflict' | 'error';
type DialogKind = 'history' | 'fund' | 'release' | 'pay' | 'edit' | 'skip';
type DialogSelection = { kind: DialogKind; id: string } | null;

const description: Record<Status, string> = {
  loading: 'Загружаем подтверждённые накопления…',
  ready: '',
  locked: 'Войдите в аккаунт для доступа к серверным накоплениям.',
  offline: 'Финансовый сервер недоступен. Данные и платежи не подтверждены.',
  conflict: 'Данные изменились или операция ожидает проверки. Запись заблокирована.',
  error: 'Не удалось проверить целостность финансовых данных. Операции недоступны.',
};

function displayDate(value: string): string {
  if (!isValidLedgerDate(value)) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value + 'T12:00:00Z'));
}
function rubles(minor: number): string {
  return formatRubMinor(minor);
}
function percentage(reserved: number, target: number): number {
  return target > 0 ? Math.min(100, Math.max(0, Math.round((reserved / target) * 100))) : 0;
}
function modeLabel(mode: string): string {
  return mode === 'fixed' ? 'Фиксированный' : 'Автоматически';
}
function actionError(error: unknown): string {
  return error instanceof Error ? error.message : 'Операция не подтверждена';
}

function TrapDialog({
  title,
  onClose,
  children,
  busy,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>('button,select,input,textarea');
    first?.focus();
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  function onKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = [
      ...ref.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <div
      className="fh-reserve-modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="surface fh-reserve-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
        onKeyDown={onKeys}
      >
        <div className="fh-reserve-modal-head">
          <h2>{title}</h2>
          <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>
            Закрыть
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function ConnectedReserves({
  verifiedActorUserId,
  currentDate,
  focusReserveId,
  importSuggestions = [],
}: ConnectedReservesProps) {
  const gateway = useMemo(() => new ReservesFinanceGateway(), [verifiedActorUserId]);
  const [view, setView] = useState<ReservesServerView | null>(null);
  const [status, setStatus] = useState<Status>(verifiedActorUserId ? 'loading' : 'locked');
  const [blocked, setBlocked] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogSelection>(null);
  const [createMobile, setCreateMobile] = useState(false);
  const [importPreview, setImportPreview] = useState<XlsxReservePreview | null>(null);
  const [importConsent, setImportConsent] = useState(false);
  const createAside = useRef<HTMLElement>(null);
  const createOpener = useRef<HTMLButtonElement>(null);

  const [obligationId, setObligationId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [target, setTarget] = useState('');
  const [months, setMonths] = useState('12');
  const [firstDue, setFirstDue] = useState(addReserveMonths(currentDate, 12));
  const [contributionMode, setContributionMode] = useState<'auto' | 'fixed'>('auto');
  const [fixed, setFixed] = useState('');
  const [opening, setOpening] = useState('0');
  const [newTitle, setNewTitle] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newStartsOn, setNewStartsOn] = useState(addReserveMonths(currentDate, 1));
  const [newEvery, setNewEvery] = useState('12');
  const [newPlanConsent, setNewPlanConsent] = useState(false);

  const [amount, setAmount] = useState('');
  const [reservedUsed, setReservedUsed] = useState('');
  const [paymentDate, setPaymentDate] = useState(currentDate);
  const [skipOn, setSkipOn] = useState(currentDate);
  const [reason, setReason] = useState('Исправление ошибочного действия');
  const [editTitle, setEditTitle] = useState('');
  const [editTarget, setEditTarget] = useState('');
  const [editMonths, setEditMonths] = useState('12');
  const [editDue, setEditDue] = useState(currentDate);
  const [editMode, setEditMode] = useState<'auto' | 'fixed'>('auto');
  const [editFixed, setEditFixed] = useState('');

  const onFailure = useCallback((failure: unknown) => {
    const kind = failure instanceof ReservesFinanceError ? failure.kind : 'error';
    setStatus(kind);
    setBlocked(true);
    setView(null); // Never display a stale figure as an authoritative bank balance.
    setError(actionError(failure));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(verifiedActorUserId ? 'loading' : 'locked');
    setBlocked(true);
    setError(null);
    setFeedback(null);
    setView(null);
    if (verifiedActorUserId) {
      void gateway
        .open(verifiedActorUserId, currentDate, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setView(next);
          setStatus('ready');
          setBlocked(gateway.writeBlocked);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) onFailure(failure);
        });
    }
    return () => {
      controller.abort();
      gateway.invalidate();
    };
  }, [gateway, verifiedActorUserId, currentDate, onFailure]);

  const refresh = useCallback(() => {
    if (!verifiedActorUserId || inFlight.current) return;
    setError(null);
    setStatus('loading');
    void gateway
      .refresh(verifiedActorUserId, currentDate)
      .then((next) => {
        setView(next);
        setStatus('ready');
        setBlocked(gateway.writeBlocked); // A plain refresh never unlocks an uncertain debit.
      })
      .catch(onFailure);
  }, [gateway, verifiedActorUserId, currentDate, onFailure]);

  const write = useCallback(
    async (
      action: ReserveV2Action,
      payload: Record<string, unknown>,
      confirmation: string,
    ): Promise<boolean> => {
      if (inFlight.current || blocked || status !== 'ready') return false;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      setFeedback(null);
      try {
        const after = await gateway.execute(action, payload, currentDate);
        setView(after);
        setBlocked(gateway.writeBlocked);
        setStatus('ready');
        setFeedback(confirmation + '. Подтверждено сервером.');
        setDialog(null);
        setCreateMobile(false);
        return true;
      } catch (failure) {
        onFailure(failure);
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [gateway, blocked, status, currentDate, onFailure],
  );

  const obligations = view?.obligations.filter((obligation) => !obligation.archived) ?? [];
  const accounts = view?.accounts.filter((account) => !account.archived) ?? [];
  const visibleReserves = view?.reserves.filter((reserve) => !reserve.archived) ?? [];
  const archivedReserves = view?.reserves.filter((reserve) => reserve.archived) ?? [];
  const selected = view?.reserves.find((reserve) => reserve.id === dialog?.id) ?? null;
  const chosenAccount = accounts.find((account) => account.id === accountId) ?? accounts[0];
  const chosenObligation =
    obligations.find((obligation) => obligation.id === obligationId) ?? obligations[0];

  useEffect(() => {
    if (!view) return;
    const firstAccount = view.accounts.find((item) => !item.archived);
    const firstObligation = view.obligations.find((item) => !item.archived);
    setAccountId((previous) => previous || firstAccount?.id || '');
    setObligationId((previous) => previous || firstObligation?.id || '');
    setTarget(
      (previous) => previous || (firstObligation ? String(firstObligation.amountMinor / 100) : ''),
    );
  }, [view]);

  const creationForecast = useMemo(() => {
    try {
      const amountMinor = parseRubMinor(target);
      const openingMinor = parseRubMinor(opening);
      const fixedMinor = contributionMode === 'fixed' ? parseRubMinor(fixed) : undefined;
      const count = Number(months);
      if (
        amountMinor <= 0 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 60 ||
        firstDue < currentDate ||
        !isValidLedgerDate(firstDue)
      )
        return null;
      const definition: ReserveDefinition = {
        id: 'preview',
        title: 'Предварительный расчёт',
        openedOn: currentDate,
        firstDueDate: firstDue,
        periodMonths: count,
        targetCents: amountMinor,
        openingReservedCents: openingMinor,
        dueDay: Number(firstDue.slice(8)),
        contributionMode,
        ...(fixedMinor !== undefined ? { fixedMonthlyCents: fixedMinor } : {}),
      };
      return calculateReserve(definition, [], currentDate);
    } catch {
      return null;
    }
  }, [target, opening, contributionMode, fixed, months, firstDue, currentDate]);

  useEffect(() => {
    if (!view || !focusReserveId) return;
    if (view.reserves.some((reserve) => reserve.id === focusReserveId)) {
      setDialog({ kind: 'history', id: focusReserveId });
    }
  }, [focusReserveId, view?.revision]); // Focus once the target exists in the verified snapshot.

  useEffect(() => {
    if (!createMobile) return;
    createAside.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      createOpener.current?.focus();
    };
  }, [createMobile]);

  function openDialog(kind: DialogKind, reserve: ReserveViewRow) {
    setAmount('');
    setReservedUsed('');
    setPaymentDate(currentDate);
    setSkipOn(
      reserve.projection.schedule.filter((slot) => slot.date <= currentDate).at(-1)?.date ??
        currentDate,
    );
    setReason('Исправление ошибочного действия');
    if (kind === 'edit') {
      setEditTitle(reserve.source.definition.title);
      setEditTarget(String(reserve.projection.targetCents / 100));
      setEditMonths(String(reserve.source.definition.periodMonths));
      setEditDue(reserve.projection.dueDate);
      setEditMode(reserve.source.definition.contributionMode);
      setEditFixed(String((reserve.source.definition.fixedMonthlyCents ?? 0) / 100));
    }
    setDialog({ kind, id: reserve.id });
    setError(null);
  }

  async function onCreatePlanning(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      inFlight.current ||
      !view ||
      blocked ||
      !newPlanConsent ||
      !newTitle.trim() ||
      !isValidLedgerDate(newStartsOn)
    ) {
      setError('Нужно явно подтвердить создание серверного обязательства.');
      return;
    }
    const minor = parseRubMinor(newAmount);
    const every = Number(newEvery);
    if (
      minor <= 0 ||
      !Number.isSafeInteger(every) ||
      every < 1 ||
      every > 60 ||
      view.obligations.some(
        (item) =>
          !item.archived && item.title.trim().toLowerCase() === newTitle.trim().toLowerCase(),
      )
    ) {
      setError('Проверьте сумму, период и отсутствие существующего обязательства.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const created = await gateway.createPlanningObligation(
        {
          title: newTitle.trim(),
          amountMinor: minor,
          startsOn: newStartsOn,
          recurrenceUnit: 'month',
          recurrenceEvery: every,
          timezone,
        },
        currentDate,
      );
      setView(created.view);
      setBlocked(gateway.writeBlocked);
      setStatus('ready');
      setObligationId(created.obligationId);
      setTarget(newAmount);
      setMonths(newEvery);
      setFirstDue(newStartsOn);
      setFeedback('Серверное обязательство создано. Проверьте параметры резерва.');
      setNewPlanConsent(false);
    } catch (failure) {
      onFailure(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !chosenAccount || !chosenObligation || !creationForecast) {
      setError('Проверьте обязательство, счёт, дату и все суммы.');
      return;
    }
    const openingMinor = parseRubMinor(opening);
    if (
      openingMinor > chosenAccount.availableMinor ||
      view.reserves.some(
        (reserve) => reserve.obligationId === chosenObligation.id && !reserve.archived,
      )
    ) {
      setError('Недостаточно свободных средств либо резерв этого обязательства уже существует.');
      return;
    }
    let payload: Record<string, unknown> = {
      id: crypto.randomUUID(),
      account_id: chosenAccount.id,
      obligation_id: chosenObligation.id,
      title: chosenObligation.title,
      target_minor: creationForecast.targetCents,
      opened_on: currentDate,
      first_due_on: firstDue,
      period_months: Number(months),
      due_day: Number(firstDue.slice(8)),
      contribution_mode: contributionMode,
      opening_reserved_minor: openingMinor,
      ...(contributionMode === 'fixed' ? { fixed_monthly_minor: parseRubMinor(fixed) } : {}),
    };
    if (importPreview?.status === 'suggestion') {
      if (!importConsent || Number(months) !== importPreview.periodMonths) {
        setError('Подтвердите сохранение исходной записи и периодичность XLSX.');
        return;
      }
      const confirmed = confirmXlsxReservePreview(importPreview, {
        obligationId: chosenObligation.id,
        accountId: chosenAccount.id,
        reserveId: String(payload.id),
        openedOn: currentDate,
        firstDueOn: firstDue,
        dueDay: Number(firstDue.slice(8)),
        targetCents: creationForecast.targetCents,
        openingReservedCents: openingMinor,
        contributionMode,
        ...(contributionMode === 'fixed' ? { fixedMonthlyCents: parseRubMinor(fixed) } : {}),
        confirmed: true,
        sourceHandling: 'keep-original-unchanged',
      });
      payload = Object.fromEntries(
        Object.entries(confirmed.payload).filter(([, val]) => val !== null),
      );
    }
    const saved = await write('reserve.create', payload, 'Резерв создан');
    if (saved) {
      setImportPreview(null);
      setImportConsent(false);
    }
  }

  async function onEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !isValidLedgerDate(editDue)) return;
    const targetMinor = parseRubMinor(editTarget);
    const periods = Number(editMonths);
    if (
      targetMinor <= 0 ||
      !Number.isSafeInteger(periods) ||
      periods < 1 ||
      periods > 60 ||
      editDue < currentDate
    ) {
      setError('Проверьте сумму, период и ближайшую дату.');
      return;
    }
    await write(
      'reserve.update',
      {
        reserve_id: selected.id,
        title: editTitle.trim(),
        target_minor: targetMinor,
        first_due_on: editDue,
        due_day: Number(editDue.slice(8)),
        period_months: periods,
        contribution_mode: editMode,
        occurred_on: currentDate,
        ...(editMode === 'fixed' ? { fixed_monthly_minor: parseRubMinor(editFixed) } : {}),
      },
      'Параметры резерва обновлены',
    );
  }

  async function onAllocate(event: FormEvent<HTMLFormElement>, direction: 1 | -1) {
    event.preventDefault();
    if (!selected || !view) return;
    const input = parseRubMinor(amount);
    const account = view.accounts.find((item) => item.id === selected.accountId);
    if (
      !account ||
      input <= 0 ||
      (direction === 1 && input > account.availableMinor) ||
      (direction === -1 && input > selected.source.allocatedCents)
    ) {
      setError('Указанная сумма превышает доступные средства.');
      return;
    }
    await write(
      'reserve.allocate',
      {
        reserve_id: selected.id,
        account_id: selected.accountId,
        delta_minor: direction * input,
        occurred_on: currentDate,
      },
      direction === 1 ? 'Резерв пополнен' : 'Средства освобождены',
    );
  }

  const paymentImpact = useMemo(() => {
    if (dialog?.kind !== 'pay' || !selected || !view) return null;
    try {
      const account = view.accounts.find((item) => item.id === selected.accountId);
      if (!account) return null;
      const input = parseRubMinor(amount);
      const used = parseRubMinor(reservedUsed || '0');
      if (input <= 0 || input > selected.projection.remainingObligationCents) return null;
      return previewReservePaymentImpact({
        accountBalanceCents: account.balanceMinor,
        allocatedOnAccountCents: account.reservedMinor,
        reservedForObligationCents: selected.source.allocatedCents,
        paymentCents: input,
        reservedUsedCents: used,
      });
    } catch {
      return null;
    }
  }, [dialog, selected, view, amount, reservedUsed]);

  async function onPay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selected ||
      !paymentImpact ||
      !isValidLedgerDate(paymentDate) ||
      paymentDate > currentDate ||
      paymentImpact.unreservedShortfallCents > 0
    ) {
      setError('Проверьте сумму, дату и достаточность свободных средств.');
      return;
    }
    await write(
      'settlement.payment.record',
      {
        transaction_id: crypto.randomUUID(),
        fact_id: crypto.randomUUID(),
        account_id: selected.accountId,
        obligation_id: selected.obligationId,
        amount_minor: paymentImpact.expenseCents,
        paid_on: paymentDate,
        occurrence_on: selected.projection.dueDate,
        reserve_id: selected.id,
        reserved_used_minor: parseRubMinor(reservedUsed || '0'),
      },
      'Фактическая оплата проведена один раз',
    );
  }

  async function onSkip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selected ||
      !isValidLedgerDate(skipOn) ||
      skipOn > currentDate ||
      !selected.projection.schedule.some((item) => item.date === skipOn)
    ) {
      setError('Выберите прошедшую запланированную дату взноса.');
      return;
    }
    await write(
      'reserve.skip',
      {
        reserve_id: selected.id,
        slot_on: skipOn,
        occurred_on: currentDate,
      },
      'Пропуск взноса зафиксирован',
    );
  }

  async function archive(reserve: ReserveViewRow) {
    if (!window.confirm('Архивировать резерв и сохранить его историю?')) return;
    await write('reserve.archive', { reserve_id: reserve.id }, 'Резерв архивирован');
  }
  async function closeCycle(reserve: ReserveViewRow) {
    if (!window.confirm('Закрыть оплаченный цикл и перенести остаток в следующий?')) return;
    await write(
      'reserve.cycle.close',
      {
        reserve_id: reserve.id,
        occurred_on: currentDate,
      },
      'Цикл закрыт',
    );
  }
  async function reopenCycle(reserve: ReserveViewRow) {
    if (!window.confirm('Отменить последнее закрытие цикла?')) return;
    await write(
      'reserve.cycle.void',
      {
        reserve_id: reserve.id,
        occurred_on: currentDate,
        reason,
      },
      'Последний цикл восстановлен',
    );
  }
  async function voidEvent(reserve: ReserveViewRow, eventId: string) {
    const event = reserve.history.find((entry) => entry.id === eventId && !entry.voided);
    if (!event || !window.confirm('Отменить выбранное финансовое действие?')) return;
    if (event.kind === 'payment') {
      if (!event.transactionId || !event.settlementId) {
        setError('Нельзя подтвердить связь оплаты с банковской проводкой.');
        return;
      }
      await write(
        'settlement.payment.void',
        {
          transaction_id: event.transactionId,
          fact_id: event.settlementId,
          account_id: reserve.accountId,
          reserve_id: reserve.id,
          reason,
        },
        'Оплата отменена вместе с банковской проводкой',
      );
    } else {
      await write(
        'reserve.event.void',
        {
          reserve_id: reserve.id,
          account_id: reserve.accountId,
          target_event_id: event.id,
          occurred_on: currentDate,
          reason,
        },
        'Движение резерва отменено',
      );
    }
  }

  function onCreateKeys(event: KeyboardEvent<HTMLElement>) {
    if (!createMobile) return;
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation();
      setCreateMobile(false);
      return;
    }
    if (event.key !== 'Tab' || !createAside.current) return;
    const focusable = [
      ...createAside.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled])',
      ),
    ];
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
    } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  }

  if (status !== 'ready' || !view) {
    return (
      <section className="surface fh-reserve-empty" aria-live="polite">
        <Icon name={status === 'loading' ? 'database' : 'lock'} />
        <h2>{status === 'loading' ? 'Накопления' : 'Накопления недоступны'}</h2>
        <p>{description[status]}</p>
        {error ? <p role="alert">{error}</p> : null}
        {verifiedActorUserId && status !== 'locked' ? (
          <button type="button" className="button-secondary" onClick={refresh}>
            Обновить данные
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="fh-reserves" aria-label="Накопления к обязательствам">
      <div className="fh-reserve-layout">
        <div className="fh-reserve-main">
          <div className="fh-reserve-topline">
            <div className="fh-reserve-statline">
              <div className="surface fh-reserve-stat">
                <span>
                  <Icon name="credit" /> На счетах
                </span>
                <strong>{rubles(view.totalMinor)}</strong>
              </div>
              <div className="surface fh-reserve-stat">
                <span>
                  <Icon name="database" /> Зарезервировано
                </span>
                <strong>{rubles(view.reservedMinor)}</strong>
              </div>
              <div className="surface fh-reserve-stat">
                <span>
                  <Icon name="check" /> Доступно
                </span>
                <strong>{rubles(view.availableMinor)}</strong>
              </div>
            </div>
          </div>
          {importSuggestions.some((hint) => hint.status === 'suggestion') ? (
            <div className="surface fh-reserve-import-hints">
              <h3>Предложения из последнего XLSX</h3>
              <p className="small-hint">
                Исходные расходы остаются без изменений. Создание накопления требует отдельного
                подтверждения.
              </p>
              {importSuggestions
                .filter((hint) => hint.status === 'suggestion')
                .map((hint) => (
                  <button
                    key={hint.source}
                    type="button"
                    className="button-secondary"
                    disabled={blocked || busy}
                    onClick={() => {
                      if (hint.status !== 'suggestion') return;
                      setImportPreview(hint);
                      setImportConsent(false);
                      setTarget(String(hint.importedAmountCents / 100));
                      setMonths(String(hint.periodMonths));
                      setFirstDue(addReserveMonths(currentDate, hint.periodMonths));
                      setOpening('0');
                      if (window.matchMedia('(max-width:760px)').matches) setCreateMobile(true);
                      else createAside.current?.querySelector<HTMLElement>('select')?.focus();
                    }}
                  >
                    {hint.title} · раз в {hint.periodMonths} мес. · Подтвердить
                  </button>
                ))}
            </div>
          ) : null}
          <button
            ref={createOpener}
            type="button"
            className="button-primary fh-reserve-mobile-create"
            disabled={blocked || busy || !obligations.length || !accounts.length}
            onClick={() => setCreateMobile(true)}
          >
            <Icon name="plus" /> Создать резерв
          </button>
          <div className="fh-reserve-list-head">
            <h2>Резервы к обязательствам</h2>
            <button type="button" className="button-text" onClick={refresh} disabled={busy}>
              Обновить
            </button>
          </div>
          {blocked ? (
            <p className="fh-reserve-warning" role="alert">
              Операции заблокированы до проверки предыдущего действия.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="fh-reserve-error">
              {error}
            </p>
          ) : null}
          {feedback ? (
            <p role="status" className="fh-reserve-success">
              {feedback}
            </p>
          ) : null}
          <div className="fh-reserve-list">
            {visibleReserves.length ? (
              visibleReserves.map((reserve) => {
                const p = reserve.projection;
                const done = p.fundingGapCents <= 0;
                return (
                  <article key={reserve.id} className="surface fh-reserve-card">
                    <div className="fh-reserve-card-head">
                      <div className="fh-reserve-card-title">
                        <span className="fh-reserve-card-icon">
                          <Icon name="credit" />
                        </span>
                        <div>
                          <h3>{reserve.source.definition.title}</h3>
                          <p>
                            Цель: {rubles(p.targetCents)} · Срок: {displayDate(p.dueDate)}
                          </p>
                        </div>
                      </div>
                      <span className="fh-reserve-pill">
                        {done ? 'Накоплено' : 'Осталось: ' + rubles(p.fundingGapCents)}
                      </span>
                    </div>
                    <div
                      className="fh-reserve-track"
                      role="progressbar"
                      aria-label={'Накоплено на ' + reserve.source.definition.title}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percentage(p.reservedCents, p.targetCents)}
                    >
                      <span style={{ width: percentage(p.reservedCents, p.targetCents) + '%' }} />
                    </div>
                    <div className="fh-reserve-progress-label">
                      <span>
                        {rubles(p.reservedCents)} из {rubles(p.targetCents)}
                      </span>
                      <strong>{percentage(p.reservedCents, p.targetCents)} %</strong>
                    </div>
                    <div className="fh-reserve-secondary">
                      <span>
                        {p.overdue ? 'Срок оплаты прошёл' : 'До оплаты: ' + p.daysUntilDue + ' дн.'}
                      </span>
                      <span>
                        {modeLabel(p.contributionMode)}:{' '}
                        {p.nextContribution
                          ? rubles(p.nextContribution.amountCents)
                          : 'новый взнос не требуется'}
                      </span>
                      {p.projectedShortfallCents > 0 ? (
                        <span className="fh-reserve-error">
                          Прогноз дефицита: {rubles(p.projectedShortfallCents)}
                        </span>
                      ) : null}
                    </div>
                    <div className="fh-reserve-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={blocked || busy}
                        onClick={() => openDialog('fund', reserve)}
                      >
                        <Icon name="plus" /> Пополнить
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={blocked || busy || p.remainingObligationCents <= 0}
                        onClick={() => openDialog('pay', reserve)}
                      >
                        <Icon name="check" /> Отметить оплату
                      </button>
                      <button
                        type="button"
                        className="button-text"
                        onClick={() => openDialog('history', reserve)}
                      >
                        Подробнее
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="surface fh-reserve-no-items">
                <h3>Пока нет накоплений</h3>
                <p>Создайте резерв для существующего обязательства и выберите счёт.</p>
              </div>
            )}
          </div>
          {archivedReserves.length ? (
            <details className="fh-reserve-archive">
              <summary>Архивированные резервы ({archivedReserves.length})</summary>
              {archivedReserves.map((reserve) => (
                <button
                  className="button-text"
                  key={reserve.id}
                  type="button"
                  onClick={() => openDialog('history', reserve)}
                >
                  {reserve.source.definition.title} · {displayDate(reserve.projection.dueDate)}
                </button>
              ))}
            </details>
          ) : null}
        </div>
        {createMobile ? <div className="fh-reserve-create-backdrop" aria-hidden="true" /> : null}
        <aside
          className={'surface fh-reserve-editor' + (createMobile ? ' opened' : '')}
          ref={createAside}
          role={createMobile ? 'dialog' : undefined}
          aria-label={createMobile ? 'Новый резерв' : undefined}
          aria-modal={createMobile ? true : undefined}
          onKeyDown={onCreateKeys}
        >
          <div className="fh-reserve-editor-heading">
            <h2>Новый резерв</h2>
            <button
              type="button"
              className="button-text fh-reserve-create-close"
              onClick={() => setCreateMobile(false)}
            >
              Закрыть
            </button>
          </div>
          <details className="fh-reserve-plan-create">
            <summary>Нет нужного обязательства? Добавить на сервер</summary>
            <p className="small-hint">
              Это плановая запись на финансовом сервере, не списание денег. Существующая локальная
              запись останется без изменений.
            </p>
            <form
              className="fh-reserve-form"
              onSubmit={(event) => {
                void onCreatePlanning(event).catch((failure) => setError(actionError(failure)));
              }}
            >
              <label>
                Название обязательства
                <input
                  required
                  maxLength={160}
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                />
              </label>
              <label>
                Сумма обязательства, ₽
                <input
                  required
                  inputMode="decimal"
                  value={newAmount}
                  onChange={(event) => setNewAmount(event.target.value)}
                />
              </label>
              <label>
                Ближайшая дата оплаты
                <input
                  type="date"
                  required
                  min={currentDate}
                  value={newStartsOn}
                  onChange={(event) => setNewStartsOn(event.target.value)}
                />
              </label>
              <label>
                Повторять раз в N месяцев
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  required
                  value={newEvery}
                  onChange={(event) => setNewEvery(event.target.value)}
                />
              </label>
              <label className="fh-reserve-plan-consent">
                <input
                  type="checkbox"
                  checked={newPlanConsent}
                  onChange={(event) => setNewPlanConsent(event.target.checked)}
                />
                <span>
                  Подтверждаю создание отдельного серверного обязательства. Локальные платежи не
                  изменяются.
                </span>
              </label>
              <button
                className="button-secondary"
                type="submit"
                disabled={busy || blocked || !newPlanConsent}
              >
                Создать обязательство
              </button>
            </form>
          </details>
          {importPreview?.status === 'suggestion' ? (
            <div className="fh-reserve-import-choice" role="status">
              <strong>Из XLSX: {importPreview.title}</strong>
              <span>
                Период: каждые {importPreview.periodMonths} мес. Выберите соответствующее серверное
                обязательство и подтвердите сумму.
              </span>
              <label className="fh-reserve-plan-consent">
                <input
                  type="checkbox"
                  checked={importConsent}
                  onChange={(event) => setImportConsent(event.target.checked)}
                />
                <span>
                  Подтверждаю: исходный импортированный расход оставить без изменений. Накопление
                  будет отдельной записью, без повторного расхода.
                </span>
              </label>
              <button
                type="button"
                className="button-text"
                onClick={() => {
                  setImportPreview(null);
                  setImportConsent(false);
                }}
              >
                Отменить предложение XLSX
              </button>
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              void onCreate(event).catch((failure) => setError(actionError(failure)));
            }}
            className="fh-reserve-form"
          >
            <label>
              Обязательство
              <select
                required
                value={obligationId || chosenObligation?.id || ''}
                onChange={(event) => {
                  const id = event.target.value;
                  setObligationId(id);
                  const found = obligations.find((obligation) => obligation.id === id);
                  if (found) setTarget(String(found.amountMinor / 100));
                }}
              >
                <option value="" disabled>
                  Выберите обязательство
                </option>
                {obligations.map((obligation) => (
                  <option key={obligation.id} value={obligation.id}>
                    {obligation.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Счёт
              <select
                required
                value={accountId || chosenAccount?.id || ''}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="" disabled>
                  Выберите счёт
                </option>
                {accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сумма цели, ₽
              <input
                required
                inputMode="decimal"
                value={target}
                placeholder="Например, 9000"
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            <label>
              Периодичность
              <select
                disabled={importPreview?.status === 'suggestion'}
                value={months}
                onChange={(event) => {
                  setMonths(event.target.value);
                  setFirstDue(addReserveMonths(currentDate, Number(event.target.value)));
                }}
              >
                {[1, 2, 3, 6, 12, 24, 36, 60].map((count) => (
                  <option value={count} key={count}>
                    Раз в {count} мес.
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ближайшая дата
              <input
                required
                type="date"
                min={currentDate}
                value={firstDue}
                onChange={(event) => setFirstDue(event.target.value)}
              />
            </label>
            <fieldset>
              <legend>Ежемесячный взнос</legend>
              <label className="fh-reserve-radio">
                <input
                  type="radio"
                  name="reserve-contribution"
                  checked={contributionMode === 'auto'}
                  onChange={() => setContributionMode('auto')}
                />
                <span>
                  Автоматически <small>Рассчитывать по сумме и сроку</small>
                </span>
              </label>
              <label className="fh-reserve-radio">
                <input
                  type="radio"
                  name="reserve-contribution"
                  checked={contributionMode === 'fixed'}
                  onChange={() => setContributionMode('fixed')}
                />
                <span>
                  Фиксированный <small>Задать собственную сумму</small>
                </span>
              </label>
            </fieldset>
            {contributionMode === 'fixed' ? (
              <label>
                Фиксированный взнос, ₽
                <input
                  required
                  inputMode="decimal"
                  value={fixed}
                  onChange={(event) => setFixed(event.target.value)}
                />
              </label>
            ) : null}
            <label>
              Уже накоплено, ₽
              <input
                required
                inputMode="decimal"
                value={opening}
                onChange={(event) => setOpening(event.target.value)}
              />
            </label>
            {creationForecast ? (
              <div className="fh-reserve-form-preview">
                <span>
                  Следующий взнос:{' '}
                  {creationForecast.nextContribution
                    ? rubles(creationForecast.nextContribution.amountCents)
                    : 'не требуется'}
                </span>
                {creationForecast.projectedShortfallCents > 0 ? (
                  <strong>Дефицит: {rubles(creationForecast.projectedShortfallCents)}</strong>
                ) : null}
              </div>
            ) : null}
            {accounts.length === 0 || obligations.length === 0 ? (
              <p className="small-hint">
                Для создания необходимы серверный счёт и обязательство. Локальные записи не
                подменяют серверные.
              </p>
            ) : null}
            <button
              type="submit"
              className="button-primary"
              disabled={
                blocked ||
                busy ||
                !creationForecast ||
                !accounts.length ||
                !obligations.length ||
                (importPreview?.status === 'suggestion' && !importConsent)
              }
            >
              Создать
            </button>
          </form>
          {error ? (
            <p className="fh-reserve-error" role="alert">
              {error}
            </p>
          ) : null}
        </aside>
      </div>
      {dialog && selected ? (
        <TrapDialog
          title={
            dialog.kind === 'history'
              ? selected.source.definition.title
              : {
                  fund: 'Пополнить резерв',
                  release: 'Освободить средства',
                  pay: 'Отметить фактическую оплату',
                  edit: 'Изменить резерв',
                  skip: 'Пропустить взнос',
                }[dialog.kind]
          }
          busy={busy}
          onClose={() => setDialog(null)}
        >
          {dialog.kind === 'history' ? (
            <>
              <div className="fh-reserve-history-summary">
                <p>
                  Счёт: {view.accounts.find((account) => account.id === selected.accountId)?.name}
                </p>
                <p>
                  Цикл № {selected.source.cycleNumber} · {displayDate(selected.projection.dueDate)}
                </p>
                <p>Остаток обязательства: {rubles(selected.projection.remainingObligationCents)}</p>
              </div>
              <div className="fh-reserve-detail-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || blocked}
                  onClick={() => openDialog('edit', selected)}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || blocked || selected.source.allocatedCents === 0}
                  onClick={() => openDialog('release', selected)}
                >
                  Освободить
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || blocked}
                  onClick={() => openDialog('skip', selected)}
                >
                  Пропуск взноса
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || blocked || !selected.projection.cyclePaid}
                  onClick={() => {
                    void closeCycle(selected);
                  }}
                >
                  Закрыть цикл
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={
                    busy ||
                    blocked ||
                    !selected.history.some((item) => item.kind === 'cycle_close' && !item.voided)
                  }
                  onClick={() => {
                    void reopenCycle(selected);
                  }}
                >
                  Вернуть цикл
                </button>
                <button
                  type="button"
                  className="button-text"
                  disabled={
                    busy || blocked || selected.source.allocatedCents !== 0 || selected.archived
                  }
                  onClick={() => {
                    void archive(selected);
                  }}
                >
                  Архивировать
                </button>
              </div>
              <label className="fh-reserve-reason">
                Причина отмены
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                  required
                />
              </label>
              <h3>История операций</h3>
              <div className="fh-reserve-history-list">
                {selected.history.length ? (
                  selected.history.map((item) => (
                    <div className="fh-reserve-history-entry" key={item.id}>
                      <div>
                        <strong>
                          {(
                            {
                              contribution: 'Пополнение',
                              release: 'Освобождение',
                              skip: 'Пропуск',
                              payment: 'Оплата',
                              target_change: 'Изменение цели',
                              cycle_close: 'Закрытие цикла',
                              void: 'Отмена',
                            } as Record<string, string>
                          )[item.kind] ?? item.kind}
                        </strong>
                        <small>
                          {displayDate(item.date)}
                          {item.amountMinor !== null ? ' · ' + rubles(item.amountMinor) : ''}
                        </small>
                        {item.voided ? <small>Отменено</small> : null}
                      </div>
                      {!selected.archived &&
                      !item.voided &&
                      ['contribution', 'release', 'skip', 'payment'].includes(item.kind) ? (
                        <button
                          type="button"
                          className="button-text"
                          disabled={
                            busy ||
                            blocked ||
                            !reason.trim() ||
                            (item.kind === 'payment' && (!item.transactionId || !item.settlementId))
                          }
                          onClick={() => {
                            void voidEvent(selected, item.id);
                          }}
                        >
                          Отменить
                        </button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p>Движений пока нет.</p>
                )}
              </div>
            </>
          ) : dialog.kind === 'edit' ? (
            <form
              className="fh-reserve-form"
              onSubmit={(event) => {
                void onEdit(event).catch((failure) => setError(actionError(failure)));
              }}
            >
              <label>
                Название
                <input
                  required
                  maxLength={160}
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                />
              </label>
              <label>
                Цель, ₽
                <input
                  required
                  inputMode="decimal"
                  value={editTarget}
                  onChange={(event) => setEditTarget(event.target.value)}
                />
              </label>
              <label>
                Период, месяцев
                <input
                  required
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={editMonths}
                  onChange={(event) => setEditMonths(event.target.value)}
                />
              </label>
              <label>
                Следующая дата оплаты
                <input
                  type="date"
                  required
                  value={editDue}
                  onChange={(event) => setEditDue(event.target.value)}
                />
              </label>
              <label>
                Способ взноса
                <select
                  value={editMode}
                  onChange={(event) => setEditMode(event.target.value as 'auto' | 'fixed')}
                >
                  <option value="auto">Автоматически</option>
                  <option value="fixed">Фиксированный</option>
                </select>
              </label>
              {editMode === 'fixed' ? (
                <label>
                  Взнос, ₽
                  <input
                    required
                    value={editFixed}
                    inputMode="decimal"
                    onChange={(event) => setEditFixed(event.target.value)}
                  />
                </label>
              ) : null}
              <button type="submit" className="button-primary" disabled={busy || blocked}>
                Сохранить
              </button>
            </form>
          ) : dialog.kind === 'skip' ? (
            <form
              className="fh-reserve-form"
              onSubmit={(event) => {
                void onSkip(event).catch((failure) => setError(actionError(failure)));
              }}
            >
              <label>
                Дата пропущенного взноса
                <input
                  type="date"
                  required
                  max={currentDate}
                  value={skipOn}
                  onChange={(event) => setSkipOn(event.target.value)}
                />
              </label>
              <button type="submit" className="button-primary" disabled={busy || blocked}>
                Зафиксировать пропуск
              </button>
            </form>
          ) : dialog.kind === 'pay' ? (
            <form
              className="fh-reserve-form"
              onSubmit={(event) => {
                void onPay(event).catch((failure) => setError(actionError(failure)));
              }}
            >
              <p className="small-hint">
                Оплата списывает деньги со счёта один раз. Использование резерва только уменьшает
                выделенную сумму.
              </p>
              <label>
                Счёт оплаты
                <select value={selected.accountId} disabled>
                  <option value={selected.accountId}>
                    {view.accounts.find((account) => account.id === selected.accountId)?.name}
                  </option>
                </select>
              </label>
              <label>
                Фактически оплачено, ₽
                <input
                  required
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <label>
                Из резерва, ₽
                <input
                  required
                  inputMode="decimal"
                  value={reservedUsed}
                  onChange={(event) => setReservedUsed(event.target.value)}
                />
              </label>
              <label>
                Дата оплаты
                <input
                  required
                  type="date"
                  max={currentDate}
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
              </label>
              {paymentImpact ? (
                <div className="fh-reserve-payment-preview" aria-live="polite">
                  <p>
                    Баланс счёта после оплаты
                    <strong>{rubles(paymentImpact.accountBalanceAfterCents)}</strong>
                  </p>
                  <p>
                    Зарезервировано после
                    <strong>{rubles(paymentImpact.allocatedAfterCents)}</strong>
                  </p>
                  <p>
                    Свободно после оплаты
                    <strong>{rubles(paymentImpact.unreservedAfterCents)}</strong>
                  </p>
                  <p>
                    Остаток обязательства
                    <strong>
                      {rubles(
                        Math.max(
                          0,
                          selected.projection.remainingObligationCents - paymentImpact.expenseCents,
                        ),
                      )}
                    </strong>
                  </p>
                  {paymentImpact.unreservedShortfallCents > 0 ? (
                    <p className="fh-reserve-error">
                      Недостаточно свободных средств:{' '}
                      {rubles(paymentImpact.unreservedShortfallCents)}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="small-hint">Введите сумму и используемую часть резерва.</p>
              )}
              <button
                type="submit"
                className="button-primary"
                disabled={
                  busy || blocked || !paymentImpact || paymentImpact.unreservedShortfallCents > 0
                }
              >
                Подтвердить фактическую оплату
              </button>
            </form>
          ) : (
            <form
              className="fh-reserve-form"
              onSubmit={(event) => {
                void onAllocate(event, dialog.kind === 'fund' ? 1 : -1).catch((failure) =>
                  setError(actionError(failure)),
                );
              }}
            >
              <p className="small-hint">
                {dialog.kind === 'fund'
                  ? 'Резервирование не уменьшает банковский остаток.'
                  : 'Освобождение возвращает деньги в доступный остаток без новой проводки.'}
              </p>
              <label>
                Сумма, ₽
                <input
                  required
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <p>Зарезервировано: {rubles(selected.source.allocatedCents)}</p>
              <button type="submit" className="button-primary" disabled={busy || blocked}>
                {dialog.kind === 'fund' ? 'Пополнить' : 'Освободить'}
              </button>
            </form>
          )}
          {error ? (
            <p className="fh-reserve-error" role="alert">
              {error}
            </p>
          ) : null}
        </TrapDialog>
      ) : null}
    </section>
  );
}
