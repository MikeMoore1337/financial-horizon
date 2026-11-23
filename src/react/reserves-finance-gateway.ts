/**
 * #6 - authenticated, server-authoritative reserves gateway.
 * Online payments persist one account-scoped recovery intent before sending.
 * No optimistic financial updates or new payment IDs on retry: receipt and
 * complete authenticated server snapshot must confirm the original command.
 */
import { decodeCompleteFinanceState, type AccountServerView } from '../domain/accounts/server-snapshot.ts';
import { pendingOnlinePayment } from '../../storage.js?rev=auth-scopes-v18';
import { deriveAccountsView, type AccountViewRow } from './accounts-view-model.ts';
import {
  decodeServerReserve, projectServerReserve, type ReserveServerRecord,
} from '../domain/reserves/server-snapshot.ts';
import { type ReserveProjection } from '../domain/reserves/index.ts';
import {
  encodeReserveV2, type ReserveV2Action,
} from '../domain/reserves/v2-wire.ts';
import { verifyReservePostcondition } from './reserve-commit-proof.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR = /^[0-9a-f]{32}$/;
const ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_RESPONSE_BYTES = 2_000_000;
// A page may mount several finance screens; reuse the verified binding in memory.
// Every subsequent /state request still authenticates and checks the profile.
type FinanceSession = {profile: string; paymentGuard: boolean};
let sharedFinanceSession: ({actor: string} & FinanceSession) | null = null;
let pendingFinanceSession: {actor: string; promise: Promise<FinanceSession>} | null = null;

type JsonObject = Record<string, unknown>;
type FailureKind = 'locked' | 'conflict' | 'offline' | 'error';

export class ReservesFinanceError extends Error {
  readonly kind: FailureKind;
  readonly httpStatus?: number;
  readonly serverCode?: string;
  constructor(kind: FailureKind, httpStatus?: number, serverCode?: string) {
    super({
      locked: 'Доступ к финансам не подтверждён. Войдите в аккаунт.',
      conflict: 'Данные изменились или операция требует сверки. Новые платежи заблокированы.',
      offline: 'Сервер финансов временно недоступен. Запись не подтверждена.',
      error: 'Не удалось проверить финансовые данные.',
    }[kind]);
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.serverCode = serverCode;
    this.name = 'ReservesFinanceError';
  }
}

