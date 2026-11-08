/**
 * Read-only structural adapter for the public #33 ledger contracts.
 * No runtime dependency on #33 while its PR is unmerged. The caller must load
 * an authorized, validated snapshot (assertLedgerState / server RLS).
 */
import {
  calculateBudgetReport,
  MAX_MINOR,
  type BudgetOperation,
  type BudgetReport,
  type BudgetRule,
} from './index.ts';

/** Structurally compatible with LedgerState, LedgerTransaction and LedgerPosting in #33. */
export interface LedgerBudgetSnapshot {
  profileId: string;
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

/** This mapping belongs to the future category API, not mutable ledger postings. */
export interface BudgetCategoryAssignment {
  profileId: string;
  transactionId: string;
  categoryId: string | null;
}

function fail(message: string): never {
  throw new Error(`Invalid #33 ledger budget snapshot: ${message}`);
}

export function toBudgetOperations(
  snapshot: LedgerBudgetSnapshot,
  assignments: readonly BudgetCategoryAssignment[] = [],
  planned: readonly BudgetOperation[] = [],
): BudgetOperation[] {
  if (!snapshot || typeof snapshot.profileId !== 'string'
    || !Array.isArray(snapshot.transactions) || !Array.isArray(snapshot.postings)
    || !Array.isArray(snapshot.paymentLinks)) fail('missing ledger collections');

  const transactions = new Map<string, LedgerBudgetSnapshot['transactions'][number]>();
  for (const tx of snapshot.transactions) {
    if (!tx || typeof tx.id !== 'string' || !tx.id || transactions.has(tx.id)) {
      fail('missing or duplicate transaction ID');
    }
    if (tx.profileId !== snapshot.profileId) fail('foreign transaction');
    if (!['income', 'expense', 'transfer', 'adjustment', 'payment', 'reversal'].includes(tx.kind)) {
      fail('unknown transaction kind');
    }
    if ((tx.kind === 'reversal') !== (tx.reversedTransactionId !== null)) {
      fail('invalid reversal reference');
    }
    transactions.set(tx.id, tx);
  }

  const postings = new Map<string, LedgerBudgetSnapshot['postings'][number][]>();
  for (const posting of snapshot.postings) {
    if (!posting || posting.profileId !== snapshot.profileId || !transactions.has(posting.transactionId)) {
      fail('foreign or orphan posting');
    }
    if (!Number.isSafeInteger(posting.signedMinor) || posting.signedMinor === 0
      || Math.abs(posting.signedMinor) > MAX_MINOR) fail('invalid posting amount');
    const rows = postings.get(posting.transactionId) ?? [];
    if (rows.some(row => row.accountId === posting.accountId)) fail('duplicate account posting');
    rows.push(posting);
    postings.set(posting.transactionId, rows);
  }

  const links = new Map<string, string>();
  const factIds = new Set<string>();
  for (const link of snapshot.paymentLinks) {
    if (!link || link.profileId !== snapshot.profileId || transactions.get(link.transactionId)?.kind !== 'payment') {
      fail('foreign or orphan payment link');
    }
    const hasSettlement = typeof link.settlementId === 'string' && link.settlementId.length > 0;
    const hasLoan = typeof link.loanPaymentId === 'string' && link.loanPaymentId.length > 0;
    if (hasSettlement === hasLoan || links.has(link.transactionId)) fail('ambiguous payment link');
    const factId = hasSettlement ? `settlement:${link.settlementId}` : `loanPayment:${link.loanPaymentId}`;
    if (factIds.has(factId)) fail('duplicate settled payment fact');
    factIds.add(factId);
    links.set(link.transactionId, factId);
  }

  const categories = new Map<string, string | null>();
  for (const assignment of assignments) {
    if (!assignment || assignment.profileId !== snapshot.profileId
      || !transactions.has(assignment.transactionId)
      || transactions.get(assignment.transactionId)?.kind === 'reversal'
      || categories.has(assignment.transactionId)
      || (assignment.categoryId !== null
        && (typeof assignment.categoryId !== 'string' || !assignment.categoryId.trim()))) {
      fail('invalid or duplicate category assignment');
    }
    categories.set(assignment.transactionId, assignment.categoryId);
  }

  const results: BudgetOperation[] = [];
  for (const tx of snapshot.transactions) {
    const rows = postings.get(tx.id) ?? [];
    const source = tx.kind === 'reversal' ? transactions.get(tx.reversedTransactionId!) : undefined;
    if (tx.kind === 'reversal' && (!source || source.kind === 'reversal')) {
      fail('missing reversal target');
    }
    const expectedCount = tx.kind === 'transfer' || source?.kind === 'transfer' ? 2 : 1;
    if (rows.length !== expectedCount) fail('incorrect posting count');
    const signedMinor = rows.reduce((sum, row) => {
      const result = sum + row.signedMinor;
      if (!Number.isSafeInteger(result)) fail('posting sum overflow');
      return result;
    }, 0);
    if (tx.kind === 'transfer' && signedMinor !== 0) fail('unbalanced transfer');
    if (tx.kind === 'income' && signedMinor <= 0) fail('invalid income sign');
    if (tx.kind === 'expense' && signedMinor >= 0) fail('invalid expense sign');
    if (tx.kind === 'payment' && !links.has(tx.id)) fail('unlinked payment');
    if (tx.kind === 'reversal') {
      const originalRows = postings.get(source!.id) ?? [];
      if (originalRows.length !== rows.length || originalRows.some(original =>
        !rows.some(reversed => reversed.accountId === original.accountId
          && reversed.signedMinor === -original.signedMinor))) {
        fail('reversal postings do not compensate original');
      }
    }
    results.push({
      id: tx.id,
      profileId: tx.profileId,
      occurredOn: tx.occurredOn,
      kind: tx.kind,
      status: 'confirmed',
      signedMinor,
      categoryId: categories.get(tx.id) ?? null,
      reversedTransactionId: tx.reversedTransactionId,
      sourceFactId: links.get(tx.id) ?? null,
    });
  }

  for (const operation of planned) {
    if (operation.status !== 'planned' || operation.kind !== 'expense'
      || operation.profileId !== snapshot.profileId) fail('invalid planned operation');
    results.push({ ...operation });
  }
  return results;
}

export function calculateLedgerBudgetReport(input: {
  snapshot: LedgerBudgetSnapshot;
  month: string;
  rules: readonly BudgetRule[];
  assignments?: readonly BudgetCategoryAssignment[];
  planned?: readonly BudgetOperation[];
}): BudgetReport {
  return calculateBudgetReport({
    profileId: input.snapshot.profileId,
    month: input.month,
    rules: input.rules,
    operations: toBudgetOperations(input.snapshot, input.assignments, input.planned),
  });
}
