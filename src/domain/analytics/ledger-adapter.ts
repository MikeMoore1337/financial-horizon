/**
 * Isolated read-only projection of #33's append-only RUB journal into analytics.
 * This adapter is NOT an authorization or snapshot-integrity boundary:
 * callers must first enforce tenant/session ownership and assertLedgerState.
 * No direct import from #33 while its PR is unmerged.
 */
import { buildAnalyticsReport } from './engine.ts';
import type { AnalyticsCategory, AnalyticsInput, AnalyticsPlan, AnalyticsReport,
  AnalyticsSnapshot, AnalyticsTransaction } from './types.ts';

const MAX_MINOR = 1_000_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Structural subset of #33 LedgerState, compatible without a pre-merge dependency. */
export interface LedgerAnalyticsSnapshot {
  profileId: string;
  revision: number;
  accounts: readonly { id: string; profileId: string; currency: 'RUB' }[];
  transactions: readonly {
    id: string;
    profileId: string;
    kind: 'income' | 'expense' | 'transfer' | 'adjustment' | 'payment' | 'reversal';
    occurredOn: string;
    reversedTransactionId: string | null;
  }[];
  postings: readonly {
    profileId: string;
    transactionId: string;
    accountId: string;
    signedMinor: number;
  }[];
  paymentLinks: readonly {
    profileId: string;
    transactionId: string;
    settlementId?: string;
    loanPaymentId?: string;
  }[];
}

/** Category associations belong to the category API; #33 ledger postings are immutable. */
export interface AnalyticsCategoryAssignment {
  profileId: string;
  transactionId: string;
  categoryId: string | null;
}

export interface LedgerAnalyticsInput {
  expectedProfileId: string; // Must be derived from a trusted session, never from arbitrary HTTP JSON.
  snapshot: LedgerAnalyticsSnapshot; // Must be authorized and verified via #33 before calling.
  categoryAssignments?: readonly AnalyticsCategoryAssignment[];
  from: string;
  to: string;
  categories?: readonly AnalyticsCategory[];
  plans?: readonly AnalyticsPlan[];
  debtSnapshots?: readonly AnalyticsSnapshot[];
  savingsSnapshots?: readonly AnalyticsSnapshot[];
}

function bad(reason: string): never {
  throw new Error(`Некорректный журнал аналитики #33: ${reason}`);
}
function uuid(id: unknown): void {
  if (typeof id !== 'string' || !UUID.test(id)) bad('неверный UUID');
}
function validDate(value: unknown): void {
  if (typeof value !== 'string' || !DATE.test(value) || value.startsWith('0000-')) bad('неверная дата');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) bad('неверная дата');
}
function validPostingAmount(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value as number) > MAX_MINOR) {
    bad('неверная сумма проводки');
  }
}
function sum(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) bad('переполнение суммы проводок');
  return result;
}

