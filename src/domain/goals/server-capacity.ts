/**
 * Read-only reconciliation against the CURRENT pre-goals #33/#6 /state wire.
 * Caller must provide authenticated, complete snapshots at one revision.
 * This does not authorize, persist, lock, or post any operation.
 * The server must enforce the same invariants atomically before enabling writes.
 */
import {decodeCompleteFinanceState} from '../accounts/server-snapshot.ts';
import {assertGoalDate} from './calendar.ts';
import {goalLedgerLinks} from './engine.ts';
import {encodeGoalsSnapshot, type GoalsSnapshotV1} from './snapshot.ts';
import {reconcileGoalCapacity, type MandatoryCapacityReserve} from './allocation-capacity.ts';
import type {GoalAccountBinding} from './cashflow-bridge.ts';

type Entity = {id: string; kind: string; data: Record<string, unknown>};
function reject(message: string): never {
  throw new Error('GOAL_RECONCILIATION: ' + message);
}

export function reconcileGoalsWithFinanceSnapshot(
  raw: unknown, expectedProfileId: string, verifiedActorUserId: string,
  snapshot: GoalsSnapshotV1, bindings: readonly GoalAccountBinding[], asOfDate: string,
) {
  assertGoalDate(asOfDate);
  const view = decodeCompleteFinanceState(raw, expectedProfileId, verifiedActorUserId);
  const ledger = view.ledger;
  encodeGoalsSnapshot(snapshot);
  if (snapshot.scopeKey !== expectedProfileId || snapshot.revision !== ledger.revision) {
    reject('Goal scope or revision differs from account snapshot');
  }
  // Current account balances are not historical balances. Refuse future goal
  // events here; the separate historical projection accepts as-of dates.
  if (snapshot.goals.some(g => g.events.some(e => e.on > asOfDate)) ||
      ledger.transactions.some(t => t.occurredOn > asOfDate)) {
    reject('Current snapshot includes future events');
  }
  const entities = (raw as {entities: Entity[]}).entities;
  const accountIds = new Set(ledger.accounts.map(a => a.id));
  const totals = new Map<string, bigint>();
  const mandatoryReserves: MandatoryCapacityReserve[] = [];
  for (const entity of entities.filter(e => e.kind === 'reserve')) {
    const pairs = entity.data.allocations_by_account;
    if (!Array.isArray(pairs)) reject('Missing mandatory reserve breakdown');
    let total = 0n;
    const seen = new Set<string>();
    for (const pair of pairs) {
      if (!pair || typeof pair.account_id !== 'string' ||
          !accountIds.has(pair.account_id) || seen.has(pair.account_id) ||
          !Number.isSafeInteger(pair.allocated_minor) || pair.allocated_minor < 0) {
        reject('Invalid mandatory reserve allocation');
      }
      const accountId: string = pair.account_id;
      const amount: number = pair.allocated_minor;
      seen.add(accountId);
      total += BigInt(amount);
      totals.set(accountId, (totals.get(accountId) ?? 0n) + BigInt(amount));
      mandatoryReserves.push({id: entity.id + ':' + accountId,
        scopeKey: expectedProfileId, accountId, allocatedCents: amount});
    }
    if (!Number.isSafeInteger(entity.data.allocated_minor) ||
        total !== BigInt(entity.data.allocated_minor as number)) reject('Reserve total differs');
  }
  for (const id of accountIds) {
    if ((totals.get(id) ?? 0n) !== BigInt(view.reservedMinorByAccount[id]!)) {
      reject('Account reserved total differs from mandatory allocations');
    }
  }
  const balances = new Map(ledger.accounts.map(a => [a.id, BigInt(a.openingMinor)]));
  const signed = new Map<string, number>();
  for (const p of ledger.postings) {
    balances.set(p.accountId, balances.get(p.accountId)! + BigInt(p.signedMinor));
    signed.set(p.transactionId + ':' + p.accountId, p.signedMinor);
  }
  const capacity = reconcileGoalCapacity({
    scopeKey: expectedProfileId, asOfDate, ledgerRevision: ledger.revision,
    accounts: ledger.accounts.map(a => ({id: a.id, scopeKey: expectedProfileId,
      currency: 'RUB', balanceCents: Number(balances.get(a.id)!)})),
    goals: snapshot.goals, bindings, mandatoryReserves,
  });
  const tx = new Map(ledger.transactions.map(t => [t.id, t]));
  const reservedLinks = new Set(entities.filter(e => e.kind === 'transaction' &&
    Object.hasOwn(e.data,'reserve_allocation')).map(e => e.id));
  const reversedBy = new Map(ledger.transactions.filter(t => t.kind === 'reversal')
    .map(t => [t.reversedTransactionId, t.id]));
  const bound = new Map(bindings.map(b => [b.goalId, b.accountId]));
  const goals = new Map(snapshot.goals.map(g => [g.id,g]));
  for (const link of goalLedgerLinks(snapshot.goals)) {
    const goal = goals.get(link.goalId)!;
    const event = goal.events.find(e => e.id === link.eventId)!;
    const movement = tx.get(link.ledgerMovementId);
    if (!movement || movement.occurredOn !== event.on || reservedLinks.has(movement.id)) {
      reject('Missing, wrong-date or mandatory-reserve ledger link');
    }
    const expectedKind = link.expectedLedgerKind === 'internal-transfer' ? 'transfer' : link.expectedLedgerKind;
    if (movement.kind !== expectedKind) reject('Ledger movement kind differs');
    const posting = signed.get(movement.id + ':' + bound.get(goal.id));
    if (event.type === 'void') {
      const original = goal.events.find(e => e.id === event.eventId);
      if (!original || (original.type !== 'contribution' && original.type !== 'use') ||
          original.ledgerMovementId !== movement.reversedTransactionId ||
          posting !== (original.type === 'contribution' ? -link.amountCents : link.amountCents)) {
        reject('Ledger reversal differs from goal correction');
      }
    } else {
      if ((event.type !== 'contribution' && event.type !== 'use') ||
          posting !== (event.type === 'contribution' ? link.amountCents : -link.amountCents)) {
        reject('Ledger posting amount or direction differs');
      }
      const correction = goal.events.find(e => e.type === 'void' && e.eventId === event.id);
      const correctionId = correction?.type === 'void' ? correction.ledgerReversalId : undefined;
      if (reversedBy.get(movement.id) !== correctionId) reject('Ledger reversal lacks matching goal correction');
    }
  }
  return capacity;
}
