/**
 * Read-only, fail-closed bridge from authoritative finance v2 snapshots to #6.
 * No IndexedDB mutation, API write, ledger posting or source-of-truth duplication.
 */
import {
  addReserveMonths,
  calculateReserve,
  type ReserveDefinition,
  type ReserveEvent,
  type ReserveProjection,
} from './index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MINOR = 1_000_000_000_000;
const MAX_EVENTS = 10_000;

type RecordValue = Record<string, unknown>;

export interface ReserveServerRecord {
  readonly definition: ReserveDefinition;
  readonly events: readonly ReserveEvent[];
  readonly accountId: string;
  readonly obligationId: string;
  readonly allocatedCents: number;
  readonly cycleNumber: number;
  readonly currentDueDate: string;
}

function record(value: unknown, key: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${key}: ожидается объект серверного состояния`);
  }
  return value as RecordValue;
}

function text(value: unknown, key: string, max = 160): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !value.trim()) {
    throw new RangeError(`${key}: некорректная строка`);
  }
  return value;
}

function uuid(value: unknown, key: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new RangeError(`${key}: требуется UUID`);
  }
  return value;
}

function int(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${key}: недопустимое целое значение`);
  }
  return value;
}

function day(value: unknown, key: string): string {
  if (typeof value !== 'string' || addReserveMonths(value, 0) !== value) {
    throw new RangeError(`${key}: некорректная календарная дата`);
  }
  return value;
}

function serverEvent(raw: unknown, reserveId: string, previousRevision: number): {
  event: ReserveEvent;
  revision: number;
} {
  const source = record(raw, 'Событие');
  const id = uuid(source.id, 'ID события');
  if (uuid(source.reserve_id, 'ID резерва события') !== reserveId) {
    throw new RangeError('Событие принадлежит другому резерву');
  }
  const revision = int(source.revision, 'Ревизия события', 1, Number.MAX_SAFE_INTEGER);
  if (revision <= previousRevision) {
    throw new RangeError('События имеют дублирующиеся или переставленные ревизии');
  }
  int(source.cycle_number, 'Номер цикла события', 1, 10_000);
  const date = day(source.occurred_on, 'Дата события');
  const base = { id, reserveId, date };
  switch (source.kind) {
    case 'contribution':
      return {
        event: { ...base, kind: 'contribution',
          amountCents: int(source.amount_minor, 'Сумма взноса', 1, MAX_MINOR) },
        revision,
      };
    case 'release':
      return {
        event: { ...base, kind: 'release',
          amountCents: int(source.amount_minor, 'Сумма освобождения', 1, MAX_MINOR) },
        revision,
      };
    case 'payment': {
      const amountCents = int(source.amount_minor, 'Сумма оплаты', 1, MAX_MINOR);
      return {
        event: { ...base, kind: 'payment', amountCents,
          reservedUsedCents: int(source.reserved_used_minor,
            'Оплачено из резерва', 0, amountCents) },
        revision,
      };
    }
    case 'target_change':
      return {
        event: { ...base, kind: 'target_change',
          targetCents: int(source.target_minor, 'Новая цель', 1, MAX_MINOR) },
        revision,
      };
    case 'skip':
      return {
        event: { ...base, kind: 'skip',
          slotDate: day(source.slot_on, 'Пропущенный взнос') },
        revision,
      };
    case 'cycle_close':
      return { event: { ...base, kind: 'cycle_close' }, revision };
    case 'void':
      return {
        event: { ...base, kind: 'void',
          targetEventId: uuid(source.target_event_id, 'Отменяемое событие') },
        revision,
      };
    default:
      throw new RangeError('Неизвестный вид события резерва');
  }
}

