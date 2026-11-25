/** #38: strictly authenticated, read-only finance snapshot and bank rows. */
import {
  decodeCompleteFinanceState, type AccountServerView,
} from '../../domain/accounts/server-snapshot.ts';
import type { ExistingBankMovement } from './types.ts';
import { BankCommitError } from './save.ts';

interface BankRowWire {
  transaction_id: string;
  source_key: string;
  fingerprint: string;
  external_id: string | null;
  kind: 'income' | 'expense' | 'transfer';
  account_id: string;
  target_account_id: string | null;
  occurred_on: string;
  amount_minor: number;
  description: string;
  category: string | null;
  status: 'committed' | 'cancelled';
}
export interface BankHistoryEntry {
  batch_id: string;
  batch_key: string;
  status: 'committed' | 'cancelled';
  committed_revision: number;
  cancelled_revision: number | null;
  committed_at: string;
  operation_count: number;
}
export interface SignedBankSnapshot {
  accounts: ReadonlyArray<{ id: string; name: string; entityRevision: number; balanceMinor: number }>;
  movements: ExistingBankMovement[];
  batches: BankHistoryEntry[];
  historyNextCursor: number | null;
  revision: number;
  etag: string;
}
const safeNumber = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function requestJson(
  url: string,
  options: RequestInit,
  transport: typeof fetch,
): Promise<{ payload: unknown; revisionTag: string; status: number }> {
  let response: Response;
  try {
    // Preserve receiver for native WebKit Window.fetch and test transports.
    response = await transport.call(globalThis, url, {
      redirect: 'error',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'same-origin',
      headers: { Accept: 'application/json', ...options.headers },
      ...options,
    });
  } catch {
    throw new BankCommitError('Не удалось получить финансовый снимок', 'offline', 0);
  }
  if (!response.ok || response.redirected) {
    throw new BankCommitError(
      'Серверная сверка банковского импорта недоступна',
      response.status === 404 ? 'feature_off' : 'finance_read_failed',
      response.status,
    );
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new BankCommitError('Сервер вернул неожиданные данные', 'invalid_snapshot', response.status);
  }
  const body = await response.text();
  if (body.length > 2_000_000) {
    throw new BankCommitError('Финансовый снимок превышает допустимый размер',
      'snapshot_too_large', response.status);
  }
  let payload: unknown;
  try { payload = JSON.parse(body); } catch {
    throw new BankCommitError('Сервер вернул повреждённый JSON', 'invalid_snapshot', response.status);
  }
  return { payload, revisionTag: response.headers.get('etag') || '', status: response.status };
}

