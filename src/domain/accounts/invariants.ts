/**
 * Structural and financial invariants for loaded ledger snapshots.
 * Validate after deserializing an untrusted cache/snapshot and before/after
 * local command simulation. Authoritative SQL/RLS checks remain in #66/#67.
 */
import { MAX_MINOR } from './money.ts';
import type { LedgerState, LedgerPosting, LedgerTransaction } from './ledger.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR = /^[0-9a-f]{32}$/;
const KINDS = new Set(['bank', 'card', 'cash', 'savings', 'other']);
const TRANSACTION_KINDS = new Set(['income', 'expense', 'transfer', 'adjustment', 'payment', 'reversal']);

function requireUUID(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Повреждён UUID в финансовом журнале');
}
function requireMoney(value: unknown, allowZero: boolean): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > MAX_MINOR
      || (!allowZero && value === 0)) throw new Error('Повреждена сумма в финансовом журнале');
}
function requireRevision(value: unknown, allowZero: boolean): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < (allowZero ? 0 : 1)) throw new Error('Повреждена ревизия финансового журнала');
}
function requireDate(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Повреждена дата финансовой операции');
  const t = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(t.getTime()) || t.toISOString().slice(0, 10) !== value) {
    throw new Error('Несуществующая дата финансовой операции');
  }
}
function requireISOString(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Повреждена отметка времени в финансовом журнале');
  }
}
function requireArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error('Повреждена коллекция финансового журнала');
}
function safeAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error('Переполнен накопленный финансовый баланс');
  return sum;
}

