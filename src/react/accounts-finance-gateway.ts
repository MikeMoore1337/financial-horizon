/**
 * #33 - opt-in browser bridge for the FH finance API candidates.
 *
 * No caller controls profile/actor identity in commands. No writes are
 * queued, retried, cached or stored. A failed/ambiguous write locks this
 * instance until #68 can prove the exact receipt and authoritative delta.
 * The production application does not mount the ConnectedAccounts screen.
 */
import { encodeTransfer } from '../domain/accounts/api-wire.ts';
import { decodeCompleteFinanceState, type AccountServerView } from '../domain/accounts/server-snapshot.ts';
import { deriveAccountsView } from './accounts-view-model';
import type {
  AccountArchive, AccountCreation, AccountModification, AccountTransfer,
} from './Accounts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR = /^[0-9a-f]{32}$/;
const ETAG = /^"[^"\r\n]{1,254}"$/;
const MAX_RESPONSE_BYTES = 2_000_000;

type Failure = 'locked' | 'conflict' | 'offline' | 'error';
export class FinanceBridgeError extends Error {
  readonly kind: Failure;
  constructor(kind: Failure) {
    super('Финансовая операция не подтверждена');
    this.kind = kind;
    this.name = 'FinanceBridgeError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class AccountsFinanceGateway {
  private actorId: string | null = null;
  private profile: string | null = null;
  private view: AccountServerView | null = null;
  private etag: string | null = null;
  private generation = 0;
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
    this.transport = transport;
    this.origin = origin;
    this.makeId = makeId;
    const source = new URL(origin);
    if (source.origin !== origin || (source.protocol !== 'https:' &&
      !['localhost', '127.0.0.1'].includes(source.hostname))) {
      throw new FinanceBridgeError('error');
    }
  }

  get profileId(): string | null { return this.profile; }
  get writeBlocked(): boolean { return this.uncertain || this.writing || !this.view; }

  invalidate(): void {
    this.generation += 1;
    this.actorId = null;
    this.profile = null;
    this.view = null;
    this.etag = null;
    this.uncertain = true;
  }