/** Pure conversion for bank source identities and cancelled ledger entries. */
export function reconcileSignedBankMovements(
  state: AccountServerView, bankRows: BankRowWire[],
): ExistingBankMovement[] {
  const byTransaction = new Map<string, BankRowWire>();
  for (const row of bankRows) {
    if (byTransaction.has(row.transaction_id)) {
      throw new BankCommitError('Повторяющаяся банковская операция', 'invalid_snapshot', 422);
    }
    byTransaction.set(row.transaction_id, row);
  }
  const postings = new Map<string, { accountId: string; minor: number }[]>();
  for (const item of state.ledger.postings) {
    const existing = postings.get(item.transactionId) || [];
    existing.push({ accountId: item.accountId, minor: item.signedMinor });
    postings.set(item.transactionId, existing);
  }
  const voided = new Set(state.ledger.transactions
    .filter(tx => tx.reversedTransactionId !== null)
    .map(tx => tx.reversedTransactionId!));
  const linked = new Map(state.ledger.paymentLinks
    .map(link => [link.transactionId, link.settlementId || link.loanPaymentId]));
  const records: ExistingBankMovement[] = [];
  for (const tx of state.ledger.transactions) {
    if (tx.kind === 'reversal') continue;
    const legs = postings.get(tx.id) || [];
    if (legs.length === 0) throw new BankCommitError('Неполный журнал операций',
      'invalid_snapshot', 422);
    const first = tx.kind === 'transfer' ? legs.find(item => item.minor < 0) : legs[0];
    const last = tx.kind === 'transfer' ? legs.find(item => item.minor > 0) : null;
    if (!first || (tx.kind === 'transfer' && (!last ||
        first.minor + last.minor !== 0))) {
      throw new BankCommitError('Неполный перевод', 'invalid_snapshot', 422);
    }
    const saved = byTransaction.get(tx.id);
    if (saved && (saved.account_id !== first.accountId ||
      saved.amount_minor !== Math.abs(first.minor) ||
      saved.kind !== (tx.kind === 'payment' ? (first.minor > 0 ? 'income' : 'expense') : tx.kind))) {
      throw new BankCommitError('Несогласованная история импорта', 'invalid_snapshot', 422);
    }
    // Existing public transaction.reverse may independently reverse one
    // imported row while its batch remains committed. A cancelled whole batch
    // must have a reversal for every row, but the converse is not required.
    if (saved && saved.status === 'cancelled' && !voided.has(tx.id)) {
      throw new BankCommitError('Отменённая банковская партия без компенсации',
        'invalid_snapshot', 422);
    }
    const kind = tx.kind === 'transfer' ? 'transfer' :
      (first.minor > 0 ? 'income' : 'expense');
    records.push({
      id: tx.id, sourceKey: saved?.source_key || null,
      fingerprint: saved?.fingerprint || null,
      externalId: saved?.external_id || null,
      accountId: first.accountId, targetAccountId: last?.accountId || null,
      date: tx.occurredOn, amountCents: Math.abs(first.minor), kind,
      description: saved?.description ?? tx.note ?? '',
      category: saved?.category || null, currency: 'RUB',
      linkedPaymentId: linked.get(tx.id) || null,
      // Even cancelled imported source keys remain reserved on the server,
      // and must still count as seen for precise re-import protection.
      voidedAt: voided.has(tx.id) ? tx.occurredOn : null,
    });
  }
  if ([...byTransaction.keys()].some(id => !state.ledger.transactions.some(tx => tx.id === id))) {
    throw new BankCommitError('Неполная история импортированных операций',
      'invalid_snapshot', 422);
  }
  return records;
}

/** One verified page of bank-import history. A long audit must not block cash writes. */
export interface SignedBankHistoryPage {
  batches: BankHistoryEntry[];
  historyNextCursor: number | null;
}

export function validateSignedBankHistoryPage(
  payload: unknown,
  etag: string,
  expectedRevision: number,
  expectedEtag: string,
  beforeCursor: number | null = null,
): SignedBankHistoryPage {
  if (!plain(payload) || payload.schema_version !== 1 ||
      payload.revision !== expectedRevision || etag !== expectedEtag ||
      !Array.isArray(payload.batches) || payload.batches.length > 100 ||
      typeof payload.has_more !== 'boolean' ||
      (beforeCursor !== null && (!Number.isSafeInteger(beforeCursor) ||
        beforeCursor < 1))) {
    throw new BankCommitError('История изменилась при чтении, повторите сверку',
      'stale_revision', 412);
  }
  const batches = payload.batches as BankHistoryEntry[];
  const ids = new Set<string>();
  let last = beforeCursor ?? expectedRevision + 1;
  for (const batch of batches) {
    if (!batch || typeof batch.batch_id !== 'string' ||
        typeof batch.batch_key !== 'string' ||
        !/^[0-9a-f]{64}$/.test(batch.batch_key) ||
        (batch.status !== 'committed' && batch.status !== 'cancelled') ||
        !Number.isSafeInteger(batch.committed_revision) ||
        batch.committed_revision < 1 ||
        batch.committed_revision >= last ||
        !Number.isSafeInteger(batch.operation_count) ||
        batch.operation_count < 1 || batch.operation_count > 1000 ||
        !Number.isFinite(Date.parse(batch.committed_at)) ||
        ids.has(batch.batch_id)) {
      throw new BankCommitError('Некорректная история партий', 'invalid_snapshot', 422);
    }
    ids.add(batch.batch_id);
    last = batch.committed_revision;
  }
  if (payload.has_more) {
    if (batches.length !== 100 ||
        !Number.isSafeInteger(payload.next_cursor) ||
        payload.next_cursor !== batches[batches.length - 1]?.committed_revision ||
        (beforeCursor !== null && (payload.next_cursor as number) >= beforeCursor)) {
      throw new BankCommitError('Некорректный курсор истории импорта',
        'invalid_snapshot', 422);
    }
  } else if (payload.next_cursor !== null) {
    throw new BankCommitError('Некорректное завершение истории импорта',
      'invalid_snapshot', 422);
  }
  return {
    batches,
    historyNextCursor: payload.has_more ? payload.next_cursor as number : null,
  };
}

