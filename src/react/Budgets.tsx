import { useState, type FormEvent } from 'react';
import { getMonthEvents } from '../../finance.js';
import { projectGuestBudget } from '../domain/budgets/guest.mjs';
import { projectServerBudgetLoans } from '../domain/budgets/server-loan-plan.mjs';
import type { FinanceStateV2 } from '../types/finance.ts';
import type { AccountServerView } from '../domain/accounts/server-snapshot.ts';
import {
  calculateBudgetReport,
  type BudgetOperation,
  type BudgetUsage,
} from '../domain/budgets/index.ts';
import { toAuthoritativeBudgetOperations } from '../domain/budgets/ledger-adapter.ts';
import type { ServerBudgetRule, ServerBudgetCategory } from '../domain/budgets/server-snapshot.ts';
import { Icon } from './Calendar';
import { formatRubMinor, parseRubMinor } from './accounts-view-model';
import { projectServerPaymentPlanner } from './reserves-finance-gateway';
import './budgets.css';

export type BudgetAction =
  | 'budget.create'
  | 'budget.amend'
  | 'budget.archive'
  | 'budget.category.create'
  | 'budget.category.rename'
  | 'budget.category.archive'
  | 'budget.category.assign';

interface BudgetControls {
  writable: boolean;
  pending: boolean;
  onCommand: (
    action: BudgetAction,
    payload: Record<string, unknown>,
    versions: Record<string, number>,
  ) => Promise<void>;
}
type BudgetProps = BudgetControls &
  (
    | { mode?: 'account'; view: AccountServerView; entities: readonly unknown[] }
    | { mode: 'guest'; guestState: FinanceStateV2 }
  );

function localMonth() {
  const d = new Date();
  return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function shift(month: string, delta: number) {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + delta;
  if (index < 12 || index >= 120000) return month;
  return (
    String(Math.floor(index / 12)).padStart(4, '0') +
    '-' +
    String((index % 12) + 1).padStart(2, '0')
  );
}
function label(month: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(month + '-01T00:00:00Z'));
}
function minorInput(minor: number) {
  return String(Math.floor(minor / 100)) + ',' + String(minor % 100).padStart(2, '0');
}

function Usage({
  usage,
  title,
  onEdit,
  onArchive,
  disabled,
}: {
  usage: BudgetUsage;
  title: string;
  onEdit: () => void;
  onArchive: () => void;
  disabled: boolean;
}) {
  return (
    <article className="surface fh-budget-usage">
      <h2>{title}</h2>
      <div className="fh-budget-amount">
        <strong className={usage.exceeded ? 'fh-budget-over' : ''}>
          {formatRubMinor(usage.remainingMinor)}
        </strong>
        <span>{usage.exceeded ? 'Перерасход' : 'Осталось'}</span>
      </div>
      <progress
        aria-label={'Использовано: ' + title}
        max={100}
        value={Math.min(100, usage.percentUsed ?? (usage.spentMinor > 0 ? 100 : 0))}
      />
      <dl className="fh-budget-metrics">
        <div>
          <dt>Лимит</dt>
          <dd>{formatRubMinor(usage.limitMinor)}</dd>
        </div>
        <div>
          <dt>Потрачено</dt>
          <dd>{formatRubMinor(usage.spentMinor)}</dd>
        </div>
        <div>
          <dt>Использовано</dt>
          <dd>
            {usage.percentUsed === null ? 'Не применимо' : usage.percentUsed.toFixed(1) + '%'}
          </dd>
        </div>
      </dl>
      <div className="dialog-actions">
        <button type="button" className="button-secondary" disabled={disabled} onClick={onEdit}>
          Изменить
        </button>
        <button type="button" className="button-secondary" disabled={disabled} onClick={onArchive}>
          Архивировать
        </button>
      </div>
    </article>
  );
}

