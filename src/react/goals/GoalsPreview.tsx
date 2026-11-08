import type { GoalsScreenModel } from '../../domain/goals/presentation.ts';
import './goals-preview.css';

const categoryLabel: Record<string, string> = {
  emergency: 'Подушка безопасности',
  travel: 'Путешествие',
  purchase: 'Покупка',
  education: 'Образование',
  other: 'Другая цель',
};

const statusLabel: Record<string, string> = {
  active: 'В процессе',
  completed: 'Завершена',
  archived: 'В архиве',
};

export interface GoalsPreviewProps {
  /** Authorized, immutable as-of read model. This component never fetches it. */
  model: GoalsScreenModel;
  rubles: (kopecks: number) => string;
  formatDate: (iso: string) => string;
  /** Selection is a UI intent only; it does not mutate bank or goal data. */
  onSelect?: (goalId: string) => void;
}

/**
 * Isolated owner-approved read view for the #37 goals feature.
 * NOT connected to PWA navigation, persistence, auth or a bank ledger.
 * No financial mutations can be initiated from this component.
 */
export function GoalsPreview({ model, rubles, formatDate, onSelect }: GoalsPreviewProps) {
  const chosen = model.selected;
  return (
    <section className="goals-preview" aria-labelledby="goals-preview-heading">
      <header className="page-header">
        <div>
          <div className="eyebrow">Личные финансы · Накопления</div>
          <h1 id="goals-preview-heading">Финансовые цели</h1>
          <p className="subtitle">Следите за прогрессом, взносами и сроками достижения.</p>
        </div>
      </header>
      <div className="goals-preview-notice" role="status">
        Предварительный просмотр. Операции со счетами и сохранение целей пока недоступны.
      </div>
      <div className="goals-preview-summary">
        <div className="surface"><span>Целей</span><strong>{model.cards.length}</strong></div>
        <div className="surface"><span>Активных</span><strong>{model.activeCount}</strong></div>
        <div className="surface">
          <span>Выделено на цели</span><strong>{rubles(model.earmarkedCents)}</strong>
          <small>Это не банковский остаток и не расход</small>
        </div>
      </div>
      <div className="goals-preview-columns">
        <div className="goals-preview-list" aria-label="Список целей">
          {model.cards.length === 0
            ? <div className="surface goals-preview-empty">Накоплений пока нет.</div>
            : model.cards.map(goal => (
              <button type="button" key={goal.id}
                className="surface goals-preview-item"
                aria-pressed={goal.id === chosen?.card.id}
                disabled={!onSelect}
                onClick={() => onSelect?.(goal.id)}>
                <span className="goals-preview-item-head">
                  <strong>{goal.title}</strong>
                  <small>{statusLabel[goal.status]}</small>
                </span>
                <span className="goals-preview-item-money">
                  {rubles(goal.savedCents)} <small>из {rubles(goal.targetCents)}</small>
                </span>
                <span className="goals-preview-track" role="progressbar"
                  aria-label={'Прогресс: ' + goal.title}
                  aria-valuemin={0} aria-valuemax={100}
                  aria-valuenow={goal.progressBasisPoints / 100}>
                  <span style={{ width: String(Math.min(100, Math.max(0, goal.progressBasisPoints / 100))) + '%' }} />
                </span>
                <span className="goals-preview-item-foot">
                  <span>{String(goal.progressBasisPoints / 100)}%</span>
                  <span>До {formatDate(goal.targetDate)}</span>
                </span>
              </button>
            ))}
        </div>
        {chosen && <section className="surface goals-preview-detail" aria-label="Выбранная цель">
          <div className="eyebrow">{categoryLabel[chosen.card.category]}</div>
          <h2>{chosen.card.title}</h2>
          <p className="small-hint">{statusLabel[chosen.card.status]} · До {formatDate(chosen.card.targetDate)}</p>
          <div className="goals-preview-values">
            <div><small>Накоплено</small><strong>{rubles(chosen.card.savedCents)}</strong></div>
            <div><small>Осталось</small><strong>{rubles(chosen.card.remainingCents)}</strong></div>
          </div>
          <div className="goals-preview-track" role="progressbar"
            aria-label="Прогресс выбранной цели" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={chosen.card.progressBasisPoints / 100}>
            <span style={{ width: String(Math.min(100, Math.max(0, chosen.card.progressBasisPoints / 100))) + '%' }} />
          </div>
          <div className="goals-preview-facts">
            <div><small>Плановый взнос</small><strong>{rubles(chosen.card.monthlyCents)}</strong></div>
            <div><small>Следующий взнос</small>
              <strong>{chosen.card.nextInstallmentOn ? formatDate(chosen.card.nextInstallmentOn) : 'Не требуется'}</strong>
            </div>
            <div><small>Прогноз</small>
              <strong>{chosen.card.projectedCompletionDate ? formatDate(chosen.card.projectedCompletionDate) : 'Не рассчитан'}</strong>
            </div>
            <div><small>Дефицит взноса</small><strong>{rubles(chosen.snapshot.monthlyDeficitCents ?? 0)}</strong></div>
          </div>
          <h3>Ближайшие взносы</h3>
          <ul className="goals-preview-rows">
            {chosen.installments.slice(0, 12).map(row => (
              <li key={row.dueOn}>
                <span>{formatDate(row.dueOn)} <small>{row.status}</small></span>
                <strong>{rubles(row.actualCents)} / {rubles(row.plannedCents)}</strong>
              </li>
            ))}
          </ul>
          <h3>История</h3>
          <ul className="goals-preview-rows">
            {chosen.history.slice(0, 20).map(item => (
              <li key={item.eventId}>
                <span>{formatDate(item.on)} <small>{item.type}{item.reversed ? ' · Отменено' : ''}</small></span>
                <strong>{item.amountCents === null ? '' : rubles(item.amountCents)}</strong>
              </li>
            ))}
          </ul>
          <p className="small-hint">Внесение средств не отражается как расход. Сверка операций доступна после подключения счетов.</p>
        </section>}
      </div>
    </section>
  );
}
