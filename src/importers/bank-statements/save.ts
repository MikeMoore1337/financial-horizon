/** #38: normalized confirmed money only. Never send source CSV/XLSX or local draft data. */
import type {
  ImportBatchPlan, NormalizedBankOperation, ReconciliationResult,
} from './types.ts';

export interface BankCommitContext {
  revision: number;
  etag: string;
  /** Entity revisions from the authenticated finance snapshot, not IndexedDB. */
  accountEntityRevisions: Readonly<Record<string, number>>;
  /** Persist across retry of the SAME intent. Never generate again on timeout. */
  clientMutationId: string;
}

export interface BankCommitRow {
  source_key: string;
  fingerprint: string;
  external_id: string | null;
  account_id: string;
  target_account_id: string | null;
  occurred_on: string;
  amount_minor: number;
  kind: 'income' | 'expense' | 'transfer';
  description: string;
  category: string | null;
  currency: 'RUB';
  reviewed_transaction_ids: string[];
}

export interface BankCommitRequest {
  schema_version: 1;
  client_mutation_id: string;
  base_revision: number;
  batch_key: string;
  file_digest: string;
  expected_account_revisions: Record<string, number>;
  operations: BankCommitRow[];
}

export interface BankUndoRequest {
  schema_version: 1;
  client_mutation_id: string;
  base_revision: number;
  batch_key: string;
  reason: string;
}

export interface ConfirmedBankResult {
  status: 'COMMITTED' | 'CANCELLED';
  batch_id: string;
  revision: number;
  new_operations: number;
  reversed_operations?: number;
  replayed: boolean;
  etag: string;
}

export class BankCommitError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'BankCommitError';
    this.code = code;
    this.status = status;
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_MINOR = 1_000_000_000_000;
const MAX_JS_INT = Number.MAX_SAFE_INTEGER;

function invalid(message = 'Некорректное подтверждение банковского импорта'): never {
  throw new BankCommitError(message, 'invalid_confirmation', 422);
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_MINOR;
}

function checkContext(context: BankCommitContext): void {
  if (!ETAG.test(context.etag) || !UUID.test(context.clientMutationId) ||
      !Number.isSafeInteger(context.revision) || context.revision < 0) {
    invalid('Требуется актуальный финансовый снимок и корректный ключ запроса');
  }
}