/** Throws on invalid/foreign/orphan/double-linked records; never edits or normalizes input. */
export function assertLedgerState(state: LedgerState): void {
  if (!state || typeof state !== 'object') throw new Error('Отсутствует финансовый журнал');
  requireUUID(state.profileId);
  requireRevision(state.revision, true);
  requireArray(state.accounts);
  requireArray(state.transactions);
  requireArray(state.postings);
  requireArray(state.paymentLinks);
  requireArray(state.receipts);

  const accounts = new Map<string, number>();
  for (const account of state.accounts) {
    if (!account || typeof account !== 'object') throw new Error('Повреждён счёт');
    requireUUID(account.id);
    if (account.profileId !== state.profileId || accounts.has(account.id)) throw new Error('Чужой или повторяющийся счёт');
    if (typeof account.name !== 'string' || !account.name.trim() || account.name.length > 160
      || !KINDS.has(account.kind) || account.currency !== 'RUB') throw new Error('Повреждены реквизиты счёта');
    requireMoney(account.openingMinor, true);
    requireRevision(account.entityRevision, false);
    if (account.archivedAt !== null) requireISOString(account.archivedAt);
    accounts.set(account.id, account.openingMinor);
  }

  const transactions = new Map<string, LedgerTransaction>();
  for (const tx of state.transactions) {
    if (!tx || typeof tx !== 'object') throw new Error('Повреждена операция');
    requireUUID(tx.id);
    if (tx.profileId !== state.profileId || transactions.has(tx.id)) throw new Error('Чужая или повторяющаяся операция');
    if (!TRANSACTION_KINDS.has(tx.kind) || !ACTOR.test(tx.actorUserId)
      || (tx.note !== null && (typeof tx.note !== 'string' || tx.note.length > 500))) {
      throw new Error('Повреждены реквизиты операции');
    }
    requireDate(tx.occurredOn);
    requireRevision(tx.entityRevision, false);
    if (tx.kind === 'reversal') requireUUID(tx.reversedTransactionId);
    else if (tx.reversedTransactionId !== null) throw new Error('Ссылка на отмену у обычной операции');
    transactions.set(tx.id, tx);
  }

  const postings = new Map<string, LedgerPosting[]>();
  const postingKeys = new Set<string>();
  for (const p of state.postings) {
    if (!p || typeof p !== 'object') throw new Error('Повреждена проводка');
    requireUUID(p.accountId);
    requireUUID(p.transactionId);
    if (p.profileId !== state.profileId || !transactions.has(p.transactionId) || !accounts.has(p.accountId)) {
      throw new Error('Проводка ссылается на чужой или несуществующий счёт/операцию');
    }
    requireMoney(p.signedMinor, false);
    const uniqueKey = p.transactionId + ':' + p.accountId;
    if (postingKeys.has(uniqueKey)) throw new Error('Дублированная проводка по счёту');
    postingKeys.add(uniqueKey);
    const list = postings.get(p.transactionId) ?? [];
    list.push(p);
    postings.set(p.transactionId, list);
    accounts.set(p.accountId, safeAdd(accounts.get(p.accountId)!, p.signedMinor));
  }

  const linkedTransactionIds = new Set<string>();
  const loanPaymentTransactionIds = new Set<string>();
  const linkedPaymentFacts = new Set<string>();
  for (const link of state.paymentLinks) {
    if (!link || typeof link !== 'object' || link.profileId !== state.profileId) throw new Error('Чужая связь оплаты');
    requireUUID(link.transactionId);
    if (transactions.get(link.transactionId)?.kind !== 'payment') throw new Error('Связь оплаты не у фактического движения');
    if (linkedTransactionIds.has(link.transactionId)) throw new Error('Платёж имеет несколько связей');
    const hasSettlement = typeof link.settlementId === 'string';
    const hasLoan = typeof link.loanPaymentId === 'string';
    if (hasSettlement === hasLoan) throw new Error('Ссылка на оплату неоднозначна');
    const fact = hasSettlement ? link.settlementId : link.loanPaymentId;
    requireUUID(fact);
    const factKey = (hasSettlement ? 'settlement:' : 'loan:') + fact;
    if (linkedPaymentFacts.has(factKey)) throw new Error('Факт оплаты списан более одного раза');
    linkedPaymentFacts.add(factKey);
    linkedTransactionIds.add(link.transactionId);
    if (hasLoan) loanPaymentTransactionIds.add(link.transactionId);
  }

  const reversed = new Set<string>();
  for (const tx of state.transactions) {
    const pair = postings.get(tx.id) ?? [];
    if (tx.kind === 'transfer') {
      if (pair.length !== 2 || safeAdd(pair[0]!.signedMinor, pair[1]!.signedMinor) !== 0
          || !((pair[0]!.signedMinor < 0 && pair[1]!.signedMinor > 0)
            || (pair[0]!.signedMinor > 0 && pair[1]!.signedMinor < 0))) throw new Error('Перевод не сбалансирован');
    } else if (tx.kind === 'reversal') {
      if (reversed.has(tx.reversedTransactionId!)) throw new Error('Повторная отмена операции');
      reversed.add(tx.reversedTransactionId!);
      const original = transactions.get(tx.reversedTransactionId!);
      if (!original || original.kind === 'reversal') throw new Error('Невозможно отменить несуществующую операцию');
      // Without an atomically voided loan/settlement fact, a refunded linked
      // payment would misstate both available cash and the outstanding debt.
      if (original.kind === 'payment') throw new Error('Связанная оплата отменена без аннулирования факта платежа');
      const sourcePair = postings.get(original.id) ?? [];
      if (!sourcePair.length || sourcePair.length !== pair.length) throw new Error('Неверное число компенсирующих проводок');
      const inverse = new Map(sourcePair.map(item => [item.accountId, -item.signedMinor]));
      if (pair.some(item => inverse.get(item.accountId) !== item.signedMinor)) throw new Error('Неверная компенсация операции');
    } else {
      if (pair.length !== 1) throw new Error('Неверное число проводок в фактической операции');
      if (tx.kind === 'income' && pair[0]!.signedMinor <= 0) throw new Error('Неверный знак дохода');
      if (tx.kind === 'expense' && pair[0]!.signedMinor >= 0) throw new Error('Неверный знак расхода');
      if (tx.kind === 'payment' && loanPaymentTransactionIds.has(tx.id) && pair[0]!.signedMinor >= 0) {
        throw new Error('Кредитный платёж не может быть поступлением');
      }
    }
    if (tx.kind === 'payment' && !linkedTransactionIds.has(tx.id)) throw new Error('Отсутствует связь фактической оплаты');
  }

  const receipts = new Set<string>();
  for (const receipt of state.receipts) {
    if (!receipt || typeof receipt !== 'object') throw new Error('Повреждена квитанция команды');
    requireUUID(receipt.clientMutationId);
    requireUUID(receipt.affectedId);
    requireRevision(receipt.revision, false);
    if (receipt.revision > state.revision || receipts.has(receipt.clientMutationId)
      || typeof receipt.requestFingerprint !== 'string' || !receipt.requestFingerprint) {
      throw new Error('Повторяющаяся или повреждённая квитанция');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(receipt.requestFingerprint);
    } catch {
      throw new Error('Повреждён исходный запрос квитанции');
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Повреждён исходный запрос квитанции');
    }
    const request = decoded as { clientMutationId?: unknown; action?: unknown; payload?: unknown };
    if (request.clientMutationId !== receipt.clientMutationId
        || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
      throw new Error('Квитанция не соответствует исходной команде');
    }
    const payload = request.payload as Record<string, unknown>;
    let targetId: unknown;
    let targetType: 'account' | 'transaction';
    switch (request.action) {
      case 'account.create':
        targetType = 'account';
        targetId = payload.id;
        break;
      case 'account.update':
      case 'account.archive':
      case 'account.unarchive':
        targetType = 'account';
        targetId = payload.accountId;
        break;
      case 'transaction.record':
      case 'account.transfer':
      case 'payment.record':
      case 'transaction.reverse':
        targetType = 'transaction';
        targetId = payload.id;
        break;
      case 'transaction.correct': {
        targetType = 'transaction';
        targetId = payload.replacement && typeof payload.replacement === 'object'
          ? (payload.replacement as { id?: unknown }).id : undefined;
        // A correction commits TWO transactions (reversal + replacement) but
        // emits one receipt. Validate both before allowing an idempotent replay.
        const reversalId = payload.reversalId;
        const originalId = payload.originalTransactionId;
        requireUUID(reversalId);
        requireUUID(originalId);
        const reversal = transactions.get(reversalId);
        if (!transactions.has(originalId) || !reversal || reversal.kind !== 'reversal'
            || reversal.reversedTransactionId !== originalId) {
          throw new Error('Квитанция исправления без нужной компенсирующей операции');
        }
        break;
      }
      default:
        throw new Error('Неизвестный тип команды в квитанции');
    }
    if (targetId !== receipt.affectedId ||
        (targetType === 'account' ? !accounts.has(receipt.affectedId)
          : !transactions.has(receipt.affectedId))) {
      throw new Error('Квитанция указывает на отсутствующую или неверную сущность');
    }
    if (request.action === 'account.create') {
      const account = state.accounts.find(a => a.id === receipt.affectedId);
      if (!account || account.openingMinor !== payload.openingMinor) {
        throw new Error('Квитанция создания не соответствует начальному остатку');
      }
    }
    if (targetType === 'transaction') {
      const tx = transactions.get(receipt.affectedId);
      if (!tx) throw new Error('Квитанция не соответствует финансовой операции');
      const actual = postings.get(tx.id) ?? [];
      const match = (expected: Array<[unknown, unknown]>): void => {
        if (actual.length !== expected.length) throw new Error('Квитанция не соответствует проводкам');
        const matched = new Set<number>();
        for (const [accountId, signedMinor] of expected) {
          requireUUID(accountId);
          requireMoney(signedMinor, false);
          const index = actual.findIndex((p, i) => !matched.has(i)
            && p.accountId === accountId && p.signedMinor === signedMinor);
          if (index < 0) throw new Error('Квитанция не соответствует проводкам');
          matched.add(index);
        }
      };
      switch (request.action) {
        case 'transaction.record':
          if (!['income','expense','adjustment'].includes(String(payload.kind))
              || tx.kind !== payload.kind || tx.occurredOn !== payload.occurredOn) {
            throw new Error('Квитанция не соответствует виду/дате операции');
          }
          match([[payload.accountId, payload.signedMinor]]);
          break;
        case 'account.transfer': {
          const amount = payload.amountMinor;
          requireMoney(amount, false);
          if (amount <= 0 || tx.kind !== 'transfer' || tx.occurredOn !== payload.occurredOn) {
            throw new Error('Квитанция не соответствует переводу');
          }
          match([[payload.fromAccountId, -amount], [payload.toAccountId, amount]]);
          break;
        }
        case 'payment.record': {
          const amount = payload.amountMinor;
          requireMoney(amount, false);
          if (amount <= 0 || tx.kind !== 'payment' || tx.occurredOn !== payload.occurredOn
            || actual.length !== 1 || Math.abs(actual[0]!.signedMinor) !== amount) {
            throw new Error('Квитанция не соответствует сумме оплаты');
          }
          // The request only contains unsigned amountMinor. The signed effect was
          // confirmed by a trusted settlement/loan fact at commit time; do not
          // infer its direction from mutable restored postings.
          requireMoney(receipt.postedSignedMinor, false);
          if (Math.abs(receipt.postedSignedMinor!) !== amount) {
            throw new Error('Квитанция не соответствует подтверждённому направлению оплаты');
          }
          match([[payload.accountId, receipt.postedSignedMinor]]);
          const fact = payload.link;
          if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
            throw new Error('Квитанция не соответствует связи оплаты');
          }
          const requested = fact as Record<string, unknown>;
          const link = state.paymentLinks.find(p => p.transactionId === tx.id);
          const isSettlement = typeof requested.settlementId === 'string';
          const isLoan = typeof requested.loanPaymentId === 'string';
          if (!link || isSettlement === isLoan ||
            (isSettlement ? link.settlementId !== requested.settlementId
              : link.loanPaymentId !== requested.loanPaymentId)) {
            throw new Error('Квитанция не соответствует связи оплаты');
          }
          break;
        }
        case 'transaction.reverse':
          if (tx.kind !== 'reversal' || tx.reversedTransactionId !== payload.transactionId
            || tx.occurredOn !== payload.occurredOn || tx.note !== payload.reason) {
            throw new Error('Квитанция отмены указывает на другую исходную операцию');
          }
          break;
        case 'transaction.correct': {
          const replacement = payload.replacement as Record<string, unknown>;
          if (tx.kind !== replacement.kind || tx.occurredOn !== replacement.occurredOn) {
            throw new Error('Квитанция не соответствует исправленной операции');
          }
          if (replacement.kind === 'transfer') {
            const amount = replacement.amountMinor;
            requireMoney(amount, false);
            if (amount <= 0) throw new Error('Квитанция не соответствует исправленному переводу');
            match([[replacement.fromAccountId, -amount], [replacement.toAccountId, amount]]);
          } else if (['income','expense','adjustment'].includes(String(replacement.kind))) {
            match([[replacement.accountId, replacement.signedMinor]]);
          } else {
            throw new Error('Неизвестный вид исправленной операции в квитанции');
          }
          const reversal = transactions.get(payload.reversalId as string);
          if (!reversal || reversal.occurredOn !== payload.occurredOn || reversal.note !== payload.reason) {
            throw new Error('Квитанция не соответствует компенсирующей операции');
          }
          break;
        }
      }
    }
    receipts.add(receipt.clientMutationId);
  }
}