/** One analytics event per transaction ID, never one per posting/account/settlement. */
export function toAnalyticsTransactions(
  snapshot: LedgerAnalyticsSnapshot,
  expectedProfileId: string,
  assignments: readonly AnalyticsCategoryAssignment[] = [],
): AnalyticsTransaction[] {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.accounts)
      || !Array.isArray(snapshot.transactions) || !Array.isArray(snapshot.postings)
      || !Array.isArray(snapshot.paymentLinks) || !Array.isArray(assignments)) bad('нет обязательных коллекций');
  uuid(expectedProfileId);
  if (snapshot.profileId !== expectedProfileId) bad('чужой финансовый профиль');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) bad('неверная ревизия');

  const accounts = new Set<string>();
  for (const account of snapshot.accounts) {
    if (!account || account.profileId !== expectedProfileId || account.currency !== 'RUB') {
      bad('чужой счёт или валюта');
    }
    uuid(account.id);
    if (accounts.has(account.id)) bad('повторный счёт');
    accounts.add(account.id);
  }
  const transactions = new Map<string, LedgerAnalyticsSnapshot['transactions'][number]>();
  for (const tx of snapshot.transactions) {
    if (!tx || tx.profileId !== expectedProfileId) bad('чужая операция');
    uuid(tx.id);
    validDate(tx.occurredOn);
    if (transactions.has(tx.id)) bad('повторная операция');
    if (!['income','expense','transfer','adjustment','payment','reversal'].includes(tx.kind)) {
      bad('неизвестный тип операции');
    }
    if (tx.kind === 'reversal') uuid(tx.reversedTransactionId);
    else if (tx.reversedTransactionId !== null) bad('лишняя ссылка на отмену');
    transactions.set(tx.id, tx);
  }

  const postings = new Map<string, LedgerAnalyticsSnapshot['postings'][number][]>();
  for (const row of snapshot.postings) {
    if (!row || row.profileId !== expectedProfileId || !transactions.has(row.transactionId)
        || !accounts.has(row.accountId)) bad('проводка чужого/отсутствующего счёта');
    validPostingAmount(row.signedMinor);
    const current = postings.get(row.transactionId) ?? [];
    if (current.some(item => item.accountId === row.accountId)) bad('повторная проводка на счёт');
    current.push(row);
    postings.set(row.transactionId, current);
  }

  const links = new Map<string, string>();
  const paymentFacts = new Set<string>();
  for (const link of snapshot.paymentLinks) {
    if (!link || link.profileId !== expectedProfileId
        || transactions.get(link.transactionId)?.kind !== 'payment' || links.has(link.transactionId)) {
      bad('чужая/повторная связь фактической оплаты');
    }
    const settlement = Object.hasOwn(link, 'settlementId');
    const loan = Object.hasOwn(link, 'loanPaymentId');
    if (settlement === loan) bad('неоднозначная связь оплаты');
    const factId = settlement ? link.settlementId : link.loanPaymentId;
    uuid(factId);
    const factKey = `${settlement ? 'settlement' : 'loanPayment'}:${factId}`;
    if (paymentFacts.has(factKey)) bad('повторное проведение одного факта оплаты');
    paymentFacts.add(factKey);
    links.set(link.transactionId, factKey);
  }
  const categories = new Map<string, string | null>();
  for (const assignment of assignments) {
    const tx = transactions.get(assignment?.transactionId);
    if (!assignment || assignment.profileId !== expectedProfileId || !tx
        || !['income','expense','payment'].includes(tx.kind)
        || categories.has(assignment.transactionId)
        || (assignment.categoryId !== null
          && (typeof assignment.categoryId !== 'string' || !assignment.categoryId.trim()
            || assignment.categoryId.length > 160))) {
      bad('некорректная/повторная категория');
    }
    categories.set(assignment.transactionId, assignment.categoryId);
  }

  const result: AnalyticsTransaction[] = [];
  const reversedIds = new Set<string>();
  for (const tx of snapshot.transactions) {
    const pair = postings.get(tx.id) ?? [];
    const original = tx.kind === 'reversal'
      ? transactions.get(tx.reversedTransactionId!) : undefined;
    if (tx.kind === 'reversal' && (!original || original.kind === 'reversal')) {
      bad('нет исходной проводки для отмены');
    }
    // Until #67 can atomically void a linked payment fact, #33 prohibits this.
    if (tx.kind === 'reversal' && original?.kind === 'payment') {
      bad('отмена связанного платежа без аннулирования факта');
    }
    if (tx.kind === 'reversal') {
      if (reversedIds.has(original!.id)) bad('двойная компенсация');
      reversedIds.add(original!.id);
    }
    const expectedCount = tx.kind === 'transfer' || original?.kind === 'transfer' ? 2 : 1;
    if (pair.length !== expectedCount) bad('неверное количество проводок');
    const signedMinor = pair.reduce((acc, item) => sum(acc, item.signedMinor), 0);
    if (tx.kind === 'transfer' && (signedMinor !== 0 || pair[0]!.signedMinor !== -pair[1]!.signedMinor)) {
      bad('перевод не сбалансирован');
    }
    if (tx.kind === 'income' && signedMinor <= 0) bad('неверный знак дохода');
    if (tx.kind === 'expense' && signedMinor >= 0) bad('неверный знак расхода');
    if (tx.kind === 'payment') {
      if (!links.has(tx.id) || signedMinor === 0) bad('некорректная оплата');
      if (links.get(tx.id)!.startsWith('loanPayment:') && signedMinor > 0) {
        bad('кредитный платёж не может быть доходом');
      }
    }
    if (tx.kind === 'reversal') {
      const old = postings.get(original!.id) ?? [];
      if (old.length !== pair.length || old.some(item => !pair.some(other =>
        other.accountId === item.accountId && other.signedMinor === -item.signedMinor))) {
        bad('компенсация не равна обратной проводке');
      }
    }
    result.push({
      id: tx.id, date: tx.occurredOn, kind: tx.kind,
      signedMinor, categoryId: categories.get(tx.id) ?? null,
      ...(tx.kind === 'reversal' && { reversedTransactionId: tx.reversedTransactionId }),
    });
  }
  return result;
}

/** This is a read-only candidate for #33/#41 review, not a public finance API route. */
export function buildLedgerAnalyticsReport(input: LedgerAnalyticsInput): AnalyticsReport {
  const transactions = toAnalyticsTransactions(input.snapshot, input.expectedProfileId,
    input.categoryAssignments);
  const normalized: AnalyticsInput = {
    from: input.from, to: input.to, transactions,
    categories: input.categories, plans: input.plans,
    debtSnapshots: input.debtSnapshots, savingsSnapshots: input.savingsSnapshots,
  };
  return buildAnalyticsReport(normalized);
}
