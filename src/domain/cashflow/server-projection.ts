/**
 * Assemble one revision-consistent read-only server forecast.
 * The caller owns authentication and the independently confirmed checkpoint.
 * No endpoint, persistence, bank posting or cross-profile merge is performed.
 */
import { decodeCompleteFinanceState } from '../accounts/server-snapshot.ts';
import { projectServerBudgetLoans } from '../budgets/server-loan-plan.mjs';
import { buildGoalCashflowBundle } from '../goals/cashflow-bridge.ts';
import { calculateReserve, type ReserveEvent } from '../reserves/index.ts';
import { decodeServerReserve, projectServerReserve } from '../reserves/server-snapshot.ts';
import { addMonthsAnchored, dayNumber, isoDay } from './calendar.ts';
import { addCents, adaptCashflowSources } from './adapters.ts';
import { forecastCashflow } from './engine.ts';
import { readConfirmedCashflowLedger, type ConfirmedCashflowCheckpoint } from './confirmed-ledger.ts';
import type { BookedFlowDto, CashflowResult, CashflowSourcesDto, HorizonMonths,
  PlannedFlowDto, ReserveMovementDto } from './types.ts';

type Entity = { id: string; kind: string; entity_revision: number; data: Record<string, unknown> };
type OpeningReserve = CashflowSourcesDto['reserves'][number];
type Plan = { id: string; kind: 'income' | 'expense'; start: string; months: number;
  amount: number; deleted: boolean };
const MAX_MINOR = 1_000_000_000_000;
const fail = (reason: string): never => { throw Error('CASHFLOW_SOURCE: ' + reason); };
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return fail('Некорректная сумма или период');
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string') return fail('Некорректная дата');
  dayNumber(value);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Неполная сущность');
  return value as Record<string, unknown>;
}
const occurrenceKey = (id: string, on: string) => JSON.stringify([id, on]);
const active = (e: Entity, field: string) => {
  if (e.data[field] === null) return true;
  const stamp = e.data[field];
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(stamp) ||
      !Number.isFinite(Date.parse(stamp))) return fail('Некорректная дата архивации');
  return false;
};
const monthIndex = (on: string) => Number(on.slice(0, 4)) * 12 + Number(on.slice(5, 7)) - 1;
const monthText = (index: number) =>
  String(Math.floor(index / 12)).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0');

function ordinary(row: Entity): Plan {
  const d = row.data;
  if (d.direction !== 'income' && d.direction !== 'expense') return fail('Неизвестное обязательство');
  const unit = d.recurrence_unit;
  if (unit !== 'none' && unit !== 'month' && unit !== 'year') return fail('Неизвестная периодичность');
  const every = integer(d.recurrence_every, 1, 120);
  return { id: row.id, kind: d.direction, start: date(d.starts_on),
    months: unit === 'none' ? 0 : every * (unit === 'year' ? 12 : 1),
    amount: integer(d.amount_minor, 0, MAX_MINOR), deleted: !active(row, 'deleted_at') };
}
function deltaOf(event: ReserveEvent): number {
  if (event.kind === 'contribution') return event.amountCents;
  if (event.kind === 'release') return -event.amountCents;
  if (event.kind === 'payment') return -event.reservedUsedCents;
  return 0;
}

export interface ServerCashflowProjection {
  readonly result: CashflowResult;
  readonly profileId: string;
  readonly revision: number;
  readonly loanProjection: 'none' | 'estimated-calendar';
  readonly assumptions: readonly string[];
}

/** All numbers are checked integer kopecks. Unsupported historical contracts
 * throw instead of silently showing a lower debt/reserve or fake cash. */
