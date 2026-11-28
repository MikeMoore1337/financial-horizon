/**
 * #36: read-only confirmed cash ledger adapter for the existing #33/#67
 * complete finance snapshot. Never creates a balance checkpoint or posting.
 * The caller must obtain both the authorized snapshot and independently
 * confirmed start-of-day balances for its exact profile/revision.
 */
import { decodeCompleteFinanceState } from '../accounts/server-snapshot.ts';
import { dayNumber } from './calendar.ts';
import { addCents } from './adapters.ts';
import type { BookedFlowDto, CashflowSourcesDto } from './types.ts';

export interface ConfirmedCashflowCheckpoint {
  readonly profileId: string;
  readonly revision: number;
  /** Explicit confirmed balance at START of this day, not today's balance. */
  readonly openingDate: string;
  readonly accounts: CashflowSourcesDto['accounts'];
}

export interface ConfirmedCashflowLedger {
  readonly profileId: string;
  readonly revision: number;
  readonly openingDate: string;
  readonly asOfDate: string;
  readonly accounts: CashflowSourcesDto['accounts'];
  readonly actuals: readonly BookedFlowDto[];
  readonly confirmedAsOfBalanceCents: number;
  /** Includes all mandatory and voluntary allocations. Not opening reserves. */
  readonly confirmedAsOfReservedCents: number;
}

type Entity = { kind: string; id: string; data: Record<string, unknown> };

function fail(reason: string): never {
  throw new Error('CASHFLOW_SNAPSHOT: ' + reason);
}

