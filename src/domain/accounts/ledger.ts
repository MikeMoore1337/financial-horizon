/**
 * Financial Horizon #33: pure, account-scoped ledger domain.
 * Persistence, session verification, RLS, transaction locks and SHA-256 command
 * receipts belong to finance API #67. Never use this as a client-side authority.
 */
export const MAX_MINOR = 1_000_000_000_000;
export type AccountKind = 'bank' | 'card' | 'cash' | 'savings' | 'other';
export type TransactionKind = 'income' | 'expense' | 'transfer' | 'adjustment' | 'payment' | 'reversal';

export interface Account {
  id: string;
  profileId: string;
  name: string;
  kind: AccountKind;
  currency: 'RUB';
  openingMinor: number;
  entityRevision: number;
  archivedAt: string | null;
}
export interface LedgerTransaction {
  id: string;
  profileId: string;
  kind: TransactionKind;
  occurredOn: string;
  actorUserId: string;
  note: string | null;
  entityRevision: number;
  reversedTransactionId: string | null;
}
export interface LedgerPosting {
  profileId: string;
  transactionId: string;
  accountId: string;
  signedMinor: number;
}
export type PaymentLink = {
  profileId: string;
  transactionId: string;
} & ({ settlementId: string; loanPaymentId?: never } | { loanPaymentId: string; settlementId?: never });
export interface CommandReceipt {
  clientMutationId: string;
  requestFingerprint: string;
  revision: number;
  affectedId: string;
}
export interface LedgerState {
  profileId: string;
  revision: number;
  accounts: Account[];
  transactions: LedgerTransaction[];
  postings: LedgerPosting[];
  paymentLinks: PaymentLink[];
  receipts: CommandReceipt[];
}
export interface LedgerContext {
  /** Must be resolved from an authenticated session by the calling server. */
  profileId: string;
  actorUserId: string;
}
interface CommandBase {
  clientMutationId: string;
  baseRevision: number;
  expectedEntityRevisions: Record<string, number>;
}
interface Occurrence { occurredOn: string; note?: string | null }
export type LedgerCommand = CommandBase & (
  | { action: 'account.create'; payload: { id: string; name: string; kind: AccountKind; currency: 'RUB'; openingMinor: number } }
  | { action: 'account.archive'; payload: { accountId: string; archivedAt: string } }
  | { action: 'account.unarchive'; payload: { accountId: string } }
  | { action: 'transaction.record'; payload: Occurrence & { id: string; accountId: string; kind: 'income' | 'expense' | 'adjustment'; signedMinor: number } }
  | { action: 'account.transfer'; payload: Occurrence & { id: string; fromAccountId: string; toAccountId: string; amountMinor: number } }
  | { action: 'payment.record'; payload: Occurrence & { id: string; accountId: string; amountMinor: number; link: { settlementId: string } | { loanPaymentId: string } } }
  | { action: 'transaction.reverse'; payload: { id: string; transactionId: string; occurredOn: string; reason: string } }
);
export interface AppliedLedgerCommand {
  state: LedgerState;
  receipt: CommandReceipt;
  replayed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_RE = /^[0-9a-f]{32}$/;
const KINDS = new Set<AccountKind>(['bank', 'card', 'cash', 'savings', 'other']);

function uuid(value: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new TypeError('Ожидается UUID');
}
function integer(value: number, min: number, max = MAX_MINOR): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError('Сумма должна быть целым числом копеек в допустимых пределах');
  }
}
function add(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_MINOR) {
    throw new RangeError('Остаток превышает допустимый предел');
  }
  return result;
}
function date(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Неверная дата');
  const t = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(t.getTime()) || t.toISOString().slice(0, 10) !== value) throw new TypeError('Несуществующая дата');
}
function text(value: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError('Неверное текстовое поле');
}
function checkedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Неверная ревизия');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Неверное число в команде');
  const output = JSON.stringify(value);
  if (output === undefined) throw new TypeError('Недопустимое поле команды');
  return output;
}