/** Cursor read stays anchored to the exact full authenticated finance revision. */
export async function loadOlderSignedBankHistory(
  current: SignedBankSnapshot,
  transport: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SignedBankHistoryPage> {
  const cursor = current.historyNextCursor;
  if (cursor === null) return { batches: [], historyNextCursor: null };
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new BankCommitError('Неверный курсор', 'invalid_snapshot', 422);
  }
  const response = await requestJson(
    '/api/finance/v2/bank-import/batches?limit=100&cursor=' + cursor,
    { method: 'GET', signal }, transport,
  );
  return validateSignedBankHistoryPage(
    response.payload, response.revisionTag, current.revision, current.etag, cursor,
  );
}

/** Bootstrap same FH authenticated finance cookie; read all 3 revisions consistently. */
export async function loadSignedBankSnapshot(
  verifiedActorUserId: string,
  transport: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SignedBankSnapshot> {
  if (!/^[0-9a-f]{32}$/.test(verifiedActorUserId)) {
    throw new BankCommitError('Требуется подтверждённый аккаунт', 'locked', 401);
  }
  const session = await requestJson('/api/auth/email/finance/session', {
    method: 'POST', headers: { Origin: globalThis.location?.origin || '' },
    body: '{}', signal,
  }, transport);
  if (session.status !== 200 || !plain(session.payload) ||
      session.payload.ok !== true || typeof session.payload.profile_id !== 'string') {
    throw new BankCommitError('Сессия финансов недоступна', 'locked', 401);
  }
  const snapshot = await requestJson('/api/finance/v1/state?limit_entities=5000',
    { method: 'GET', signal }, transport);
  if (snapshot.status !== 200 || !plain(snapshot.payload)) {
    throw new BankCommitError('Для сверки необходим полный финансовый снимок',
      'incomplete_snapshot', 412);
  }
  const server = decodeCompleteFinanceState(
    snapshot.payload, session.payload.profile_id, verifiedActorUserId,
  );
  const rows = await requestJson('/api/finance/v2/bank-import/rows',
    { method: 'GET', signal }, transport);
  const history = await requestJson('/api/finance/v2/bank-import/batches?limit=100',
    { method: 'GET', signal }, transport);
  if (!plain(rows.payload) || !plain(history.payload) ||
      rows.payload.schema_version !== 1 || history.payload.schema_version !== 1 ||
      !Array.isArray(rows.payload.rows) || !Array.isArray(history.payload.batches) ||
      rows.payload.revision !== server.ledger.revision ||
      rows.revisionTag !== snapshot.revisionTag) {
    throw new BankCommitError('История изменилась при чтении, повторите сверку',
      'stale_revision', 412);
  }
  const bankRows = rows.payload.rows as BankRowWire[];
  if (bankRows.some(row => !row || typeof row.transaction_id !== 'string' ||
      typeof row.source_key !== 'string' || !safeNumber(row.amount_minor) ||
      (row.status !== 'committed' && row.status !== 'cancelled'))) {
    throw new BankCommitError('Некорректные банковские операции', 'invalid_snapshot', 422);
  }
  const historyPage = validateSignedBankHistoryPage(
    history.payload, history.revisionTag, server.ledger.revision, snapshot.revisionTag,
  );
  return {
    accounts: server.ledger.accounts.filter(a => a.archivedAt === null).map(account => ({
      id: account.id, name: account.name, entityRevision: account.entityRevision,
      balanceMinor: stateBalance(server, account.id),
    })),
    movements: reconcileSignedBankMovements(server, bankRows),
    batches: historyPage.batches,
    historyNextCursor: historyPage.historyNextCursor,
    revision: server.ledger.revision,
    etag: snapshot.revisionTag,
  };
}

function stateBalance(state: AccountServerView, accountId: string): number {
  const account = state.ledger.accounts.find(item => item.id === accountId);
  if (!account) throw new BankCommitError('Счёт отсутствует', 'invalid_snapshot', 422);
  const balance = state.ledger.postings.reduce((sum, item) =>
    item.accountId === accountId ? sum + item.signedMinor : sum, account.openingMinor);
  if (!Number.isSafeInteger(balance)) {
    throw new BankCommitError('Переполнение остатка', 'invalid_snapshot', 422);
  }
  return balance;
}