function validateOperation(op: NormalizedBankOperation): void {
  if (!DIGEST.test(op.sourceKey) || !DIGEST.test(op.fingerprint) ||
      !positive(op.amountCents) || !UUID.test(op.accountId) ||
      (op.targetAccountId != null && !UUID.test(op.targetAccountId)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(op.date) ||
      !['income','expense','transfer'].includes(op.kind) ||
      (op.kind === 'transfer') !== (op.targetAccountId != null) ||
      op.targetAccountId === op.accountId || op.currency !== 'RUB' ||
      op.description.length > 500 ||
      (op.externalId != null && (op.externalId.length < 1 || op.externalId.length > 150)) ||
      (op.category != null && (op.category.length < 1 || op.category.length > 160))) {
    invalid();
  }
}

/** Builds a frozen-intent request from a reconciled, owner-confirmed selection. */
export function buildBankCommitRequest(
  plan: ImportBatchPlan,
  reconciliation: ReconciliationResult,
  sourceDigest: string,
  context: BankCommitContext,
): BankCommitRequest {
  checkContext(context);
  if (!DIGEST.test(sourceDigest) || !DIGEST.test(plan.batchKey) ||
      !Number.isInteger(plan.expectedOperationCount) ||
      plan.expectedOperationCount < 1 || plan.expectedOperationCount > 1000 ||
      plan.expectedOperationCount !== plan.operations.length ||
      plan.sourceKeys.length !== plan.operations.length ||
      new Set(plan.sourceKeys).size !== plan.sourceKeys.length) {
    invalid();
  }
  const selected = new Set(plan.sourceKeys);
  const byKey = new Map(reconciliation.rows.filter(row => row.operation)
    .map(row => [row.operation!.sourceKey, row]));
  const versionMap: Record<string, number> = {};
  const operations: BankCommitRow[] = [];
  for (const op of plan.operations) {
    validateOperation(op);
    if (!selected.has(op.sourceKey)) invalid();
    const row = byKey.get(op.sourceKey);
    // draftBankImportBatch intentionally clones and freezes every operation.
    // Compare every financial field, never the source object reference.
    const original = row?.operation;
    if (!row || !original || original.sourceRow !== op.sourceRow ||
        original.sourceKey !== op.sourceKey || original.fingerprint !== op.fingerprint ||
        original.externalId !== op.externalId || original.date !== op.date ||
        original.amountCents !== op.amountCents || original.kind !== op.kind ||
        original.description !== op.description || original.accountId !== op.accountId ||
        original.targetAccountId !== op.targetAccountId ||
        original.category !== op.category || original.currency !== op.currency ||
        !['ready','possible-duplicate'].includes(row.status) ||
        row.warnings.some(warning => warning.severity === 'error')) invalid();
    for (const account of [op.accountId, op.targetAccountId]) {
      if (!account) continue;
      const version = context.accountEntityRevisions[account];
      if (typeof version !== 'number' || !Number.isSafeInteger(version) ||
          version < 1 || version > MAX_JS_INT) {
        invalid('Счёт недоступен в актуальном финансовом снимке');
      }
      versionMap[account] = version;
    }
    const reviewed = row.status === 'possible-duplicate' ? row.existingIds : [];
    if (reviewed.some(id => !UUID.test(id)) || new Set(reviewed).size !== reviewed.length) {
      invalid('Невозможно проверить связанные операции сервера');
    }
    operations.push({
      source_key: op.sourceKey, fingerprint: op.fingerprint,
      external_id: op.externalId, account_id: op.accountId,
      target_account_id: op.targetAccountId, occurred_on: op.date,
      amount_minor: op.amountCents, kind: op.kind,
      description: op.description, category: op.category, currency: 'RUB',
      reviewed_transaction_ids: [...reviewed].sort(),
    });
  }
  if (new Set(operations.map(op => op.source_key)).size !== operations.length) invalid();
  return {
    schema_version: 1, client_mutation_id: context.clientMutationId,
    base_revision: context.revision, batch_key: plan.batchKey,
    file_digest: sourceDigest, expected_account_revisions: versionMap,
    operations,
  };
}

export function buildBankUndoRequest(
  batchKey: string, reason: string, context: BankCommitContext,
): BankUndoRequest {
  checkContext(context);
  if (!DIGEST.test(batchKey) || !reason.trim() || reason.length > 500) invalid();
  return {
    schema_version: 1, client_mutation_id: context.clientMutationId,
    base_revision: context.revision, batch_key: batchKey, reason,
  };
}

/** Ambiguous transport errors MUST NOT be treated as successful server writes. */
async function sendBankRequest(
  action: 'commit' | 'undo',
  request: BankCommitRequest | BankUndoRequest,
  etag: string,
  fetcher: typeof fetch,
): Promise<ConfirmedBankResult> {
  if (!ETAG.test(etag) || !UUID.test(request.client_mutation_id)) invalid();
  let response: Response;
  try {
    response = await fetcher('/api/finance/v2/bank-import/' + action, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      // WebKit can send Origin:null for same-origin POST with no-referrer.
      // Match the existing strict FH CSRF/Origin contract.
      referrerPolicy: 'same-origin',
      headers: {
        'Content-Type': 'application/json', 'If-Match': etag,
        'Idempotency-Key': request.client_mutation_id,
      },
      body: JSON.stringify(request),
    });
  } catch {
    throw new BankCommitError(
      'Ответ сервера неизвестен. Проверьте историю импорта перед повтором',
      'ambiguous_commit', 0,
    );
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new BankCommitError('Непроверенный ответ сервера', 'invalid_server_reply', response.status); }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body &&
      typeof body.code === 'string' ? body.code : 'server_rejected';
    throw new BankCommitError('Импорт отклонён сервером', code, response.status);
  }
  const ack = body as Partial<ConfirmedBankResult> | null;
  const replyEtag = response.headers.get('etag') || '';
  if (!ack || (response.status !== 200 && response.status !== 201) ||
      !ETAG.test(replyEtag) ||
      typeof ack.batch_id !== 'string' || !UUID.test(ack.batch_id) ||
      typeof ack.revision !== 'number' ||
      !Number.isSafeInteger(ack.revision) || ack.revision < 0 ||
      typeof ack.replayed !== 'boolean' ||
      ack.status !== (action === 'commit' ? 'COMMITTED' : 'CANCELLED') ||
      typeof ack.new_operations !== 'number' ||
      !Number.isSafeInteger(ack.new_operations) || ack.new_operations < 0) {
    throw new BankCommitError('Операция не подтверждена сервером', 'invalid_server_reply', response.status);
  }
  if (action === 'commit') {
    const count = (request as BankCommitRequest).operations.length;
    if ((response.status === 201 && (ack.replayed || ack.new_operations !== count)) ||
        (response.status === 200 && (!ack.replayed || ack.new_operations !== 0))) {
      throw new BankCommitError('Число проведённых операций не подтверждено', 'invalid_server_reply', response.status);
    }
  } else if ((response.status !== 200 && response.status !== 201) ||
             (response.status === 201 && (!Number.isSafeInteger(ack.reversed_operations) ||
               ack.reversed_operations! < 1))) {
    throw new BankCommitError('Отмена партии не подтверждена', 'invalid_server_reply', response.status);
  }
  return { status: ack.status, batch_id: ack.batch_id, revision: ack.revision,
    new_operations: ack.new_operations, reversed_operations: ack.reversed_operations,
    replayed: ack.replayed, etag: replyEtag };
}

export async function commitConfirmedBankBatch(
  request: BankCommitRequest, etag: string, fetcher: typeof fetch = fetch,
): Promise<ConfirmedBankResult> {
  return sendBankRequest('commit', request, etag, fetcher);
}

export async function undoConfirmedBankBatch(
  request: BankUndoRequest, etag: string, fetcher: typeof fetch = fetch,
): Promise<ConfirmedBankResult> {
  return sendBankRequest('undo', request, etag, fetcher);
}
