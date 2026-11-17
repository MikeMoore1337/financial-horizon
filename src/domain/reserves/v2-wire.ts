/** #6 pure command encoder for the server-verified, ETag-protected finance v2 API.
 * No fetch, persistence, identity claims or automatic retry. All money is kopecks.
 */
import { addReserveMonths } from './index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_MINOR = 1_000_000_000_000;

export type ReserveV2Action =
  | 'reserve.create' | 'reserve.update' | 'reserve.archive'
  | 'reserve.allocate' | 'reserve.skip'
  | 'reserve.cycle.close' | 'reserve.cycle.void'
  | 'reserve.event.void' | 'settlement.payment.record'
  | 'settlement.payment.void';

export interface ReserveV2Input {
  action: ReserveV2Action;
  payload: Readonly<Record<string, unknown>>;
  clientMutationId: string;
  baseRevision: number;
  expectedEntityRevisions: Readonly<Record<string, number>>;
  ifMatch: string;
}

export interface EncodedReserveV2 {
  readonly path: '/api/finance/v2/commands';
  readonly headers: Readonly<{
    'Content-Type': 'application/json';
    'If-Match': string;
    'Idempotency-Key': string;
  }>;
  readonly body: Readonly<{
    schema_version: 2;
    client_mutation_id: string;
    base_revision: number;
    action: ReserveV2Action;
    expected_entity_revisions: Readonly<Record<string, number>>;
    payload: Readonly<Record<string, unknown>>;
  }>;
}

const shapes: Readonly<Record<ReserveV2Action, readonly [readonly string[], readonly string[]]>> = {
  'reserve.create': [[
    'id', 'obligation_id', 'account_id', 'title', 'target_minor',
    'opened_on', 'first_due_on', 'period_months', 'due_day',
    'contribution_mode', 'opening_reserved_minor',
  ], ['fixed_monthly_minor']],
  'reserve.update': [[
    'reserve_id', 'title', 'target_minor', 'first_due_on',
    'period_months', 'due_day', 'contribution_mode',
  ], ['fixed_monthly_minor', 'occurred_on']],
  'reserve.archive': [['reserve_id'], []],
  'reserve.allocate': [['reserve_id', 'account_id', 'delta_minor'], ['occurred_on']],
  'reserve.skip': [['reserve_id', 'slot_on', 'occurred_on'], []],
  'reserve.cycle.close': [['reserve_id', 'occurred_on'], []],
  'reserve.cycle.void': [['reserve_id', 'occurred_on', 'reason'], []],
  'reserve.event.void': [['reserve_id', 'account_id', 'target_event_id', 'occurred_on', 'reason'], []],
  'settlement.payment.record': [[
    'transaction_id', 'fact_id', 'account_id', 'obligation_id', 'amount_minor', 'paid_on',
    'occurrence_on', 'reserve_id', 'reserved_used_minor',
  ], []],
  'settlement.payment.void': [[
    'transaction_id', 'fact_id', 'account_id', 'reserve_id', 'reason',
  ], []],
};

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RangeError('Некорректный UUID');
  return value;
}
function safeInt(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < min || value > max) throw new RangeError('Некорректное целое значение');
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || addReserveMonths(value, 0) !== value) {
    throw new RangeError('Некорректная дата');
  }
  return value;
}
function nonblank(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new RangeError('Некорректный текст');
  }
  return value;
}
function shape(raw: unknown, action: ReserveV2Action): Readonly<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new TypeError('Некорректные поля финансовой команды');
  }
  const source = raw as Record<string, unknown>;
  const [required, optional] = shapes[action];
  const permitted = new Set<string>([...required, ...optional]);
  if (Object.keys(source).some(key => !permitted.has(key))
      || required.some(key => !Object.hasOwn(source, key))) {
    throw new RangeError('Неизвестные или отсутствующие поля команды');
  }
  return Object.freeze({ ...source });
}