function object(raw: unknown): raw is JsonObject {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
// The server mints the payment and ledger IDs. Match its receipt to the
// requested payment before accepting either identifier for the snapshot proof.
export function paymentReceiptIds(changes: unknown[], payload: JsonObject, revision: number): JsonObject {
  const transactions = changes.filter((item) => object(item) && item.kind === 'ledger_posted' &&
    object(item.payload) && object(item.payload.entity) && item.payload.entity.kind === 'transaction');
  const facts = changes.filter((item) => object(item) && item.kind === 'upsert' &&
    object(item.payload) && object(item.payload.entity) && item.payload.entity.kind === 'settlement');
  if (transactions.length !== 1 || facts.length !== 1) throw new ReservesFinanceError('error');
  const txChange = transactions[0] as JsonObject, factChange = facts[0] as JsonObject;
  const tx = (txChange.payload as JsonObject).entity as JsonObject;
  const fact = (factChange.payload as JsonObject).entity as JsonObject;
  if (!object(tx.data) || !object(fact.data) || !object(tx.data.payment_link) ||
      txChange.revision !== revision || factChange.revision !== revision ||
      txChange.entity_id !== tx.id || factChange.entity_id !== fact.id ||
      txChange.entity_revision !== tx.entity_revision || factChange.entity_revision !== fact.entity_revision ||
      !UUID.test(String(tx.id)) || !UUID.test(String(fact.id)) || tx.id === fact.id ||
      tx.data.kind !== 'payment' || tx.data.occurred_on !== payload.paid_on ||
      tx.data.payment_link.settlement_id !== fact.id || tx.data.payment_link.loan_payment_id !== null ||
      !Array.isArray(tx.data.postings) || tx.data.postings.length !== 1 ||
      !object(tx.data.postings[0]) || tx.data.postings[0].account_id !== payload.account_id ||
      tx.data.postings[0].signed_minor !== -(payload.amount_minor as number) ||
      fact.data.obligation_id !== payload.obligation_id || fact.data.amount_minor !== payload.amount_minor ||
      fact.data.paid_on !== payload.paid_on || fact.data.occurrence_on !== payload.occurrence_on ||
      fact.data.voided_at !== null) throw new ReservesFinanceError('error');
  return {...payload, transaction_id: tx.id, fact_id: fact.id};
}
function reversalReceiptId(changes: unknown[], payload: JsonObject, revision: number,
  original: ReservesServerView): string {
  const originalTx = original.ledger.transactions.find(item => item.id === payload.transaction_id);
  const posting = original.ledger.postings.filter(item => item.transactionId === payload.transaction_id);
  const link = original.ledger.paymentLinks.find(item => item.transactionId === payload.transaction_id);
  const fact = original.planner.settlements.find(item => item.id === payload.fact_id);
  const reversals = changes.filter(item => object(item) && item.kind === 'ledger_posted' &&
    object(item.payload) && object(item.payload.entity) && item.payload.entity.kind === 'transaction');
  const facts = changes.filter(item => object(item) && item.kind === 'upsert' &&
    object(item.payload) && object(item.payload.entity) && item.payload.entity.kind === 'settlement');
  if (!originalTx || originalTx.kind !== 'payment' || posting.length !== 1 ||
      posting[0]?.accountId !== payload.account_id || !link || link.settlementId !== payload.fact_id ||
      !fact || reversals.length !== 1 || facts.length !== 1) throw new ReservesFinanceError('error');
  const reversal = reversals[0] as JsonObject, factChange = facts[0] as JsonObject;
  const tx = (reversal.payload as JsonObject).entity as JsonObject;
  const updated = (factChange.payload as JsonObject).entity as JsonObject;
  if (!object(tx.data) || !object(updated.data) || reversal.revision !== revision ||
      factChange.revision !== revision || reversal.entity_id !== tx.id ||
      factChange.entity_id !== updated.id || reversal.entity_revision !== tx.entity_revision ||
      factChange.entity_revision !== updated.entity_revision || !UUID.test(String(tx.id)) ||
      tx.data.kind !== 'reversal' || tx.data.reversed_transaction_id !== payload.transaction_id ||
      tx.data.note !== payload.reason || !Array.isArray(tx.data.postings) ||
      tx.data.postings.length !== 1 || !object(tx.data.postings[0]) ||
      tx.data.postings[0].account_id !== payload.account_id ||
      tx.data.postings[0].signed_minor !== -posting[0]!.signedMinor ||
      updated.id !== fact.id || updated.data.obligation_id !== fact.entryId ||
      updated.data.amount_minor !== fact.amountCents || updated.data.paid_on !== fact.date ||
      typeof updated.data.occurrence_on !== 'string' ||
      updated.data.occurrence_on.slice(0, 7) !== fact.occurrence ||
      typeof updated.data.voided_at !== 'string') throw new ReservesFinanceError('error');
  return String(tx.id);
}

function entityId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new ReservesFinanceError('error');
  return raw;
}
function integer(raw: unknown, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new ReservesFinanceError('error');
  }
  return raw;
}
function asEntity(raw: unknown): { id: string; kind: string; revision: number; data: JsonObject } {
  if (!object(raw) || typeof raw.kind !== 'string' || !object(raw.data)) {
    throw new ReservesFinanceError('error');
  }
  return {
    id: entityId(raw.id),
    kind: raw.kind,
    revision: integer(raw.entity_revision, 1, Number.MAX_SAFE_INTEGER),
    data: raw.data,
  };
}

/** Read-only adapter for the existing calendar/reminder model. It never writes
 * local records or infers a relationship between server and legacy IDs. */
export function projectServerPaymentPlanner(raw: unknown): {
  entries: Array<{id: string; title: string; kind: 'income' | 'expense'; amountCents: number;
    date: string; recurrence: 'once' | 'monthly' | 'yearly'; recurrenceEvery: number;
    category: string; deletedAt: string | null}>;
  settlements: Array<{id: string; entryId: string; occurrence: string; date: string;
    amountCents: number; voidedAt: string | null}>;
  loans: never[]; loanPayments: never[]; serverLoanCount: number;
} {
  if (!Array.isArray(raw)) throw new ReservesFinanceError('error');
  const items = raw.map(asEntity);
  const entries: ReturnType<typeof projectServerPaymentPlanner>['entries'] = [];
  const settlements: ReturnType<typeof projectServerPaymentPlanner>['settlements'] = [];
  const ids = new Set<string>();
  const validDate = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  for (const item of items) {
    if (item.kind !== 'obligation') continue;
    const d = item.data;
    if (ids.has(item.id) || typeof d.title !== 'string' || !d.title.trim() ||
        (d.direction !== 'income' && d.direction !== 'expense') || !validDate(d.starts_on) ||
        (d.recurrence_unit !== 'none' && d.recurrence_unit !== 'month' && d.recurrence_unit !== 'year') ||
        (d.deleted_at != null && typeof d.deleted_at !== 'string') ||
        (d.category != null && typeof d.category !== 'string')) throw new ReservesFinanceError('error');
    ids.add(item.id);
    entries.push({id: item.id, title: d.title, kind: d.direction,
      amountCents: integer(d.amount_minor, 0, 1_000_000_000_000), date: d.starts_on,
      recurrence: d.recurrence_unit === 'none' ? 'once' : d.recurrence_unit === 'month' ? 'monthly' : 'yearly',
      recurrenceEvery: integer(d.recurrence_every, 1, 120), category: d.category ?? '',
      deletedAt: d.deleted_at ?? null});
  }
  const facts = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'settlement') continue;
    const d = item.data;
    if (facts.has(item.id) || typeof d.obligation_id !== 'string' || !ids.has(d.obligation_id) ||
        !validDate(d.occurrence_on) || !validDate(d.paid_on) ||
        (d.voided_at != null && typeof d.voided_at !== 'string')) throw new ReservesFinanceError('error');
    facts.add(item.id);
    settlements.push({id: item.id, entryId: d.obligation_id, occurrence: d.occurrence_on.slice(0, 7),
      date: d.paid_on, amountCents: integer(d.amount_minor, 1, 1_000_000_000_000),
      voidedAt: d.voided_at ?? null});
  }
  return {entries, settlements, loans: [], loanPayments: [],
    serverLoanCount: items.filter(item => item.kind === 'loan' && item.data.deleted_at == null).length};
}

