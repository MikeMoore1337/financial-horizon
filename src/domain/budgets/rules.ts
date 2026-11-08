/**
 * #35 - pure, deterministic budget-rule mutations.
 *
 * This module does not persist data or authorize a user. The eventual #67
 * server must bind profileId to the authenticated session and atomically
 * persist revision, rules and hashed idempotency receipts under RLS.
 * Neither legacy backups nor IndexedDB are written by these functions.
 */
import { MAX_MINOR, type BudgetRule } from './index.ts';

export interface BudgetRuleReceipt {
  clientMutationId: string;
  /** Local canonical command, NOT an authenticated/server SHA-256 receipt. */
  requestFingerprint: string;
  revision: number;
  affectedRuleId: string;
}

export interface BudgetRuleState {
  profileId: string;
  revision: number;
  rules: BudgetRule[];
  receipts: BudgetRuleReceipt[];
}

interface CommandBase {
  clientMutationId: string;
  baseRevision: number;
}

export type BudgetRuleCommand = CommandBase & (
  | { action: 'budget.create'; payload: { rule: BudgetRule } }
  | { action: 'budget.amend'; payload: {
      ruleId: string;
      effectiveFromMonth: string;
      replacementId: string;
      limitMinor: number;
    } }
  | { action: 'budget.archive'; payload: { ruleId: string; archivedFromMonth: string } }
);

export interface AppliedBudgetRuleCommand {
  state: BudgetRuleState;
  receipt: BudgetRuleReceipt;
  replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function nonblank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160
    || value.trim() !== value) throw new TypeError(`Invalid ${field}`);
}
function month(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !MONTH.test(value)) throw new TypeError('Invalid budget month');
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError('Invalid budget revision');
}
function money(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_MINOR) {
    throw new RangeError('Budget limit must use integer kopecks within range');
  }
}
function monthIndex(value: string): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}
function exactKeys(value: unknown, allowed: readonly string[], description: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TypeError(`Invalid ${description}`);
  }
}
function checkRule(rule: BudgetRule, profileId: string): void {
  exactKeys(rule, ['id', 'profileId', 'scope', 'limitMinor', 'recurrence',
    'fromMonth', 'endsBeforeMonth', 'archivedFromMonth'], 'budget rule');
  nonblank(rule.id, 'rule ID');
  if (rule.profileId !== profileId) throw new Error('Cross-profile budget rule');
  money(rule.limitMinor);
  month(rule.fromMonth);
  if (rule.recurrence !== 'monthly' && rule.recurrence !== 'once') {
    throw new TypeError('Invalid rule recurrence');
  }
  if (rule.endsBeforeMonth != null) {
    month(rule.endsBeforeMonth);
    if (rule.endsBeforeMonth <= rule.fromMonth) throw new RangeError('Invalid rule end month');
  }
  if (rule.archivedFromMonth != null) {
    month(rule.archivedFromMonth);
    if (rule.archivedFromMonth < rule.fromMonth) throw new RangeError('Archive precedes rule start');
  }
  exactKeys(rule.scope, rule.scope.kind === 'total' ? ['kind'] : ['kind', 'categoryId'], 'budget scope');
  if (rule.scope.kind === 'category') nonblank(rule.scope.categoryId, 'category ID');
  else if (rule.scope.kind !== 'total') throw new TypeError('Invalid budget scope');
}

function bounds(rule: BudgetRule): [start: number, end: number] {
  const start = monthIndex(rule.fromMonth);
  let end = rule.recurrence === 'once' ? start + 1 : Number.POSITIVE_INFINITY;
  if (rule.endsBeforeMonth != null) end = Math.min(end, monthIndex(rule.endsBeforeMonth));
  if (rule.archivedFromMonth != null) end = Math.min(end, monthIndex(rule.archivedFromMonth));
  return [start, end];
}

