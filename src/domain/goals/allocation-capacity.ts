/**
 * #37 - read-only allocation capacity guard across voluntary goals and #6 obligations.
 *
 * A caller MUST obtain accounts, existing mandatory reserves, bindings and goals
 * from one authorized profile/revision. This pure function does not authenticate,
 * read a bank balance, lock funds, write a transaction, or reserve any money.
 * Never substitute caller-supplied scope keys for #33/#67 server authorization.
 */
import { assertGoalDate } from './calendar.ts';
import { calculateGoal, goalLedgerLinks, MAX_GOAL_CENTS } from './engine.ts';
import type { GoalAccountBinding } from './cashflow-bridge.ts';
import type { GoalRecord } from './types.ts';

const MAX_ACCOUNTS = 500;
const MAX_MANDATORY_RESERVES = 10_000;
const MAX_GOALS = 500;
const MAX_ID_LENGTH = 160;

export interface GoalCapacityAccount {
  id: string;
  scopeKey: string;
  currency: 'RUB';
  /** Confirmed account cash at asOfDate, before subtracting any earmarking. */
  balanceCents: number;
}

export interface MandatoryCapacityReserve {
  id: string;
  scopeKey: string;
  accountId: string;
  /** Confirmed funds earmarked for #6 commitments, not their future plan. */
  allocatedCents: number;
}

export interface GoalCapacityInput {
  scopeKey: string;
  asOfDate: string;
  /** Profile-level revision, to be checked in a real compare-and-swap write. */
  ledgerRevision: number;
  accounts: readonly GoalCapacityAccount[];
  goals: readonly GoalRecord[];
  bindings: readonly GoalAccountBinding[];
  mandatoryReserves: readonly MandatoryCapacityReserve[];
}

export interface AccountCapacityRow {
  accountId: string;
  /** Unchanged confirmed account balance: reservations NEVER reduce this field. */
  balanceCents: number;
  voluntaryGoalCents: number;
  mandatoryReserveCents: number;
  earmarkedCents: number;
  /** May be negative, showing a shortage rather than silently hiding it. */
  availableCents: number;
  shortageCents: number;
}

export interface GoalCapacityResult {
  scopeKey: string;
  asOfDate: string;
  ledgerRevision: number;
  accounts: readonly AccountCapacityRow[];
  /** False when at least one account has an allocation shortfall. */
  withinCapacity: boolean;
  /** Always zero: this guard never posts or replays bank transactions. */
  postedBankCents: 0;
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}
function integer(value: unknown, name: string, allowNegative = false): asserts value is number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < (allowNegative ? -MAX_GOAL_CENTS : 0) ||
      (value as number) > MAX_GOAL_CENTS) {
    throw new RangeError(`Invalid ${name} in integer kopecks`);
  }
}
function exactKeys(value: unknown, fields: readonly string[], name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError(`Invalid ${name} fields`);
  }
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Aggregate account allocations overflow integer kopecks');
  }
  return Number(value);
}

/**
 * Report an overcommitment without mutating cash or making a fictitious expense.
 * Valid snapshots with shortages are readable, but must not authorize new allocations.
 */