export function readConfirmedCashflowLedger(
  raw: unknown,
  expectedProfileId: string,
  verifiedActorUserId: string,
  checkpoint: ConfirmedCashflowCheckpoint,
  asOfDate: string,
): ConfirmedCashflowLedger {
  const view = decodeCompleteFinanceState(raw, expectedProfileId, verifiedActorUserId);
  const { ledger } = view;
  if (!checkpoint || checkpoint.profileId !== ledger.profileId ||
      checkpoint.revision !== ledger.revision || !Array.isArray(checkpoint.accounts) ||
      !checkpoint.accounts.length) {
    fail('Не подтверждён начальный остаток этого профиля и ревизии');
  }
  const opening = dayNumber(checkpoint.openingDate);
  const asOf = dayNumber(asOfDate);
  if (opening > asOf || ledger.transactions.some(tx => dayNumber(tx.occurredOn) > asOf)) {
    fail('Снимок содержит операции за пределами подтверждённой даты');
  }

  // Reconcile every individual account, not merely a consolidated total.
  // A caller cannot accidentally substitute a different profile or a stale
  // balance. This validates consistency, not the provenance of a checkpoint.
  const current = new Map(ledger.accounts.map(a => [a.id, BigInt(a.openingMinor)]));
  const replay = new Map<string, bigint>();
  for (const account of checkpoint.accounts) {
    if (!account || !current.has(account.id) || replay.has(account.id) ||
        account.currency !== 'RUB' || !Number.isSafeInteger(account.openingBalanceCents)) {
      fail('Некорректный или чужой начальный остаток счёта');
    }
    replay.set(account.id, BigInt(account.openingBalanceCents));
  }
  if (replay.size !== current.size) fail('Неполный начальный снимок счетов');
  const byId = new Map(ledger.transactions.map(tx => [tx.id, tx]));
  const signed = new Map<string, number>();
  for (const p of ledger.postings) {
    current.set(p.accountId, current.get(p.accountId)! + BigInt(p.signedMinor));
    if (byId.get(p.transactionId)!.occurredOn >= checkpoint.openingDate) {
      replay.set(p.accountId, replay.get(p.accountId)! + BigInt(p.signedMinor));
    }
    signed.set(p.transactionId, addCents(signed.get(p.transactionId) ?? 0, p.signedMinor));
  }
  for (const [accountId, balance] of current) {
    if (balance !== replay.get(accountId)) fail('Начальный остаток не сходится с проводками');
  }

  const exactTotal = [...current.values()].reduce((sum, value) => sum + value, 0n);
  const exactOpening = checkpoint.accounts.reduce((sum, a) => sum + BigInt(a.openingBalanceCents), 0n);
  const exactReserved = Object.values(view.reservedMinorByAccount)
    .reduce((sum, value) => sum + BigInt(value), 0n);
  const safe = (value: bigint) => value >= -BigInt(Number.MAX_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER);
  if (!safe(exactTotal) || !safe(exactOpening) || !safe(exactReserved) ||
      !safe(exactTotal - exactReserved) || exactTotal !== BigInt(view.totalMinor) ||
      exactTotal - exactReserved !== BigInt(view.availableMinor)) {
    fail('Некорректная сумма подтверждённых остатков');
  }

  const entities = (raw as { entities: Entity[] }).entities;
  const byKind = new Map(entities.map(e => [e.kind + ':' + e.id, e.data]));
  const links = new Map(ledger.paymentLinks.map(link => [link.transactionId, link]));
  const linkedFacts = new Set(ledger.paymentLinks.map(link =>
    'settlementId' in link ? 'settlement:' + link.settlementId : 'loan_payment:' + link.loanPaymentId));
  for (const entity of entities) {
    if ((entity.kind === 'settlement' || entity.kind === 'loan_payment') &&
        entity.data.voided_at === null && !linkedFacts.has(entity.kind + ':' + entity.id)) {
      fail('Активная оплата не имеет подтверждённой проводки');
    }
  }
  const reversalByOriginal = new Map(ledger.transactions
    .filter(tx => tx.kind === 'reversal').map(tx => [tx.reversedTransactionId!, tx]));
  const actuals: BookedFlowDto[] = [];
  for (const tx of ledger.transactions) {
    if (tx.kind === 'reversal') continue; // consumed by its original below
    const reversal = reversalByOriginal.get(tx.id);
    if (reversal && reversal.occurredOn < tx.occurredOn) fail('Отмена предшествует оплате');
    if (tx.kind === 'transfer') continue; // zero consolidated external flow
    const amount = signed.get(tx.id)!;
    const base = {
      id: tx.id, date: tx.occurredOn, amountCents: Math.abs(amount),
      ...(reversal ? { voided: true, reversedOn: reversal.occurredOn } : {}),
    };
    if (tx.kind === 'adjustment') {
      actuals.push({ ...base, kind: amount > 0 ? 'adjustment-credit' : 'adjustment-debit' });
      continue;
    }
    const kind = amount > 0 ? 'income' : 'expense';
    if (tx.kind !== 'payment') {
      actuals.push({ ...base, kind });
      continue;
    }
    const link = links.get(tx.id)!;
    const isSettlement = 'settlementId' in link;
    const fact = byKind.get(isSettlement
      ? 'settlement:' + link.settlementId : 'loan_payment:' + link.loanPaymentId);
    if (!fact || fact.amount_minor !== Math.abs(amount) || fact.paid_on !== tx.occurredOn ||
        (fact.voided_at !== null) !== Boolean(reversal)) {
      fail('Проводка не совпадает с подтверждённой оплатой');
    }
    if (isSettlement) {
      if (typeof fact.obligation_id !== 'string' || typeof fact.occurrence_on !== 'string') {
        fail('Оплата не связана с обязательством');
      }
      const plan = byKind.get('obligation:' + fact.obligation_id);
      if (!plan || plan.direction !== kind) fail('Оплата не связана с обязательством');
      dayNumber(fact.occurrence_on);
      actuals.push({ ...base, kind, planId: fact.obligation_id, occurrenceDate: fact.occurrence_on });
    } else {
      if (kind !== 'expense' || typeof fact.loan_id !== 'string' ||
          !byKind.has('loan:' + fact.loan_id)) fail('Оплата не связана с кредитом');
      // A loan_payment fact is a confirmed cash expense. The loan schedule
      // must separately exclude obsolete future installments after prepayment.
      // It is not an inferred payment of a calendar installment.
      actuals.push({ ...base, kind });
    }
  }
  actuals.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    profileId: ledger.profileId, revision: ledger.revision, openingDate: checkpoint.openingDate,
    asOfDate, accounts: checkpoint.accounts.map(a => ({ id: a.id, currency: a.currency,
      openingBalanceCents: a.openingBalanceCents })), actuals,
    confirmedAsOfBalanceCents: view.totalMinor,
    confirmedAsOfReservedCents: Number(exactReserved),
  };
}