/** Check all months, including future months not requested by the UI. */
export function assertBudgetRuleState(state: BudgetRuleState): void {
  exactKeys(state, ['profileId', 'revision', 'rules', 'receipts'], 'budget rule state');
  nonblank(state.profileId, 'financial profile');
  revision(state.revision);
  if (!Array.isArray(state.rules) || !Array.isArray(state.receipts)) {
    throw new TypeError('Invalid budget collections');
  }
  const ids = new Set<string>();
  const scopes = new Map<string, Array<[number, number]>>();
  for (const rule of state.rules) {
    checkRule(rule, state.profileId);
    if (ids.has(rule.id)) throw new Error('Duplicate budget rule ID');
    ids.add(rule.id);
    const key = rule.scope.kind === 'total' ? 'total' : `category:${rule.scope.categoryId}`;
    const interval = bounds(rule);
    if (interval[1] > interval[0]) {
      const periods = scopes.get(key) ?? [];
      periods.push(interval);
      scopes.set(key, periods);
    }
  }
  for (const periods of scopes.values()) {
    periods.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < periods.length; i++) {
      if (periods[i]![0] < periods[i - 1]![1]) throw new Error('Overlapping budget rule intervals');
    }
  }
  // A pure state transition appends exactly one receipt per revision. Never
  // accept a snapshot with silently discarded receipts or forged revision gaps.
  if (state.revision !== state.receipts.length) throw new Error('Budget receipt sequence mismatch');
  const mutations = new Set<string>();
  for (const [position, receipt] of state.receipts.entries()) {
    exactKeys(receipt, ['clientMutationId', 'requestFingerprint', 'revision',
      'affectedRuleId'], 'budget receipt');
    if (typeof receipt.clientMutationId !== 'string' || !UUID.test(receipt.clientMutationId)) {
      throw new TypeError('Invalid receipt mutation ID');
    }
    if (typeof receipt.requestFingerprint !== 'string' || !receipt.requestFingerprint
      || receipt.requestFingerprint.length > 32_768) throw new TypeError('Invalid receipt fingerprint');
    revision(receipt.revision);
    if (receipt.revision !== position + 1) throw new Error('Budget receipt sequence mismatch');
    if (mutations.has(receipt.clientMutationId)) throw new Error('Duplicate budget receipt');
    mutations.add(receipt.clientMutationId);
    assertReceiptFingerprint(receipt, position, state.profileId);
    if (!ids.has(receipt.affectedRuleId)) throw new Error('Orphan budget receipt');
  }
}

