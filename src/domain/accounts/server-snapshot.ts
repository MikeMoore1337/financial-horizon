/** #33 - authoritative, single-page PostgreSQL finance /state -> LedgerState.
 *
 * Feature OFF. This is a strict snapshot *adapter*, never a storage or
 * authorization layer. The calling host must authenticate FH session, verify
 * profile binding and read all pages from #67. A partial page is rejected,
 * not shown as a lower bank balance. Receipts remain server-authoritative.
 */
import type {
  LedgerState, Account, LedgerTransaction, LedgerPosting, PaymentLink,
  LinkedPaymentVoidProof,
} from './ledger.ts';
import {assertLedgerState} from './invariants.ts';
import {MAX_MINOR} from './money.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const user = /^[0-9a-f]{32}$/;
const kinds = new Set(['account','transaction','obligation','loan','reserve',
  'settlement','loan_payment']);
const accountKinds = new Set(['bank','card','cash','savings','other']);
const txKinds = new Set(['income','expense','adjustment','transfer','payment','reversal']);
function reject(message: string): never {
  throw Error('INVALID_FINANCE_SNAPSHOT: ' + message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
     Object.getPrototypeOf(value) === null);
}
function safeInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= min && value <= max;
}
function text(value: unknown): value is string {
  return typeof value === 'string';
}
function requireUUID(value: unknown): string {
  if (!text(value) || !uuid.test(value)) reject('Повреждён UUID');
  return value;
}
function requiredString(value: unknown): string {
  if (!text(value)) reject('Повреждено текстовое поле');
  return value;
}
function money(value: unknown, min = -MAX_MINOR): number {
  if (!safeInt(value, min, MAX_MINOR)) reject('Некорректная сумма в копейках');
  return value;
}
function accountBalance(value: unknown, min = -Number.MAX_SAFE_INTEGER): number {
  // Individual postings and opening are bounded by MAX_MINOR; a sum of
  // many legitimate postings can exceed that individual-command limit.
  if (!safeInt(value, min, Number.MAX_SAFE_INTEGER)) {
    reject('Некорректный расчётный остаток счёта');
  }
  return value;
}
function serverUtcTime(value: unknown): string | null {
  if (value === null) return null;
  if (!text(value) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) {
    reject('Повреждена дата архивации');
  }
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) ||
      time.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    reject('Неизвестная дата архивации');
  }
  return time.toISOString();
}
function requireRevision(value: unknown): number {
  if (!safeInt(value, 1, Number.MAX_SAFE_INTEGER)) reject('Повреждена ревизия сущности');
  return value;
}

export interface AccountServerView {
  ledger: LedgerState;
  reservedMinorByAccount: Readonly<Record<string, number>>;
  /** Always server-reported, never inferred from planned obligations. */
  totalMinor: number;
  availableMinor: number;
}