export function projectAuthorizedCashflow(
  raw: unknown, profileId: string, actor: string, checkpoint: ConfirmedCashflowCheckpoint,
  asOfDate: string, horizonMonths: HorizonMonths,
): ServerCashflowProjection {
  const ledger = readConfirmedCashflowLedger(raw, profileId, actor, checkpoint, asOfDate);
  const view = decodeCompleteFinanceState(raw, profileId, actor);
  const entities = (raw as { entities: Entity[] }).entities;
  const end = addMonthsAnchored(asOfDate, horizonMonths);
  const opening = ledger.openingDate;
  if (![1, 3, 6, 12].includes(horizonMonths) || dayNumber(end) - dayNumber(opening) > 2000)
    return fail('Некорректный горизонт');
  const planRows = new Map(entities.filter(e => e.kind === 'obligation').map(e => [e.id, ordinary(e)]));
  const facts = ledger.actuals.filter(a => a.planId !== undefined);
  const actualById = new Map(ledger.actuals.map(a => [a.id, a]));
  const txById = new Map(entities.filter(e => e.kind === 'transaction').map(e => [e.id, e.data]));
  const paidByOccurrence = new Map<string, number>();
  const latest = new Map<string, string>();
  for (const a of facts) {
    const key = occurrenceKey(a.planId!, a.occurrenceDate!);
    if (!a.voided) paidByOccurrence.set(key, addCents(paidByOccurrence.get(key) ?? 0, a.amountCents));
    if (a.occurrenceDate! > (latest.get(a.planId!) ?? end)) latest.set(a.planId!, a.occurrenceDate!);
  }

  const plans: PlannedFlowDto[] = [];
  const planIds = new Map<string, string>();
  const reserves: OpeningReserve[] = [];
  const movements: ReserveMovementDto[] = [];
  const accountTotals = new Map(ledger.accounts.map(a => [a.id, 0]));
  const reserveStarts = new Map<string, string>();
  const reserveObligations = new Set<string>();
  const seenReservePayments = new Set<string>();
  function plan(id: string, on: string, kind: PlannedFlowDto['kind'], amount: number,
    carry = false, cancelled = false, loanCoveredCents?: number) {
    const key = occurrenceKey(id, on);
    if (planIds.has(key) || plans.length >= 20_000) fail('Дублирование или слишком много обязательств');
    const planId = 'occ:' + key;
    planIds.set(key, planId);
    plans.push({id: planId, dueDate: on, kind, amountCents: amount,
      confidence: 'estimated', ...(carry ? {carryUnpaidBeforeOpening: true} : {}),
      ...(cancelled ? {cancelled: true} : {}),
      ...(loanCoveredCents !== undefined ? {loanCoveredCents} : {})});
  }
  function addAccount(id: string, amount: number) {
    const prior = accountTotals.get(id);
    if (prior === undefined) return fail('Резерв относится к неизвестному счёту');
    accountTotals.set(id, addCents(prior, amount));
  }
  function movement(id: string, on: string, delta: number, status: 'actual' | 'planned') {
    if (delta === 0) return;
    movements.push({id, date: on, kind: delta > 0 ? 'allocate' : 'release',
      amountCents: Math.abs(delta), status});
  }

  for (const row of entities.filter(e => e.kind === 'reserve')) {
    const source = decodeServerReserve(row);
    if (source === null) return fail('Старый резерв не содержит подтверждённой истории по датам');
    const def = source.definition;
    const obligation = planRows.get(source.obligationId);
    if (!obligation || obligation.kind !== 'expense' || reserveObligations.has(source.obligationId))
      return fail('Неоднозначная история обязательства и резерва');
    reserveObligations.add(source.obligationId);
    if (def.openedOn > asOfDate || source.events.some(e => e.date > asOfDate))
      return fail('Снимок резерва содержит будущее событие');
    const projection = projectServerReserve(row, asOfDate)!;
    const isActive = active(row, 'archived_at');
    if (isActive && obligation.deleted) return fail('Действующий резерв у удалённого обязательства');
    if (!isActive && (source.allocatedCents !== 0 || source.events.some(e => e.kind === 'payment')))
      return fail('Архивный резерв требует отдельной исторической сверки');
    if (isActive) reserveStarts.set(obligation.id, def.openedOn);

    let locked = 0, beforeOpening = 0;
    function factual(id: string, on: string, delta: number) {
      locked = addCents(locked, delta);
      if (locked < 0) fail('Отрицательный подтверждённый резерв');
      if (on < opening) beforeOpening = addCents(beforeOpening, delta);
      else movement('reserve:' + row.id + ':' + id, on, delta, 'actual');
    }
    factual('opening', def.openedOn, def.openingReservedCents);
    const byEvent = new Map<string, ReserveEvent>();
    const rawEvents = row.data.event_log as unknown[];
    const dueFor = (cycle: number) => addMonthsAnchored(def.firstDueDate,
      (cycle - 1) * def.periodMonths, def.dueDay);
    for (let i = 0; i < source.events.length; i++) {
      const event = source.events[i]!;
      const wire = object(rawEvents[i]);
      if (event.kind === 'payment') {
        const txId = wire.transaction_id;
        if (typeof txId !== 'string' || seenReservePayments.has(txId))
          return fail('Повторная или отсутствующая проводка резерва');
        seenReservePayments.add(txId);
        const a = actualById.get(txId);
        const cycle = integer(wire.cycle_number, 1, 10_000);
        if (!a || a.kind !== 'expense' || a.planId !== obligation.id ||
            a.occurrenceDate !== dueFor(cycle) || a.date !== event.date ||
            a.amountCents !== event.amountCents ||
            Boolean(a.voided) !== projection.history[i]?.voided)
          return fail('Оплата резерва не совпадает с проводкой');
        const tx = txById.get(txId)!;
        if (event.reservedUsedCents > 0) {
          const allocation = object(tx.reserve_allocation);
          if (allocation.reserve_id !== row.id || allocation.account_id !== source.accountId ||
              allocation.delta_minor !== -event.reservedUsedCents)
            return fail('Освобождение резерва не совпадает с оплатой');
        } else if (Object.hasOwn(tx, 'reserve_allocation'))
          return fail('Лишнее освобождение резерва');
      }
      let delta = deltaOf(event);
      if (event.kind === 'void') {
        const prior = byEvent.get(event.targetEventId);
        if (!prior) return fail('Отсутствует отменяемое событие');
        delta = -deltaOf(prior);
        if (prior.kind === 'payment') {
          const original = rawEvents[source.events.findIndex(e => e.id === prior.id)];
          const tx = actualById.get(String(object(original).transaction_id));
          if (!tx?.voided || tx.reversedOn !== event.date)
            return fail('Несогласованная дата отмены оплаты резерва');
        }
      }
      factual(event.id, event.date, delta);
      byEvent.set(event.id, event);
    }
    if (locked !== source.allocatedCents || beforeOpening < 0)
      return fail('История резерва не сходится');
    reserves.push({id: 'reserve:' + row.id, accountId: source.accountId,
      openingReservedCents: beforeOpening});
    addAccount(source.accountId, locked);
    if (!isActive) continue;

    // For the reserve-owned portion, #6 defines the payment amount and
    // due date, not a second copy of the base obligation's recurrence.
    let cycle = 1, target = def.targetCents;
    for (const event of projection.history) {
      if (event.voided || event.kind === 'void') continue;
      if (event.kind === 'target_change') target = event.targetCents;
      if (event.kind === 'cycle_close') {
        const due = dueFor(cycle);
        if ((paidByOccurrence.get(occurrenceKey(obligation.id, due)) ?? 0) !== target)
          return fail('Закрытый цикл не совпадает с подтверждёнными оплатами');
        plan(obligation.id, due, 'obligation', target, true);
        cycle++;
      }
    }
    if (cycle !== projection.cycleNumber || target !== projection.targetCents)
      return fail('Не согласованы циклы резерва');
    const currentPaid = paidByOccurrence.get(occurrenceKey(obligation.id, projection.dueDate)) ?? 0;
    if (currentPaid !== projection.paidThisCycleCents)
      return fail('Частичная оплата цикла требует сверки с резервом');
    plan(obligation.id, projection.dueDate, 'obligation', target, true);

    // Model future allocations and payment releases. These are proposals,
    // not writes. After the current cycle assume unchanged target/cadence.
    let modeledLocked = locked;
    let previousPayment = asOfDate;
    for (let n = cycle; n <= 10_000; n++) {
      const due = dueFor(n);
      if (due > end) break;
      const current = n === cycle;
      if (!current && due <= asOfDate)
        return fail('Незакрытый резерв имеет несколько прошедших циклов');
      if (!current) plan(obligation.id, due, 'obligation', target, true);
      const paid = current ? currentPaid : paidByOccurrence.get(occurrenceKey(obligation.id, due)) ?? 0;
      if (!current && paid !== 0) return fail('Предоплата будущего цикла требует сверки');
      const remaining = target - paid;
      if (remaining < 0) return fail('Переплата обязательства');
      const schedule = current ? projection.schedule :
        calculateReserve({...def, openedOn: previousPayment, firstDueDate: due,
          openingReservedCents: modeledLocked, targetCents: target}, [], previousPayment).schedule;
      for (const slot of schedule) {
        const amount = Math.min(slot.amountCents, Math.max(0, remaining - modeledLocked));
        movement('reserve-plan:' + row.id + ':' + n + ':' + slot.date, slot.date, amount, 'planned');
        modeledLocked = addCents(modeledLocked, amount);
      }
      const paymentDate = due < asOfDate ? asOfDate : due;
      const release = Math.min(modeledLocked, remaining);
      movement('reserve-use:' + row.id + ':' + n, paymentDate, -release, 'planned');
      modeledLocked -= release;
      previousPayment = paymentDate;
    }
  }

  for (const p of planRows.values()) {
    const reserveStart = reserveStarts.get(p.id);
    const limit = latest.get(p.id) ?? end;
    for (let n = 0; n <= 20_000; n++) {
      const due = n === 0 ? p.start : addMonthsAnchored(p.start, n * p.months);
      if (due > limit || reserveStart && due >= reserveStart) break;
      if (!p.deleted || facts.some(a => a.planId === p.id && a.occurrenceDate === due)) {
        const kind = p.kind === 'income' ? 'income' : p.months ? 'obligation' : 'irregular';
        plan(p.id, due, kind, p.amount, p.kind === 'expense', p.deleted);
      }
      if (!p.months) break;
      if (n === 20_000) fail('История обязательства слишком велика');
    }
  }
  const actuals: BookedFlowDto[] = ledger.actuals.map(a => {
    if (a.planId === undefined) return a;
    const key = occurrenceKey(a.planId, a.occurrenceDate!);
    const id = planIds.get(key);
    if (!id) return fail('Не найдена исходная дата подтверждённой оплаты');
    return {...a, planId: id};
  });

  const base: CashflowSourcesDto = {openingDate: opening, asOfDate, horizonMonths,
    accounts: ledger.accounts, actuals, plans, reserves, reserveMovements: movements};
  // #37's existing bridge replays each goal once. Compare its opening +
  // movements with the authoritative allocation, before summing #6 and #37.
  for (const goal of view.goals) {
    if (goal.record.events.some(e => e.on > asOfDate)) return fail('Снимок цели содержит будущее событие');
    const bundle = buildGoalCashflowBundle([goal.record], base, [{goalId: goal.id, accountId: goal.accountId}]);
    const total = bundle.openingReserves.reduce((s, a) => addCents(s, a.openingReservedCents), 0);
    const actual = bundle.movements.filter(e => e.status === 'actual')
      .reduce((s, e) => addCents(s, e.kind === 'allocate' ? e.amountCents : -e.amountCents), total);
    if (actual !== goal.savedMinor) return fail('История финансовой цели не сходится');
    reserves.push(...bundle.openingReserves);
    movements.push(...bundle.movements);
    addAccount(goal.accountId, actual);
  }
  for (const [id, total] of accountTotals) {
    if (total !== view.reservedMinorByAccount[id]) return fail('Резервы и цели не сходятся со счётом');
  }

  const loans = entities.filter(e => e.kind === 'loan' && active(e, 'deleted_at'));
  if (loans.length) {
    const first = Math.min(...loans.map(e => monthIndex(date(e.data.as_of_date))), monthIndex(opening));
    const last = monthIndex(end);
    const loanFacts = entities.filter(e => e.kind === 'loan_payment').length;
    if (last - first > 1200 || (last - first + 1) * (entities.length + loans.length * (loanFacts + 1)) > 10_000_000)
      return fail('История кредитов слишком велика');
    for (let m = first; m <= last; m++) {
      const projected = projectServerBudgetLoans(entities, monthText(m));
      if (projected.missing) return fail('Недостаточно данных кредитного графика');
      for (const e of projected.events) {
        const due = date(e.date);
        const amount = integer(e.plannedCents, 0, Number.MAX_SAFE_INTEGER);
        const paid = integer(e.paidCents, 0, Number.MAX_SAFE_INTEGER);
        if (due <= end) plan('loan:' + e.id, due, 'loan', amount, true, false, Math.min(amount, paid));
      }
    }
  }
  const result = forecastCashflow(adaptCashflowSources(base));
  if (result.confirmedAsOfBalanceCents !== ledger.confirmedAsOfBalanceCents ||
      result.confirmedAsOfReservedCents !== ledger.confirmedAsOfReservedCents)
    return fail('Итог расчёта не совпадает с подтверждённым снимком');
  return {result, profileId: ledger.profileId, revision: ledger.revision,
    loanProjection: loans.length ? 'estimated-calendar' : 'none',
    assumptions: [
      'Будущие поступления и взносы являются оценкой. Подтверждённые остатки относятся к финансовому журналу, а не к банковской выписке.',
      'Будущие циклы резервов рассчитаны при неизменной цели и периодичности.',
      ...(loans.length ? ['Кредитные платежи рассчитаны по существующей приблизительной месячной модели; будущие досрочные платежи не предполагаются. Банковская точность не подтверждена.'] : []),
    ]};
}
