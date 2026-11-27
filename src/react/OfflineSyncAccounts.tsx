import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Accounts,
  type AccountCreation,
  type AccountModification,
  type AccountArchive,
  type AccountTransfer,
} from './Accounts';
import {
  decodeCompleteFinanceState,
  type AccountServerView,
} from '../domain/accounts/server-snapshot.ts';
import { formatRubMinor, isValidLedgerDate, parseRubMinor } from './accounts-view-model';
import { FinanceSyncController } from '../cloud/finance-sync-controller.mjs';
import './offline-sync.css';
import { Budgets } from './Budgets';
import { GoalWorkspace } from './goals/GoalWorkspace';

type Command = {
  schema_version: number;
  client_mutation_id: string;
  base_revision: number;
  action: string;
  expected_entity_revisions: Record<string, number>;
  payload: Record<string, unknown>;
};
type QueueItem = { mutationId: string; command: Command };
type Conflict = { kind: string; mutationId: string; httpStatus: number; decision: string };
type TransactionData = {
  kind?: string;
  occurred_on?: string;
  reversed_transaction_id?: string | null;
  postings?: Array<{ account_id: string; signed_minor: number }>;
  payment_link?: { settlement_id?: string | null; loan_payment_id?: string | null };
  reserve_allocation?: { reserve_id?: string };
};
type SyncState = {
  status: string;
  cloud: {
    profileId: string;
    revision: number;
    entities: Array<{ id: string; entity_revision: number; kind: string; data: unknown }>;
  };
  outbox: QueueItem[];
  conflicts: Conflict[];
  bundleEpoch: number;
  canCancel: boolean;
  canBudget?: boolean;
  canGoal?: boolean;
  onlineVerified: boolean;
};
const isSyncBusy = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === 'SYNC_BUSY';
const isSyncNetwork = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === 'SYNC_NETWORK';

function operationLabel(command: Command, state: SyncState): string {
  const p = command.payload;
  const accountName = (id: unknown) => {
    const entity = state.cloud.entities.find((x) => x.kind === 'account' && x.id === id);
    const data = entity?.data as { name?: unknown } | undefined;
    return typeof data?.name === 'string' ? data.name : 'счёт недоступен';
  };
  const amount = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? formatRubMinor(value)
      : 'сумма недоступна';
  switch (command.action) {
    case 'goal.append':
      return 'Изменение финансовой цели: ' + accountName(p.account_id);
    case 'budget.create':
      return 'Создать лимит: ' + amount(p.limit_minor);
    case 'budget.amend':
      return 'Изменить лимит: ' + amount(p.limit_minor);
    case 'budget.archive':
      return 'Архивировать лимит';
    case 'budget.category.create':
      return 'Создать категорию: ' + String(p.name);
    case 'budget.category.rename':
      return 'Переименовать категорию: ' + String(p.name);
    case 'budget.category.archive':
      return 'Архивировать категорию';
    case 'budget.category.assign':
      return 'Изменить категорию расхода';
    case 'reserve.create':
      return `Создать резерв «${String(p.title)}» на ${amount(p.target_minor)}, начальное распределение ${amount(p.opening_reserved_minor)}`;
    case 'reserve.update':
      return `Изменить резерв «${String(p.title)}»: цель ${amount(p.target_minor)}`;
    case 'reserve.skip':
      return `Отметить пропущенный взнос за ${String(p.slot_on)}`;
    case 'reserve.event.void':
      return `Отменить событие резерва: ${String(p.reason)}`;
    case 'reserve.cycle.close':
      return `Завершить цикл резерва от ${String(p.occurred_on)}`;
    case 'reserve.cycle.void':
      return `Отменить закрытие цикла: ${String(p.reason)}`;
    case 'reserve.allocate': {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === p.reserve_id,
      );
      const title = (reserve?.data as { title?: unknown } | undefined)?.title;
      const delta = Number(p.delta_minor);
      return `${delta > 0 ? 'Пополнить' : 'Освободить'} резерв «${typeof title === 'string' ? title : 'резерв'}» на ${amount(Math.abs(delta))}`;
    }
    case 'reserve.archive': {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === p.reserve_id,
      );
      const title = (reserve?.data as { title?: unknown } | undefined)?.title;
      return `Архивировать резерв «${typeof title === 'string' ? title : 'резерв'}»`;
    }
    case 'obligation.create':
      return `Создать обязательство «${String(p.title)}» на ${amount(p.amount_minor)}`;
    case 'account.create':
      return `Создать счёт «${String(p.name)}», начальный остаток ${amount(p.opening_minor)}`;
    case 'account.update':
      return `Изменить счёт «${accountName(p.account_id)}»: ${String(p.name)}`;
    case 'account.archive':
      return `Архивировать счёт «${accountName(p.account_id)}»`;
    case 'account.unarchive':
      return `Восстановить счёт «${accountName(p.account_id)}»`;
    case 'account.transfer':
      return `Перевести ${amount(p.amount_minor)}: «${accountName(p.from_account_id)}» → «${accountName(p.to_account_id)}»`;
    case 'transaction.record':
      return `${p.kind === 'income' ? 'Доход' : 'Расход'} ${amount(Math.abs(Number(p.signed_minor)))}: «${accountName(p.account_id)}»`;
    case 'transaction.reverse': {
      const original = state.cloud.entities.find(
        (x) => x.kind === 'transaction' && x.id === p.transaction_id,
      );
      const date = (original?.data as TransactionData | undefined)?.occurred_on;
      return `Отменить операцию${date ? ` от ${date}` : ''}: ${String(p.reason)}`;
    }
    case 'settlement.payment.record': {
      const obligation = state.cloud.entities.find(
        (x) => x.kind === 'obligation' && x.id === p.obligation_id,
      );
      const title = (obligation?.data as { title?: unknown } | undefined)?.title;
      return `Оплата «${typeof title === 'string' ? title : 'обязательство'}» на ${amount(p.amount_minor)}`;
    }
    case 'settlement.payment.void':
      return `Отмена оплаты: ${String(p.reason)}`;
    case 'loan.payment.record': {
      const loan = state.cloud.entities.find((x) => x.kind === 'loan' && x.id === p.loan_id);
      const title = (loan?.data as { title?: unknown } | undefined)?.title;
      return `Платёж по кредиту «${typeof title === 'string' ? title : 'кредит'}» на ${amount(p.amount_minor)}`;
    }
    case 'loan.payment.void':
      return `Отмена платежа по кредиту: ${String(p.reason)}`;
    default:
      return 'Операция ожидает проверки';
  }
}