  private async json(path: string, init: RequestInit, signal?: AbortSignal): Promise<{
    status: number; body: unknown; etag: string | null;
  }> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new FinanceBridgeError('error');
    let response: Response;
    try {
      response = await this.transport(url.href, {
        ...init,
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
      });
    } catch {
      throw new FinanceBridgeError('offline');
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      throw new FinanceBridgeError('error');
    }
    if (response.status === 401 || response.status === 403) throw new FinanceBridgeError('locked');
    if ([409, 410, 412, 428].includes(response.status)) throw new FinanceBridgeError('conflict');
    if (response.status === 429 || response.status >= 500) throw new FinanceBridgeError('offline');
    if (response.status < 200 || response.status >= 300) throw new FinanceBridgeError('error');
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new FinanceBridgeError('error');
    }
    const length = response.headers.get('content-length');
    if (length && Number(length) > MAX_RESPONSE_BYTES) throw new FinanceBridgeError('error');
    let body: unknown;
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
        throw new Error('Oversized finance response');
      }
      body = JSON.parse(text);
    } catch {
      throw new FinanceBridgeError('error');
    }
    return { status: response.status, body, etag: response.headers.get('etag') };
  }

  async open(verifiedActorId: string, signal?: AbortSignal): Promise<AccountServerView> {
    this.invalidate();
    const epoch = this.generation;
    if (!ACTOR.test(verifiedActorId)) throw new FinanceBridgeError('locked');
    this.actorId = verifiedActorId;
    const response = await this.json('/api/auth/email/finance/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, signal);
    if (epoch !== this.generation) throw new FinanceBridgeError('locked');
    if (response.status !== 200 || !isObject(response.body) ||
      response.body.ok !== true || typeof response.body.profile_id !== 'string' ||
      !UUID.test(response.body.profile_id)) {
      throw new FinanceBridgeError('error');
    }
    this.profile = response.body.profile_id;
    this.uncertain = false;
    return this.refresh(verifiedActorId, signal);
  }

  async refresh(verifiedActorId: string, signal?: AbortSignal): Promise<AccountServerView> {
    return this.load(verifiedActorId, signal, false);
  }

  private async load(verifiedActorId: string, signal?: AbortSignal, internal = false): Promise<AccountServerView> {
    const epoch = this.generation;
    if (verifiedActorId !== this.actorId || !this.profile || (this.writing && !internal)) {
      throw new FinanceBridgeError('locked');
    }
    const response = await this.json('/api/finance/v1/state?limit_entities=5000', {
      method: 'GET',
    }, signal);
    if (epoch !== this.generation) throw new FinanceBridgeError('locked');
    if (response.status !== 200 || !response.etag || !ETAG.test(response.etag)) {
      // HTTP 206 MUST NOT become an undercounted bank balance.
      throw new FinanceBridgeError('error');
    }
    let decoded: AccountServerView;
    try {
      decoded = decodeCompleteFinanceState(response.body, this.profile, verifiedActorId);
    } catch {
      throw new FinanceBridgeError('error');
    }
    this.view = decoded;
    this.etag = response.etag;
    // A generic refresh MUST NOT unlock an ambiguous debit.
    return decoded;
  }

  private async mutate(
    version: 1 | 2, action: string, payload: Record<string, unknown>,
    baseRevision: number, versions: Record<string, number>,
    check: (before: AccountServerView, after: AccountServerView) => boolean,
  ): Promise<AccountServerView> {
    if (this.writeBlocked || !this.actorId || !this.view || !this.etag ||
      this.view.ledger.revision !== baseRevision) throw new FinanceBridgeError('conflict');
    const before = this.view;
    const epoch = this.generation;
    const actor = this.actorId;
    const mutationId = this.makeId();
    if (!UUID.test(mutationId)) throw new FinanceBridgeError('error');
    const envelope = version === 1
      ? encodeTransfer({
          fromAccountId: payload.from_account_id as string,
          toAccountId: payload.to_account_id as string,
          amountMinor: payload.amount_minor as number,
          occurredOn: payload.occurred_on as string,
          baseRevision, expectedEntityRevisions: versions,
          clientMutationId: mutationId, ifMatch: this.etag,
        })
      : {
          headers: { 'If-Match': this.etag, 'Idempotency-Key': mutationId },
          body: {
            schema_version: 2, client_mutation_id: mutationId,
            base_revision: baseRevision, action,
            expected_entity_revisions: versions, payload,
          },
        };
    this.writing = true;
    this.uncertain = true;
    try {
      const ack = await this.json(`/api/finance/v${version}/commands`, {
        method: 'POST',
        headers: { ...envelope.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope.body),
      });
      if (epoch !== this.generation) throw new FinanceBridgeError('locked');
      if (![200, 201].includes(ack.status) || !isObject(ack.body) ||
        ack.body.schema_version !== version ||
        ack.body.client_mutation_id !== mutationId ||
        ack.body.replayed !== false ||
        ack.body.revision !== baseRevision + 1 ||
        !Array.isArray(ack.body.changes) || ack.body.changes.length === 0 ||
        !ack.etag || !ETAG.test(ack.etag)) {
        throw new FinanceBridgeError('error');
      }
      // Hold the write lock during the authoritative post-commit read.
      const after = await this.load(actor, undefined, true);
      if (epoch !== this.generation || after.ledger.revision !== ack.body.revision ||
        this.etag !== ack.etag || !check(before, after)) {
        throw new FinanceBridgeError('conflict');
      }
      this.uncertain = false;
      return after;
    } finally {
      this.writing = false;
    }
  }

  create(input: AccountCreation): Promise<AccountServerView> {
    const id = this.makeId();
    if (!UUID.test(id)) throw new FinanceBridgeError('error');
    return this.mutate(2, 'account.create', {
      id, name: input.name, kind: input.kind, currency: 'RUB',
      opening_minor: input.openingMinor,
    }, input.baseRevision, {}, (before, after) =>
      after.ledger.accounts.length === before.ledger.accounts.length + 1 &&
      after.ledger.accounts.some(a => a.id === id && a.name === input.name &&
        a.kind === input.kind && a.openingMinor === input.openingMinor &&
        a.archivedAt === null));
  }

  update(input: AccountModification): Promise<AccountServerView> {
    return this.mutate(2, 'account.update', {
      account_id: input.accountId, name: input.name, kind: input.kind,
    }, input.baseRevision, { [input.accountId]: input.expectedEntityRevision },
    (_, after) => after.ledger.accounts.some(a => a.id === input.accountId &&
      a.name === input.name && a.kind === input.kind &&
      a.entityRevision === input.expectedEntityRevision + 1));
  }

  archive(input: AccountArchive, restore = false): Promise<AccountServerView> {
    return this.mutate(2, restore ? 'account.unarchive' : 'account.archive', {
      account_id: input.accountId,
    }, input.baseRevision, { [input.accountId]: input.expectedEntityRevision },
    (_, after) => after.ledger.accounts.some(a => a.id === input.accountId &&
      a.entityRevision === input.expectedEntityRevision + 1 &&
      (a.archivedAt === null) === restore));
  }

  transfer(input: AccountTransfer): Promise<AccountServerView> {
    return this.mutate(1, 'account.transfer', {
      from_account_id: input.fromAccountId,
      to_account_id: input.toAccountId,
      amount_minor: input.amountMinor,
      occurred_on: input.occurredOn,
    }, input.baseRevision, input.expectedEntityRevisions,
    (before, after) => {
      const old = deriveAccountsView(before.ledger, before.ledger.profileId,
        before.reservedMinorByAccount);
      const next = deriveAccountsView(after.ledger, after.ledger.profileId,
        after.reservedMinorByAccount);
      if (old.totalMinor !== next.totalMinor || old.reservedMinor !== next.reservedMinor ||
        old.rows.length !== next.rows.length) return false;
      for (const row of old.rows) {
        const updated = next.rows.find(a => a.id === row.id);
        const difference = row.id === input.fromAccountId ? -input.amountMinor :
          row.id === input.toAccountId ? input.amountMinor : 0;
        if (!updated || updated.balanceMinor !== row.balanceMinor + difference ||
          updated.reservedMinor !== row.reservedMinor) return false;
      }
      return true;
    });
  }
}
