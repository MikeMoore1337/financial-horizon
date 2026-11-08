import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Icon } from './Calendar';
import type { LedgerState } from '../domain/accounts/ledger.ts';
import {
  deriveAccountsView,
  formatRubMinor,
  isValidLedgerDate,
  parseRubMinor,
  type AccountKind,
  type AccountViewRow,
} from './accounts-view-model';
import './accounts.css';

const kinds: Record<AccountKind, string> = {
  bank: 'Банковский счёт',
  card: 'Карта',
  cash: 'Наличные',
  savings: 'Накопления',
  other: 'Другой',
};

export interface AccountCreation {
  baseRevision: number;
  name: string;
  kind: AccountKind;
  openingMinor: number;
}
export interface AccountModification {
  accountId: string;
  name: string;
  kind: AccountKind;
  expectedEntityRevision: number;
  baseRevision: number;
}
export interface AccountTransfer {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  occurredOn: string;
  baseRevision: number;
  expectedEntityRevisions: Record<string, number>;
}
export interface AccountArchive {
  accountId: string;
  expectedEntityRevision: number;
  baseRevision: number;
}

export interface AccountsProps {
  /** Verified, revision-consistent server or explicitly isolated local snapshot. */
  snapshot: LedgerState | null;
  /** Must be derived from the current verified user/session, not from request JSON. */
  activeProfileId: string | null;
  /** Verified per-account allocation: null is UNKNOWN, never implicitly zero. */
  reservedMinorByAccount: Readonly<Record<string, number>> | null;
  status: 'loading' | 'ready' | 'offline' | 'conflict' | 'error' | 'locked';
  writable: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onCreate?: (input: AccountCreation) => Promise<void>;
  onUpdate?: (input: AccountModification) => Promise<void>;
  onTransfer?: (input: AccountTransfer) => Promise<void>;
  onArchive?: (input: AccountArchive) => Promise<void>;
  onUnarchive?: (input: AccountArchive) => Promise<void>;
}

type Panel = { kind: 'create' } | { kind: 'transfer'; fromId?: string } |
  { kind: 'edit' | 'history' | 'archive' | 'unarchive'; accountId: string };

const statusText: Record<AccountsProps['status'], string> = {
  loading: 'Загружаем подтверждённые остатки…',
  ready: '',
  offline: 'Нет связи с сервером. Показанные остатки могут быть устаревшими. Запись отключена.',
  conflict: 'Данные изменились на другом устройстве. Обновите остатки перед новой операцией.',
  error: 'Не удалось подтвердить состояние счетов. Попробуйте обновить данные.',
  locked: 'Финансовые данные заблокированы. Сначала подтвердите доступ.',
};

function availableText(row: AccountViewRow) {
  return 'Доступно ' + formatRubMinor(row.availableMinor);
}