export interface ReserveObligationOption {
  readonly id: string;
  readonly title: string;
  readonly amountMinor: number;
  readonly entityRevision: number;
  readonly archived: boolean;
}
export interface ReserveHistoryEntry {
  readonly id: string;
  readonly kind: string;
  readonly date: string;
  readonly amountMinor: number | null;
  readonly reservedUsedMinor: number | null;
  readonly voided: boolean;
  readonly transactionId: string | null;
  readonly settlementId: string | null;
}
export interface ReserveViewRow {
  readonly id: string;
  readonly accountId: string;
  readonly obligationId: string;
  readonly entityRevision: number;
  readonly archived: boolean;
  readonly source: ReserveServerRecord;
  readonly projection: ReserveProjection;
  readonly history: readonly ReserveHistoryEntry[];
}
export interface ReservesServerView {
  readonly profileId: string;
  readonly revision: number;
  readonly accounts: readonly AccountViewRow[];
  readonly obligations: readonly ReserveObligationOption[];
  readonly planner: ReturnType<typeof projectServerPaymentPlanner>;
  readonly ledger: AccountServerView['ledger'];
  readonly reserves: readonly ReserveViewRow[];
  readonly totalMinor: number;
  readonly reservedMinor: number;
  readonly availableMinor: number;
  readonly entityRevisions: Readonly<Record<string, number>>;
}

function decodeReserves(
  raw: unknown, profileId: string, verifiedActor: string, asOfDate: string,
): ReservesServerView {
  const accountState = decodeCompleteFinanceState(raw, profileId, verifiedActor);
  const totals = deriveAccountsView(
    accountState.ledger, profileId, accountState.reservedMinorByAccount,
  );
  if (!object(raw) || !Array.isArray(raw.entities) || raw.entities.length > 10_000) {
    throw new ReservesFinanceError('error');
  }
  const entities = raw.entities.map(asEntity);
  const revisions: Record<string, number> = Object.create(null);
  const obligations: ReserveObligationOption[] = [];
  const transactions = new Map<string, string>();
  for (const item of entities) {
    if (Object.hasOwn(revisions, item.id)) {
      throw new ReservesFinanceError('error');
    }
    revisions[item.id] = item.revision;
    if (item.kind === 'obligation' && item.data.direction === 'expense') {
      obligations.push({
        id: item.id,
        title: String(item.data.title ?? ''),
        amountMinor: integer(item.data.amount_minor, 0, 1_000_000_000_000),
        entityRevision: item.revision,
        archived: item.data.deleted_at !== null && item.data.deleted_at !== undefined,
      });
    }
    if (item.kind === 'transaction' && object(item.data.payment_link)) {
      const id = item.data.payment_link.settlement_id;
      if (typeof id === 'string' && UUID.test(id)) transactions.set(item.id, id);
    }
  }
  const accountIds = new Set(totals.rows.map((account) => account.id));
  const obligationIds = new Set(obligations.map((obligation) => obligation.id));
  const reserves: ReserveViewRow[] = [];
  for (const item of entities) {
    if (item.kind !== 'reserve') continue;
    const source = projectServerReserve({
      id: item.id, kind: item.kind, entity_revision: item.revision, data: item.data,
    }, asOfDate);
    if (!source) continue; // Legacy non-recurring reserve, not a #6 cycle.
    const decoded = source;
    const rawRecord = {
      id: item.id, kind: item.kind, entity_revision: item.revision, data: item.data,
    };
    // Decode a single authoritative source, never fabricate a local reserve.
    // projectServerReserve verifies the full immutable event stream against SQL.
    const complete = decodeServerReserve(rawRecord);
    if (!complete) throw new ReservesFinanceError('error');
    if (!accountIds.has(entityId(item.data.account_id)) ||
        !obligationIds.has(entityId(item.data.obligation_id))) {
      throw new ReservesFinanceError('error');
    }
    const events = item.data.event_log;
    if (!Array.isArray(events)) throw new ReservesFinanceError('error');
    const voided = new Set(
      events.filter((event) => object(event) && event.kind === 'void')
        .map((event) => (event as JsonObject).target_event_id),
    );
    const history = events.map((event): ReserveHistoryEntry => {
      if (!object(event)) throw new ReservesFinanceError('error');
      const transactionId = typeof event.transaction_id === 'string' &&
        UUID.test(event.transaction_id) ? event.transaction_id : null;
      return {
        id: entityId(event.id),
        kind: String(event.kind),
        date: String(event.occurred_on),
        amountMinor: typeof event.amount_minor === 'number' ? event.amount_minor : null,
        reservedUsedMinor: typeof event.reserved_used_minor === 'number' ?
          event.reserved_used_minor : null,
        voided: voided.has(event.id),
        transactionId,
        settlementId: transactionId ? transactions.get(transactionId) ?? null : null,
      };
    });
    // The strict domain decoder is called below for editing and event IDs.
    reserves.push({
      id: item.id,
      accountId: entityId(item.data.account_id),
      obligationId: entityId(item.data.obligation_id),
      entityRevision: item.revision,
      archived: item.data.archived_at !== null && item.data.archived_at !== undefined,
      source: complete,
      projection: decoded,
      history,
    });
  }
  return {
    profileId, revision: accountState.ledger.revision, accounts: totals.rows,
    obligations, planner: projectServerPaymentPlanner(raw.entities), ledger: accountState.ledger,
    reserves, totalMinor: totals.totalMinor,
    reservedMinor: totals.reservedMinor, availableMinor: totals.availableMinor,
    entityRevisions: revisions,
  };
}

