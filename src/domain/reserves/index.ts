/**
 * Financial Horizon reserve domain. Pure calculations only: no accounts, storage,
 * clock, UI or ledger writes. All monetary values are integer minor units (kopecks).
 *
 * The input event stream is ordered by recording time (non-decreasing event.date).
 * Voids are append-only compensating records, and the active stream is replayed.
 * The integration layer must commit a payment and its account posting atomically.
 */

export type ReserveDate = string;
export type ContributionMode = 'auto' | 'fixed';

export interface ReserveDefinition {
  readonly id: string;
  readonly title: string;
  readonly openedOn: ReserveDate;
  /** The first upcoming due date; later cycles derive from this original anchor. */
  readonly firstDueDate: ReserveDate;
  readonly periodMonths: number;
  readonly targetCents: number;
  /** Already owned money earmarked on opening. Never new income or an expense. */
  readonly openingReservedCents: number;
  readonly contributionMode: ContributionMode;
  readonly fixedMonthlyCents?: number;
  /** Optional day 1..31 to preserve e.g. a 31st across short months. */
  readonly dueDay?: number;
}

interface BaseEvent {
  readonly reserveId: string;
  readonly id: string;
  readonly date: ReserveDate;
}

export interface ReserveContribution extends BaseEvent {
  readonly kind: 'contribution';
  readonly amountCents: number;
}

export interface ReservePayment extends BaseEvent {
  readonly kind: 'payment';
  /** Full amount actually paid. Account transaction must be posted once in #33. */
  readonly amountCents: number;
  /** Portion of earmarked funds consumed, never greater than actual payment. */
  readonly reservedUsedCents: number;
}

export interface ReserveTargetChange extends BaseEvent {
  readonly kind: 'target_change';
  readonly targetCents: number;
}

export interface ReserveSkippedContribution extends BaseEvent {
  readonly kind: 'skip';
  /** Original scheduled contribution slot, not an amount removed from the account. */
  readonly slotDate: ReserveDate;
}

export interface ReserveCycleClose extends BaseEvent {
  readonly kind: 'cycle_close';
}

export interface ReserveVoid extends BaseEvent {
  readonly kind: 'void';
  readonly targetEventId: string;
}

export type ReserveEvent =
  | ReserveContribution
  | ReservePayment
  | ReserveTargetChange
  | ReserveSkippedContribution
  | ReserveCycleClose
  | ReserveVoid;

export type ReserveHistoryItem = ReserveEvent & {
  readonly voided: boolean;
  /** A void record itself does not belong to a financial cycle. */
  readonly cycleNumber: number | null;
};

export interface ReserveInstallment {
  readonly date: ReserveDate;
  readonly amountCents: number;
}

export interface ReserveProjection {
  readonly id: string;
  readonly title: string;
  readonly cycleNumber: number;
  readonly dueDate: ReserveDate;
  readonly periodMonths: number;
  readonly contributionMode: ContributionMode;
  readonly targetCents: number;
  readonly paidThisCycleCents: number;
  readonly remainingObligationCents: number;
  readonly reservedCents: number;
  readonly fundingGapCents: number;
  readonly schedule: readonly ReserveInstallment[];
  readonly nextContribution: ReserveInstallment | null;
  readonly projectedShortfallCents: number;
  readonly immediateFundingRequiredCents: number;
  readonly daysUntilDue: number;
  readonly overdue: boolean;
  readonly cyclePaid: boolean;
  readonly totalContributedCents: number;
  /** Declared real payments only; no ledger/account mutation is performed here. */
  readonly totalPaidCents: number;
  readonly totalReservedUsedCents: number;
  readonly skippedContributions: number;
  readonly history: readonly ReserveHistoryItem[];
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const MONEY_LIMIT = 1_000_000_000_000;
const MAX_EVENTS = 10_000;
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334] as const;

function validId(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RangeError(`${name}: неверный идентификатор`);
  }
}

function money(value: unknown, name: string, positive = false): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > MONEY_LIMIT
  ) {
    throw new RangeError(`${name}: требуется целое число копеек от ${positive ? 1 : 0} до ${MONEY_LIMIT}`);
  }
}