export function emptyLedger(profileId: string): LedgerState {
  uuid(profileId);
  return { profileId, revision: 0, accounts: [], transactions: [], postings: [], paymentLinks: [], receipts: [] };
}
export function accountBalanceMinor(state: LedgerState, accountId: string): number {
  const account = state.accounts.find(a => a.id === accountId && a.profileId === state.profileId);
  if (!account) throw new Error('Счёт не найден в профиле');
  integer(account.openingMinor, -MAX_MINOR);
  return state.postings.reduce((balance, posting) => {
    if (posting.profileId !== state.profileId || posting.accountId !== accountId) return balance;
    integer(posting.signedMinor, -MAX_MINOR);
    return add(balance, posting.signedMinor);
  }, account.openingMinor);
}
export function totalBalanceMinor(state: LedgerState): number {
  return state.accounts.reduce((total, account) => add(total, accountBalanceMinor(state, account.id)), 0);
}
/** The reserves module (#6) supplies an already validated allocated amount; no double subtraction of planned bills. */
export function availableBalanceMinor(state: LedgerState, accountId: string, reservedMinor: number): number {
  integer(reservedMinor, 0);
  return add(accountBalanceMinor(state, accountId), -reservedMinor);
}
export function monthlyCashFlowMinor(state: LedgerState, month: string): { incomeMinor: number; expenseMinor: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('Неверный месяц');
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const tx of state.transactions) {
    if (tx.profileId !== state.profileId || !tx.occurredOn.startsWith(`${month}-`)) continue;
    const original = tx.kind === 'reversal'
      ? state.transactions.find(value => value.id === tx.reversedTransactionId && value.profileId === state.profileId)
      : tx;
    if (!original) throw new Error('Отмена без исходной операции');
    const impact = state.postings.filter(p => p.transactionId === tx.id && p.profileId === state.profileId)
      .reduce((sum, p) => add(sum, p.signedMinor), 0);
    if (original.kind === 'income') incomeMinor = add(incomeMinor, impact);
    if (original.kind === 'expense' || original.kind === 'payment') expenseMinor = add(expenseMinor, -impact);
  }
  return { incomeMinor, expenseMinor };
}

function accountForWrite(state: LedgerState, id: string, command: LedgerCommand, archivedAllowed = false): Account {
  uuid(id);
  const account = state.accounts.find(a => a.id === id && a.profileId === state.profileId);
  if (!account || (!archivedAllowed && account.archivedAt !== null)) throw new Error('Счёт недоступен');
  if (command.expectedEntityRevisions[id] !== account.entityRevision) throw new Error('Конфликт ревизии счёта');
  return account;
}
function post(state: LedgerState, tx: LedgerTransaction, postings: Array<[Account, number]>): void {
  uuid(tx.id);
  date(tx.occurredOn);
  if (state.transactions.some(item => item.id === tx.id)) throw new Error('Идентификатор операции уже существует');
  if (new Set(postings.map(([account]) => account.id)).size !== postings.length) {
    throw new Error('Повторяющийся счёт в одной операции');
  }
  for (const [account, amount] of postings) {
    integer(amount, -MAX_MINOR);
    if (amount === 0) throw new RangeError('Нулевая проводка запрещена');
    // Check the final balance before mutating anything.
    add(accountBalanceMinor(state, account.id), amount);
  }
  state.transactions.push(tx);
  for (const [account, amount] of postings) {
    state.postings.push({ profileId: state.profileId, transactionId: tx.id, accountId: account.id, signedMinor: amount });
    account.entityRevision++;
  }
}
function transaction(state: LedgerState, context: LedgerContext, id: string, kind: TransactionKind, occurredOn: string, note?: string | null, originalId: string | null = null): LedgerTransaction {
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) throw new TypeError('Примечание слишком длинное');
  return { id, profileId: state.profileId, kind, occurredOn, actorUserId: context.actorUserId, note: note ?? null, entityRevision: 1, reversedTransactionId: originalId };
}