interface ResponseEnvelope {
  readonly status: number;
  readonly body: unknown;
  readonly etag: string | null;
}

export class ReservesFinanceGateway {
  private actor: string | null = null;
  private profile: string | null = null;
  private paymentGuard = false;
  private view: ReservesServerView | null = null;
  private etag: string | null = null;
  private generation = 0;
  private reads = 0;
  private writing = false;
  private uncertain = false;
  private readonly transport: typeof fetch;
  private readonly origin: string;
  private readonly makeId: () => string;
  private readonly sharedSession: boolean;

  constructor(
    transport: typeof fetch = fetch,
    origin: string = window.location.origin,
    makeId: () => string = () => crypto.randomUUID(),
  ) {
    this.transport = transport.bind(window);
    this.origin = origin;
    this.makeId = makeId;
    this.sharedSession = transport === window.fetch && origin === window.location.origin;
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new ReservesFinanceError('error');
    }
  }

  get supportsPaymentGuard(): boolean { return this.paymentGuard; }

  get writeBlocked(): boolean {
    return this.uncertain || this.writing || !this.view;
  }

  invalidate(): void {
    this.generation += 1;
    this.reads += 1;
    this.actor = null;
    this.profile = null;
    this.paymentGuard = false;
    this.view = null;
    this.etag = null;
    this.uncertain = true;
  }

  private async request(
    path: string, init: RequestInit, signal?: AbortSignal,
  ): Promise<ResponseEnvelope> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new ReservesFinanceError('error');
    let response: Response;
    try {
      response = await this.transport(url.href, {
        ...init,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'same-origin',
        cache: 'no-store',
        signal,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
      });
    } catch {
      throw new ReservesFinanceError('offline');
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      throw new ReservesFinanceError('error');
    }
    if (response.status === 401 || response.status === 403) throw new ReservesFinanceError('locked');
    if ([410, 412, 428].includes(response.status)) throw new ReservesFinanceError('conflict', response.status);
    if (response.status === 429 || response.status >= 500) throw new ReservesFinanceError('offline');
    if (response.status !== 409 && (response.status < 200 || response.status >= 300)) throw new ReservesFinanceError('error');
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
        !response.body) throw new ReservesFinanceError('error');
    const declared = response.headers.get('content-length');
    if (declared !== null &&
        (!/^[0-9]{1,10}$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
      throw new ReservesFinanceError('error');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let body: unknown;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (!ArrayBuffer.isView(part.value) ||
            !Number.isSafeInteger(part.value.length) ||
            part.value.length !== part.value.byteLength) throw Error('Bad chunk');
        total += part.value.byteLength;
        if (total > MAX_RESPONSE_BYTES || chunks.length >= 8192) throw Error('Oversized response');
        chunks.push(part.value);
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
    } catch {
      try { await reader.cancel(); } catch { /* Already invalid. */ }
      throw new ReservesFinanceError('error');
    } finally {
      reader.releaseLock();
    }
    if (response.status === 409) throw new ReservesFinanceError('conflict', 409,
      object(body) && typeof body.code === 'string' ? body.code : undefined);
    return { status: response.status, body, etag: response.headers.get('etag') };
  }

  private async bootstrap(actor: string, force = false): Promise<FinanceSession> {
    if (this.sharedSession && !force && sharedFinanceSession?.actor === actor) return sharedFinanceSession;
    if (this.sharedSession && !force && pendingFinanceSession?.actor === actor) return pendingFinanceSession.promise;
    const promise = (async () => {
      // Shared work is not tied to one component's abort signal; each caller
      // still checks its own generation before using the returned profile.
      const response = await this.request('/api/auth/email/finance/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (response.status !== 200 || !object(response.body) || response.body.ok !== true ||
          !UUID.test(String(response.body.profile_id))) throw new ReservesFinanceError('error');
      return {profile: String(response.body.profile_id), paymentGuard: response.body.payment_guard_v1 === true};
    })();
    if (this.sharedSession) pendingFinanceSession = {actor, promise};
    try {
      const session = await promise;
      if (this.sharedSession && pendingFinanceSession?.promise === promise) {
        sharedFinanceSession = {actor, ...session};
      }
      return session;
    } finally {
      if (this.sharedSession && pendingFinanceSession?.promise === promise) pendingFinanceSession = null;
    }
  }

  async open(actor: string, asOfDate: string, signal?: AbortSignal): Promise<ReservesServerView> {
    this.invalidate();
    const epoch = this.generation;
    if (!ACTOR.test(actor) || signal?.aborted) throw new ReservesFinanceError('locked');
    this.actor = actor;
    const cached = this.sharedSession && sharedFinanceSession?.actor === actor;
    const session = await this.bootstrap(actor);
    this.profile = session.profile;
    this.paymentGuard = session.paymentGuard;
    if (epoch !== this.generation || signal?.aborted) throw new ReservesFinanceError('locked');
    this.uncertain = false;
    try {
      return await this.load(actor, asOfDate, signal);
    } catch (error) {
      // A revoked or expired cookie is never trusted merely because the page
      // remembers a profile. Re-bootstrap once against the real FH session.
      if (!cached || !(error instanceof ReservesFinanceError) || error.kind !== 'locked' ||
          epoch !== this.generation || signal?.aborted) throw error;
      sharedFinanceSession = null;
      const renewed = await this.bootstrap(actor, true);
      this.profile = renewed.profile;
      this.paymentGuard = renewed.paymentGuard;
      if (epoch !== this.generation || signal?.aborted) throw new ReservesFinanceError('locked');
      return this.load(actor, asOfDate, signal);
    }
  }

  async refresh(actor: string, asOfDate: string, signal?: AbortSignal): Promise<ReservesServerView> {
    return this.load(actor, asOfDate, signal);
  }

  private async load(
    actor: string, asOfDate: string, signal?: AbortSignal, internal = false,
  ): Promise<ReservesServerView> {
    const epoch = this.generation;
    if (actor !== this.actor || !this.profile || (this.writing && !internal)) {
      throw new ReservesFinanceError('locked');
    }
    const read = ++this.reads;
    const response = await this.request('/api/finance/v1/state?limit_entities=5000', {
      method: 'GET',
    }, signal);
    if (epoch !== this.generation) throw new ReservesFinanceError('locked');
    if (read !== this.reads || (this.writing && !internal)) {
      throw new ReservesFinanceError('conflict');
    }
    // Partial 206 pages MUST NOT be shown as real account totals.
    if (response.status !== 200 || !response.etag || !ETAG.test(response.etag)) {
      throw new ReservesFinanceError('error');
    }
    let view: ReservesServerView;
    try {
      view = decodeReserves(response.body, this.profile, actor, asOfDate);
    } catch {
      throw new ReservesFinanceError('error');
    }
    if (epoch !== this.generation || read !== this.reads ||
        (this.writing && !internal)) throw new ReservesFinanceError('conflict');
    this.view = view;
    this.etag = response.etag;
    // A read alone must never reauthorize another debit after an ambiguous POST.
    return view;
  }

  /** Check only the currently selected local account's unresolved online request. */
  async hasPendingOnlinePayment(): Promise<boolean> {
    if (!this.actor || !this.profile) throw new ReservesFinanceError('locked');
    return (await pendingOnlinePayment(this.actor, 'read')) !== null;
  }

  private async withPaymentLock<T>(operation: () => Promise<T>): Promise<T> {
    const actor = this.actor;
    if (!actor || !navigator.locks) throw new ReservesFinanceError('locked');
    return navigator.locks.request('fh-online-payment:' + actor, {mode: 'exclusive'}, operation);
  }

  /** Online-only: persist one already requested command before transmitting it.
   * On an ambiguous response, recovery resends the exact same mutation UUID. */
  async confirmOnlinePayment(
    input: {accountId: string; obligationId: string; amountMinor: number;
      paidOn: string; occurrenceOn: string}, asOfDate: string,
  ): Promise<ReservesServerView> {
    if (!this.paymentGuard) throw new ReservesFinanceError('error');
    return this.withPaymentLock(async () => {
      const before = this.view, actor = this.actor, profile = this.profile, etag = this.etag;
      if (!before || !actor || !profile || !etag || this.writeBlocked) {
        throw new ReservesFinanceError('conflict');
      }
      if (navigator.onLine === false) throw new ReservesFinanceError('offline');
      if (await pendingOnlinePayment(actor, 'read')) throw new ReservesFinanceError('conflict');
      const account = before.accounts.find(item => item.id === input.accountId && !item.archived);
      const obligation = before.obligations.find(item => item.id === input.obligationId && !item.archived);
      if (!account || !obligation || before.reserves.some(item =>
        !item.archived && item.obligationId === input.obligationId)) {
        throw new ReservesFinanceError('conflict');
      }
      const mutationId = this.makeId();
      const wire = encodeReserveV2({action: 'settlement.payment.record', clientMutationId: mutationId,
        baseRevision: before.revision, ifMatch: etag,
        expectedEntityRevisions: {[account.id]: before.entityRevisions[account.id]!,
          [obligation.id]: before.entityRevisions[obligation.id]!},
        payload: {account_id: account.id, obligation_id: obligation.id,
          amount_minor: input.amountMinor, paid_on: input.paidOn, occurrence_on: input.occurrenceOn}});
      const pending = {actor, profile, mutationId, ifMatch: etag, body: wire.body};
      await pendingOnlinePayment(actor, 'create', pending);
      return this.deliverOnlinePayment(pending, asOfDate);
    });
  }

  /** Cancel a linked server payment as one compensating server transaction. */
  async voidOnlinePayment(transactionId: string, factId: string, accountId: string,
    asOfDate: string): Promise<ReservesServerView> {
    if (!this.paymentGuard) throw new ReservesFinanceError('error');
    return this.withPaymentLock(async () => {
      const before = this.view, actor = this.actor, profile = this.profile, etag = this.etag;
      if (!before || !actor || !profile || !etag || this.writeBlocked) throw new ReservesFinanceError('conflict');
      if (navigator.onLine === false) throw new ReservesFinanceError('offline');
      if (await pendingOnlinePayment(actor, 'read')) throw new ReservesFinanceError('conflict');
      const fact = before.planner.settlements.find(item => item.id === factId && !item.voidedAt);
      const link = before.ledger.paymentLinks.find(item => item.transactionId === transactionId && item.settlementId === factId);
      const postings = before.ledger.postings.filter(item => item.transactionId === transactionId);
      if (!fact || !link || postings.length !== 1 || postings[0]?.accountId !== accountId ||
          before.reserves.some(item => item.history.some(event => event.kind === 'payment' && event.transactionId === transactionId))) {
        throw new ReservesFinanceError('conflict');
      }
      const mutationId = this.makeId();
      const wire = encodeReserveV2({action: 'settlement.payment.void', clientMutationId: mutationId,
        baseRevision: before.revision, ifMatch: etag,
        expectedEntityRevisions: {[transactionId]: before.entityRevisions[transactionId]!,
          [factId]: before.entityRevisions[factId]!, [accountId]: before.entityRevisions[accountId]!},
        payload: {transaction_id: transactionId, fact_id: factId, account_id: accountId,
          reason: 'Отмена ошибочной оплаты'}});
      const pending = {actor, profile, mutationId, ifMatch: etag, body: wire.body};
      await pendingOnlinePayment(actor, 'create', pending);
      return this.deliverOnlinePayment(pending, asOfDate);
    });
  }

  /** Reconcile a lost response only with the original request and mutation UUID. */
  async resumeOnlinePayment(asOfDate: string): Promise<ReservesServerView> {
    if (!this.paymentGuard) throw new ReservesFinanceError('error');
    return this.withPaymentLock(async () => {
      if (!this.actor || !this.profile || !this.view) throw new ReservesFinanceError('locked');
      if (navigator.onLine === false) throw new ReservesFinanceError('offline');
      const pending = await pendingOnlinePayment(this.actor, 'read');
      if (!object(pending)) throw new ReservesFinanceError('conflict');
      return this.deliverOnlinePayment(pending, asOfDate);
    });
  }

  private async deliverOnlinePayment(pending: JsonObject, asOfDate: string): Promise<ReservesServerView> {
    const actor = this.actor, profile = this.profile, generation = this.generation;
    if (!actor || !profile || pending.actor !== actor || pending.profile !== profile ||
        typeof pending.mutationId !== 'string' || typeof pending.ifMatch !== 'string' ||
        !object(pending.body) ||
        (pending.body.action !== 'settlement.payment.record' && pending.body.action !== 'settlement.payment.void') ||
        pending.body.client_mutation_id !== pending.mutationId ||
        !object(pending.body.payload) || !object(pending.body.expected_entity_revisions) ||
        Object.hasOwn(pending.body.payload, 'reserve_id')) throw new ReservesFinanceError('error');
    const body = pending.body;
    const before = this.view;
    if (!before) throw new ReservesFinanceError('locked');
    const action = body.action as 'settlement.payment.record' | 'settlement.payment.void';
    const wire = encodeReserveV2({action,
      clientMutationId: pending.mutationId, ifMatch: pending.ifMatch,
      baseRevision: body.base_revision as number, payload: body.payload as JsonObject,
      expectedEntityRevisions: body.expected_entity_revisions as Record<string, number>});
    this.reads += 1;
    this.writing = true;
    this.uncertain = true;
    try {
      let response: ResponseEnvelope;
      try {
        response = await this.request(wire.path, {method: 'POST', headers: wire.headers,
          body: JSON.stringify(wire.body)});
      } catch (error) {
        // The server checks an existing idempotency receipt before revisions or
        // semantic validation. These specific replies prove no commit occurred.
        if (error instanceof ReservesFinanceError &&
            (error.httpStatus === 412 || error.httpStatus === 409 && error.serverCode === 'semantic_conflict') &&
            generation === this.generation) await pendingOnlinePayment(actor, 'clear', pending.mutationId);
        throw error;
      }
      if (generation !== this.generation || !object(response.body) ||
          ![200, 201].includes(response.status) || response.body.schema_version !== 2 ||
          response.body.client_mutation_id !== pending.mutationId ||
          response.body.replayed !== (response.status === 200) ||
          !Number.isSafeInteger(response.body.revision) ||
          response.body.revision !== (body.base_revision as number) + 1 ||
          !Array.isArray(response.body.changes) || !response.etag || !ETAG.test(response.etag)) {
        throw new ReservesFinanceError('error');
      }
      const receiptRevision = response.body.revision as number;
      const proof = action === 'settlement.payment.record'
        ? paymentReceiptIds(response.body.changes, wire.body.payload, receiptRevision)
        : null;
      const reversalId = action === 'settlement.payment.void'
        ? reversalReceiptId(response.body.changes, wire.body.payload, receiptRevision, before)
        : null;
      const after = await this.load(actor, asOfDate, undefined, true);
      if (generation !== this.generation || after.revision < receiptRevision) throw new ReservesFinanceError('conflict');
      if (proof) {
        const transaction = after.ledger.transactions.find(item => item.id === proof.transaction_id);
        const posting = after.ledger.postings.filter(item => item.transactionId === proof.transaction_id);
        const link = after.ledger.paymentLinks.find(item => item.transactionId === proof.transaction_id);
        const fact = after.planner.settlements.find(item => item.id === proof.fact_id);
        if (!transaction || transaction.kind !== 'payment' || transaction.occurredOn !== proof.paid_on ||
            posting.length !== 1 || posting[0]?.accountId !== proof.account_id ||
            posting[0]?.signedMinor !== -(proof.amount_minor as number) ||
            !link || link.settlementId !== proof.fact_id || !fact || fact.entryId !== proof.obligation_id ||
            fact.amountCents !== proof.amount_minor || fact.date !== proof.paid_on ||
            fact.occurrence !== (proof.occurrence_on as string).slice(0, 7)) {
          throw new ReservesFinanceError('conflict');
        }
      } else {
        const reversal = after.ledger.transactions.find(item => item.id === reversalId);
        const fact = after.planner.settlements.find(item => item.id === wire.body.payload.fact_id);
        if (!reversal || reversal.kind !== 'reversal' ||
            reversal.reversedTransactionId !== wire.body.payload.transaction_id || !fact?.voidedAt ||
            !after.ledger.linkedPaymentVoids?.some(item => item.factId === fact.id &&
              item.reversedByTransactionId === reversalId)) throw new ReservesFinanceError('conflict');
      }
      await pendingOnlinePayment(actor, 'clear', pending.mutationId);
      if (generation !== this.generation) throw new ReservesFinanceError('locked');
      this.uncertain = false;
      return after;
    } finally {
      this.writing = false;
    }
  }

  /** Deliberate planning-only server obligation, never a cash posting or
   * invisible copy of an existing IndexedDB expense.
   * v1 owns obligation.create; v2 intentionally does not expose it.
   */
  async createPlanningObligation(
    input: {
      title: string; amountMinor: number; startsOn: string;
      recurrenceUnit: 'none' | 'month' | 'year'; recurrenceEvery: number;
      timezone: string;
    },
    asOfDate: string,
  ): Promise<{ view: ReservesServerView; obligationId: string }> {
    const before = this.view;
    const etag = this.etag;
    const actor = this.actor;
    const epoch = this.generation;
    if (!before || !etag || !actor || this.writeBlocked) {
      throw new ReservesFinanceError('conflict');
    }
    if (input.title.trim().length === 0 || input.title.length > 160 ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 ||
        input.amountMinor > 1_000_000_000_000 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) ||
        !['none', 'month', 'year'].includes(input.recurrenceUnit) ||
        !Number.isInteger(input.recurrenceEvery) || input.recurrenceEvery < 1 ||
        input.recurrenceEvery > 120 ||
        typeof input.timezone !== 'string' || input.timezone.length > 64 ||
        input.timezone.length === 0) throw new ReservesFinanceError('error');
    const mutationId = this.makeId();
    this.reads += 1;
    this.writing = true;
    this.uncertain = true;
    try {
      const response = await this.request('/api/finance/v1/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'If-Match': etag,
          'Idempotency-Key': mutationId,
        },
        body: JSON.stringify({
          schema_version: 1, client_mutation_id: mutationId,
          base_revision: before.revision, action: 'obligation.create',
          expected_entity_revisions: {},
          payload: {
            title: input.title.trim(), direction: 'expense', amount_minor: input.amountMinor,
            starts_on: input.startsOn, timezone: input.timezone,
            recurrence_unit: input.recurrenceUnit, recurrence_every: input.recurrenceEvery,
          },
        }),
      });
      if (epoch !== this.generation || response.status !== 201 ||
          !object(response.body) || response.body.schema_version !== 1 ||
          response.body.replayed !== false ||
          response.body.client_mutation_id !== mutationId ||
          response.body.revision !== before.revision + 1 ||
          !Array.isArray(response.body.changes) || !response.body.changes.length ||
          !response.etag || !ETAG.test(response.etag)) {
        throw new ReservesFinanceError('conflict');
      }
      const after = await this.load(actor, asOfDate, undefined, true);
      if (epoch !== this.generation || after.revision !== response.body.revision ||
          this.etag !== response.etag) throw new ReservesFinanceError('conflict');
      const oldIds = new Set(before.obligations.map((item) => item.id));
      const created = after.obligations.filter((item) => !oldIds.has(item.id));
      if (created.length !== 1 || created[0]?.title !== input.title.trim() ||
          created[0].amountMinor !== input.amountMinor) {
        throw new ReservesFinanceError('conflict');
      }
      this.uncertain = false;
      return { view: after, obligationId: created[0].id };
    } finally {
      this.writing = false;
    }
  }

  async execute(
    action: ReserveV2Action, payload: Record<string, unknown>, asOfDate: string,
  ): Promise<ReservesServerView> {
    const before = this.view;
    const etag = this.etag;
    const actor = this.actor;
    const epoch = this.generation;
    if (action.startsWith('settlement.payment.') && !this.paymentGuard) throw new ReservesFinanceError('error');
    if (!before || !etag || !actor || this.writeBlocked) throw new ReservesFinanceError('conflict');
    const mutationId = this.makeId();
    const expected: Record<string, number> = Object.create(null);
    const keys = action === 'reserve.create' ? ['obligation_id', 'account_id'] :
      action === 'reserve.allocate' || action === 'reserve.event.void' ?
        ['reserve_id', 'account_id'] :
      action === 'settlement.payment.record' ?
        ['account_id', 'obligation_id', 'reserve_id'] :
      action === 'settlement.payment.void' ?
        ['transaction_id', 'fact_id', 'account_id', 'reserve_id'] :
        ['reserve_id'];
    for (const key of keys) {
      const id = entityId(payload[key]);
      const revision = before.entityRevisions[id];
      if (!revision) throw new ReservesFinanceError('conflict');
      expected[id] = revision;
    }
    const wire = encodeReserveV2({
      action, payload, clientMutationId: mutationId, baseRevision: before.revision,
      expectedEntityRevisions: expected, ifMatch: etag,
    });
    this.reads += 1; // Fence all in-flight older reads.
    this.writing = true;
    this.uncertain = true;
    try {
      const response = await this.request(wire.path, {
        method: 'POST',
        headers: wire.headers,
        body: JSON.stringify(wire.body),
      });
      if (epoch !== this.generation) throw new ReservesFinanceError('locked');
      if (![200, 201].includes(response.status) || !object(response.body) ||
          response.body.schema_version !== 2 ||
          response.body.client_mutation_id !== mutationId ||
          response.body.replayed !== false ||
          response.body.revision !== before.revision + 1 ||
          !Array.isArray(response.body.changes) || response.body.changes.length === 0 ||
          !response.etag || !ETAG.test(response.etag)) {
        throw new ReservesFinanceError('error');
      }
      const proofPayload = action === 'settlement.payment.record'
        ? paymentReceiptIds(response.body.changes, payload, response.body.revision as number)
        : payload;
      const after = await this.load(actor, asOfDate, undefined, true);
      if (epoch !== this.generation ||
          after.revision !== response.body.revision || this.etag !== response.etag ||
          !verifyReservePostcondition(before, after, action, proofPayload)) {
        throw new ReservesFinanceError('conflict');
      }
      this.uncertain = false;
      return after;
    } finally {
      this.writing = false;
    }
  }
}
