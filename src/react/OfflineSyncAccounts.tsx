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
  onlineVerified: boolean;
};
const isSyncBusy = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === 'SYNC_BUSY';

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
}: {
  actor: string;
  onBack: () => void;
  offlineOnly?: boolean;
  onSessionRevoked?: () => void;
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
          else showError(error);
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
        <h2 id="sync-unlock-title">Офлайн-синхронизация</h2>
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
          Здесь синхронизируются счета, переводы, отдельные доходы и расходы и оплаты обязательств.
          Кредиты, управление резервами и остальные разделы работают отдельно.
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
      <p>
        Синхронизация счетов, переводов, отдельных доходов и расходов, обязательств и платежей по
        кредитам. Управление резервами и остальные разделы работают отдельно.
      </p>
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
          Будет создана компенсирующая проводка; история сохранится. До ответа сервера остаток не
          изменится.
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
          Новый ключ заменит прежний; парольная фраза останется прежней. Для выпуска требуется сеть
          и действующая сессия.
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
    </section>
  );
}
