/**
 * #35: pure profile-scoped category reclassification, never a ledger mutation.
 * The caller MUST provide authoritative #33 operations after session/RLS and
 * assertLedgerState checks. This module does not authorize an HTTP caller,
 * persist events or change an account, posting, or bank balance.
 */
import { MAX_MINOR, type BudgetOperation } from './index.ts';
import type { BudgetCategoryAssignment } from './ledger-adapter.ts';

export interface BudgetCategoryEvent {
  revision: number;
  transactionId: string;
  previousCategoryId: string | null;
  categoryId: string | null;
}

export interface BudgetCategoryReceipt {
  clientMutationId: string;
  /** Local deterministic fingerprint, NOT a server-side cryptographic receipt. */
  requestFingerprint: string;
  revision: number;
  transactionId: string;
}

export interface BudgetCategoryState {
  profileId: string;
  revision: number;
  assignments: BudgetCategoryAssignment[];
  events: BudgetCategoryEvent[];
  receipts: BudgetCategoryReceipt[];
}

export interface BudgetCategoryCommand {
  action: 'budget.category.assign';
  clientMutationId: string;
  baseRevision: number;
  payload: { transactionId: string; categoryId: string | null };
}

export interface AppliedBudgetCategoryCommand {
  state: BudgetCategoryState;
  receipt: BudgetCategoryReceipt;
  replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || value.trim() !== value) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function category(value: unknown): asserts value is string | null {
  if (value !== null) id(value, 'category ID');
}

function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError('Invalid category revision');
  }
}

/** Consistent with the canonical JSON used by #35 budget-rule commands. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const items = Object.entries(value).filter(([, part]) => part !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${items.map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Invalid command number');
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError('Invalid command field');
  return result;
}

/** Validate both event sequence and its current projection, including after JSON restore. */
export function assertBudgetCategoryState(state: BudgetCategoryState): void {
  exactKeys(state, ['profileId', 'revision', 'assignments', 'events', 'receipts'], 'category state');
  id(state.profileId, 'financial profile');
  revision(state.revision);
  if (!Array.isArray(state.assignments) || !Array.isArray(state.events) ||
    !Array.isArray(state.receipts) || state.revision !== state.events.length ||
    state.revision !== state.receipts.length) throw new Error('Category revision sequence mismatch');
  const current = new Map<string, string>();
  const seenMutations = new Set<string>();
  for (let index = 0; index < state.events.length; index++) {
    const event = state.events[index]!;
    const receipt = state.receipts[index]!;
    exactKeys(event, ['revision', 'transactionId', 'previousCategoryId', 'categoryId'], 'category event');
    exactKeys(receipt, ['clientMutationId', 'requestFingerprint', 'revision', 'transactionId'], 'category receipt');
    revision(event.revision);
    revision(receipt.revision);
    if (event.revision !== index + 1 || receipt.revision !== event.revision) {
      throw new Error('Category revision sequence mismatch');
    }
    id(event.transactionId, 'transaction ID');
    category(event.previousCategoryId);
    category(event.categoryId);
    if (event.previousCategoryId !== (current.get(event.transactionId) ?? null) ||
      event.categoryId === event.previousCategoryId) {
      throw new Error('Category history mismatch');
    }
    if (event.categoryId === null) current.delete(event.transactionId);
    else current.set(event.transactionId, event.categoryId);
    if (typeof receipt.clientMutationId !== 'string' || !UUID.test(receipt.clientMutationId) ||
      seenMutations.has(receipt.clientMutationId)) throw new Error('Invalid category receipt mutation ID');
    seenMutations.add(receipt.clientMutationId);
    if (receipt.transactionId !== event.transactionId ||
      receipt.requestFingerprint !== canonical({
        action: 'budget.category.assign', clientMutationId: receipt.clientMutationId,
        baseRevision: index,
        payload: { transactionId: event.transactionId, categoryId: event.categoryId },
      })) throw new Error('Category receipt does not match event');
  }
  const assigned = new Map<string, string>();
  for (const item of state.assignments) {
    exactKeys(item, ['profileId', 'transactionId', 'categoryId'], 'category assignment');
    if (item.profileId !== state.profileId) throw new Error('Cross-profile category assignment');
    id(item.transactionId, 'transaction ID');
    if (typeof item.categoryId !== 'string') throw new Error('Null category should have no assignment row');
    category(item.categoryId);
    if (assigned.has(item.transactionId)) throw new Error('Duplicate category assignment');
    assigned.set(item.transactionId, item.categoryId);
  }
  if (assigned.size !== current.size) throw new Error('Category projection mismatch');
  for (const [transactionId, categoryId] of current) {
    if (assigned.get(transactionId) !== categoryId) throw new Error('Category projection mismatch');
  }
}