/** Null only for old finance reserves that intentionally have no recurring plan. */
export function decodeServerReserve(entity: unknown): ReserveServerRecord | null {
  const item = record(entity, 'Резерв');
  if (item.kind !== 'reserve') {
    throw new RangeError('Ожидается серверная сущность резерва');
  }
  const id = uuid(item.id, 'ID резерва');
  int(item.entity_revision, 'Ревизия резерва', 1, Number.MAX_SAFE_INTEGER);
  const data = record(item.data, 'Содержимое резерва');
  if (data.period_months === null) return null;
  const cycleNumber = int(data.cycle_number, 'Номер цикла', 1, 10_000);
  const accountId = uuid(data.account_id, 'Счёт резерва');
  const obligationId = uuid(data.obligation_id, 'Обязательство');
  const mode = data.contribution_mode;
  if (mode !== 'auto' && mode !== 'fixed') {
    throw new RangeError('Неизвестный способ взноса');
  }
  const fixed = data.fixed_monthly_minor;
  if ((mode === 'auto' && fixed !== null) || (mode === 'fixed' && fixed === null)) {
    throw new RangeError('Фиксированный взнос противоречит выбранному режиму');
  }
  const dueDay = int(data.due_day, 'День оплаты', 1, 31);
  const definition: ReserveDefinition = {
    id,
    title: text(data.title, 'Название резерва'),
    openedOn: day(data.opened_on, 'Дата открытия'),
    firstDueDate: day(data.first_due_on, 'Первоначальный срок'),
    periodMonths: int(data.period_months, 'Период', 1, 60),
    targetCents: int(data.opening_target_minor, 'Первоначальная цель', 1, MAX_MINOR),
    openingReservedCents: int(data.opening_reserved_minor, 'Начальный резерв', 0, MAX_MINOR),
    contributionMode: mode,
    dueDay,
    ...(mode === 'fixed' ? {
      fixedMonthlyCents: int(fixed, 'Фиксированный взнос', 1, MAX_MINOR),
    } : {}),
  };
  const currentDueDate = day(data.target_on, 'Ближайшая дата оплаты');
  const allocatedCents = int(data.allocated_minor, 'Выделено средств', 0, MAX_MINOR);
  if (!Array.isArray(data.allocations_by_account)) {
    throw new RangeError('Нет полного распределения средств по счетам');
  }
  let allocationSum = 0;
  for (const raw of data.allocations_by_account) {
    const allocated = record(raw, 'Распределение');
    if (uuid(allocated.account_id, 'Счёт распределения') !== accountId) {
      throw new RangeError('Резерв использует другой счёт');
    }
    allocationSum += int(allocated.allocated_minor, 'Выделенная сумма', 1, MAX_MINOR);
    if (!Number.isSafeInteger(allocationSum)) throw new RangeError('Переполнение распределения');
  }
  if (allocationSum !== allocatedCents) {
    throw new RangeError('Сумма распределения не совпадает с резервом');
  }
  if (!Array.isArray(data.event_log) || data.event_log.length > MAX_EVENTS) {
    throw new RangeError('Журнал резерва неполон или слишком большой');
  }
  const events: ReserveEvent[] = [];
  const ids = new Set<string>();
  let revision = 0;
  let lastDate = definition.openedOn;
  for (const raw of data.event_log) {
    const decoded = serverEvent(raw, id, revision);
    if (ids.has(decoded.event.id) || decoded.event.date < lastDate) {
      throw new RangeError('Дублирующиеся ID или нарушения дат в журнале');
    }
    ids.add(decoded.event.id);
    events.push(decoded.event);
    revision = decoded.revision;
    lastDate = decoded.event.date;
  }
  return { definition, events, accountId, obligationId,
    allocatedCents, cycleNumber, currentDueDate };
}

/** No network or write. Past dates exclude future events and skip live state checks. */
export function projectServerReserve(
  entity: unknown,
  asOfDate: string,
): ReserveProjection | null {
  const source = decodeServerReserve(entity);
  if (source === null) return null;
  day(asOfDate, 'Дата расчёта');
  const visible = source.events.filter(event => event.date <= asOfDate);
  const result = calculateReserve(source.definition, visible, asOfDate);
  const last = source.events.at(-1);
  if (!last || last.date <= asOfDate) {
    if (result.reservedCents !== source.allocatedCents
      || result.cycleNumber !== source.cycleNumber
      || result.dueDate !== source.currentDueDate) {
      throw new RangeError('Финансовый прогноз противоречит подтверждённому состоянию сервера');
    }
  }
  return result;
}