function plus(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError('Сумма выходит за безопасный диапазон целых копеек');
  }
  return result;
}

function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leap(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function parseDate(value: unknown, name: string): CalendarDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${name}: дата должна быть YYYY-MM-DD`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`${name}: несуществующая дата`);
  }
  return { year, month, day };
}

function dateOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, daysInMonth(year, month))).padStart(2, '0')}`;
}

function monthNumber(date: CalendarDate): number {
  return (date.year - 1) * 12 + date.month - 1;
}

/** Recalculate from the ORIGINAL anchor on every cycle; never drift via February. */
export function addReserveMonths(date: ReserveDate, months: number, anchorDay?: number): ReserveDate {
  const parsed = parseDate(date, 'Дата для переноса');
  if (!Number.isSafeInteger(months)) throw new RangeError('Смещение месяцев должно быть целым');
  const day = anchorDay ?? parsed.day;
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new RangeError('День оплаты должен быть от 1 до 31');
  }
  const index = monthNumber(parsed) + months;
  if (index < 0 || index >= 9999 * 12) throw new RangeError('Дата выходит за допустимый диапазон');
  return dateOf(Math.floor(index / 12) + 1, (index % 12) + 1, day);
}

function ordinal(date: CalendarDate): number {
  const previousYear = date.year - 1;
  return (
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400) +
    DAYS_BEFORE_MONTH[date.month - 1]! +
    (date.month > 2 && leap(date.year) ? 1 : 0) +
    date.day
  );
}

function validateDefinition(def: ReserveDefinition): number {
  if (!def || typeof def !== 'object') throw new TypeError('Резерв не указан');
  validId(def.id, 'Резерв');
  if (typeof def.title !== 'string' || !def.title.trim() || def.title.length > 200) {
    throw new RangeError('Название резерва должно содержать от 1 до 200 символов');
  }
  const start = parseDate(def.openedOn, 'Дата открытия');
  const due = parseDate(def.firstDueDate, 'Первая дата оплаты');
  if (def.firstDueDate <= def.openedOn) throw new RangeError('Дата оплаты должна быть после открытия');
  if (!Number.isInteger(def.periodMonths) || def.periodMonths < 1 || def.periodMonths > 60) {
    throw new RangeError('Периодичность должна быть от 1 до 60 месяцев');
  }
  if (monthNumber(due) - monthNumber(start) > def.periodMonths) {
    throw new RangeError('Первая дата оплаты должна попадать в текущий цикл');
  }
  money(def.targetCents, 'Цель резерва', true);
  money(def.openingReservedCents, 'Начальный резерв');
  if (def.contributionMode !== 'auto' && def.contributionMode !== 'fixed') {
    throw new RangeError('Неизвестный способ пополнения');
  }
  if (def.contributionMode === 'fixed') {
    money(def.fixedMonthlyCents, 'Фиксированный взнос', true);
  } else if (def.fixedMonthlyCents !== undefined) {
    throw new RangeError('В автоматическом режиме фиксированный взнос не задаётся');
  }
  const anchorDay = def.dueDay ?? due.day;
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError('День оплаты должен быть от 1 до 31');
  }
  if (dateOf(due.year, due.month, anchorDay) !== def.firstDueDate) {
    throw new RangeError('Дата оплаты не соответствует заданному дню месяца');
  }
  return anchorDay;
}

function installmentsBetween(startExclusive: ReserveDate, dueInclusive: ReserveDate, day: number): string[] {
  if (startExclusive >= dueInclusive) return [];
  const start = monthNumber(parseDate(startExclusive, 'Дата расчёта'));
  const end = monthNumber(parseDate(dueInclusive, 'Дата оплаты'));
  const result: string[] = [];
  for (let monthIndex = start; monthIndex <= end; monthIndex += 1) {
    const date = dateOf(Math.floor(monthIndex / 12) + 1, (monthIndex % 12) + 1, day);
    if (date > startExclusive && date <= dueInclusive) result.push(date);
  }
  return result;
}