function checkPayload(action: ReserveV2Action, p: Readonly<Record<string, unknown>>): string[] {
  for (const key of ['id', 'reserve_id', 'account_id', 'obligation_id', 'target_event_id',
      'transaction_id', 'fact_id']) {
    if (Object.hasOwn(p, key)) uuid(p[key]);
  }
  for (const key of ['opened_on', 'first_due_on', 'occurred_on', 'slot_on',
      'paid_on', 'occurrence_on']) {
    if (p[key] !== undefined && p[key] !== null) date(p[key]);
  }
  for (const key of ['target_minor', 'amount_minor', 'fixed_monthly_minor']) {
    if (p[key] !== undefined && p[key] !== null) safeInt(p[key], 1, MAX_MINOR);
  }
  if (Object.hasOwn(p, 'opening_reserved_minor')) safeInt(p.opening_reserved_minor, 0, MAX_MINOR);
  if (Object.hasOwn(p, 'delta_minor') && safeInt(p.delta_minor, -MAX_MINOR, MAX_MINOR) === 0) {
    throw new RangeError('Нулевое движение резерва');
  }
  if (Object.hasOwn(p, 'reserved_used_minor')) {
    const used = safeInt(p.reserved_used_minor, 0, MAX_MINOR);
    if (used > safeInt(p.amount_minor, 1, MAX_MINOR)) throw new RangeError('Резерв больше оплаты');
  }
  if (Object.hasOwn(p, 'title')) nonblank(p.title, 160);
  if (Object.hasOwn(p, 'reason')) nonblank(p.reason, 500);

  if (action === 'reserve.create' || action === 'reserve.update') {
    safeInt(p.period_months, 1, 60);
    safeInt(p.due_day, 1, 31);
    if (p.contribution_mode !== 'auto' && p.contribution_mode !== 'fixed') {
      throw new RangeError('Некорректный способ пополнения');
    }
    if (p.contribution_mode === 'fixed' && p.fixed_monthly_minor === undefined) {
      throw new RangeError('Нужен фиксированный взнос');
    }
    if (p.contribution_mode === 'auto' && p.fixed_monthly_minor !== undefined) {
      throw new RangeError('Автоматический режим не имеет фиксированной суммы');
    }
    const first = date(p.first_due_on);
    if (addReserveMonths(first, 0, p.due_day as number) !== first) {
      throw new RangeError('День месяца противоречит первой дате');
    }
    if (action === 'reserve.create') {
      const opened = date(p.opened_on);
      const months = (Number(first.slice(0, 4)) - Number(opened.slice(0, 4))) * 12
        + Number(first.slice(5, 7)) - Number(opened.slice(5, 7));
      if (first < opened || months > (p.period_months as number)) {
        throw new RangeError('Первая оплата должна входить в первый цикл');
      }
    }
  }
  switch (action) {
    case 'reserve.create': return [uuid(p.account_id), uuid(p.obligation_id)];
    case 'reserve.allocate':
    case 'reserve.event.void': return [uuid(p.account_id), uuid(p.reserve_id)];
    case 'settlement.payment.record': return [
      uuid(p.account_id), uuid(p.obligation_id), uuid(p.reserve_id),
    ];
    case 'settlement.payment.void': return [
      uuid(p.transaction_id), uuid(p.fact_id), uuid(p.account_id), uuid(p.reserve_id),
    ];
    default: return [uuid(p.reserve_id)];
  }
}

/** The caller must obtain revision/ETag from a complete authenticated server snapshot. */
export function encodeReserveV2(input: ReserveV2Input): EncodedReserveV2 {
  if (!input || !Object.hasOwn(shapes, input.action)) {
    throw new RangeError('Команда резервирования не поддерживается');
  }
  const mutation = uuid(input.clientMutationId);
  const revision = safeInt(input.baseRevision, 0, Number.MAX_SAFE_INTEGER);
  if (typeof input.ifMatch !== 'string' || !STRONG_ETAG.test(input.ifMatch)) {
    throw new RangeError('Нужен сильный If-Match');
  }
  const payload = shape(input.payload, input.action);
  const required = new Set(checkPayload(input.action, payload));
  const source = input.expectedEntityRevisions;
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).length !== required.size) {
    throw new RangeError('Неполные ревизии зависимых сущностей');
  }
  const versions: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (!required.has(uuid(key))) throw new RangeError('Лишняя ревизия');
    versions[key] = safeInt(value, 1, Number.MAX_SAFE_INTEGER);
  }
  return Object.freeze({
    path: '/api/finance/v2/commands' as const,
    headers: Object.freeze({
      'Content-Type': 'application/json' as const,
      'If-Match': input.ifMatch,
      'Idempotency-Key': mutation,
    }),
    body: Object.freeze({
      schema_version: 2 as const,
      client_mutation_id: mutation,
      base_revision: revision,
      action: input.action,
      expected_entity_revisions: Object.freeze(versions),
      payload,
    }),
  });
}