export function emptyBudgetCategoryState(profileId: string): BudgetCategoryState {
  id(profileId, 'financial profile');
  return { profileId, revision: 0, assignments: [], events: [], receipts: [] };
}

/**
 * The operations must originate from a validated #33 snapshot; this is a
 * necessary domain check, NOT an authorization/ledger-integrity substitute.
 */
export function applyBudgetCategoryCommand(
  source: BudgetCategoryState,
  operations: readonly BudgetOperation[],
  command: BudgetCategoryCommand,
): AppliedBudgetCategoryCommand {
  assertBudgetCategoryState(source);
  exactKeys(command, ['action', 'clientMutationId', 'baseRevision', 'payload'], 'category command');
  if (command.action !== 'budget.category.assign') throw new TypeError('Unknown category command');
  if (typeof command.clientMutationId !== 'string' || !UUID.test(command.clientMutationId)) {
    throw new TypeError('Invalid category mutation ID');
  }
  revision(command.baseRevision);
  exactKeys(command.payload, ['transactionId', 'categoryId'], 'category command payload');
  id(command.payload.transactionId, 'transaction ID');
  category(command.payload.categoryId);
  // Replay must remain valid after the original transaction was reversed or
  // removed from a later authorized snapshot. No new write is made on replay.
  // The server MUST still authenticate the profile before calling this function.
  const fingerprint = canonical(command);
  const prior = source.receipts.find(r => r.clientMutationId === command.clientMutationId);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint) throw new Error('idempotency_key_reuse');
    return { state: source, receipt: prior, replayed: true };
  }
  if (!Array.isArray(operations)) throw new TypeError('Missing confirmed operations');
  const matching = operations.filter(op => op.id === command.payload.transactionId);
  if (matching.length !== 1) throw new Error('Unknown or ambiguous transaction');
  const operation = matching[0]!;
  if (operation.profileId !== source.profileId) throw new Error('Cross-profile transaction');
  if (operation.status !== 'confirmed' ||
    (operation.kind !== 'expense' && operation.kind !== 'payment') ||
    !Number.isSafeInteger(operation.signedMinor) || operation.signedMinor >= 0 ||
    -operation.signedMinor > MAX_MINOR) {
    throw new Error('Only confirmed expense or debit payment may be reclassified');
  }
  if (operations.some(op => op.kind === 'reversal' && op.status === 'confirmed' &&
    op.reversedTransactionId === operation.id)) {
    throw new Error('Cannot reclassify reversed expense');
  }
  if (source.revision !== command.baseRevision) throw new Error('stale_revision');
  if (source.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Category revision overflow');
  const before = source.assignments.find(a => a.transactionId === command.payload.transactionId)?.categoryId ?? null;
  if (before === command.payload.categoryId) throw new Error('Category is unchanged');
  const state = structuredClone(source);
  state.assignments = state.assignments.filter(a => a.transactionId !== command.payload.transactionId);
  if (command.payload.categoryId !== null) {
    state.assignments.push({ profileId: source.profileId,
      transactionId: command.payload.transactionId, categoryId: command.payload.categoryId });
  }
  state.assignments.sort((a, b) => a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0);
  const next = source.revision + 1;
  state.events.push({ revision: next, transactionId: command.payload.transactionId,
    previousCategoryId: before, categoryId: command.payload.categoryId });
  const receipt = { clientMutationId: command.clientMutationId, requestFingerprint: fingerprint,
    revision: next, transactionId: command.payload.transactionId };
  state.receipts.push(receipt);
  state.revision = next;
  assertBudgetCategoryState(state);
  return { state, receipt, replayed: false };
}