export function OfflineSyncAccounts({
  actor,
  onBack,
  offlineOnly = false,
  onSessionRevoked,
  budgetMode: initialBudgetMode = false,
  allowOfflineBudgets = false,
  goalMode: initialGoalMode = false,
  allowOfflineGoals = false,
}: {
  actor: string;
  onBack: () => void;
  offlineOnly?: boolean;
  onSessionRevoked?: () => void;
  budgetMode?: boolean;
  allowOfflineBudgets?: boolean;
  goalMode?: boolean;
  allowOfflineGoals?: boolean;
}) {
  const controller = useRef<FinanceSyncController | null>(null);
  const mounted = useRef(true);
  const [password, setPassword] = useState('');
  const [credentialKind, setCredentialKind] = useState<'passphrase' | 'recoveryKey'>('passphrase');
  const [recovery, setRecovery] = useState('');
  const [savedRecovery, setSavedRecovery] = useState(false);
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('');
  const [replacementRecovery, setReplacementRecovery] = useState('');
  const [confirmRecoveryChange, setConfirmRecoveryChange] = useState(false);
  const [state, setState] = useState<SyncState | null>(null);
  const [localBudgetMode, setLocalBudgetMode] = useState(false);
  const [localGoalMode, setLocalGoalMode] = useState(false);
  const goalMode = initialGoalMode || (offlineOnly && allowOfflineGoals && localGoalMode);
  const budgetMode =
    !goalMode && (initialBudgetMode || (offlineOnly && allowOfflineBudgets && localBudgetMode));
  const [view, setView] = useState<AccountServerView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Для доступа нужна отдельная парольная фраза.');
  const [online, setOnline] = useState(navigator.onLine);
  const [needsVerification, setNeedsVerification] = useState(offlineOnly);
  const [autoPaused, setAutoPaused] = useState(false);
  const [cashAccount, setCashAccount] = useState('');
  const [cashKind, setCashKind] = useState<'income' | 'expense'>('expense');
  const [cashAmount, setCashAmount] = useState('');
  const [cashDate, setCashDate] = useState('');
  const [cashNote, setCashNote] = useState('');
  const [reverseId, setReverseId] = useState('');
  const [reverseReason, setReverseReason] = useState('');
  const [paymentObligation, setPaymentObligation] = useState('');
  const [paymentAccount, setPaymentAccount] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [paymentOccurrence, setPaymentOccurrence] = useState('');
  const [paymentReserve, setPaymentReserve] = useState('');
  const [paymentReservedUsed, setPaymentReservedUsed] = useState('0');
  const [loanId, setLoanId] = useState('');
  const [loanAccount, setLoanAccount] = useState('');
  const [loanAmount, setLoanAmount] = useState('');
  const [loanDate, setLoanDate] = useState('');
  const [loanStrategy, setLoanStrategy] = useState<'term' | 'amount'>('term');
  const [obligationTitle, setObligationTitle] = useState('');
  const [obligationDirection, setObligationDirection] = useState<'expense' | 'income'>('expense');
  const [obligationAmount, setObligationAmount] = useState('');
  const [obligationDate, setObligationDate] = useState('');
  const [obligationRecurrence, setObligationRecurrence] = useState<'none' | 'month' | 'year'>(
    'none',
  );
  const [allocationReserve, setAllocationReserve] = useState('');
  const [allocationAmount, setAllocationAmount] = useState('');
  const [allocationDate, setAllocationDate] = useState('');
  const [allocationKind, setAllocationKind] = useState<'contribution' | 'release'>('contribution');
  const [reserveTitle, setReserveTitle] = useState('');
  const [reserveObligation, setReserveObligation] = useState('');
  const [reserveAccount, setReserveAccount] = useState('');
  const [reserveTarget, setReserveTarget] = useState('');
  const [reserveOpened, setReserveOpened] = useState('');
  const [reserveDue, setReserveDue] = useState('');
  const [reservePeriod, setReservePeriod] = useState('1');
  const [reserveDay, setReserveDay] = useState('');
  const [reserveMode, setReserveMode] = useState<'auto' | 'fixed'>('auto');
  const [reserveFixed, setReserveFixed] = useState('');
  const [reserveOpening, setReserveOpening] = useState('0');
  const [editReserveId, setEditReserveId] = useState('');
  const [editReserveTitle, setEditReserveTitle] = useState('');
  const [editReserveTarget, setEditReserveTarget] = useState('');
  const [editReserveDate, setEditReserveDate] = useState('');
  const [editReserveDue, setEditReserveDue] = useState('');
  const [editReservePeriod, setEditReservePeriod] = useState('');
  const [editReserveDay, setEditReserveDay] = useState('');
  const [editReserveMode, setEditReserveMode] = useState<'auto' | 'fixed'>('auto');
  const [editReserveFixed, setEditReserveFixed] = useState('');
  const [skipReserveId, setSkipReserveId] = useState('');
  const [skipSlot, setSkipSlot] = useState('');
  const [skipDate, setSkipDate] = useState('');
  const [voidReserveId, setVoidReserveId] = useState('');
  const [voidReserveEvent, setVoidReserveEvent] = useState('');
  const [voidReserveDate, setVoidReserveDate] = useState('');
  const [voidReserveReason, setVoidReserveReason] = useState('');
  const [cycleReserveId, setCycleReserveId] = useState('');
  const [cycleDate, setCycleDate] = useState('');
  const [cycleReason, setCycleReason] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
  const busyRetries = useRef(0);
  const sending = useRef(false);
  const syncChannel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    mounted.current = true;
    const onOnline = () => {
      const connected = navigator.onLine;
      setOnline(connected);
      if (connected) {
        retries.current = 0;
        setAutoPaused(false);
      } else {
        controller.current?.markOffline();
        setNeedsVerification(true);
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
      if (timer.current !== null) clearTimeout(timer.current);
      controller.current?.close();
      controller.current = null;
    };
  }, []);

  const instance = useCallback(() => {
    if (!controller.current)
      controller.current = new FinanceSyncController({
        ...(offlineOnly ? { lastVerifiedActorUserId: actor } : { verifiedActorUserId: actor }),
        onClose: () => {
          controller.current = null;
          if (mounted.current) {
            setState(null);
            setView(null);
            setPassword('');
            setRecovery('');
            setRecoveryPassphrase('');
            setReplacementRecovery('');
            setMessage('Доступ к аккаунту отозван. Войдите снова.');
            onSessionRevoked?.();
          }
        },
      });
    return controller.current;
  }, [actor, offlineOnly, onSessionRevoked]);
  const show = useCallback(
    (value: SyncState) => {
      const snapshot = {
        schema_version: 1,
        profile_id: value.cloud.profileId,
        currency: 'RUB',
        revision: value.cloud.revision,
        entities: value.cloud.entities,
        next_cursor: null,
      };
      const decoded = decodeCompleteFinanceState(snapshot, value.cloud.profileId, actor);
      if (!mounted.current) return;
      setState(value);
      setView(decoded);
    },
    [actor],
  );
  const showError = useCallback((error: unknown) => {
    if (!mounted.current) return;
    if (!controller.current) {
      setMessage('Доступ к аккаунту отозван. Войдите снова.');
      return;
    }
    setMessage(
      error instanceof Error ? error.message.replace(/^SYNC_HOLD: /, '') : 'Ошибка синхронизации',
    );
  }, []);

  const create = async () => {
    if (busy || !password) return;
    setBusy(true);
    try {
      const result = await instance().createLocal(password, true);
      if (!mounted.current) return;
      setRecovery(result.recoveryKey);
      setSavedRecovery(false);
      setMessage(
        'Сохраните ключ восстановления вне браузера. Без него и парольной фразы копию не открыть.',
      );
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !password || (recovery && !savedRecovery)) return;
    setBusy(true);
    try {
      const credential =
        credentialKind === 'passphrase' ? { passphrase: password } : { recoveryKey: password };
      const opened = offlineOnly
        ? await instance().unlockOffline(credential)
        : await instance().unlock(credential);
      show(opened as SyncState);
      setPassword('');
      setRecovery('');
      setMessage(
        offlineOnly
          ? 'Открыта локальная копия последнего подтверждённого аккаунта.'
          : 'Показаны подтверждённые сервером остатки.',
      );
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const read = useCallback(async () => {
    if (!controller.current) return;
    try {
      show((await controller.current.read()) as SyncState);
    } catch (error) {
      showError(error);
    }
  }, [show, showError]);
  const announce = useCallback(() => {
    try {
      syncChannel.current?.postMessage('changed');
    } catch {
      /* Local queue remains authoritative. */
    }
  }, []);
  useEffect(() => {
    try {
      const channel = new BroadcastChannel('fh-finance-sync-v1');
      syncChannel.current = channel;
      channel.onmessage = (event) => {
        if (event.data !== 'changed' || !controller.current) return;
        void controller.current
          .read()
          .then((value) => show(value as SyncState))
          .catch(() => {});
      };
      return () => {
        channel.close();
        if (syncChannel.current === channel) syncChannel.current = null;
      };
    } catch {
      return undefined;
    }
  }, [show]);
  const refresh = async () => {
    if (busy || !controller.current) return;
    setBusy(true);
    try {
      show((await controller.current.refresh()) as SyncState);
      setNeedsVerification(false);
      announce();
      setMessage('Серверные данные обновлены.');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!online || !needsVerification || !state || !controller.current) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let networkAttempts = 0;
    const verify = () => {
      if (!active || !controller.current || !navigator.onLine) return;
      void controller.current
        .refresh()
        .then((value) => {
          if (!active || !mounted.current) return;
          show(value as SyncState);
          setNeedsVerification(false);
          setMessage('Сессия и серверный снимок подтверждены.');
        })
        .catch((error) => {
          if (!active) return;
          if (isSyncBusy(error) && attempts++ < 20) retry = setTimeout(verify, 250);
          else if (isSyncNetwork(error) && networkAttempts < 5) {
            showError(error);
            const delay =
              Math.min(1000 * 2 ** networkAttempts++, 16000) * (0.75 + Math.random() * 0.5);
            retry = setTimeout(verify, delay);
          } else showError(error);
        });
    };
    verify();
    return () => {
      active = false;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [online, needsVerification, Boolean(state), show, showError]);
  const reissueRecovery = async () => {
    if (!controller.current || busy || !confirmRecoveryChange || !recoveryPassphrase) return;
    setBusy(true);
    try {
      const result = await controller.current.reissueRecovery(recoveryPassphrase);
      if (!mounted.current) return;
      setReplacementRecovery(result.recoveryKey);
      setRecoveryPassphrase('');
      setConfirmRecoveryChange(false);
      setMessage('Сохраните новый ключ вне браузера: предыдущий ключ больше не действует.');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const send = useCallback(async () => {
    const current = controller.current;
    if (!current || !navigator.onLine || sending.current) return;
    sending.current = true;
    try {
      const result = await current.dispatchOnce();
      if (!mounted.current) return;
      if (result.status === 'DURABLY_CONFIRMED') {
        retries.current = 0;
        busyRetries.current = 0;
        try {
          show((await current.refresh()) as SyncState);
        } catch {
          await read();
        }
        setMessage('Операция подтверждена сервером.');
        announce();
      } else {
        await read();
        announce();
        if (result.status === 'RETRY_SAME_UUID' && retries.current++ < 5 && result.retryDelayMs) {
          timer.current = setTimeout(() => {
            timer.current = null;
            void send();
          }, result.retryDelayMs);
          setMessage('Нет связи с сервером. Операция сохранена и будет повторена.');
        } else if (result.status === 'LEASE_BUSY') {
          setAutoPaused(true);
          setMessage('Другая вкладка отправляет операцию.');
        } else if (result.status !== 'EMPTY_OUTBOX') {
          setAutoPaused(true);
          setMessage('Операция сохранена. Проверьте состояние синхронизации.');
        }
      }
    } catch (error) {
      if (isSyncBusy(error) && busyRetries.current++ < 20 && navigator.onLine) {
        timer.current = setTimeout(() => {
          timer.current = null;
          void send();
        }, 250);
      } else {
        busyRetries.current = 0;
        setAutoPaused(true);
        showError(error);
      }
    } finally {
      sending.current = false;
    }
  }, [announce, read, show, showError]);
  useEffect(() => {
    if (
      !state?.outbox.length ||
      state.status === 'CONFLICT' ||
      !online ||
      needsVerification ||
      autoPaused ||
      timer.current !== null
    )
      return;
    const id = setTimeout(() => {
      timer.current = null;
      void send();
    }, 300);
    timer.current = id;
    return () => {
      clearTimeout(id);
      if (timer.current === id) timer.current = null;
    };
  }, [
    state?.bundleEpoch,
    state?.outbox.length,
    state?.status,
    online,
    needsVerification,
    autoPaused,
    send,
  ]);

  const enqueue = async (command: Command) => {
    if (!controller.current) throw Error('Локальная копия заблокирована');
    await controller.current.enqueue(command);
    await read();
    announce();
    if (mounted.current) setMessage('Операция сохранена на устройстве и ожидает отправки.');
  };
  const createAccount = (x: AccountCreation) =>
    enqueue({
      schema_version: 2,
      client_mutation_id: crypto.randomUUID(),
      base_revision: x.baseRevision,
      action: 'account.create',
      expected_entity_revisions: {},
      payload: {
        id: crypto.randomUUID(),
        name: x.name,
        kind: x.kind,
        currency: 'RUB',
        opening_minor: x.openingMinor,
      },
    });
  const updateAccount = (x: AccountModification) =>
    enqueue({
      schema_version: 2,
      client_mutation_id: crypto.randomUUID(),
      base_revision: x.baseRevision,
      action: 'account.update',
      expected_entity_revisions: { [x.accountId]: x.expectedEntityRevision },
      payload: { account_id: x.accountId, name: x.name, kind: x.kind },
    });
  const archive = (x: AccountArchive, restore: boolean) =>
    enqueue({
      schema_version: 2,
      client_mutation_id: crypto.randomUUID(),
      base_revision: x.baseRevision,
      action: restore ? 'account.unarchive' : 'account.archive',
      expected_entity_revisions: { [x.accountId]: x.expectedEntityRevision },
      payload: { account_id: x.accountId },
    });
  const transfer = (x: AccountTransfer) =>
    enqueue({
      schema_version: 1,
      client_mutation_id: crypto.randomUUID(),
      base_revision: x.baseRevision,
      action: 'account.transfer',
      expected_entity_revisions: x.expectedEntityRevisions,
      payload: {
        from_account_id: x.fromAccountId,
        to_account_id: x.toAccountId,
        amount_minor: x.amountMinor,
        occurred_on: x.occurredOn,
      },
    });

  const recordCashMovement = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    const account = state.cloud.entities.find(
      (entity) => entity.kind === 'account' && entity.id === cashAccount,
    );
    const data = account?.data as
      { archived_at?: unknown; reserved_minor?: unknown; available_minor?: unknown } | undefined;
    try {
      if (!account || data?.archived_at !== null) throw Error('Выберите действующий счёт');
      const amount = parseRubMinor(cashAmount);
      if (amount <= 0) throw Error('Укажите сумму больше нуля');
      if (!isValidLedgerDate(cashDate)) throw Error('Укажите корректную дату');
      if (
        cashKind === 'expense' &&
        typeof data.reserved_minor === 'number' &&
        data.reserved_minor > 0 &&
        (typeof data.available_minor !== 'number' || data.available_minor < amount)
      )
        throw Error('Расход затронет зарезервированные средства');
      if (cashNote.length > 500) throw Error('Примечание слишком длинное');
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'transaction.record',
        expected_entity_revisions: { [account.id]: account.entity_revision },
        payload: {
          id: crypto.randomUUID(),
          account_id: account.id,
          kind: cashKind,
          signed_minor: cashKind === 'expense' ? -amount : amount,
          occurred_on: cashDate,
          ...(cashNote ? { note: cashNote } : {}),
        },
      });
      if (mounted.current) {
        setCashAmount('');
        setCashNote('');
      }
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const reverseCashMovement = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const original = state.cloud.entities.find(
        (x) => x.kind === 'transaction' && x.id === reverseId,
      );
      const data = original?.data as TransactionData | undefined;
      const settlementId =
        data?.kind === 'payment' && !data.payment_link?.loan_payment_id
          ? data.payment_link?.settlement_id
          : null;
      const loanPaymentId =
        data?.kind === 'payment' && !data.payment_link?.settlement_id
          ? data.payment_link?.loan_payment_id
          : null;
      if (
        !original ||
        !data ||
        (!['income', 'expense', 'adjustment', 'transfer'].includes(data.kind || '') &&
          !settlementId &&
          !loanPaymentId) ||
        !Array.isArray(data.postings) ||
        !data.postings.length ||
        data.postings.length > 2 ||
        state.cloud.entities.some(
          (x) =>
            x.kind === 'transaction' &&
            (x.data as TransactionData)?.reversed_transaction_id === reverseId,
        )
      ) {
        throw Error('Операция недоступна для отмены');
      }
      if (!reverseReason.trim() || reverseReason.length > 500)
        throw Error('Укажите причину отмены');
      const revisions: Record<string, number> = { [original.id]: original.entity_revision };
      for (const posting of data.postings) {
        const account = state.cloud.entities.find(
          (x) => x.kind === 'account' && x.id === posting.account_id,
        );
        if (!account || Object.hasOwn(revisions, account.id))
          throw Error('Счёт операции недоступен');
        revisions[account.id] = account.entity_revision;
      }
      let action = 'transaction.reverse';
      let schemaVersion = 1;
      let payload: Record<string, unknown> = {
        transaction_id: original.id,
        reason: reverseReason.trim(),
      };
      if (settlementId) {
        if (data.postings.length !== 1) throw Error('Проводка оплаты недоступна');
        const fact = state.cloud.entities.find(
          (x) => x.kind === 'settlement' && x.id === settlementId,
        );
        if (
          !fact ||
          (fact.data as { voided_at?: unknown })?.voided_at !== null ||
          Object.hasOwn(revisions, fact.id)
        ) {
          throw Error('Факт оплаты недоступен для отмены');
        }
        revisions[fact.id] = fact.entity_revision;
        const reserves = state.cloud.entities.filter((x) => {
          if (x.kind !== 'reserve') return false;
          const log = (x.data as { event_log?: Array<{ kind?: string; transaction_id?: string }> })
            ?.event_log;
          return (
            Array.isArray(log) &&
            log.some((item) => item.kind === 'payment' && item.transaction_id === original.id)
          );
        });
        if (
          reserves.length > 1 ||
          (data.reserve_allocation &&
            (reserves.length !== 1 || reserves[0]?.id !== data.reserve_allocation.reserve_id))
        ) {
          throw Error('Связь с резервом не подтверждена');
        }
        payload = {
          transaction_id: original.id,
          fact_id: fact.id,
          account_id: data.postings[0]!.account_id,
          reason: reverseReason.trim(),
        };
        if (reserves.length === 1) {
          if (Object.hasOwn(revisions, reserves[0]!.id)) throw Error('Некорректная связь резерва');
          revisions[reserves[0]!.id] = reserves[0]!.entity_revision;
          payload.reserve_id = reserves[0]!.id;
        }
        action = 'settlement.payment.void';
        schemaVersion = 2;
      } else if (loanPaymentId) {
        if (data.postings.length !== 1 || data.reserve_allocation)
          throw Error('Проводка кредита недоступна');
        const fact = state.cloud.entities.find(
          (x) => x.kind === 'loan_payment' && x.id === loanPaymentId,
        );
        if (
          !fact ||
          (fact.data as { voided_at?: unknown })?.voided_at !== null ||
          Object.hasOwn(revisions, fact.id)
        )
          throw Error('Факт платежа недоступен для отмены');
        revisions[fact.id] = fact.entity_revision;
        payload = {
          transaction_id: original.id,
          fact_id: fact.id,
          account_id: data.postings[0]!.account_id,
          reason: reverseReason.trim(),
        };
        action = 'loan.payment.void';
        schemaVersion = 2;
      }
      setBusy(true);
      await enqueue({
        schema_version: schemaVersion,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action,
        expected_entity_revisions: revisions,
        payload,
      });
      if (mounted.current) {
        setReverseId('');
        setReverseReason('');
      }
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const changeReserveCycle = async (closing: boolean) => {
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === cycleReserveId,
      );
      const data = reserve?.data as
        { title?: unknown; archived_at?: unknown; period_months?: unknown } | undefined;
      if (
        !reserve ||
        data?.archived_at !== null ||
        typeof data.period_months !== 'number' ||
        !isValidLedgerDate(cycleDate) ||
        (!closing && (!cycleReason.trim() || cycleReason.length > 500))
      )
        throw Error('Проверьте резерв, дату и причину отмены');
      if (
        !window.confirm(
          `${closing ? 'Завершить цикл' : 'Отменить закрытие цикла'} резерва «${String(data.title)}»?`,
        )
      )
        return;
      const payload: Record<string, unknown> = { reserve_id: reserve.id, occurred_on: cycleDate };
      if (!closing) payload.reason = cycleReason.trim();
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: closing ? 'reserve.cycle.close' : 'reserve.cycle.void',
        expected_entity_revisions: { [reserve.id]: reserve.entity_revision },
        payload,
      });
      if (mounted.current && !closing) setCycleReason('');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const voidReserveEventAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === voidReserveId,
      );
      const data = reserve?.data as
        | {
            archived_at?: unknown;
            account_id?: unknown;
            cycle_number?: unknown;
            event_log?: Array<{
              id?: string;
              kind?: string;
              cycle_number?: number;
              target_event_id?: string;
            }>;
          }
        | undefined;
      const account = state.cloud.entities.find(
        (x) => x.kind === 'account' && x.id === data?.account_id,
      );
      const original = data?.event_log?.find((entry) => entry.id === voidReserveEvent);
      if (
        !reserve ||
        data?.archived_at !== null ||
        !account ||
        !original ||
        !['skip', 'contribution', 'release'].includes(String(original.kind)) ||
        original.cycle_number !== data.cycle_number ||
        data.event_log?.some(
          (entry) => entry.kind === 'void' && entry.target_event_id === original.id,
        ) ||
        !isValidLedgerDate(voidReserveDate) ||
        !voidReserveReason.trim() ||
        voidReserveReason.length > 500
      )
        throw Error('Проверьте событие, дату и причину отмены');
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'reserve.event.void',
        expected_entity_revisions: {
          [reserve.id]: reserve.entity_revision,
          [account.id]: account.entity_revision,
        },
        payload: {
          reserve_id: reserve.id,
          account_id: account.id,
          target_event_id: original.id,
          occurred_on: voidReserveDate,
          reason: voidReserveReason.trim(),
        },
      });
      if (mounted.current) {
        setVoidReserveEvent('');
        setVoidReserveReason('');
      }
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const skipReserveContribution = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === skipReserveId,
      );
      const data = reserve?.data as { archived_at?: unknown; period_months?: unknown } | undefined;
      if (
        !reserve ||
        data?.archived_at !== null ||
        typeof data.period_months !== 'number' ||
        !isValidLedgerDate(skipSlot) ||
        !isValidLedgerDate(skipDate)
      )
        throw Error('Выберите резерв и укажите корректные даты');
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'reserve.skip',
        expected_entity_revisions: { [reserve.id]: reserve.entity_revision },
        payload: { reserve_id: reserve.id, slot_on: skipSlot, occurred_on: skipDate },
      });
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const updateReserve = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === editReserveId,
      );
      const data = reserve?.data as
        | {
            archived_at?: unknown;
            first_due_on?: unknown;
            period_months?: unknown;
            due_day?: unknown;
            contribution_mode?: unknown;
            fixed_monthly_minor?: unknown;
          }
        | undefined;
      const target = parseRubMinor(editReserveTarget);
      if (
        !reserve ||
        data?.archived_at !== null ||
        typeof data.first_due_on !== 'string' ||
        typeof data.period_months !== 'number' ||
        typeof data.due_day !== 'number' ||
        !['auto', 'fixed'].includes(String(data.contribution_mode)) ||
        !editReserveTitle.trim() ||
        editReserveTitle.length > 160 ||
        target <= 0 ||
        !isValidLedgerDate(editReserveDate)
      )
        throw Error('Проверьте резерв, название, цель и дату изменения');
      const payload: Record<string, unknown> = {
        reserve_id: reserve.id,
        title: editReserveTitle.trim(),
        target_minor: target,
        first_due_on: editReserveDue,
        period_months: Number(editReservePeriod),
        due_day: Number(editReserveDay),
        contribution_mode: editReserveMode,
        occurred_on: editReserveDate,
      };
      if (editReserveMode === 'fixed')
        payload.fixed_monthly_minor = parseRubMinor(editReserveFixed);
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'reserve.update',
        expected_entity_revisions: { [reserve.id]: reserve.entity_revision },
        payload,
      });
      if (mounted.current) setEditReserveId('');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const createReserve = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const obligation = state.cloud.entities.find(
        (x) => x.kind === 'obligation' && x.id === reserveObligation,
      );
      const account = state.cloud.entities.find(
        (x) => x.kind === 'account' && x.id === reserveAccount,
      );
      const data = obligation?.data as { deleted_at?: unknown; direction?: unknown } | undefined;
      const target = parseRubMinor(reserveTarget);
      const opening = parseRubMinor(reserveOpening);
      if (
        !obligation ||
        data?.deleted_at !== null ||
        data.direction !== 'expense' ||
        !account ||
        (account.data as { archived_at?: unknown })?.archived_at !== null ||
        !reserveTitle.trim() ||
        reserveTitle.length > 160 ||
        target <= 0 ||
        !isValidLedgerDate(reserveOpened) ||
        !isValidLedgerDate(reserveDue)
      )
        throw Error('Проверьте название, обязательство, счёт, сумму и даты');
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'reserve.create',
        expected_entity_revisions: {
          [obligation.id]: obligation.entity_revision,
          [account.id]: account.entity_revision,
        },
        payload: {
          id: crypto.randomUUID(),
          obligation_id: obligation.id,
          account_id: account.id,
          title: reserveTitle.trim(),
          target_minor: target,
          opened_on: reserveOpened,
          first_due_on: reserveDue,
          period_months: Number(reservePeriod),
          due_day: Number(reserveDay),
          contribution_mode: reserveMode,
          opening_reserved_minor: opening,
          ...(reserveMode === 'fixed' ? { fixed_monthly_minor: parseRubMinor(reserveFixed) } : {}),
        },
      });
      if (mounted.current) {
        setReserveTitle('');
        setReserveTarget('');
      }
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const archiveReserve = async () => {
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === allocationReserve,
      );
      const data = reserve?.data as
        { title?: unknown; archived_at?: unknown; allocated_minor?: unknown } | undefined;
      if (!reserve || data?.archived_at !== null || data.allocated_minor !== 0)
        throw Error('Сначала выберите резерв без остатка');
      if (!window.confirm(`Архивировать резерв «${String(data.title)}»?`)) return;
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'reserve.archive',
        expected_entity_revisions: { [reserve.id]: reserve.entity_revision },
        payload: { reserve_id: reserve.id },
      });
      if (mounted.current) setAllocationReserve('');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const allocateReserve = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const reserve = state.cloud.entities.find(
        (x) => x.kind === 'reserve' && x.id === allocationReserve,
      );
      const data = reserve?.data as
        { account_id?: unknown; archived_at?: unknown; period_months?: unknown } | undefined;
      const account = state.cloud.entities.find(
        (x) => x.kind === 'account' && x.id === data?.account_id,
      );
      if (
        !reserve ||
        data?.archived_at !== null ||
        typeof data.period_months !== 'number' ||
        !account ||
        (account.data as { archived_at?: unknown })?.archived_at !== null
      )
        throw Error('Выберите действующий резерв, связанный со счётом');
      const amount = parseRubMinor(allocationAmount);
      if (amount <= 0 || !isValidLedgerDate(allocationDate))
        throw Error('Укажите сумму и корректную дату');
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'reserve.allocate',
        expected_entity_revisions: {
          [reserve.id]: reserve.entity_revision,
          [account.id]: account.entity_revision,
        },
        payload: {
          reserve_id: reserve.id,
          account_id: account.id,
          delta_minor: allocationKind === 'contribution' ? amount : -amount,
          occurred_on: allocationDate,
        },
      });
      if (mounted.current) setAllocationAmount('');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const createObligation = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const amount = parseRubMinor(obligationAmount);
      if (
        !obligationTitle.trim() ||
        obligationTitle.length > 160 ||
        !isValidLedgerDate(obligationDate)
      )
        throw Error('Укажите название и корректную дату');
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!timezone) throw Error('Не удалось определить часовой пояс');
      setBusy(true);
      await enqueue({
        schema_version: 1,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'obligation.create',
        expected_entity_revisions: {},
        payload: {
          title: obligationTitle.trim(),
          direction: obligationDirection,
          amount_minor: amount,
          starts_on: obligationDate,
          timezone,
          recurrence_unit: obligationRecurrence,
          recurrence_every: 1,
        },
      });
      if (mounted.current) {
        setObligationTitle('');
        setObligationAmount('');
      }
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const recordLoanPayment = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const loan = state.cloud.entities.find((x) => x.kind === 'loan' && x.id === loanId);
      const account = state.cloud.entities.find(
        (x) => x.kind === 'account' && x.id === loanAccount,
      );
      if (
        !loan ||
        (loan.data as { deleted_at?: unknown })?.deleted_at !== null ||
        !account ||
        (account.data as { archived_at?: unknown })?.archived_at !== null
      )
        throw Error('Выберите действующие кредит и счёт');
      const amount = parseRubMinor(loanAmount);
      if (amount <= 0 || !isValidLedgerDate(loanDate))
        throw Error('Укажите сумму и корректную дату');
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'loan.payment.record',
        expected_entity_revisions: {
          [loan.id]: loan.entity_revision,
          [account.id]: account.entity_revision,
        },
        payload: {
          loan_id: loan.id,
          account_id: account.id,
          amount_minor: amount,
          paid_on: loanDate,
          strategy: loanStrategy,
        },
      });
      if (mounted.current) setLoanAmount('');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const recordSettlement = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || busy || state.status === 'CONFLICT') return;
    try {
      const obligation = state.cloud.entities.find(
        (x) => x.kind === 'obligation' && x.id === paymentObligation,
      );
      const account = state.cloud.entities.find(
        (x) => x.kind === 'account' && x.id === paymentAccount,
      );
      const obligationData = obligation?.data as
        { deleted_at?: unknown; direction?: unknown } | undefined;
      const accountData = account?.data as { archived_at?: unknown } | undefined;
      if (
        !obligation ||
        obligationData?.deleted_at !== null ||
        !['income', 'expense'].includes(String(obligationData?.direction)) ||
        !account ||
        accountData?.archived_at !== null
      )
        throw Error('Выберите действующие обязательство и счёт');
      const amount = parseRubMinor(paymentAmount);
      if (amount <= 0) throw Error('Укажите сумму больше нуля');
      if (!isValidLedgerDate(paymentDate) || !isValidLedgerDate(paymentOccurrence))
        throw Error('Укажите корректные даты');
      const revisions: Record<string, number> = {
        [account.id]: account.entity_revision,
        [obligation.id]: obligation.entity_revision,
      };
      const payload: Record<string, unknown> = {
        account_id: account.id,
        obligation_id: obligation.id,
        amount_minor: amount,
        paid_on: paymentDate,
        occurrence_on: paymentOccurrence,
      };
      if (paymentReserve) {
        const reserve = state.cloud.entities.find(
          (x) => x.kind === 'reserve' && x.id === paymentReserve,
        );
        const data = reserve?.data as
          | {
              account_id?: unknown;
              obligation_id?: unknown;
              target_on?: unknown;
              archived_at?: unknown;
            }
          | undefined;
        const used = parseRubMinor(paymentReservedUsed);
        if (
          !reserve ||
          data?.archived_at !== null ||
          data.account_id !== account.id ||
          data.obligation_id !== obligation.id ||
          data.target_on !== paymentOccurrence ||
          used > amount
        ) {
          throw Error('Проверьте резерв, счёт и период обязательства');
        }
        revisions[reserve.id] = reserve.entity_revision;
        payload.reserve_id = reserve.id;
        payload.reserved_used_minor = used;
      }
      setBusy(true);
      await enqueue({
        schema_version: 2,
        client_mutation_id: crypto.randomUUID(),
        base_revision: state.cloud.revision,
        action: 'settlement.payment.record',
        expected_entity_revisions: revisions,
        payload,
      });
      if (mounted.current) {
        setPaymentAmount('');
        setPaymentReserve('');
        setPaymentReservedUsed('0');
      }
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const conflict = state?.conflicts.find((x) => x.kind === 'finance_sync_hold');
  const pending = conflict && state?.outbox.find((x) => x.mutationId === conflict.mutationId);
  const resolve = async (choice: 'ACCEPT_SERVER' | 'REAPPLY') => {
    if (!controller.current || !state || !pending || busy) return;
    setBusy(true);
    try {
      let replacement: Command | null = null;
      if (choice === 'REAPPLY') {
        const revisions: Record<string, number> = {};
        for (const id of Object.keys(pending.command.expected_entity_revisions)) {
          const entity = state.cloud.entities.find((x) => x.id === id);
          if (!entity)
            throw Error(
              'Связанная запись больше недоступна. Сохраните исходную операцию для проверки.',
            );
          revisions[id] = entity.entity_revision;
        }
        replacement = {
          ...pending.command,
          client_mutation_id: crypto.randomUUID(),
          base_revision: state.cloud.revision,
          expected_entity_revisions: revisions,
        };
        if (replacement.action === 'goal.append')
          replacement.payload = {
            ...replacement.payload,
            event: {
              ...(replacement.payload.event as Record<string, unknown>),
              id: replacement.client_mutation_id,
            },
          };
      }
      await controller.current.resolve({
        mutationId: pending.mutationId,
        observedRevision: state.cloud.revision,
        choice,
        replacementCommand: replacement,
        explicitUserChoice: true,
      });
      await read();
      announce();
      retries.current = 0;
      setAutoPaused(false);
      setMessage(
        choice === 'REAPPLY' ? 'Новая операция ожидает отправки.' : 'Выбрана серверная версия.',
      );
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!state || !view)
    return (
      <section className="fh-sync" aria-labelledby="sync-unlock-title">
        <button type="button" className="button-secondary" onClick={onBack}>
          Назад
        </button>
        <h2 id="sync-unlock-title">
          {goalMode ? 'Финансовые цели' : budgetMode ? 'Бюджеты' : 'Офлайн-синхронизация'}
        </h2>
        {offlineOnly && (
          <p>
            Доступна только локальная зашифрованная копия последнего подтверждённого аккаунта.
            Удалённый отзыв сессии нельзя обнаружить без сети; перед отправкой аккаунт проверится
            снова.
          </p>
        )}
        <p>
          Создайте отдельную зашифрованную копию или разблокируйте существующую. Локальные и
          гостевые записи не переносятся автоматически.
        </p>
        <p>
          Здесь синхронизируются счета, переводы, отдельные доходы и расходы, обязательства, платежи
          по кредитам и распределения существующих резервов. Остальные операции работают отдельно.
        </p>
        <form onSubmit={unlock}>
          <label className="field">
            <span>Способ разблокировки</span>
            <select
              value={credentialKind}
              onChange={(event) => {
                setCredentialKind(event.target.value as 'passphrase' | 'recoveryKey');
                setPassword('');
              }}
            >
              <option value="passphrase">Парольная фраза</option>
              <option value="recoveryKey">Ключ восстановления</option>
            </select>
          </label>
          <label className="field">
            <span>
              {credentialKind === 'passphrase' ? 'Парольная фраза' : 'Ключ восстановления'}
            </span>
            <input
              type="password"
              value={password}
              autoComplete="off"
              minLength={12}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {recovery && (
            <>
              <p>
                Ключ восстановления: <output>{recovery}</output>
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={savedRecovery}
                  onChange={(event) => setSavedRecovery(event.target.checked)}
                />{' '}
                Я сохранил ключ вне браузера
              </label>
            </>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={
                offlineOnly ||
                busy ||
                !password ||
                Boolean(recovery) ||
                credentialKind !== 'passphrase'
              }
              onClick={() => void create()}
            >
              Создать копию
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={busy || !password || Boolean(recovery && !savedRecovery)}
            >
              Разблокировать
            </button>
          </div>
        </form>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
    );

  const leave = () => {
    if (
      state.outbox.length &&
      !window.confirm(
        'В очереди есть операции. Они останутся на устройстве и будут отправлены после проверки сессии. Выйти?',
      )
    )
      return;
    onBack();
  };
  const reversible = state.cloud.entities.filter((entity) => {
    if (entity.kind !== 'transaction') return false;
    if (
      view.goals.some((g) =>
        g.record.events.some(
          (e) =>
            (e.type === 'contribution' || e.type === 'use') && e.ledgerMovementId === entity.id,
        ),
      )
    )
      return false;
    const data = entity.data as TransactionData;
    return (
      (['income', 'expense', 'adjustment', 'transfer'].includes(data?.kind || '') ||
        (data?.kind === 'payment' &&
          Boolean(data.payment_link?.settlement_id) !==
            Boolean(data.payment_link?.loan_payment_id))) &&
      Array.isArray(data.postings) &&
      data.postings.length > 0 &&
      data.postings.length <= 2 &&
      !state.cloud.entities.some(
        (other) =>
          other.kind === 'transaction' &&
          (other.data as TransactionData)?.reversed_transaction_id === entity.id,
      )
    );
  });
  return (
    <section className="fh-sync">
      {!budgetMode && !goalMode && (
        <p>
          Синхронизация счетов, переводов, отдельных доходов и расходов, обязательств и платежей по
          кредитам и распределения существующих резервов. Остальные операции с резервами и разделы
          работают отдельно.
        </p>
      )}
      <div role="status" aria-live="polite">
        <strong>
          {online && needsVerification
            ? 'Проверяем доступ'
            : state.status === 'CONFLICT'
              ? 'Конфликт'
              : state.outbox.length
                ? 'Ожидает отправки'
                : online
                  ? 'Синхронизировано'
                  : 'Локально'}
        </strong>
        {!online && ' · Нет сети'} · Подтверждённые сервером остатки · В очереди:{' '}
        {state.outbox.length}
        <p>{message}</p>
      </div>
      {state.outbox.length > 0 && (
        <details>
          <summary>Ожидающие операции</summary>
          <ul>
            {state.outbox.map((item) => (
              <li key={item.mutationId}>{operationLabel(item.command, state)}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !online}
          onClick={() => void refresh()}
        >
          Обновить с сервера
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !online || !state.outbox.length}
          onClick={() => {
            retries.current = 0;
            setAutoPaused(false);
            void send();
          }}
        >
          Повторить отправку
        </button>
      </div>
      {offlineOnly && allowOfflineBudgets && state.canBudget === true && (
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            setLocalGoalMode(false);
            setLocalBudgetMode((v) => !v);
          }}
        >
          {budgetMode ? 'Счета и кошельки' : 'Бюджеты'}
        </button>
      )}
      {offlineOnly && allowOfflineGoals && state.canGoal === true && (
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            setLocalBudgetMode(false);
            setLocalGoalMode((v) => !v);
          }}
        >
          {goalMode ? 'Счета и кошельки' : 'Финансовые цели'}
        </button>
      )}
      {goalMode && (
        <GoalWorkspace
          goals={view.goals}
          accounts={view.ledger.accounts.map((a) => ({
            id: a.id,
            name: a.name,
            available: (
              state.cloud.entities.find((e) => e.kind === 'account' && e.id === a.id)?.data as {
                available_minor: number;
              }
            ).available_minor,
            archived: a.archivedAt !== null,
          }))}
          entities={state.cloud.entities}
          revision={state.cloud.revision}
          writable={state.canGoal === true && !busy && state.status !== 'CONFLICT'}
          pending={state.outbox.length > 0}
          onCommand={enqueue}
        />
      )}
      {budgetMode && (
        <Budgets
          view={view}
          entities={state.cloud.entities}
          writable={state.canBudget === true && !busy && state.status !== 'CONFLICT'}
          pending={state.outbox.length > 0}
          onCommand={(action, payload, versions) =>
            enqueue({
              schema_version: 2,
              client_mutation_id: crypto.randomUUID(),
              base_revision: state.cloud.revision,
              action,
              expected_entity_revisions: versions,
              payload,
            })
          }
        />
      )}
      {!budgetMode && !goalMode && (
        <>
          <details>
            <summary>Записать доход или расход</summary>
            <form onSubmit={(event) => void recordCashMovement(event)}>
              <label className="field">
                <span>Счёт операции</span>
                <select
                  value={cashAccount}
                  onChange={(event) => setCashAccount(event.target.value)}
                  required
                >
                  <option value="">Выберите счёт</option>
                  {state.cloud.entities
                    .filter(
                      (entity) =>
                        entity.kind === 'account' &&
                        (entity.data as { archived_at?: unknown })?.archived_at === null,
                    )
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { name: string }).name)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Направление</span>
                <select
                  value={cashKind}
                  onChange={(event) => setCashKind(event.target.value as 'income' | 'expense')}
                >
                  <option value="expense">Расход</option>
                  <option value="income">Доход</option>
                </select>
              </label>
              <label className="field">
                <span>Сумма, ₽</span>
                <input
                  value={cashAmount}
                  onChange={(event) => setCashAmount(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Дата операции</span>
                <input
                  type="date"
                  value={cashDate}
                  onChange={(event) => setCashDate(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Примечание</span>
                <input
                  value={cashNote}
                  onChange={(event) => setCashNote(event.target.value)}
                  maxLength={500}
                />
              </label>
              <p>Остаток изменится после подтверждения сервером.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить операцию
              </button>
            </form>
          </details>
          <details>
            <summary>Создать резерв</summary>
            <form onSubmit={(event) => void createReserve(event)}>
              <label className="field">
                <span>Название резерва</span>
                <input
                  value={reserveTitle}
                  onChange={(event) => setReserveTitle(event.target.value)}
                  maxLength={160}
                  required
                />
              </label>
              <label className="field">
                <span>Расход для резерва</span>
                <select
                  value={reserveObligation}
                  onChange={(event) => setReserveObligation(event.target.value)}
                  required
                >
                  <option value="">Выберите обязательство</option>
                  {state.cloud.entities
                    .filter((entity) => {
                      const data = entity.data as { deleted_at?: unknown; direction?: unknown };
                      return (
                        entity.kind === 'obligation' &&
                        data?.deleted_at === null &&
                        data.direction === 'expense'
                      );
                    })
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Счёт для резерва</span>
                <select
                  value={reserveAccount}
                  onChange={(event) => setReserveAccount(event.target.value)}
                  required
                >
                  <option value="">Выберите счёт</option>
                  {state.cloud.entities
                    .filter(
                      (entity) =>
                        entity.kind === 'account' &&
                        (entity.data as { archived_at?: unknown })?.archived_at === null,
                    )
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { name: string }).name)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Цель резерва, ₽</span>
                <input
                  value={reserveTarget}
                  onChange={(event) => setReserveTarget(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Дата открытия резерва</span>
                <input
                  type="date"
                  value={reserveOpened}
                  onChange={(event) => setReserveOpened(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Первая дата оплаты резерва</span>
                <input
                  type="date"
                  value={reserveDue}
                  onChange={(event) => {
                    setReserveDue(event.target.value);
                    setReserveDay(String(Number(event.target.value.slice(-2)) || ''));
                  }}
                  required
                />
              </label>
              <label className="field">
                <span>Период резерва, месяцев</span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  step="1"
                  value={reservePeriod}
                  onChange={(event) => setReservePeriod(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>День месяца резерва</span>
                <input
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  value={reserveDay}
                  onChange={(event) => setReserveDay(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Режим взноса резерва</span>
                <select
                  value={reserveMode}
                  onChange={(event) => setReserveMode(event.target.value as 'auto' | 'fixed')}
                >
                  <option value="auto">Автоматический</option>
                  <option value="fixed">Фиксированный</option>
                </select>
              </label>
              {reserveMode === 'fixed' && (
                <label className="field">
                  <span>Фиксированный взнос, ₽</span>
                  <input
                    value={reserveFixed}
                    onChange={(event) => setReserveFixed(event.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
              )}
              <label className="field">
                <span>Начальное распределение резерва, ₽</span>
                <input
                  value={reserveOpening}
                  onChange={(event) => setReserveOpening(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <p>
                Начальное распределение повлияет на доступный остаток после подтверждения сервером.
              </p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить резерв в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Завершить или восстановить цикл резерва</summary>
            <label className="field">
              <span>Резерв для цикла</span>
              <select
                value={cycleReserveId}
                onChange={(event) => setCycleReserveId(event.target.value)}
              >
                <option value="">Выберите резерв</option>
                {state.cloud.entities
                  .filter((entity) => {
                    const data = entity.data as { archived_at?: unknown; period_months?: unknown };
                    return (
                      entity.kind === 'reserve' &&
                      data?.archived_at === null &&
                      typeof data.period_months === 'number'
                    );
                  })
                  .map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {String((entity.data as { title: string }).title)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Дата действия с циклом</span>
              <input
                type="date"
                value={cycleDate}
                onChange={(event) => setCycleDate(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Причина восстановления цикла</span>
              <input
                value={cycleReason}
                onChange={(event) => setCycleReason(event.target.value)}
                maxLength={500}
              />
            </label>
            <p>Цикл можно завершить после полной оплаты. Результат подтвердит сервер.</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT' || !cycleReserveId}
                onClick={() => void changeReserveCycle(true)}
              >
                Завершить цикл
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT' || !cycleReserveId}
                onClick={() => void changeReserveCycle(false)}
              >
                Отменить закрытие цикла
              </button>
            </div>
          </details>
          <details>
            <summary>Отменить событие резерва</summary>
            <form onSubmit={(event) => void voidReserveEventAction(event)}>
              <label className="field">
                <span>Резерв для отмены события</span>
                <select
                  value={voidReserveId}
                  onChange={(event) => {
                    setVoidReserveId(event.target.value);
                    setVoidReserveEvent('');
                  }}
                  required
                >
                  <option value="">Выберите резерв</option>
                  {state.cloud.entities
                    .filter((entity) => {
                      const data = entity.data as { archived_at?: unknown; account_id?: unknown };
                      return (
                        entity.kind === 'reserve' &&
                        data?.archived_at === null &&
                        typeof data.account_id === 'string'
                      );
                    })
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Событие для отмены</span>
                <select
                  value={voidReserveEvent}
                  onChange={(event) => setVoidReserveEvent(event.target.value)}
                  required
                >
                  <option value="">Выберите событие</option>
                  {(() => {
                    const reserve = state.cloud.entities.find(
                      (x) => x.kind === 'reserve' && x.id === voidReserveId,
                    );
                    const data = reserve?.data as
                      | {
                          cycle_number?: number;
                          event_log?: Array<{
                            id: string;
                            kind: string;
                            cycle_number: number;
                            occurred_on: string;
                            target_event_id?: string | null;
                          }>;
                        }
                      | undefined;
                    const history = data?.event_log || [];
                    return history
                      .filter(
                        (item) =>
                          ['skip', 'contribution', 'release'].includes(item.kind) &&
                          item.cycle_number === data?.cycle_number &&
                          !history.some(
                            (other) => other.kind === 'void' && other.target_event_id === item.id,
                          ),
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.occurred_on} ·{' '}
                          {item.kind === 'skip'
                            ? 'Пропуск'
                            : item.kind === 'contribution'
                              ? 'Пополнение'
                              : 'Освобождение'}
                        </option>
                      ));
                  })()}
                </select>
              </label>
              <label className="field">
                <span>Дата отмены события</span>
                <input
                  type="date"
                  value={voidReserveDate}
                  onChange={(event) => setVoidReserveDate(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Причина отмены события</span>
                <input
                  value={voidReserveReason}
                  onChange={(event) => setVoidReserveReason(event.target.value)}
                  maxLength={500}
                  required
                />
              </label>
              <p>Компенсация распределения и остаток будут подтверждены сервером.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить отмену события в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Отметить пропущенный взнос</summary>
            <form onSubmit={(event) => void skipReserveContribution(event)}>
              <label className="field">
                <span>Резерв для пропуска</span>
                <select
                  value={skipReserveId}
                  onChange={(event) => setSkipReserveId(event.target.value)}
                  required
                >
                  <option value="">Выберите резерв</option>
                  {state.cloud.entities
                    .filter((entity) => {
                      const data = entity.data as {
                        archived_at?: unknown;
                        period_months?: unknown;
                      };
                      return (
                        entity.kind === 'reserve' &&
                        data?.archived_at === null &&
                        typeof data.period_months === 'number'
                      );
                    })
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Дата пропущенного взноса</span>
                <input
                  type="date"
                  value={skipSlot}
                  onChange={(event) => setSkipSlot(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Дата отметки пропуска</span>
                <input
                  type="date"
                  value={skipDate}
                  onChange={(event) => setSkipDate(event.target.value)}
                  required
                />
              </label>
              <p>Остаток счёта и резерва не изменится.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить пропуск в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Изменить название или цель резерва</summary>
            <form onSubmit={(event) => void updateReserve(event)}>
              <label className="field">
                <span>Резерв для изменения</span>
                <select
                  value={editReserveId}
                  onChange={(event) => {
                    const id = event.target.value;
                    const selected = state.cloud.entities.find(
                      (item) => item.kind === 'reserve' && item.id === id,
                    );
                    const data = selected?.data as
                      | {
                          title?: unknown;
                          target_minor?: unknown;
                          first_due_on?: unknown;
                          period_months?: unknown;
                          due_day?: unknown;
                          contribution_mode?: unknown;
                          fixed_monthly_minor?: unknown;
                        }
                      | undefined;
                    setEditReserveId(id);
                    setEditReserveTitle(typeof data?.title === 'string' ? data.title : '');
                    setEditReserveTarget(
                      typeof data?.target_minor === 'number'
                        ? (data.target_minor / 100).toFixed(2).replace('.', ',')
                        : '',
                    );
                    setEditReserveDue(
                      typeof data?.first_due_on === 'string' ? data.first_due_on : '',
                    );
                    setEditReservePeriod(
                      typeof data?.period_months === 'number' ? String(data.period_months) : '',
                    );
                    setEditReserveDay(
                      typeof data?.due_day === 'number' ? String(data.due_day) : '',
                    );
                    setEditReserveMode(data?.contribution_mode === 'fixed' ? 'fixed' : 'auto');
                    setEditReserveFixed(
                      typeof data?.fixed_monthly_minor === 'number'
                        ? (data.fixed_monthly_minor / 100).toFixed(2).replace('.', ',')
                        : '',
                    );
                  }}
                  required
                >
                  <option value="">Выберите резерв</option>
                  {state.cloud.entities
                    .filter((entity) => {
                      const data = entity.data as {
                        archived_at?: unknown;
                        period_months?: unknown;
                      };
                      return (
                        entity.kind === 'reserve' &&
                        data?.archived_at === null &&
                        typeof data.period_months === 'number'
                      );
                    })
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Новое название резерва</span>
                <input
                  value={editReserveTitle}
                  onChange={(event) => setEditReserveTitle(event.target.value)}
                  maxLength={160}
                  required
                />
              </label>
              <label className="field">
                <span>Новая цель резерва, ₽</span>
                <input
                  value={editReserveTarget}
                  onChange={(event) => setEditReserveTarget(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Первая дата оплаты изменённого резерва</span>
                <input
                  type="date"
                  value={editReserveDue}
                  onChange={(event) => setEditReserveDue(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Период изменённого резерва, месяцев</span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  step="1"
                  value={editReservePeriod}
                  onChange={(event) => setEditReservePeriod(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>День месяца изменённого резерва</span>
                <input
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  value={editReserveDay}
                  onChange={(event) => setEditReserveDay(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Режим взноса изменённого резерва</span>
                <select
                  value={editReserveMode}
                  onChange={(event) => setEditReserveMode(event.target.value as 'auto' | 'fixed')}
                >
                  <option value="auto">Автоматический</option>
                  <option value="fixed">Фиксированный</option>
                </select>
              </label>
              {editReserveMode === 'fixed' && (
                <label className="field">
                  <span>Новый фиксированный взнос, ₽</span>
                  <input
                    value={editReserveFixed}
                    onChange={(event) => setEditReserveFixed(event.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
              )}
              <label className="field">
                <span>Дата изменения резерва</span>
                <input
                  type="date"
                  value={editReserveDate}
                  onChange={(event) => setEditReserveDate(event.target.value)}
                  required
                />
              </label>
              <p>Остаток резерва сохраняется. Изменение графика доступно до первых событий.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить изменение резерва в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Пополнить или освободить резерв</summary>
            <form onSubmit={(event) => void allocateReserve(event)}>
              <label className="field">
                <span>Резерв</span>
                <select
                  value={allocationReserve}
                  onChange={(event) => setAllocationReserve(event.target.value)}
                  required
                >
                  <option value="">Выберите резерв</option>
                  {state.cloud.entities
                    .filter((entity) => {
                      const data = entity.data as {
                        archived_at?: unknown;
                        period_months?: unknown;
                        account_id?: unknown;
                      };
                      return (
                        entity.kind === 'reserve' &&
                        data?.archived_at === null &&
                        typeof data.period_months === 'number' &&
                        typeof data.account_id === 'string'
                      );
                    })
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Действие с резервом</span>
                <select
                  value={allocationKind}
                  onChange={(event) =>
                    setAllocationKind(event.target.value as 'contribution' | 'release')
                  }
                >
                  <option value="contribution">Пополнить</option>
                  <option value="release">Освободить</option>
                </select>
              </label>
              <label className="field">
                <span>Сумма распределения, ₽</span>
                <input
                  value={allocationAmount}
                  onChange={(event) => setAllocationAmount(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Дата распределения</span>
                <input
                  type="date"
                  value={allocationDate}
                  onChange={(event) => setAllocationDate(event.target.value)}
                  required
                />
              </label>
              <p>Доступный и зарезервированный остатки изменятся после подтверждения сервером.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить распределение в очередь
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void archiveReserve()}
                disabled={busy || state.status === 'CONFLICT' || !allocationReserve}
              >
                Архивировать выбранный резерв
              </button>
            </form>
          </details>
          <details>
            <summary>Создать обязательство</summary>
            <form onSubmit={(event) => void createObligation(event)}>
              <label className="field">
                <span>Название обязательства</span>
                <input
                  value={obligationTitle}
                  onChange={(event) => setObligationTitle(event.target.value)}
                  maxLength={160}
                  required
                />
              </label>
              <label className="field">
                <span>Направление обязательства</span>
                <select
                  value={obligationDirection}
                  onChange={(event) =>
                    setObligationDirection(event.target.value as 'expense' | 'income')
                  }
                >
                  <option value="expense">Расход</option>
                  <option value="income">Доход</option>
                </select>
              </label>
              <label className="field">
                <span>Сумма обязательства, ₽</span>
                <input
                  value={obligationAmount}
                  onChange={(event) => setObligationAmount(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Дата начала обязательства</span>
                <input
                  type="date"
                  value={obligationDate}
                  onChange={(event) => setObligationDate(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Повторение обязательства</span>
                <select
                  value={obligationRecurrence}
                  onChange={(event) =>
                    setObligationRecurrence(event.target.value as 'none' | 'month' | 'year')
                  }
                >
                  <option value="none">Один раз</option>
                  <option value="month">Каждый месяц</option>
                  <option value="year">Каждый год</option>
                </select>
              </label>
              <p>Обязательство появится в подтверждённой копии после ответа сервера.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить обязательство в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Записать оплату обязательства</summary>
            <form onSubmit={(event) => void recordSettlement(event)}>
              <label className="field">
                <span>Обязательство</span>
                <select
                  value={paymentObligation}
                  onChange={(event) => setPaymentObligation(event.target.value)}
                  required
                >
                  <option value="">Выберите обязательство</option>
                  {state.cloud.entities
                    .filter(
                      (entity) =>
                        entity.kind === 'obligation' &&
                        (entity.data as { deleted_at?: unknown })?.deleted_at === null,
                    )
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Счёт оплаты</span>
                <select
                  value={paymentAccount}
                  onChange={(event) => setPaymentAccount(event.target.value)}
                  required
                >
                  <option value="">Выберите счёт</option>
                  {state.cloud.entities
                    .filter(
                      (entity) =>
                        entity.kind === 'account' &&
                        (entity.data as { archived_at?: unknown })?.archived_at === null,
                    )
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { name: string }).name)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Сумма оплаты, ₽</span>
                <input
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Дата оплаты</span>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Дата периода обязательства</span>
                <input
                  type="date"
                  value={paymentOccurrence}
                  onChange={(event) => setPaymentOccurrence(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Резерв для оплаты</span>
                <select
                  value={paymentReserve}
                  onChange={(event) => setPaymentReserve(event.target.value)}
                >
                  <option value="">Без резерва</option>
                  {state.cloud.entities
                    .filter((entity) => {
                      const data = entity.data as {
                        account_id?: unknown;
                        obligation_id?: unknown;
                        archived_at?: unknown;
                      };
                      return (
                        entity.kind === 'reserve' &&
                        data?.account_id === paymentAccount &&
                        data?.obligation_id === paymentObligation &&
                        data?.archived_at === null
                      );
                    })
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              {paymentReserve && (
                <label className="field">
                  <span>Из резерва, ₽</span>
                  <input
                    value={paymentReservedUsed}
                    onChange={(event) => setPaymentReservedUsed(event.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
              )}
              <p>Оплата и остаток будут подтверждены сервером после отправки.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить оплату в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Записать платёж по кредиту</summary>
            <form onSubmit={(event) => void recordLoanPayment(event)}>
              <label className="field">
                <span>Кредит</span>
                <select value={loanId} onChange={(event) => setLoanId(event.target.value)} required>
                  <option value="">Выберите кредит</option>
                  {state.cloud.entities
                    .filter(
                      (entity) =>
                        entity.kind === 'loan' &&
                        (entity.data as { deleted_at?: unknown })?.deleted_at === null,
                    )
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { title: string }).title)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Счёт платежа по кредиту</span>
                <select
                  value={loanAccount}
                  onChange={(event) => setLoanAccount(event.target.value)}
                  required
                >
                  <option value="">Выберите счёт</option>
                  {state.cloud.entities
                    .filter(
                      (entity) =>
                        entity.kind === 'account' &&
                        (entity.data as { archived_at?: unknown })?.archived_at === null,
                    )
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {String((entity.data as { name: string }).name)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Сумма платежа по кредиту, ₽</span>
                <input
                  value={loanAmount}
                  onChange={(event) => setLoanAmount(event.target.value)}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span>Дата платежа по кредиту</span>
                <input
                  type="date"
                  value={loanDate}
                  onChange={(event) => setLoanDate(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Стратегия досрочного погашения</span>
                <select
                  value={loanStrategy}
                  onChange={(event) => setLoanStrategy(event.target.value as 'term' | 'amount')}
                >
                  <option value="term">Сократить срок</option>
                  <option value="amount">Уменьшить платёж</option>
                </select>
              </label>
              <p>Платёж и остаток будут подтверждены сервером после отправки.</p>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT'}
              >
                Сохранить платёж в очередь
              </button>
            </form>
          </details>
          <details>
            <summary>Отменить подтверждённую операцию</summary>
            <p>
              Будет создана компенсирующая проводка; история сохранится. До ответа сервера остаток
              не изменится.
            </p>
            <form onSubmit={(event) => void reverseCashMovement(event)}>
              <label className="field">
                <span>Операция для отмены</span>
                <select
                  value={reverseId}
                  onChange={(event) => setReverseId(event.target.value)}
                  required
                >
                  <option value="">Выберите операцию</option>
                  {reversible.map((entity) => {
                    const data = entity.data as TransactionData;
                    const first = data.postings?.[0]?.signed_minor;
                    return (
                      <option key={entity.id} value={entity.id}>
                        {data.occurred_on || 'Дата недоступна'} ·{' '}
                        {data.kind === 'transfer'
                          ? 'Перевод'
                          : data.kind === 'income'
                            ? 'Доход'
                            : data.kind === 'expense'
                              ? 'Расход'
                              : data.kind === 'payment'
                                ? 'Оплата обязательства'
                                : 'Корректировка'}{' '}
                        · {typeof first === 'number' ? formatRubMinor(first) : 'сумма недоступна'}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className="field">
                <span>Причина отмены</span>
                <input
                  value={reverseReason}
                  onChange={(event) => setReverseReason(event.target.value)}
                  maxLength={500}
                  required
                />
              </label>
              <button
                type="submit"
                className="button-secondary"
                disabled={busy || state.status === 'CONFLICT' || !reversible.length}
              >
                Сохранить отмену
              </button>
            </form>
          </details>
          <details>
            <summary>Ключ восстановления</summary>
            <p>
              Новый ключ заменит прежний; парольная фраза останется прежней. Для выпуска требуется
              сеть и действующая сессия.
            </p>
            <label className="field">
              <span>Парольная фраза для нового ключа</span>
              <input
                type="password"
                autoComplete="off"
                value={recoveryPassphrase}
                onChange={(event) => setRecoveryPassphrase(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmRecoveryChange}
                onChange={(event) => setConfirmRecoveryChange(event.target.checked)}
              />{' '}
              Понимаю, что прежний ключ перестанет действовать
            </label>
            <button
              type="button"
              className="button-secondary"
              disabled={busy || !online || !confirmRecoveryChange || !recoveryPassphrase}
              onClick={() => void reissueRecovery()}
            >
              Выпустить новый ключ
            </button>
            {replacementRecovery && (
              <p>
                Новый ключ восстановления: <output>{replacementRecovery}</output>
              </p>
            )}
          </details>
        </>
      )}
      {conflict && pending && (
        <section aria-labelledby="sync-conflict-title">
          <h3 id="sync-conflict-title">Конфликт операции</h3>
          <p>Исходная операция сохранена. Сначала обновите данные с сервера и выберите действие.</p>
          {[409, 410].includes(conflict.httpStatus) && (
            <p>
              Сервер сначала проверит, что исходная операция не проведена. Если она уже выполнена,
              очередь сохранится для сверки.
            </p>
          )}
          <details>
            <summary>Локальная операция</summary>
            <p>{operationLabel(pending.command, state)}</p>
          </details>
          <details>
            <summary>Текущие серверные записи</summary>
            <ul>
              {state.cloud.entities
                .filter(
                  (x) =>
                    x.kind === 'account' &&
                    Object.hasOwn(pending.command.expected_entity_revisions, x.id),
                )
                .map((x) => {
                  const data = x.data as { name?: unknown; balance_minor?: unknown };
                  return (
                    <li key={x.id}>
                      {typeof data.name === 'string' ? data.name : 'Счёт'}:{' '}
                      {typeof data.balance_minor === 'number' &&
                      Number.isSafeInteger(data.balance_minor)
                        ? formatRubMinor(data.balance_minor)
                        : 'остаток недоступен'}
                    </li>
                  );
                })}
            </ul>
          </details>
          <button
            type="button"
            className="button-secondary"
            disabled={
              busy ||
              (conflict.httpStatus !== 412 &&
                (!state.canCancel || !online || ![409, 410].includes(conflict.httpStatus)))
            }
            onClick={() => void resolve('ACCEPT_SERVER')}
          >
            Принять серверную версию
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={
              busy ||
              (conflict.httpStatus !== 412 &&
                (!state.canCancel || !online || ![409, 410].includes(conflict.httpStatus)))
            }
            onClick={() => void resolve('REAPPLY')}
          >
            Применить заново
          </button>
        </section>
      )}
      {!budgetMode && !goalMode && (
        <Accounts
          snapshot={view.ledger}
          activeProfileId={state.cloud.profileId}
          reservedMinorByAccount={view.reservedMinorByAccount}
          status="ready"
          writable={!busy && state.status !== 'CONFLICT'}
          onBack={leave}
          onRefresh={() => void read()}
          onCreate={createAccount}
          onUpdate={updateAccount}
          onArchive={(x) => archive(x, false)}
          onUnarchive={(x) => archive(x, true)}
          onTransfer={transfer}
        />
      )}
      {(budgetMode || goalMode) && (
        <button type="button" className="button-secondary" onClick={leave}>
          Назад
        </button>
      )}
    </section>
  );
}