export function Accounts({
  snapshot,
  activeProfileId,
  reservedMinorByAccount,
  status,
  writable,
  onBack,
  onRefresh,
  onCreate,
  onUpdate,
  onTransfer,
  onArchive,
  onUnarchive,
}: AccountsProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind>('bank');
  const [opening, setOpening] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState('');
  const [busy, setBusy] = useState(false);
  // Synchronous guard against double-clicks before React commits the busy state.
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [uncertain, setUncertain] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const derived = useMemo(() => {
    if (status === 'locked' || status === 'loading' || status === 'error' ||
      !snapshot || !activeProfileId || !reservedMinorByAccount) {
      return { model: null, invalid: false };
    }
    try {
      return { model: deriveAccountsView(snapshot, activeProfileId, reservedMinorByAccount), invalid: false };
    } catch {
      return { model: null, invalid: true };
    }
  }, [snapshot, activeProfileId, reservedMinorByAccount, status]);

  const model = derived.model;
  const active = model?.rows.filter(row => !row.archived) || [];
  const archived = model?.rows.filter(row => row.archived) || [];
  const selected = panel && 'accountId' in panel
    ? model?.rows.find(row => row.id === panel.accountId) : null;
  const canWrite = status === 'ready' && writable && !busy && !uncertain && Boolean(model);
  const canCreate = canWrite && Boolean(onCreate);
  const canTransfer = canWrite && Boolean(onTransfer) && active.length > 1;
  const canEdit = canWrite && Boolean(onUpdate);
  const canArchive = canWrite && Boolean(onArchive);
  const canUnarchive = canWrite && Boolean(onUnarchive);

  function startCreate() {
    setName('');
    setKind('bank');
    setOpening('');
    setFeedback(null);
    setPanel({ kind: 'create' });
  }
  function startEdit(account: AccountViewRow) {
    setName(account.name);
    setKind(account.kind);
    setFeedback(null);
    setPanel({ kind: 'edit', accountId: account.id });
  }
  function startTransfer(fromAccountId?: string) {
    setFromId(fromAccountId || active[0]?.id || '');
    setToId(active.find(row => row.id !== (fromAccountId || active[0]?.id))?.id || '');
    setAmount('');
    setOccurredOn('');
    setFeedback(null);
    setPanel({ kind: 'transfer', fromId: fromAccountId });
  }
  function closePanel() {
    if (!busy) {
      setPanel(null);
      setFeedback(null);
    }
  }

  async function commit(run: () => Promise<void>) {
    if (inFlight.current || uncertain || status !== 'ready') return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await run();
      // No optimistic ledger mutation. The caller MUST reload the authoritative
      // snapshot after a confirmed receipt, with server-side idempotency.
      setPanel(null);
      onRefresh();
    } catch {
      // A timeout can occur after commit. Do not retry with another mutation key.
      setUncertain(true);
      setFeedback('Статус операции не подтверждён. Проверьте состояние на сервере перед повтором.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function validName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 160) throw new Error('Укажите название до 160 символов');
    return trimmed;
  }
  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate || !onCreate || !snapshot) return;
    try {
      const input: AccountCreation = {
        baseRevision: snapshot.revision,
        name: validName(name),
        kind,
        openingMinor: parseRubMinor(opening, true),
      };
      void commit(() => onCreate(input));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Некорректные данные счёта');
    }
  }
  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !onUpdate || !selected || !snapshot) return;
    try {
      const input: AccountModification = {
        accountId: selected.id,
        name: validName(name),
        kind,
        expectedEntityRevision: selected.entityRevision,
        baseRevision: snapshot.revision,
      };
      void commit(() => onUpdate(input));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Некорректное название');
    }
  }
  function submitTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canTransfer || !onTransfer || !snapshot) return;
    const from = active.find(row => row.id === fromId);
    const to = active.find(row => row.id === toId);
    if (!from || !to || from.id === to.id) {
      setFeedback('Выберите два разных действующих счёта');
      return;
    }
    try {
      const amountMinor = parseRubMinor(amount);
      if (amountMinor === 0) throw new Error('Укажите сумму больше нуля');
      if (!isValidLedgerDate(occurredOn)) throw new Error('Укажите корректную дату');
      if (!Number.isSafeInteger(from.balanceMinor - amountMinor) ||
        !Number.isSafeInteger(to.balanceMinor + amountMinor)) {
        throw new Error('Остаток превышает допустимый предел');
      }
      if (from.reservedMinor > 0 && from.availableMinor < amountMinor) {
        throw new Error('Перевод затронет зарезервированные средства');
      }
      const input: AccountTransfer = {
        fromAccountId: from.id,
        toAccountId: to.id,
        amountMinor,
        occurredOn,
        baseRevision: snapshot.revision,
        expectedEntityRevisions: {
          [from.id]: from.entityRevision,
          [to.id]: to.entityRevision,
        },
      };
      void commit(() => onTransfer(input));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Некорректная сумма перевода');
    }
  }
  function commitArchive(account: AccountViewRow, reverse: boolean) {
    if (!snapshot) return;
    const callback = reverse ? onUnarchive : onArchive;
    if (!callback || !canWrite) return;
    void commit(() => callback({
      accountId: account.id,
      expectedEntityRevision: account.entityRevision,
      baseRevision: snapshot.revision,
    }));
  }

  // The modal owns focus while visible; Escape never interrupts a pending write.
  useEffect(() => {
    if (!panel) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(
      dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])') || [],
    ).filter(element => element.getClientRects().length > 0 || element.tabIndex >= 0);
    const initial = dialog?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled])');
    (initial || focusable()[0])?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) closePanel();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused?.focus();
    };
  }, [panel, busy]);

  const transferFrom = active.find(row => row.id === fromId);
  const transferTo = active.find(row => row.id === toId);
  let preview: { from: string; to: string } | null = null;
  if (transferFrom && transferTo && transferFrom.id !== transferTo.id) {
    try {
      const amountMinor = parseRubMinor(amount);
      if (amountMinor > 0 && Number.isSafeInteger(transferFrom.balanceMinor - amountMinor) &&
        Number.isSafeInteger(transferTo.balanceMinor + amountMinor)) {
        preview = {
          from: formatRubMinor(transferFrom.balanceMinor - amountMinor),
          to: formatRubMinor(transferTo.balanceMinor + amountMinor),
        };
      }
    } catch {
      // Invalid input has no preview and is never submitted.
    }
  }

  return (
    <section className="fh-accounts" aria-label="Счета">
      <header className="page-header">
        <div>
          <div className="eyebrow">Личные финансы · фактические движения</div>
          <h1>Счета</h1>
          <p className="subtitle">Подтверждённые остатки без плановых доходов и обязательств.</p>
        </div>
        <div className="header-tools">
          <button type="button" className="button-secondary" onClick={onBack}>
            <Icon name="chevron" /> К обзору
          </button>
          <button type="button" className="button-primary" onClick={startCreate} disabled={!canCreate}>
            <Icon name="plus" /> Новый счёт
          </button>
        </div>
      </header>
      {(status !== 'ready' || derived.invalid || uncertain) && (
        <div className="surface fh-accounts-notice" role="status">
          <Icon name="shield" />
          <span>{uncertain
            ? 'Результат последнего запроса неизвестен. Повторная отправка заблокирована.'
            : derived.invalid
              ? 'Не удалось проверить финансовое состояние. Счета скрыты для защиты данных.'
              : statusText[status]}</span>
          <button type="button" className="button-secondary" onClick={onRefresh}>Обновить</button>
        </div>
      )}
      {model && status !== 'locked' ? (
        <>
          <div className="surface fh-accounts-total">
            <div className="hero-label">Всего на счетах</div>
            <strong className="fh-accounts-amount">{formatRubMinor(model.totalMinor)}</strong>
            <p className="small-hint">Начальные остатки + подтверждённые проводки. Это не прогноз.</p>
          </div>
          <div className="fh-accounts-summary">
            <div className="surface fh-accounts-summary-item">
              <div className="kpi-label">Зарезервировано</div>
              <strong>{formatRubMinor(model.reservedMinor)}</strong>
            </div>
            <div className="surface fh-accounts-summary-item">
              <div className="kpi-label">Доступно</div>
              <strong className="pos">{formatRubMinor(model.availableMinor)}</strong>
            </div>
          </div>
          <div className="section-title">
            <h2>Мои счета</h2>
            <span className="small-hint">{active.length} действующих</span>
          </div>
          {active.length ? (
            <div className="fh-accounts-list">
              {active.map(account => (
                <article className="surface fh-account-card" key={account.id}>
                  <div className="fh-account-heading">
                    <span className="fh-account-icon"><Icon name="credit" /></span>
                    <div>
                      <h3>{account.name}</h3>
                      <p className="small-hint">{kinds[account.kind]} · RUB</p>
                    </div>
                  </div>
                  <div className="fh-account-balance">
                    <strong>{formatRubMinor(account.balanceMinor)}</strong>
                    <span className="small-hint">{availableText(account)}</span>
                  </div>
                  <div className="fh-account-actions">
                    <button className="button-secondary" type="button" onClick={() => setPanel({ kind: 'history', accountId: account.id })}>История</button>
                    <button className="button-secondary" type="button" disabled={!canTransfer} onClick={() => startTransfer(account.id)}>Перевести</button>
                    <button className="button-secondary" type="button" disabled={!canEdit} onClick={() => startEdit(account)}>Изменить</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="surface empty-panel"><h3>Счетов пока нет</h3>
              <p>Начальные остатки не создаются автоматически из старых платежей.</p>
            </div>
          )}
          <details className="fh-accounts-archive">
            <summary>Архивные счета ({archived.length})</summary>
            {archived.map(account => (
              <div key={account.id} className="surface fh-accounts-archive-row">
                <span>{account.name} · {formatRubMinor(account.balanceMinor)}</span>
                <div className="fh-account-actions">
                  <button type="button" className="button-secondary" onClick={() => setPanel({ kind: 'history', accountId: account.id })}>История</button>
                  <button type="button" className="button-secondary" disabled={!canUnarchive}
                    onClick={() => setPanel({ kind: 'unarchive', accountId: account.id })}>Восстановить</button>
                </div>
              </div>
            ))}
          </details>
        </>
      ) : (
        <div className="surface empty-panel">
          <Icon name="lock" />
          <h2>Сведения о счетах недоступны</h2>
          <p>До подтверждения профиля и целостности финансовых данных операции запрещены.</p>
        </div>
      )}

      {panel && model && (
        <div className="fh-accounts-overlay" role="presentation">
          <div ref={dialogRef} className="surface fh-accounts-dialog" role="dialog" aria-modal="true" aria-labelledby="fh-account-dialog-title">
            <div className="fh-accounts-dialog-header">
              <h2 id="fh-account-dialog-title">
                {panel.kind === 'create' ? 'Создать счёт' :
                  panel.kind === 'edit' ? 'Изменить счёт' :
                  panel.kind === 'transfer' ? 'Перевести между счетами' :
                  panel.kind === 'history' ? 'История операций' :
                  panel.kind === 'archive' ? 'Архивировать счёт' : 'Восстановить счёт'}
              </h2>
              <button className="tool-icon" type="button" aria-label="Закрыть" disabled={busy} onClick={closePanel}>×</button>
            </div>
            {(panel.kind === 'create' || panel.kind === 'edit') && (
              <form onSubmit={panel.kind === 'create' ? submitCreate : submitEdit} className="fh-accounts-form">
                <label>Название<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
                <label>Тип счёта<select value={kind} onChange={event => setKind(event.target.value as AccountKind)}>
                  {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select></label>
                {panel.kind === 'create' && <label>Начальный остаток в рублях (обязательно)
                  <input required inputMode="decimal" maxLength={32} value={opening} placeholder="0,00"
                    onChange={event => setOpening(event.target.value)} />
                </label>}
                <p className="small-hint">Плановые платежи и существующие кредиты не превращаются в движения автоматически.</p>
                <div className="fh-accounts-form-actions">
                  <button className="button-secondary" type="button" onClick={closePanel} disabled={busy}>Отмена</button>
                  <button className="button-primary" type="submit" disabled={panel.kind === 'create' ? !canCreate : !canEdit}>Сохранить</button>
                </div>
              </form>
            )}
            {panel.kind === 'transfer' && (
              <form onSubmit={submitTransfer} className="fh-accounts-form">
                <label>Откуда<select required value={fromId} onChange={event => {
                    const nextFrom = event.target.value;
                    setFromId(nextFrom);
                    if (toId === nextFrom) setToId(active.find(row => row.id !== nextFrom)?.id || '');
                  }}>
                  {active.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select></label>
                <label>Куда<select required value={toId} onChange={event => setToId(event.target.value)}>
                  {active.filter(row => row.id !== fromId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                </select></label>
                <label>Сумма в рублях<input required inputMode="decimal" maxLength={32}
                  value={amount} placeholder="1 000,00" onChange={event => setAmount(event.target.value)} /></label>
                <label>Дата перевода<input required type="date" value={occurredOn} onChange={event => setOccurredOn(event.target.value)} /></label>
                {preview && <div className="fh-accounts-preview" aria-label="Предварительный результат">
                  <p><span>Откуда</span><strong>{formatRubMinor(transferFrom!.balanceMinor)} → {preview.from}</strong></p>
                  <p><span>Куда</span><strong>{formatRubMinor(transferTo!.balanceMinor)} → {preview.to}</strong></p>
                  <p><span>Общий объём активов</span><strong>Без изменений</strong></p>
                </div>}
                <p className="small-hint">Перевод не считается доходом или расходом. Результат подтверждает только сервер.</p>
                <div className="fh-accounts-form-actions">
                  <button className="button-secondary" type="button" disabled={busy} onClick={closePanel}>Отмена</button>
                  <button className="button-primary" type="submit" disabled={!canTransfer}>Подтвердить перевод</button>
                </div>
              </form>
            )}
            {panel.kind === 'history' && selected && snapshot && (
              <div className="fh-accounts-history">
                <p className="small-hint">Неизменяемый журнал: отмены отражаются отдельными операциями.</p>
                {snapshot.postings.filter(p => p.accountId === selected.id).map(posting => {
                  const transaction = snapshot.transactions.find(tx => tx.id === posting.transactionId);
                  if (!transaction) return null;
                  return <div className="fh-accounts-history-row" key={transaction.id + '-' + posting.accountId}>
                    <span>{transaction.occurredOn} · {transaction.kind === 'reversal' ? 'Компенсация' :
                      transaction.kind === 'transfer' ? 'Перевод' :
                        transaction.kind === 'payment' ? 'Оплата' :
                          transaction.kind === 'income' ? 'Поступление' :
                            transaction.kind === 'expense' ? 'Расход' : 'Корректировка'}</span>
                    <strong>{formatRubMinor(posting.signedMinor)}</strong>
                  </div>;
                })}
                {!snapshot.postings.some(posting => posting.accountId === selected.id) &&
                  <p className="small-hint">Подтверждённых движений пока нет.</p>}
                <div className="fh-accounts-form-actions">
                  <button className="button-secondary" type="button" onClick={closePanel}>Закрыть</button>
                  {!selected.archived && <button className="button-secondary" type="button"
                    disabled={!canArchive} onClick={() => setPanel({ kind: 'archive', accountId: selected.id })}>В архив</button>}
                </div>
              </div>
            )}
            {(panel.kind === 'archive' || panel.kind === 'unarchive') && selected && (
              <div className="fh-accounts-form">
                <p>Подтвердите действие для счёта «{selected.name}». Проводки и остаток сохраняются.</p>
                <div className="fh-accounts-form-actions">
                  <button className="button-secondary" type="button" disabled={busy} onClick={closePanel}>Отмена</button>
                  <button className="button-primary" type="button"
                    disabled={panel.kind === 'archive' ? !canArchive : !canUnarchive}
                    onClick={() => commitArchive(selected, panel.kind === 'unarchive')}>
                    {panel.kind === 'archive' ? 'Архивировать' : 'Восстановить'}
                  </button>
                </div>
              </div>
            )}
            {feedback && <p role="alert" className="fh-accounts-error">{feedback}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