export function emptyBudgetRuleState(profileId: string): BudgetRuleState {
  nonblank(profileId, 'financial profile');
  return { profileId, revision: 0, rules: [], receipts: [] };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const ordered = Object.entries(value).filter(([,v]) => v !== undefined)
      .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${ordered.map(([key,part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Invalid command number');
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError('Invalid command field');
  return result;
}

/**
 * Verify the canonical local request represented by each receipt after JSON
 * restoration. This does not authenticate the receipt or replace the server's
 * SHA-256 fingerprint and transactional change log (#67).
 */
function assertReceiptFingerprint(
  receipt: BudgetRuleReceipt, position: number, profileId: string,
): void {
  let candidate: unknown;
  try {
    candidate = JSON.parse(receipt.requestFingerprint);
  } catch {
    throw new TypeError('Invalid budget receipt fingerprint');
  }
  exactKeys(candidate, ['action', 'payload', 'clientMutationId', 'baseRevision'], 'receipt command');
  const command = candidate as BudgetRuleCommand;
  if (command.clientMutationId !== receipt.clientMutationId ||
    command.baseRevision !== position ||
    canonical(command) !== receipt.requestFingerprint) {
    throw new Error('Budget receipt fingerprint mismatch');
  }
  switch (command.action) {
    case 'budget.create':
      exactKeys(command.payload, ['rule'], 'receipt create payload');
      checkRule(command.payload.rule, profileId);
      if (command.payload.rule.id !== receipt.affectedRuleId) {
        throw new Error('Budget receipt affected rule mismatch');
      }
      break;
    case 'budget.amend': {
      exactKeys(command.payload,
        ['ruleId', 'effectiveFromMonth', 'replacementId', 'limitMinor'], 'receipt amend payload');
      const { ruleId, effectiveFromMonth, replacementId, limitMinor } = command.payload;
      nonblank(ruleId, 'receipt amended rule ID');
      nonblank(replacementId, 'receipt replacement rule ID');
      month(effectiveFromMonth);
      money(limitMinor);
      if (receipt.affectedRuleId !== ruleId && receipt.affectedRuleId !== replacementId) {
        throw new Error('Budget receipt affected rule mismatch');
      }
      break;
    }
    case 'budget.archive':
      exactKeys(command.payload, ['ruleId', 'archivedFromMonth'], 'receipt archive payload');
      nonblank(command.payload.ruleId, 'receipt archived rule ID');
      month(command.payload.archivedFromMonth);
      if (command.payload.ruleId !== receipt.affectedRuleId) {
        throw new Error('Budget receipt affected rule mismatch');
      }
      break;
    default:
      throw new TypeError('Invalid budget receipt action');
  }
}

export function applyBudgetRuleCommand(
  source: BudgetRuleState,
  command: BudgetRuleCommand,
): AppliedBudgetRuleCommand {
  assertBudgetRuleState(source);
  exactKeys(command, ['action', 'payload', 'clientMutationId', 'baseRevision'], 'budget command');
  if (typeof command.clientMutationId !== 'string' || !UUID.test(command.clientMutationId)) {
    throw new TypeError('Invalid mutation ID');
  }
  revision(command.baseRevision);
  const fingerprint = canonical(command);
  const prior = source.receipts.find(r => r.clientMutationId === command.clientMutationId);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint) throw new Error('idempotency_key_reuse');
    return { state: source, receipt: prior, replayed: true };
  }
  if (source.revision !== command.baseRevision) throw new Error('stale_revision');
  if (source.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Budget revision overflow');
  const state: BudgetRuleState = structuredClone(source);
  let affectedRuleId: string;
  switch (command.action) {
    case 'budget.create': {
      exactKeys(command.payload, ['rule'], 'create payload');
      const rule = command.payload.rule;
      checkRule(rule, state.profileId);
      if (state.rules.some(r => r.id === rule.id)) throw new Error('Duplicate budget rule ID');
      state.rules.push(structuredClone(rule));
      affectedRuleId = rule.id;
      break;
    }
    case 'budget.amend': {
      exactKeys(command.payload, ['ruleId', 'effectiveFromMonth', 'replacementId', 'limitMinor'], 'amend payload');
      const { ruleId, effectiveFromMonth, replacementId, limitMinor } = command.payload;
      nonblank(ruleId, 'rule ID');
      nonblank(replacementId, 'replacement ID');
      month(effectiveFromMonth);
      money(limitMinor);
      const rule = state.rules.find(r => r.id === ruleId);
      if (!rule) throw new Error('Budget rule not found');
      const [start,end] = bounds(rule);
      const effective = monthIndex(effectiveFromMonth);
      if (effective < start || effective >= end) throw new Error('Rule is not active in effective month');
      if (effective === start) {
        if (replacementId !== ruleId) throw new Error('In-place amendment must preserve rule ID');
        rule.limitMinor = limitMinor;
      } else {
        if (replacementId === ruleId || state.rules.some(r => r.id === replacementId)) {
          throw new Error('Replacement rule ID already exists');
        }
        const replacement: BudgetRule = {
          ...structuredClone(rule), id: replacementId, fromMonth: effectiveFromMonth,
          limitMinor,
        };
        rule.endsBeforeMonth = effectiveFromMonth;
        state.rules.push(replacement);
      }
      affectedRuleId = effective === start ? ruleId : replacementId;
      break;
    }
    case 'budget.archive': {
      exactKeys(command.payload, ['ruleId', 'archivedFromMonth'], 'archive payload');
      const { ruleId, archivedFromMonth } = command.payload;
      nonblank(ruleId, 'rule ID');
      month(archivedFromMonth);
      const rule = state.rules.find(r => r.id === ruleId);
      if (!rule) throw new Error('Budget rule not found');
      const [start,end] = bounds(rule);
      const effective = monthIndex(archivedFromMonth);
      if (effective < start || effective >= end || rule.archivedFromMonth != null) {
        throw new Error('Cannot archive an inactive budget rule');
      }
      rule.archivedFromMonth = archivedFromMonth;
      affectedRuleId = ruleId;
      break;
    }
    default:
      throw new TypeError('Unknown budget command');
  }
  const receipt: BudgetRuleReceipt = {
    clientMutationId: command.clientMutationId, requestFingerprint: fingerprint,
    revision: source.revision + 1, affectedRuleId,
  };
  state.revision = receipt.revision;
  state.receipts.push(receipt);
  assertBudgetRuleState(state);
  return { state, receipt, replayed: false };
}