export function Budgets(props: BudgetProps) {
  const { writable, pending, onCommand } = props;
  const guest = props.mode === 'guest';
  const [month, setMonth] = useState(localMonth);
  const [history, setHistory] = useState(false);
  const [editor, setEditor] = useState<'create' | string | null>(null);
  const [scope, setScope] = useState('');
  const [amount, setAmount] = useState('');
  const [recurrence, setRecurrence] = useState<'monthly' | 'once'>('monthly');
  const [categoryName, setCategoryName] = useState('');
  const [categoryEdit, setCategoryEdit] = useState<string | null>(null);
  const [expenseId, setExpenseId] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const disabled = !writable || pending || saving;
  // Each mode supplies only its own validated source. The guest view never
  // builds a synthetic server ledger or reads account cookies.
  let report: ReturnType<typeof calculateBudgetReport>,
    expenseOperations: BudgetOperation[],
    categories: ServerBudgetCategory[],
    rules: ServerBudgetRule[],
    transactions: Array<{ id: string; entityRevision: number; note: string | null }>,
    loanPlanMissing = false;
  try {
    let profileId: string, operations: BudgetOperation[];
    if (props.mode === 'guest') {
      const model = projectGuestBudget(props.guestState, month);
      ({ profileId, categories, rules, transactions, operations, loanPlanMissing } = model);
    } else {
      const { view, entities } = props;
      const planner = projectServerPaymentPlanner(entities);
      const loanPlan = projectServerBudgetLoans(entities, month);
      loanPlanMissing = loanPlan.missing;
      categories = view.budget.categories;
      rules = view.budget.rules;
      profileId = view.ledger.profileId;
      transactions = view.ledger.transactions;
      const planned: BudgetOperation[] = [...getMonthEvents(planner, month), ...loanPlan.events]
        .filter((event) => event.kind === 'expense' && event.plannedCents > 0)
        .map((event) => ({
          id: 'plan:' + event.source + ':' + event.id,
          profileId,
          occurredOn: event.date,
          kind: 'expense' as const,
          status: 'planned' as const,
          signedMinor: -event.plannedCents,
          categoryId: categories.find((c) => c.name === event.category)?.id ?? null,
        }));
      operations = toAuthoritativeBudgetOperations(view.ledger, view.budget.assignments, planned);
    }
    report = calculateBudgetReport({ profileId, month, rules, operations });
    const reversed = new Set(
      operations.filter((o) => o.kind === 'reversal').map((o) => o.reversedTransactionId),
    );
    expenseOperations = operations.filter(
      (o) =>
        o.status === 'confirmed' &&
        o.signedMinor < 0 &&
        (o.kind === 'expense' || o.kind === 'payment') &&
        !reversed.has(o.id) &&
        o.occurredOn.startsWith(month + '-'),
    );
  } catch {
    return (
      <section className="fh-budgets">
        <h1>Бюджеты</h1>
        <p role="alert">Не удалось проверить финансовый снимок. Обновите данные.</p>
      </section>
    );
  }

  const active = categories.filter((c) => !c.archived);
  const categoryLabel = (id: string) =>
    categories.find((c) => c.id === id)?.name ?? 'Недоступная категория';
  const ruleLabel = (r: ServerBudgetRule) =>
    r.scope.kind === 'total' ? 'Общий бюджет' : categoryLabel(r.scope.categoryId);

  async function execute(
    action: BudgetAction,
    payload: Record<string, unknown>,
    versions: Record<string, number> = {},
  ) {
    if (disabled) return false;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await onCommand(action, payload, versions);
      setMessage(
        guest
          ? 'Бюджет сохранён на этом устройстве.'
          : 'Операция сохранена в зашифрованной очереди. Итоги изменятся после подтверждения сервера.',
      );
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^SYNC_HOLD: /, '')
          : 'Не удалось сохранить операцию',
      );
      return false;
    } finally {
      setSaving(false);
    }
  }
  function changeMonth(delta: number) {
    setEditor(null);
    setExpenseId('');
    setExpenseCategory('');
    setMonth((m) => shift(m, delta));
  }
  function newLimit() {
    setEditor('create');
    setAmount('');
    setScope('');
    setRecurrence('monthly');
    setError('');
  }
  function editLimit(rule: ServerBudgetRule) {
    setEditor(rule.id);
    setAmount(minorInput(rule.limitMinor));
    setError('');
  }
  async function saveLimit(event: FormEvent) {
    event.preventDefault();
    if (disabled || editor === null) return;
    let limit: number;
    try {
      limit = parseRubMinor(amount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Укажите сумму');
      return;
    }
    if (editor === 'create') {
      if (
        await execute('budget.create', {
          id: crypto.randomUUID(),
          category_id: scope || null,
          limit_minor: limit,
          recurrence,
          from_month: month,
        })
      )
        setEditor(null);
      return;
    }
    const rule = rules.find((r) => r.id === editor);
    if (!rule) {
      setError('Правило изменилось. Откройте его снова.');
      return;
    }
    if (
      await execute(
        'budget.amend',
        {
          rule_id: rule.id,
          limit_minor: limit,
          effective_from_month: month,
          replacement_id: month === rule.fromMonth ? rule.id : crypto.randomUUID(),
        },
        { [rule.id]: rule.entityRevision },
      )
    )
      setEditor(null);
  }
  function archive(rule: ServerBudgetRule) {
    if (disabled || !window.confirm('Архивировать лимит с выбранного месяца? История сохранится.'))
      return;
    void execute(
      'budget.archive',
      { rule_id: rule.id, archived_from_month: month },
      { [rule.id]: rule.entityRevision },
    );
  }
  function usageCard(usage: BudgetUsage, title: string) {
    const rule = rules.find((r) => r.id === usage.ruleId);
    if (!rule) return null;
    return (
      <Usage
        key={rule.id}
        usage={usage}
        title={title}
        disabled={disabled}
        onEdit={() => editLimit(rule)}
        onArchive={() => archive(rule)}
      />
    );
  }

  return (
    <section className="fh-budgets" aria-labelledby="fh-budget-title">
      <header className="page-header">
        <div>
          <h1 id="fh-budget-title">Бюджеты</h1>
          <p>
            {guest
              ? 'Локальные лимиты и подтверждённые банковские расходы'
              : 'Лимиты и подтверждённые расходы аккаунта'}
          </p>
        </div>
        <div className="header-tools">
          <button
            type="button"
            className="button-secondary"
            aria-expanded={history}
            onClick={() => setHistory((h) => !h)}
          >
            История правил
          </button>
          <button type="button" className="button-primary" disabled={disabled} onClick={newLimit}>
            <Icon name="plus" /> Лимит
          </button>
        </div>
      </header>
      <div className="surface fh-budget-period">
        <button
          type="button"
          className="mini-action fh-budget-prev"
          aria-label="Предыдущий месяц"
          onClick={() => changeMonth(-1)}
        >
          <Icon name="chevron" />
        </button>
        <strong aria-live="polite">{label(month)}</strong>
        <button
          type="button"
          className="mini-action"
          aria-label="Следующий месяц"
          onClick={() => changeMonth(1)}
        >
          <Icon name="chevron" />
        </button>
      </div>
      {guest && (
        <p className="small-hint">
          Факт берётся из импортированных банковских списаний. Отметки оплаты без проводки входят
          только в план, не считаются повторным расходом. Данные остаются в браузере.
        </p>
      )}
      {!writable && (
        <p className="small-hint">Изменения недоступны до подтверждения доступа к бюджетам.</p>
      )}
      {pending && (
        <p className="small-hint">
          Дождитесь подтверждения ожидающей операции. Показаны подтверждённые данные.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {editor !== null && (
        <form className="surface fh-budget-form" onSubmit={saveLimit}>
          <h2>{editor === 'create' ? 'Новый лимит' : 'Изменить лимит'}</h2>
          {editor === 'create' && (
            <>
              <label className="field">
                <span>Область лимита</span>
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="">Общий бюджет</option>
                  {active.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Повторение</span>
                <select
                  value={recurrence}
                  onChange={(e) => setRecurrence(e.target.value === 'once' ? 'once' : 'monthly')}
                >
                  <option value="monthly">Каждый месяц</option>
                  <option value="once">Один месяц</option>
                </select>
              </label>
            </>
          )}
          <p>С месяца: {label(month)}</p>
          <label className="field">
            <span>Лимит, ₽</span>
            <input
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button type="submit" className="button-primary" disabled={disabled}>
              Сохранить лимит
            </button>
            <button type="button" className="button-secondary" onClick={() => setEditor(null)}>
              Отмена
            </button>
          </div>
        </form>
      )}
      {report.total ? (
        usageCard(report.total, 'Общий бюджет')
      ) : (
        <div className="surface">
          <h2>Общий бюджет</h2>
          <p>На этот месяц лимит не установлен.</p>
        </div>
      )}
      <div className="fh-budget-grid">
        {[
          ['Запланировано', report.plannedExpenseMinor],
          ['Подтверждено', report.confirmedExpenseMinor],
          ['Превышено', report.total?.overrunMinor ?? null],
          ['Без категории', report.uncategorizedExpenseMinor],
        ].map(([title, value]) => (
          <div className="surface fh-budget-kpi" key={String(title)}>
            <span>{title}</span>
            <strong>{typeof value === 'number' ? formatRubMinor(value) : 'Нет лимита'}</strong>
          </div>
        ))}
      </div>
      {loanPlanMissing && (
        <p className="small-hint">
          План по отдельным кредитам недоступен: не подтверждены версия расчёта или порядок
          платежей. Подтверждённые списания учтены по журналу.
        </p>
      )}
      <h2>Лимиты по категориям</h2>
      {report.categories.length ? (
        <div className="fh-budget-grid">
          {report.categories.map((u) =>
            usageCard(
              u,
              u.scope.kind === 'category' ? categoryLabel(u.scope.categoryId) : 'Общий бюджет',
            ),
          )}
        </div>
      ) : (
        <p>На этот месяц нет лимитов по категориям.</p>
      )}
      {history && (
        <section className="surface">
          <h2>История правил</h2>
          {rules.length ? (
            <ul className="fh-budget-history">
              {rules.map((r) => (
                <li key={r.id}>
                  <strong>{ruleLabel(r)}</strong> · {formatRubMinor(r.limitMinor)} · {r.fromMonth} ·{' '}
                  {r.recurrence === 'once' ? 'Один месяц' : 'Каждый месяц'}
                  {r.endsBeforeMonth && ' · Действовал до ' + r.endsBeforeMonth}
                  {r.archivedFromMonth && ' · Архив с ' + r.archivedFromMonth}
                </li>
              ))}
            </ul>
          ) : (
            <p>История пуста.</p>
          )}
        </section>
      )}
      <details className="surface">
        <summary>Категории бюджета</summary>
        <p className="small-hint">
          {guest
            ? 'Названия исходных категорий сохраняются для истории; бюджетные изменения не переписывают записи и проводки.'
            : 'Категории аккаунта не меняют локальные записи и проводки.'}
        </p>
        <form
          className="fh-budget-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = categoryName.trim();
            if (!name || name.length > 40) {
              setError('Укажите название до 40 символов.');
              return;
            }
            const current = categories.find((c) => c.id === categoryEdit);
            if (
              await execute(
                current ? 'budget.category.rename' : 'budget.category.create',
                { id: current?.id ?? crypto.randomUUID(), name },
                current ? { [current.id]: current.entityRevision } : {},
              )
            ) {
              setCategoryName('');
              setCategoryEdit(null);
            }
          }}
        >
          <label className="field">
            <span>{categoryEdit ? 'Новое название' : 'Название категории'}</span>
            <input
              value={categoryName}
              maxLength={40}
              required
              onChange={(e) => setCategoryName(e.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button type="submit" className="button-primary" disabled={disabled}>
              {categoryEdit ? 'Переименовать' : 'Добавить категорию'}
            </button>
            {categoryEdit && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setCategoryEdit(null);
                  setCategoryName('');
                }}
              >
                Отмена
              </button>
            )}
          </div>
        </form>
        <ul className="fh-budget-history">
          {categories.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>
              {c.archived ? (
                ' · Архив'
              ) : (
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={disabled}
                    onClick={() => {
                      setCategoryEdit(c.id);
                      setCategoryName(c.name);
                    }}
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={disabled}
                    onClick={() => {
                      if (window.confirm('Архивировать категорию? История расходов останется.'))
                        void execute(
                          'budget.category.archive',
                          { id: c.id },
                          { [c.id]: c.entityRevision },
                        );
                    }}
                  >
                    Архивировать
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </details>
      <details className="surface">
        <summary>Категории подтверждённых расходов</summary>
        <form
          className="fh-budget-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const tx = transactions.find((t) => t.id === expenseId);
            if (!tx || !expenseOperations.some((o) => o.id === tx.id)) {
              setError('Расход изменился.');
              return;
            }
            if (
              await execute(
                'budget.category.assign',
                { transaction_id: tx.id, category_id: expenseCategory || null },
                { [tx.id]: tx.entityRevision },
              )
            )
              setExpenseId('');
          }}
        >
          <label className="field">
            <span>Расход</span>
            <select
              required
              value={expenseId}
              onChange={(e) => {
                const id = e.target.value;
                setExpenseId(id);
                const assigned = expenseOperations.find((o) => o.id === id)?.categoryId;
                setExpenseCategory(
                  assigned && active.some((c) => c.id === assigned) ? assigned : '',
                );
              }}
            >
              <option value="">Выберите расход</option>
              {expenseOperations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.occurredOn} · {formatRubMinor(-o.signedMinor)} ·{' '}
                  {transactions.find((t) => t.id === o.id)?.note ||
                    (o.kind === 'payment' ? 'Оплата' : 'Расход')}{' '}
                  · {o.categoryId ? categoryLabel(o.categoryId) : 'Без категории'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Категория расхода</span>
            <select value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)}>
              <option value="">Без категории</option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="button-primary" disabled={disabled || !expenseId}>
            Сохранить категорию
          </button>
        </form>
      </details>
    </section>
  );
}
