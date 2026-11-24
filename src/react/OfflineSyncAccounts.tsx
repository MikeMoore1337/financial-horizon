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
import { formatRubMinor } from './accounts-view-model';
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
};

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
    default:
      return 'Операция ожидает проверки';
  }
}

export function OfflineSyncAccounts({ actor, onBack }: { actor: string; onBack: () => void }) {
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
  const [autoPaused, setAutoPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
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
        verifiedActorUserId: actor,
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
          }
        },
      });
    return controller.current;
  }, [actor]);
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
      const opened = await instance().unlock(
        credentialKind === 'passphrase' ? { passphrase: password } : { recoveryKey: password },
      );
      show(opened as SyncState);
      setPassword('');
      setRecovery('');
      setMessage('Показаны подтверждённые сервером остатки.');
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
      announce();
      setMessage('Серверные данные обновлены.');
    } catch (error) {
      showError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
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
      setAutoPaused(true);
      showError(error);
    } finally {
      sending.current = false;
    }
  }, [announce, read, show, showError]);
  useEffect(() => {
    if (
      !state?.outbox.length ||
      state.status === 'CONFLICT' ||
      !online ||
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
  }, [state?.bundleEpoch, state?.outbox.length, state?.status, online, autoPaused, send]);

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
        <p>
          Создайте отдельную зашифрованную копию или разблокируйте существующую. Локальные и
          гостевые записи не переносятся автоматически.
        </p>
        <p>
          Здесь синхронизируются только счета и переводы. Платежи, резервы и остальные разделы
          работают отдельно.
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
              disabled={busy || !password || Boolean(recovery) || credentialKind !== 'passphrase'}
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
        'В очереди есть операции. Они останутся на устройстве до следующей разблокировки. Выйти?',
      )
    )
      return;
    onBack();
  };
  return (
    <section className="fh-sync">
      <p>
        Синхронизация счетов и переводов. Платежи, резервы и остальные разделы работают отдельно.
      </p>
      <div role="status" aria-live="polite">
        <strong>
          {state.status === 'CONFLICT'
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
            disabled={busy || conflict.httpStatus !== 412}
            onClick={() => void resolve('ACCEPT_SERVER')}
          >
            Принять серверную версию
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy || conflict.httpStatus !== 412}
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