/** One forecast on a calendar date. All events are historical, supplied and ordered. */
export function calculateReserve(
  def: ReserveDefinition,
  events: readonly ReserveEvent[],
  asOfDate: ReserveDate,
): ReserveProjection {
  const day = validateDefinition(def);
  parseDate(asOfDate, 'Дата расчёта');
  if (asOfDate < def.openedOn) throw new RangeError('Расчёт раньше открытия резерва');
  if (!Array.isArray(events) || events.length > MAX_EVENTS) {
    throw new RangeError('Недопустимый журнал событий резерва');
  }

  const prior = new Map<string, ReserveEvent>();
  const voided = new Set<string>();
  let lastDate = def.openedOn;
  for (const event of events) {
    if (!event || typeof event !== 'object') throw new TypeError('Повреждённое событие');
    validId(event.id, 'Событие');
    if (event.reserveId !== def.id) throw new RangeError('Событие относится к другому резерву');
    if (prior.has(event.id)) throw new Error('Повторяющийся идентификатор события');
    parseDate(event.date, 'Дата события');
    if (event.date < lastDate) throw new RangeError('События должны быть упорядочены по дате');
    if (event.date > asOfDate) throw new RangeError('Журнал содержит будущее событие');
    lastDate = event.date;
    switch (event.kind) {
      case 'contribution':
        money(event.amountCents, 'Пополнение', true);
        break;
      case 'payment':
        money(event.amountCents, 'Оплата обязательства', true);
        money(event.reservedUsedCents, 'Использовано из резерва');
        if (event.reservedUsedCents > event.amountCents) {
          throw new RangeError('Из резерва нельзя взять больше суммы оплаты');
        }
        break;
      case 'target_change':
        money(event.targetCents, 'Новая цель', true);
        break;
      case 'skip':
        parseDate(event.slotDate, 'Дата пропущенного взноса');
        if (event.slotDate > event.date) throw new RangeError('Нельзя пропустить будущий взнос');
        break;
      case 'cycle_close':
        break;
      case 'void': {
        validId(event.targetEventId, 'Отменяемое событие');
        const target = prior.get(event.targetEventId);
        if (!target || target.kind === 'void' || voided.has(event.targetEventId)) {
          throw new Error('Отмена ссылается на отсутствующее или уже отменённое действие');
        }
        voided.add(event.targetEventId);
        break;
      }
      default:
        throw new RangeError('Неизвестное событие резерва');
    }
    prior.set(event.id, event);
  }

  let cycleNumber = 1;
  let cycleStartDate = def.openedOn;
  let dueDate = def.firstDueDate;
  let targetCents = def.targetCents;
  let paidThisCycleCents = 0;
  let reservedCents = def.openingReservedCents;
  let totalContributedCents = 0;
  let totalPaidCents = 0;
  let totalReservedUsedCents = 0;
  let skippedContributions = 0;
  const skippedSlots = new Set<string>();
  const history: ReserveHistoryItem[] = [];

  for (const event of events) {
    const inactive = voided.has(event.id);
    history.push({ ...event, voided: inactive, cycleNumber: event.kind === 'void' || inactive ? null : cycleNumber });
    if (inactive || event.kind === 'void') continue;
    switch (event.kind) {
      case 'contribution':
        reservedCents = plus(reservedCents, event.amountCents);
        totalContributedCents = plus(totalContributedCents, event.amountCents);
        break;
      case 'payment':
        if (event.reservedUsedCents > reservedCents) {
          throw new RangeError('Оплата использует больше зарезервированных денег, чем имеется');
        }
        if (event.amountCents > targetCents - paidThisCycleCents) {
          throw new RangeError('Оплата превышает остаток обязательства');
        }
        reservedCents -= event.reservedUsedCents;
        paidThisCycleCents = plus(paidThisCycleCents, event.amountCents);
        totalPaidCents = plus(totalPaidCents, event.amountCents);
        totalReservedUsedCents = plus(totalReservedUsedCents, event.reservedUsedCents);
        break;
      case 'target_change':
        if (event.targetCents < paidThisCycleCents) {
          throw new RangeError('Нельзя уменьшить цель ниже уже оплаченной суммы');
        }
        targetCents = event.targetCents;
        break;
      case 'skip': {
        if (event.slotDate <= cycleStartDate || event.slotDate > dueDate) {
          throw new RangeError('Пропущенный взнос не принадлежит текущему циклу');
        }
        const slot = parseDate(event.slotDate, 'Дата пропущенного взноса');
        const valid = dateOf(slot.year, slot.month, day) === event.slotDate;
        if (!valid) throw new RangeError('Дата пропущенного взноса не соответствует графику');
        const key = `${cycleNumber}:${event.slotDate}`;
        if (skippedSlots.has(key)) throw new Error('Этот взнос уже отмечен пропущенным');
        skippedSlots.add(key);
        skippedContributions += 1;
        break;
      }
      case 'cycle_close':
        if (paidThisCycleCents !== targetCents) {
          throw new RangeError('Закрыть цикл можно только после полной оплаты обязательства');
        }
        cycleNumber += 1;
        cycleStartDate = event.date;
        dueDate = addReserveMonths(def.firstDueDate, (cycleNumber - 1) * def.periodMonths, day);
        paidThisCycleCents = 0;
        break;
      default:
        throw new Error('Внутренняя ошибка журнала событий');
    }
  }

  const remainingObligationCents = targetCents - paidThisCycleCents;
  const fundingGapCents = Math.max(0, remainingObligationCents - reservedCents);
  const slots = installmentsBetween(asOfDate, dueDate, day);
  const schedule: ReserveInstallment[] = [];
  if (def.contributionMode === 'auto') {
    if (fundingGapCents > 0 && slots.length > 0) {
      const standard = Math.floor(fundingGapCents / slots.length);
      slots.forEach((date, index) => {
        const amountCents = index === slots.length - 1
          ? fundingGapCents - standard * (slots.length - 1)
          : standard;
        schedule.push({ date, amountCents });
      });
    }
  } else if (fundingGapCents > 0) {
    let remaining = fundingGapCents;
    for (const date of slots) {
      const amountCents = Math.min(remaining, def.fixedMonthlyCents!);
      if (amountCents === 0) break; // Fully funded: no phantom zero contributions.
      schedule.push({ date, amountCents });
      remaining -= amountCents;
    }
  }
  const scheduledCents = schedule.reduce((sum, item) => plus(sum, item.amountCents), 0);
  const projectedShortfallCents = fundingGapCents - scheduledCents;

  return {
    id: def.id,
    title: def.title,
    cycleNumber,
    dueDate,
    periodMonths: def.periodMonths,
    contributionMode: def.contributionMode,
    targetCents,
    paidThisCycleCents,
    remainingObligationCents,
    reservedCents,
    fundingGapCents,
    schedule,
    nextContribution: schedule.find((installment) => installment.amountCents > 0) ?? null,
    projectedShortfallCents,
    immediateFundingRequiredCents: schedule.length === 0 ? fundingGapCents : 0,
    daysUntilDue: ordinal(parseDate(dueDate, 'Дата оплаты')) - ordinal(parseDate(asOfDate, 'Дата расчёта')),
    overdue: asOfDate > dueDate && remainingObligationCents > 0,
    cyclePaid: remainingObligationCents === 0,
    totalContributedCents,
    totalPaidCents,
    totalReservedUsedCents,
    skippedContributions,
    history,
  };
}

/** Preview only. #33 must recheck available funds within the posting transaction. */
export function assessReserveContribution(amountCents: number, unreservedAvailableCents: number): {
  readonly canFund: boolean;
  readonly shortfallCents: number;
} {
  money(amountCents, 'Запрашиваемое пополнение', true);
  // #33 permits explicitly overdrawn accounts and signed available balances.
  // The preview must report their deficit rather than reject them as corrupt data.
  if (!Number.isSafeInteger(unreservedAvailableCents)) {
    throw new RangeError('Доступная сумма должна быть целым числом копеек');
  }
  const shortfallCents = Math.max(0, amountCents - unreservedAvailableCents);
  if (!Number.isSafeInteger(shortfallCents)) {
    throw new RangeError('Дефицит превышает допустимый диапазон копеек');
  }
  return {
    canFund: amountCents <= unreservedAvailableCents,
    shortfallCents,
  };
}