export function reconcileGoalCapacity(input: GoalCapacityInput): GoalCapacityResult {
  if (!input || typeof input !== 'object') throw new TypeError('Missing account snapshot');
  id(input.scopeKey, 'scope');
  assertGoalDate(input.asOfDate);
  if (!Number.isSafeInteger(input.ledgerRevision) || input.ledgerRevision < 0) {
    throw new RangeError('Invalid ledger revision');
  }
  if (!Array.isArray(input.accounts) || !input.accounts.length ||
      input.accounts.length > MAX_ACCOUNTS) throw new RangeError('Invalid account list');
  if (!Array.isArray(input.goals) || input.goals.length > MAX_GOALS ||
      !Array.isArray(input.bindings) || input.bindings.length !== input.goals.length ||
      !Array.isArray(input.mandatoryReserves) ||
      input.mandatoryReserves.length > MAX_MANDATORY_RESERVES) {
    throw new RangeError('Invalid goal or mandatory-reserve list');
  }

  const accountIds = new Set<string>();
  const cash = new Map<string, number>();
  const voluntary = new Map<string, bigint>();
  const mandatory = new Map<string, bigint>();
  for (const account of input.accounts) {
    exactKeys(account, ['id', 'scopeKey', 'currency', 'balanceCents'], 'account');
    id(account.id, 'account ID');
    if (accountIds.has(account.id) || account.scopeKey !== input.scopeKey ||
        account.currency !== 'RUB') throw new Error('Unknown, duplicate or cross-scope account');
    integer(account.balanceCents, 'account balance', true);
    accountIds.add(account.id);
    cash.set(account.id, account.balanceCents);
  }

  // Validate *every* journal, including future-created goals, before any historical
  // projection. Their opening allocation is not factual until the creation date.
  goalLedgerLinks(input.goals); // Also detects duplicate #33 links across goals.
  const goalIds = new Set<string>();
  const balances = new Map<string, number>();
  for (const goal of input.goals) {
    if (!goal || typeof goal !== 'object') throw new TypeError('Invalid goal record');
    id(goal.id, 'goal ID');
    if (goalIds.has(goal.id)) throw new Error('Duplicate goal ID');
    goalIds.add(goal.id);
    const created = goal.events[0]; // Proven to be 'create' by the full journal replay.
    if (!created || created.type !== 'create') throw new TypeError('Invalid goal creation');
    const saved = created.on > input.asOfDate ? 0 : calculateGoal(goal, input.asOfDate).savedCents;
    balances.set(goal.id, saved);
  }

  const linked = new Set<string>();
  for (const binding of input.bindings) {
    exactKeys(binding, ['goalId', 'accountId'], 'goal binding');
    id(binding.goalId, 'bound goal ID');
    id(binding.accountId, 'bound account ID');
    if (!goalIds.has(binding.goalId) || !accountIds.has(binding.accountId) ||
        linked.has(binding.goalId)) throw new Error('Unknown or duplicate goal-account binding');
    linked.add(binding.goalId);
    const prev = voluntary.get(binding.accountId) ?? 0n;
    voluntary.set(binding.accountId, prev + BigInt(balances.get(binding.goalId) ?? 0));
  }

  const reserveIds = new Set<string>();
  for (const reserve of input.mandatoryReserves) {
    exactKeys(reserve, ['id', 'scopeKey', 'accountId', 'allocatedCents'], 'mandatory reserve');
    id(reserve.id, 'mandatory reserve ID');
    id(reserve.accountId, 'reserved account ID');
    if (reserveIds.has(reserve.id) || reserve.scopeKey !== input.scopeKey ||
        !accountIds.has(reserve.accountId)) {
      throw new Error('Duplicate, unknown or cross-scope mandatory reserve');
    }
    reserveIds.add(reserve.id);
    integer(reserve.allocatedCents, 'mandatory reserve allocation');
    mandatory.set(reserve.accountId,
      (mandatory.get(reserve.accountId) ?? 0n) + BigInt(reserve.allocatedCents));
  }

  const rows: AccountCapacityRow[] = [...accountIds].sort().map((accountId) => {
    const balanceCents = cash.get(accountId);
    if (balanceCents === undefined) throw new Error('Account snapshot incomplete');
    const goalCents = voluntary.get(accountId) ?? 0n;
    const reserveCents = mandatory.get(accountId) ?? 0n;
    const earmarked = goalCents + reserveCents;
    const available = BigInt(balanceCents) - earmarked;
    return Object.freeze({
      accountId, balanceCents,
      voluntaryGoalCents: safeNumber(goalCents),
      mandatoryReserveCents: safeNumber(reserveCents),
      earmarkedCents: safeNumber(earmarked),
      availableCents: safeNumber(available),
      shortageCents: safeNumber(available < 0n ? -available : 0n),
    });
  });
  return Object.freeze({
    scopeKey: input.scopeKey, asOfDate: input.asOfDate, ledgerRevision: input.ledgerRevision,
    accounts: Object.freeze(rows), withinCapacity: rows.every((r) => r.shortageCents === 0),
    postedBankCents: 0 as const,
  });
}

/** Conservative fail-closed guard for a proposed allocation, not a transaction API. */
export function assertGoalCapacity(input: GoalCapacityInput): GoalCapacityResult {
  const result = reconcileGoalCapacity(input);
  if (!result.withinCapacity) throw new RangeError('Not enough unallocated money on the bound account');
  return result;
}
