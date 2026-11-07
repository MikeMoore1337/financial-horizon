/**
 * #33 - request encoder for the ALREADY APPROVED subset of finance-sync-v1.openapi.json.
 * No HTTP calls, no storage, no client-derived access tokens or profile/actor IDs.
 * Server-side validation, If-Match handling and idempotency remain authoritative in #67.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRONG_ETAG = /^"[^"\r\n]+"$/;
const MAX_MINOR = 1_000_000_000_000;

export interface CommandPreconditions {
  /** UUID must not change on retry; a corrected command requires a new UUID. */
  clientMutationId: string;
  baseRevision: number;
  expectedEntityRevisions: Readonly<Record<string, number>>;
  /** Strong server-supplied ETag, never inferred from revision or user data. */
  ifMatch: string;
}
export interface TransferInput extends CommandPreconditions {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  occurredOn: string;
}
export interface ReversalInput extends CommandPreconditions {
  transactionId: string;
  reason: string;
}

export type WireCommand = {
  schema_version: 1;
  client_mutation_id: string;
  base_revision: number;
  expected_entity_revisions: Readonly<Record<string, number>>;
} & (
  | { action: 'account.transfer'; payload: Readonly<{
      from_account_id: string; to_account_id: string; amount_minor: number; occurred_on: string;
    }> }
  | { action: 'transaction.reverse'; payload: Readonly<{ transaction_id: string; reason: string }> }
);

export interface FinanceCommandEnvelope {
  headers: Readonly<{ 'If-Match': string; 'Idempotency-Key': string }>;
  body: Readonly<WireCommand>;
}

function requireUUID(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Требуется UUID');
}
function validateCommon(input: CommandPreconditions, requiredIds: readonly string[]): Readonly<Record<string, number>> {
  requireUUID(input.clientMutationId);
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new RangeError('Неверная ревизия');
  if (typeof input.ifMatch !== 'string' || input.ifMatch.length > 256 || !STRONG_ETAG.test(input.ifMatch)) {
    throw new TypeError('Требуется сильный If-Match от сервера');
  }
  if (!input.expectedEntityRevisions || Array.isArray(input.expectedEntityRevisions)
      || typeof input.expectedEntityRevisions !== 'object') throw new TypeError('Нет ревизий сущностей');
  const revisions: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [id, revision] of Object.entries(input.expectedEntityRevisions)) {
    requireUUID(id);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('Неверная ревизия сущности');
    revisions[id] = revision;
  }
  for (const id of requiredIds) if (!Object.hasOwn(revisions, id)) throw new Error('Не указана ревизия зависимой сущности');
  return Object.freeze(revisions);
}
function envelope(input: CommandPreconditions, revisions: Readonly<Record<string, number>>,
                  action: WireCommand['action'], payload: WireCommand['payload']): FinanceCommandEnvelope {
  const common = {
    schema_version: 1 as const,
    client_mutation_id: input.clientMutationId,
    base_revision: input.baseRevision,
    expected_entity_revisions: revisions,
  };
  let body: WireCommand;
  if (action === 'account.transfer') {
    body = { ...common, action, payload: payload as Extract<WireCommand, { action: 'account.transfer' }>['payload'] };
  } else {
    body = { ...common, action, payload: payload as Extract<WireCommand, { action: 'transaction.reverse' }>['payload'] };
  }
  return Object.freeze({
    headers: Object.freeze({ 'If-Match': input.ifMatch, 'Idempotency-Key': input.clientMutationId }),
    body: Object.freeze(body),
  });
}
function validateDate(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Неверная дата');
  const millis = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) {
    throw new TypeError('Несуществующая дата');
  }
}

/** Exactly the existing account.transfer OpenAPI v1 shape, no speculative extra properties. */
export function encodeTransfer(input: TransferInput): FinanceCommandEnvelope {
  requireUUID(input.fromAccountId);
  requireUUID(input.toAccountId);
  if (input.fromAccountId === input.toAccountId) throw new Error('Нельзя переводить на тот же счёт');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > MAX_MINOR) {
    throw new RangeError('Неверная сумма перевода');
  }
  validateDate(input.occurredOn);
  const revisions = validateCommon(input, [input.fromAccountId, input.toAccountId]);
  return envelope(input, revisions, 'account.transfer', Object.freeze({
    from_account_id: input.fromAccountId,
    to_account_id: input.toAccountId,
    amount_minor: input.amountMinor,
    occurred_on: input.occurredOn,
  }));
}

/** Exactly transaction.reverse OpenAPI v1 shape; server creates reversal transaction ID and UTC timestamp. */
export function encodeReversal(input: ReversalInput): FinanceCommandEnvelope {
  requireUUID(input.transactionId);
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) {
    throw new TypeError('Укажите причину отмены');
  }
  const revisions = validateCommon(input, [input.transactionId]);
  return envelope(input, revisions, 'transaction.reverse', Object.freeze({
    transaction_id: input.transactionId,
    reason: input.reason,
  }));
}
