/**
 * #6 - authenticated, server-authoritative reserves gateway.
 * No IndexedDB writes, financial optimistic updates or blind POST retries.
 * A financial command is confirmed only after its receipt AND an exact
 * revision-aligned, complete finance snapshot have been verified.
 */
import { decodeCompleteFinanceState } from '../domain/accounts/server-snapshot.ts';
import { deriveAccountsView, type AccountViewRow } from './accounts-view-model.ts';
import {
  decodeServerReserve, projectServerReserve, type ReserveServerRecord,
} from '../domain/reserves/server-snapshot.ts';
import { type ReserveProjection } from '../domain/reserves/index.ts';
import {
  encodeReserveV2, type ReserveV2Action,
} from '../domain/reserves/v2-wire.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR = /^[0-9a-f]{32}$/;
const ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_RESPONSE_BYTES = 2_000_000;

type JsonObject = Record<string, unknown>;
type FailureKind = 'locked' | 'conflict' | 'offline' | 'error';

export class ReservesFinanceError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) {
    super({
      locked: 'Доступ к финансам не подтверждён. Войдите в аккаунт.',
      conflict: 'Данные изменились или операция требует сверки. Новые платежи заблокированы.',
      offline: 'Сервер финансов временно недоступен. Запись не подтверждена.',
      error: 'Не удалось проверить финансовые данные.',
    }[kind]);
    this.kind = kind;
    this.name = 'ReservesFinanceError';
  }
}

function object(raw: unknown): raw is JsonObject {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
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
    if (Object.hasOwn(revisions, item.id) && revisions[item.id] !== item.revision) {
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
    obligations, reserves, totalMinor: totals.totalMinor,
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
  private view: ReservesServerView | null = null;
  private etag: string | null = null;
  private generation = 0;
  private reads = 0;
  private writing = false;
  private uncertain = false;
  private readonly transport: typeof fetch;
  private readonly origin: string;
  private readonly makeId: () => string;

  constructor(
    transport: typeof fetch = fetch,
    origin: string = window.location.origin,
    makeId: () => string = () => crypto.randomUUID(),
  ) {
    this.transport = transport.bind(window);
    this.origin = origin;
    this.makeId = makeId;
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new ReservesFinanceError('error');
    }
  }

  get writeBlocked(): boolean {
    return this.uncertain || this.writing || !this.view;
  }

  invalidate(): void {
    this.generation += 1;
    this.reads += 1;
    this.actor = null;
    this.profile = null;
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
    if ([409, 410, 412, 428].includes(response.status)) throw new ReservesFinanceError('conflict');
    if (response.status === 429 || response.status >= 500) throw new ReservesFinanceError('offline');
    if (response.status < 200 || response.status >= 300) throw new ReservesFinanceError('error');
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
    return { status: response.status, body, etag: response.headers.get('etag') };
  }

  async open(actor: string, asOfDate: string, signal?: AbortSignal): Promise<ReservesServerView> {
    this.invalidate();
    const epoch = this.generation;
    if (!ACTOR.test(actor)) throw new ReservesFinanceError('locked');
    this.actor = actor;
    const response = await this.request('/api/auth/email/finance/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, signal);
    if (epoch !== this.generation) throw new ReservesFinanceError('locked');
    if (response.status !== 200 || !object(response.body) ||
        response.body.ok !== true || !UUID.test(String(response.body.profile_id))) {
      throw new ReservesFinanceError('error');
    }
    this.profile = String(response.body.profile_id);
    this.uncertain = false;
    return this.load(actor, asOfDate, signal);
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
      const after = await this.load(actor, asOfDate, undefined, true);
      if (epoch !== this.generation ||
          after.revision !== response.body.revision || this.etag !== response.etag) {
        throw new ReservesFinanceError('conflict');
      }
      this.uncertain = false;
      return after;
    } finally {
      this.writing = false;
    }
  }
}
