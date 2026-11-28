/** Goal wire validation for complete server snapshots, delta commits and receipts. */
import { calculateGoal, goalLedgerLinks, MAX_GOAL_CENTS } from './engine.ts';
import type { GoalRecord, GoalEvent } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(reason: string): never { throw Error('INVALID_GOAL_SNAPSHOT: ' + reason); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Некорректный идентификатор');
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail('Недопустимая сумма или ревизия');
  }
  return value;
}
export function canonicalGoalValue(value: unknown): string {
  return JSON.stringify(value, (_key, part: unknown) => object(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
}
export interface ServerGoal {
  id: string;
  accountId: string;
  entityRevision: number;
  savedMinor: number;
  record: GoalRecord;
}
export function decodeGoalEntity(raw: unknown): ServerGoal {
  if (!object(raw) || raw.kind !== 'goal' || !object(raw.data)) fail('Неизвестная сущность цели');
  const id = uuid(raw.id), data = raw.data;
  const accountId = uuid(data.account_id);
  if (id === accountId || Object.keys(data).length !== 3 ||
      !Array.isArray(data.event_log) || data.event_log.length > 1000) fail('Повреждён журнал цели');
  const entityRevision = integer(raw.entity_revision, 1, 1000);
  if (data.event_log.length !== entityRevision) fail('Неполный журнал цели');
  const savedMinor = integer(data.saved_minor, 0, MAX_GOAL_CENTS);
  for (const event of data.event_log) {
    if (!object(event)) fail('Недопустимое событие цели');
    uuid(event.id);
    if (Object.hasOwn(event, 'ledgerMovementId')) uuid(event.ledgerMovementId);
    if (Object.hasOwn(event, 'ledgerReversalId')) uuid(event.ledgerReversalId);
  }
  const record: GoalRecord = {version: 1, id, events: structuredClone(data.event_log) as GoalEvent[]};
  if (calculateGoal(record, '2200-12-31').savedCents !== savedMinor) fail('Итог журнала цели не сходится');
  return {id, accountId, entityRevision, savedMinor, record};
}
export function assertGoalHistoryExtends(before: ServerGoal, after: ServerGoal): void {
  if (before.id !== after.id || before.accountId !== after.accountId ||
      before.entityRevision > after.entityRevision ||
      before.record.events.some((event, i) =>
        canonicalGoalValue(event) !== canonicalGoalValue(after.record.events[i]))) {
    fail('История цели удалена или изменена');
  }
}
/** Check the exact account/reserve/goal allocation totals and every linked actual posting. */
export function decodeGoalEntities(entities: readonly unknown[]): ServerGoal[] {
  const goals: ServerGoal[] = [];
  const accounts = new Map<string, Record<string, unknown>>();
  const transactions = new Map<string, Record<string, unknown>>();
  const ids = new Set<string>(), eventIds = new Set<string>();
  for (const row of entities) {
    if (!object(row)) fail('Недопустимая запись');
    if (row.kind === 'goal') {
      const goal = decodeGoalEntity(row);
      if (ids.has(goal.id)) fail('Повтор цели');
      ids.add(goal.id); goals.push(goal);
      for (const event of goal.record.events) {
        if (eventIds.has(event.id)) fail('Повтор события целей');
        eventIds.add(event.id);
      }
    } else if (row.kind === 'account' && object(row.data)) accounts.set(uuid(row.id), row.data);
    else if (row.kind === 'transaction' && object(row.data)) transactions.set(uuid(row.id), row.data);
  }
  if (!goals.length) return goals;
  if (goals.length > 500 || eventIds.size > 25000) fail('Лимит журнала целей');
  for (const row of entities) {
    if (object(row) && row.kind !== 'goal' && typeof row.id === 'string' && ids.has(row.id)) {
      fail('Идентификатор цели занят');
    }
  }
  const totals = new Map<string, bigint>();
  function add(account: string, amount: number) {
    if (!accounts.has(account)) fail('Счёт цели или резерва отсутствует');
    totals.set(account, (totals.get(account) ?? 0n) + BigInt(amount));
  }
  for (const goal of goals) add(goal.accountId, goal.savedMinor);
  for (const row of entities) {
    if (!object(row) || row.kind !== 'reserve') continue;
    if (!object(row.data) || !Array.isArray(row.data.allocations_by_account)) fail('Нет разбивки резерва');
    const seen = new Set<string>(); let total = 0n;
    for (const pair of row.data.allocations_by_account) {
      if (!object(pair)) fail('Повреждена разбивка резерва');
      const id = uuid(pair.account_id), value = integer(pair.allocated_minor);
      if (seen.has(id)) fail('Повтор счёта резерва');
      seen.add(id); add(id, value); total += BigInt(value);
    }
    if (total !== BigInt(integer(row.data.allocated_minor))) fail('Итог резерва не сходится');
  }
  for (const [id, data] of accounts) {
    const reserved = BigInt(integer(data.reserved_minor)), balance = BigInt(integer(data.balance_minor, -Number.MAX_SAFE_INTEGER));
    if (reserved !== (totals.get(id) ?? 0n) || (reserved > 0n && reserved > balance)) {
      fail('Накопления и обязательные резервы превышают или не совпадают с остатком');
    }
  }
  const byGoal = new Map(goals.map(g => [g.id, g]));
  for (const link of goalLedgerLinks(goals.map(g => g.record))) {
    const goal = byGoal.get(link.goalId)!;
    const event = goal.record.events.find(e => e.id === link.eventId)!;
    const movement = transactions.get(link.ledgerMovementId);
    if (!movement || movement.occurred_on !== event.on || Object.hasOwn(movement, 'reserve_allocation') ||
        Object.hasOwn(movement, 'payment_link')) fail('Нет подтверждённой проводки цели');
    const kind = link.expectedLedgerKind === 'internal-transfer' ? 'transfer' : link.expectedLedgerKind;
    if (movement.kind !== kind || !Array.isArray(movement.postings)) fail('Тип проводки цели не совпадает');
    const postings = movement.postings as unknown[];
    const posting = postings.filter(p => object(p) && p.account_id === goal.accountId);
    let signed = event.type === 'contribution' ? link.amountCents : -link.amountCents;
    if (event.type === 'void') {
      const original = goal.record.events.find(e => e.id === event.eventId);
      if (!original || (original.type !== 'contribution' && original.type !== 'use') ||
          movement.reversed_transaction_id !== original.ledgerMovementId) fail('Неверная компенсация цели');
      signed = original.type === 'contribution' ? -link.amountCents : link.amountCents;
      const originalTx = transactions.get(original.ledgerMovementId!);
      if (!originalTx || !Array.isArray(originalTx.postings) ||
          originalTx.postings.length !== movement.postings.length ||
          originalTx.postings.some(p => !object(p) || typeof p.signed_minor !== 'number' ||
            !postings.some((q: unknown) => object(q) && q.account_id === p.account_id &&
              q.signed_minor === -(p.signed_minor as number)))) fail('Компенсация не обратна проводке');
    } else {
      const reversed = [...transactions.entries()].filter(([, t]) => t.reversed_transaction_id === link.ledgerMovementId);
      const correction = goal.record.events.find(e => e.type === 'void' && e.eventId === event.id);
      const expected = correction?.type === 'void' ? correction.ledgerReversalId : undefined;
      if (reversed.length !== (expected ? 1 : 0) || (expected && reversed[0]?.[0] !== expected)) {
        fail('Отмена проводки не отражена в цели');
      }
    }
    if (posting.length !== 1 || (posting[0] as Record<string, unknown> | undefined)?.signed_minor !== signed) fail('Сумма проводки цели не совпадает');
    if (kind === 'expense' && movement.postings.length !== 1 ||
        kind === 'transfer' && (movement.postings.length !== 2 ||
          movement.postings.some(p => !object(p) || !accounts.has(String(p.account_id))) ||
          !movement.postings.some(p => object(p) && p.account_id !== goal.accountId && p.signed_minor === -signed))) {
      fail('Некорректное движение по собственным счетам');
    }
  }
  return goals;
}
/** Full resnapshot may add events, never remove or rewrite a previously confirmed goal. */
export function assertGoalSnapshotExtends(before: readonly unknown[], after: readonly unknown[]): void {
  const old = before.filter(x => object(x) && x.kind === 'goal').map(decodeGoalEntity);
  const next = new Map(after.filter(x => object(x) && x.kind === 'goal').map(decodeGoalEntity).map(g => [g.id, g]));
  for (const goal of old) {
    const found = next.get(goal.id);
    if (!found) fail('Серверный снимок потерял цель');
    assertGoalHistoryExtends(goal, found);
  }
}
