/**
 * Independent, versioned goals payload for a future atomic store / encrypted backup.
 * Pure encoding and validation ONLY: no IndexedDB writes, no account authorisation,
 * no encryption, no implicit legacy migration, and no automatic merging.
 */
import { goalLedgerLinks } from './engine.ts';
import type { GoalRecord } from './types.ts';

export const GOALS_SNAPSHOT_SCHEMA = 'financial-horizon-goals' as const;
export const GOALS_SNAPSHOT_VERSION = 1 as const;
export const MAX_GOALS_PER_SNAPSHOT = 500;
export const MAX_GOAL_EVENTS_PER_SNAPSHOT = 25_000;
export const MAX_GOALS_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface GoalsSnapshotV1 {
  schema: typeof GOALS_SNAPSHOT_SCHEMA;
  version: typeof GOALS_SNAPSHOT_VERSION;
  /** Opaque authenticated/guest storage namespace, never an email or token. */
  scopeKey: string;
  /** Revision to pass to the caller's real compare-and-swap transaction. */
  revision: number;
  goals: GoalRecord[];
}

function exactKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError('Unexpected field or missing field in goals snapshot');
  }
}

function scopeKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Invalid opaque financial scope');
  }
}

function validateEnvelope(value: unknown, expectedScope: string): asserts value is GoalsSnapshotV1 {
  scopeKey(expectedScope);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid goals snapshot envelope');
  }
  exactKeys(value, ['schema', 'version', 'scopeKey', 'revision', 'goals']);
  const envelope = value as GoalsSnapshotV1;
  if (envelope.schema !== GOALS_SNAPSHOT_SCHEMA || envelope.version !== GOALS_SNAPSHOT_VERSION) {
    throw new RangeError('Unsupported goals snapshot schema or version');
  }
  scopeKey(envelope.scopeKey);
  if (envelope.scopeKey !== expectedScope) throw new Error('Goals snapshot belongs to another scope');
  if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 0) {
    throw new RangeError('Invalid goals snapshot revision');
  }
  if (!Array.isArray(envelope.goals) || envelope.goals.length > MAX_GOALS_PER_SNAPSHOT) {
    throw new RangeError('Invalid goals snapshot size');
  }
  let totalEvents = 0;
  const ids = new Set<string>();
  for (const goal of envelope.goals) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
      throw new TypeError('Invalid goal record in snapshot');
    }
    exactKeys(goal, ['version', 'id', 'events']);
    if (typeof goal.id !== 'string' || !goal.id.trim() || goal.id.includes('\0') ||
        ids.has(goal.id)) {
      throw new Error('Duplicate or invalid goal ID in snapshot');
    }
    ids.add(goal.id);
    if (!Array.isArray(goal.events)) throw new TypeError('Missing goal journal');
    totalEvents += goal.events.length;
    if (totalEvents > MAX_GOAL_EVENTS_PER_SNAPSHOT) {
      throw new RangeError('Goals snapshot journal exceeds limit');
    }
  }
  // Replay and validate the COMPLETE history, then reject cross-goal bank reference duplication.
  // This proves shape/financial arithmetic, not authenticated bank posting existence.
  goalLedgerLinks(envelope.goals);
}

/** Canonical versioned JSON: caller must persist it atomically with CAS and encryption. */
export function encodeGoalsSnapshot(input: GoalsSnapshotV1): string {
  validateEnvelope(input, input?.scopeKey);
  const payload = JSON.stringify(input);
  if (typeof payload !== 'string' ||
      new TextEncoder().encode(payload).length > MAX_GOALS_SNAPSHOT_BYTES) {
    throw new RangeError('Goals snapshot exceeds size limit');
  }
  // Reject fields that JSON.stringify would silently erase or alter.
  validateEnvelope(JSON.parse(payload), input.scopeKey);
  return payload;
}

/** Verifies explicit scope. Does not change caller state or accept unknown versions. */
export function decodeGoalsSnapshot(payload: string, expectedScope: string): GoalsSnapshotV1 {
  scopeKey(expectedScope);
  if (typeof payload !== 'string' ||
      new TextEncoder().encode(payload).length > MAX_GOALS_SNAPSHOT_BYTES) {
    throw new RangeError('Invalid or oversized goals payload');
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new SyntaxError('Invalid goals JSON payload');
  }
  validateEnvelope(value, expectedScope);
  return structuredClone(value);
}

/** Absence is not an instruction to delete or overwrite existing goals on import. */
export function decodeOptionalGoalsSnapshot(
  payload: string | undefined, expectedScope: string,
): GoalsSnapshotV1 | null {
  return payload === undefined ? null : decodeGoalsSnapshot(payload, expectedScope);
}