/** Must receive one COMPLETE authenticated /state page (HTTP 200). */
export function decodeCompleteFinanceState(
  raw: unknown, expectedProfileId: string, verifiedActorUserId: string,
): AccountServerView {
  // The v1 /state read does NOT expose actor_user_id. The existing account
  // model is owner-only: the caller supplies the currently server-verified
  // FH session user ID, never client request JSON or a guessed default.
  requireUUID(expectedProfileId);
  if (!text(verifiedActorUserId) || !user.test(verifiedActorUserId)) {
    reject('Нет подтверждённого пользователя финансового профиля');
  }
  if (!object(raw) || raw.schema_version !== 1 ||
      raw.profile_id !== expectedProfileId || raw.currency !== 'RUB' ||
      !safeInt(raw.revision, 0, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(raw.entities) || raw.entities.length > 10_000 ||
      raw.next_cursor !== undefined && raw.next_cursor !== null) {
    reject('Нет полного подтверждённого финансового снимка');
  }
  const accounts: Account[] = [];
  const transactions: LedgerTransaction[] = [];
  const postings: LedgerPosting[] = [];
  const paymentLinks: PaymentLink[] = [];
  const facts = new Map<string, {kind: 'settlement' | 'loan_payment';
    revision: number; voidedAt: string | null}>();
  const reserved: Record<string, number> = Object.create(null);
  const serverBalance = new Map<string, number>();
  const seen = new Set<string>();
  for (const entry of raw.entities) {
    if (!object(entry) || !text(entry.kind) || !kinds.has(entry.kind) ||
        !object(entry.data)) reject('Некорректная серверная сущность');
    const id = requireUUID(entry.id);
    // IDs are unique *per table* in PostgreSQL, not globally unique
    // across accounts/loans/payment facts. Require kind+UUID uniqueness.
    const key = entry.kind + ':' + id;
    if (seen.has(key)) reject('Повторяющийся идентификатор серверной сущности');
    seen.add(key);
    const rev = requireRevision(entry.entity_revision);
    const data = entry.data;
    if (entry.kind === 'account') {
      if (!text(data.type) || !accountKinds.has(data.type)) {
        reject('Неизвестный тип счёта');
      }
      const account: Account = {
        id, profileId: expectedProfileId,
        name: requiredString(data.name),
        kind: data.type as Account['kind'],
        currency: data.currency as 'RUB',
        openingMinor: money(data.opening_minor),
        entityRevision: rev,
        archivedAt: serverUtcTime(data.archived_at),
      };
      if (account.currency !== 'RUB') reject('Неверная валюта счёта');
      accounts.push(account);
      const actual = accountBalance(data.balance_minor);
      const allocated = accountBalance(data.reserved_minor, 0);
      const available = accountBalance(data.available_minor);
      if (actual - allocated !== available) reject('Серверный резерв не сходится');
      reserved[id] = allocated;
      serverBalance.set(id, actual);
    } else if (entry.kind === 'transaction') {
      if (!text(data.kind) || !txKinds.has(data.kind) ||
          // If a newer server starts sending actors, do not allow claims
          // contradicting the already verified owner-only FH session.
          (data.actor_user_id !== undefined &&
           data.actor_user_id !== verifiedActorUserId) ||
          !Array.isArray(data.postings) || data.postings.length > 2 ||
          !text(data.occurred_on)) reject('Повреждённая фактическая операция');
      transactions.push({
        id, profileId: expectedProfileId, entityRevision: rev,
        kind: data.kind as LedgerTransaction['kind'],
        occurredOn: data.occurred_on,
        actorUserId: verifiedActorUserId,
        note: data.note as string | null,
        reversedTransactionId: data.reversed_transaction_id as string | null,
      });
      for (const posting of data.postings) {
        if (!object(posting)) reject('Повреждена проводка');
        postings.push({
          profileId: expectedProfileId,
          transactionId: id, accountId: requireUUID(posting.account_id),
          signedMinor: money(posting.signed_minor),
        });
      }
      if (data.payment_link !== undefined) {
        const link = data.payment_link;
        if (!object(link)) reject('Повреждена связь платежа');
        const settlement = link.settlement_id;
        const loan = link.loan_payment_id;
        if ((settlement === null || settlement === undefined) ===
            (loan === null || loan === undefined)) reject('Неоднозначная связь оплаты');
        paymentLinks.push(settlement !== null && settlement !== undefined
          ? {profileId: expectedProfileId, transactionId: id,
             settlementId: requireUUID(settlement)}
          : {profileId: expectedProfileId, transactionId: id,
             loanPaymentId: requireUUID(loan)});
      }
    } else if (entry.kind === 'settlement' || entry.kind === 'loan_payment') {
      const status = data.voided_at;
      if (status !== null && !text(status)) reject('Повреждена дата отмены');
      facts.set(entry.kind + ':' + id, {
        kind: entry.kind,
        revision: rev,
        voidedAt: status,
      });
    }
  }
  const voids: LinkedPaymentVoidProof[] = [];
  for (const link of paymentLinks) {
    const factId = requireUUID(
      'settlementId' in link ? link.settlementId : link.loanPaymentId,
    );
    const source = 'settlementId' in link ? 'settlement' : 'loanPayment';
    const fact = facts.get((source === 'settlement' ? 'settlement' : 'loan_payment') + ':' + factId);
    if (!fact || fact.kind !== (source === 'settlement' ? 'settlement' : 'loan_payment')) {
      reject('Снимок не содержит связанный факт оплаты');
    }
    if (fact.voidedAt !== null) {
      const matches = transactions.filter(tx =>
        tx.kind === 'reversal' && tx.reversedTransactionId === link.transactionId);
      if (matches.length !== 1) reject('Отмена оплаты без подтверждённой компенсации');
      voids.push({
        profileId: expectedProfileId, transactionId: link.transactionId,
        factId, source, entityRevision: fact.revision,
        reversedByTransactionId: matches[0]!.id,
        voidedAt: fact.voidedAt,
      });
    }
  }
  const ledger: LedgerState = {
    profileId: expectedProfileId, revision: raw.revision,
    accounts, transactions, postings, paymentLinks,
    linkedPaymentVoids: voids, receipts: [],
  };
  assertLedgerState(ledger);
  const calculated = new Map(accounts.map(a => [a.id, a.openingMinor]));
  for (const posting of postings) {
    const previous = calculated.get(posting.accountId);
    if (previous === undefined) reject('Финансовая проводка с чужого счёта');
    const next = previous + posting.signedMinor;
    if (!Number.isSafeInteger(next)) reject('Переполнение финансового остатка');
    calculated.set(posting.accountId, next);
  }
  let totalMinor = 0, availableMinor = 0;
  for (const account of accounts) {
    const actual = serverBalance.get(account.id)!;
    if (calculated.get(account.id) !== actual) {
      reject('Подтверждённый остаток не совпадает с проводками');
    }
    totalMinor += actual;
    availableMinor += actual - reserved[account.id]!;
  }
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(availableMinor)) {
    reject('Переполнение итогового остатка');
  }
  return {ledger, reservedMinorByAccount: reserved, totalMinor, availableMinor};
}