/** Atomic as a pure state transition. The server MUST persist all rows, receipt and revision in one DB transaction. */
export function applyLedgerCommand(source: LedgerState, command: LedgerCommand, context: LedgerContext): AppliedLedgerCommand {
  uuid(source.profileId);
  if (context.profileId !== source.profileId || !ACTOR_RE.test(context.actorUserId)) throw new Error('Доступ к финансовому профилю запрещён');
  uuid(command.clientMutationId);
  checkedRevision(source.revision);
  checkedRevision(command.baseRevision);
  if (!command.expectedEntityRevisions || Array.isArray(command.expectedEntityRevisions) || typeof command.expectedEntityRevisions !== 'object') {
    throw new TypeError('Неверные предусловия команды');
  }
  for (const value of Object.values(command.expectedEntityRevisions)) checkedRevision(value);
  const fingerprint = canonical(command);
  const oldReceipt = source.receipts.find(r => r.clientMutationId === command.clientMutationId);
  if (oldReceipt) {
    if (oldReceipt.requestFingerprint !== fingerprint) throw new Error('idempotency_key_reuse');
    return { state: source, receipt: oldReceipt, replayed: true };
  }
  if (command.baseRevision !== source.revision) throw new Error('stale_revision');
  if (source.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Переполнение ревизии');
  const state = structuredClone(source);
  let affectedId: string;
  switch (command.action) {
    case 'account.create': {
      const payload = command.payload;
      uuid(payload.id);
      text(payload.name, 160);
      if (payload.currency !== 'RUB' || !KINDS.has(payload.kind)) throw new TypeError('Неверный тип счёта или валюта');
      integer(payload.openingMinor, -MAX_MINOR); // Must be supplied explicitly, including zero.
      if (state.accounts.some(a => a.id === payload.id)) throw new Error('Счёт уже существует');
      state.accounts.push({ id: payload.id, profileId: state.profileId, name: payload.name.trim(), kind: payload.kind, currency: 'RUB', openingMinor: payload.openingMinor, entityRevision: 1, archivedAt: null });
      affectedId = payload.id;
      break;
    }
    case 'account.archive': {
      const payload = command.payload;
      const a = accountForWrite(state, payload.accountId, command);
      if (!Number.isFinite(Date.parse(payload.archivedAt))) throw new TypeError('Неверная дата архивации');
      a.archivedAt = payload.archivedAt;
      a.entityRevision++;
      affectedId = a.id;
      break;
    }
    case 'account.unarchive': {
      const payload = command.payload;
      const a = accountForWrite(state, payload.accountId, command, true);
      if (a.archivedAt === null) throw new Error('Счёт не архивирован');
      a.archivedAt = null;
      a.entityRevision++;
      affectedId = a.id;
      break;
    }
    case 'transaction.record': {
      const payload = command.payload;
      const a = accountForWrite(state, payload.accountId, command);
      if (payload.kind !== 'income' && payload.kind !== 'expense' && payload.kind !== 'adjustment') {
        throw new TypeError('Неизвестный вид фактической операции');
      }
      integer(payload.signedMinor, -MAX_MINOR);
      if (payload.signedMinor === 0 || (payload.kind === 'income' && payload.signedMinor < 0) || (payload.kind === 'expense' && payload.signedMinor > 0)) {
        throw new RangeError('Неверный знак фактической операции');
      }
      post(state, transaction(state, context, payload.id, payload.kind, payload.occurredOn, payload.note), [[a, payload.signedMinor]]);
      affectedId = payload.id;
      break;
    }
    case 'account.transfer': {
      const payload = command.payload;
      if (payload.fromAccountId === payload.toAccountId) throw new Error('Перевод на тот же счёт запрещён');
      const from = accountForWrite(state, payload.fromAccountId, command);
      const to = accountForWrite(state, payload.toAccountId, command);
      integer(payload.amountMinor, 1);
      post(state, transaction(state, context, payload.id, 'transfer', payload.occurredOn, payload.note), [[from, -payload.amountMinor], [to, payload.amountMinor]]);
      affectedId = payload.id;
      break;
    }
    case 'payment.record': {
      const payload = command.payload;
      const a = accountForWrite(state, payload.accountId, command);
      integer(payload.amountMinor, 1);
      const link = payload.link;
      const settlement = 'settlementId' in link ? link.settlementId : undefined;
      const loan = 'loanPaymentId' in link ? link.loanPaymentId : undefined;
      if ((settlement === undefined) === (loan === undefined)) throw new TypeError('Платёж должен ссылаться ровно на один факт оплаты');
      uuid((settlement ?? loan) as string);
      if (state.paymentLinks.some(p => (settlement && 'settlementId' in p && p.settlementId === settlement)
          || (loan && 'loanPaymentId' in p && p.loanPaymentId === loan))) throw new Error('Оплата уже проведена по счёту');
      post(state, transaction(state, context, payload.id, 'payment', payload.occurredOn, payload.note), [[a, -payload.amountMinor]]);
      state.paymentLinks.push(settlement !== undefined
        ? { profileId: state.profileId, transactionId: payload.id, settlementId: settlement }
        : { profileId: state.profileId, transactionId: payload.id, loanPaymentId: loan as string });
      affectedId = payload.id;
      break;
    }
    case 'transaction.reverse': {
      const payload = command.payload;
      text(payload.reason, 500);
      const original = state.transactions.find(t => t.id === payload.transactionId && t.profileId === state.profileId);
      if (!original || original.kind === 'reversal') throw new Error('Исходная операция недоступна');
      if (command.expectedEntityRevisions[original.id] !== original.entityRevision) throw new Error('Конфликт ревизии операции');
      if (state.transactions.some(t => t.reversedTransactionId === original.id)) throw new Error('Операция уже отменена');
      const originals = state.postings.filter(p => p.transactionId === original.id && p.profileId === state.profileId);
      if (originals.length < 1 || originals.length > 2) throw new Error('Исходные проводки повреждены');
      const inverse = originals.map(p => [accountForWrite(state, p.accountId, command, true), -p.signedMinor] as [Account, number]);
      post(state, transaction(state, context, payload.id, 'reversal', payload.occurredOn, payload.reason, original.id), inverse);
      original.entityRevision++;
      affectedId = payload.id;
      break;
    }
    default: {
      const neverAction: never = command;
      throw new Error(`Неизвестная команда: ${String(neverAction)}`);
    }
  }
  state.revision++;
  const receipt: CommandReceipt = { clientMutationId: command.clientMutationId, requestFingerprint: fingerprint, revision: state.revision, affectedId };
  state.receipts.push(receipt);
  return { state, receipt, replayed: false };
}
