/**
 * #6: validate that a COMMIT receipt actually produced the intended
 * authoritative state transition. Server PostgreSQL remains the sole writer.
 * Never infer success merely from a profile-revision increment or HTTP 201.
 */
import type { ReservesServerView, ReserveViewRow } from './reserves-finance-gateway.ts';
import type { ReserveV2Action } from '../domain/reserves/v2-wire.ts';

function row(view: ReservesServerView, id: unknown): ReserveViewRow | undefined {
  return view.reserves.find((item) => item.id === id);
}
function minor(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
function amountChanges(
  before: ReservesServerView, after: ReservesServerView,
  bankDelta: number, reservedDelta: number,
): boolean {
  return Number.isSafeInteger(bankDelta) &&
    Number.isSafeInteger(reservedDelta) &&
    after.totalMinor === before.totalMinor + bankDelta &&
    after.reservedMinor === before.reservedMinor + reservedDelta &&
    after.availableMinor === before.availableMinor + bankDelta - reservedDelta;
}
function accountChanges(
  before: ReservesServerView, after: ReservesServerView, accountId: unknown,
  balanceDelta: number, reservedDelta: number,
): boolean {
  const prior = before.accounts.find((item) => item.id === accountId);
  const next = after.accounts.find((item) => item.id === accountId);
  return !!prior && !!next &&
    next.balanceMinor === prior.balanceMinor + balanceDelta &&
    next.reservedMinor === prior.reservedMinor + reservedDelta &&
    next.availableMinor === prior.availableMinor + balanceDelta - reservedDelta;
}

export function verifyReservePostcondition(
  before: ReservesServerView, after: ReservesServerView,
  action: ReserveV2Action, payload: Readonly<Record<string, unknown>>,
): boolean {
  if (after.profileId !== before.profileId ||
      after.revision !== before.revision + 1) return false;

  const prior = row(before, payload.reserve_id);
  const next = row(after, payload.reserve_id);
  const unchangedBank = amountChanges(before, after, 0, 0);
  switch (action) {
    case 'reserve.create': {
      const created = row(after, payload.id);
      const opening = minor(payload.opening_reserved_minor);
      const target = minor(payload.target_minor);
      return !row(before, payload.id) && !!created && opening !== null &&
        target !== null && target > 0 && opening >= 0 &&
        created.obligationId === payload.obligation_id &&
        created.accountId === payload.account_id &&
        created.source.allocatedCents === opening &&
        created.projection.targetCents === target &&
        created.source.definition.title === payload.title &&
        amountChanges(before, after, 0, opening) &&
        accountChanges(before, after, payload.account_id, 0, opening);
    }
    case 'reserve.allocate': {
      const delta = minor(payload.delta_minor);
      if (!prior || !next || delta === null || delta === 0) return false;
      const event = next.history.at(-1);
      return next.source.allocatedCents === prior.source.allocatedCents + delta &&
        next.history.length === prior.history.length + 1 &&
        event?.kind === (delta > 0 ? 'contribution' : 'release') &&
        event.amountMinor === Math.abs(delta) &&
        amountChanges(before, after, 0, delta) &&
        accountChanges(before, after, payload.account_id, 0, delta);
    }
    case 'settlement.payment.record': {
      const paid = minor(payload.amount_minor);
      const used = minor(payload.reserved_used_minor);
      if (!prior || !next || paid === null || paid <= 0 || used === null ||
          used < 0 || used > paid) return false;
      const event = next.history.at(-1);
      return next.source.allocatedCents === prior.source.allocatedCents - used &&
        next.history.length === prior.history.length + 1 &&
        event?.kind === 'payment' && event.amountMinor === paid &&
        event.reservedUsedMinor === used &&
        event.transactionId === payload.transaction_id &&
        event.settlementId === payload.fact_id &&
        amountChanges(before, after, -paid, -used) &&
        accountChanges(before, after, payload.account_id, -paid, -used);
    }
    case 'settlement.payment.void': {
      if (!prior || !next) return false;
      const event = prior.history.find((entry) =>
        entry.kind === 'payment' && entry.transactionId === payload.transaction_id &&
        entry.settlementId === payload.fact_id && !entry.voided);
      if (!event || event.amountMinor === null || event.reservedUsedMinor === null) {
        return false;
      }
      const paid = event.amountMinor;
      const used = event.reservedUsedMinor;
      return next.history.length === prior.history.length + 1 &&
        next.history.some((entry) => entry.id === event.id && entry.voided) &&
        next.source.allocatedCents === prior.source.allocatedCents + used &&
        amountChanges(before, after, paid, used) &&
        accountChanges(before, after, payload.account_id, paid, used);
    }
    case 'reserve.update':
      return !!prior && !!next && unchangedBank &&
        next.source.definition.title === payload.title &&
        next.projection.targetCents === payload.target_minor &&
        next.source.definition.periodMonths === payload.period_months &&
        next.source.definition.contributionMode === payload.contribution_mode;
    case 'reserve.archive':
      return !!prior && !!next && !prior.archived && next.archived && unchangedBank &&
        next.source.allocatedCents === 0;
    case 'reserve.skip':
      return !!prior && !!next && unchangedBank &&
        next.history.length === prior.history.length + 1 &&
        next.history.at(-1)?.kind === 'skip';
    case 'reserve.cycle.close':
      return !!prior && !!next && unchangedBank &&
        next.source.cycleNumber === prior.source.cycleNumber + 1 &&
        next.projection.dueDate > prior.projection.dueDate;
    case 'reserve.cycle.void':
      return !!prior && !!next && unchangedBank &&
        next.source.cycleNumber === prior.source.cycleNumber - 1 &&
        next.projection.dueDate < prior.projection.dueDate;
    case 'reserve.event.void': {
      if (!prior || !next) return false;
      const event = prior.history.find((item) =>
        item.id === payload.target_event_id && !item.voided);
      if (!event || next.history.length !== prior.history.length + 1 ||
          !next.history.some((item) => item.id === event.id && item.voided)) {
        return false;
      }
      if (event.kind === 'skip') return unchangedBank;
      if ((event.kind !== 'contribution' && event.kind !== 'release') ||
          event.amountMinor === null) return false;
      const delta = event.kind === 'contribution' ? -event.amountMinor : event.amountMinor;
      return next.source.allocatedCents === prior.source.allocatedCents + delta &&
        amountChanges(before, after, 0, delta) &&
        accountChanges(before, after, payload.account_id, 0, delta);
    }
    default:
      return false;
  }
}
