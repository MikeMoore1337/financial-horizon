import { describe, expect, it, vi } from 'vitest';
import { AccountsFinanceGateway } from '../../src/react/accounts-finance-gateway';

const PROFILE = '00000000-0000-4000-8000-0000000000aa';
const ACTOR = 'a'.repeat(32);
const A = '00000000-0000-4000-8000-0000000000ab';
const B = '00000000-0000-4000-8000-0000000000ac';
const TX = '00000000-0000-4000-8000-0000000000ad';
const MUTATION = '00000000-0000-4000-8000-0000000000ae';

function state(revision = 1, transfer = false) {
  return {
    schema_version: 1,
    profile_id: PROFILE,
    currency: 'RUB',
    revision,
    entities: [
      ...[
        { id: A, name: 'Основной', opening: 400000, delta: transfer ? -100000 : 0 },
        { id: B, name: 'Сбережения', opening: 200000, delta: transfer ? 100000 : 0 },
      ].map((account) => ({
        id: account.id,
        kind: 'account',
        entity_revision: transfer ? 2 : 1,
        data: {
          name: account.name,
          type: 'bank',
          currency: 'RUB',
          opening_minor: account.opening,
          balance_minor: account.opening + account.delta,
          reserved_minor: 0,
          available_minor: account.opening + account.delta,
          archived_at: null,
        },
      })),
      ...(transfer
        ? [
            {
              id: TX,
              kind: 'transaction',
              entity_revision: 1,
              data: {
                kind: 'transfer',
                occurred_on: '2026-11-12',
                note: null,
                reversed_transaction_id: null,
                postings: [
                  { account_id: A, signed_minor: -100000 },
                  { account_id: B, signed_minor: 100000 },
                ],
              },
            },
          ]
        : []),
    ],
  };
}
function reply(body: unknown, status = 200, etag = '"fh.1.1.example"') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', etag },
  });
}
function sequence(...responses: Array<Response | Error>) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new Error('Unexpected HTTP request');
    return value;
  });
  return fetcher;
}

describe('#33 verified account UI -> finance HTTP gateway, feature off', () => {
  it('boots through FH session and displays only a complete scoped server snapshot', async () => {
    const fetcher = sequence(reply({ ok: true, profile_id: PROFILE }), reply(state()));
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example');
    const view = await gateway.open(ACTOR);
    expect(view.totalMinor).toBe(600000);
    expect(view.ledger.accounts).toHaveLength(2);
    expect(gateway.writeBlocked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toContain('/api/auth/email/finance/session');
    expect(fetcher.mock.calls[1]![0]).toContain('/api/finance/v1/state?limit_entities=5000');
    for (const call of fetcher.mock.calls) {
      expect(call[1]).toMatchObject({
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        mode: 'same-origin',
      });
    }
  });

  it('encodes a real v1 1000 RUB transfer, reloads committed balances and forbids optimistic edits', async () => {
    const ack = {
      schema_version: 1,
      client_mutation_id: MUTATION,
      revision: 2,
      replayed: false,
      changes: [{ revision: 2, ordinal: 0 }],
    };
    const fetcher = sequence(
      reply({ ok: true, profile_id: PROFILE }),
      reply(state()),
      reply(ack, 201, '"fh.1.2.example"'),
      reply(state(2, true), 200, '"fh.1.2.example"'),
    );
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example', () => MUTATION);
    const old = await gateway.open(ACTOR);
    const updated = await gateway.transfer({
      fromAccountId: A,
      toAccountId: B,
      amountMinor: 100000,
      occurredOn: '2026-11-12',
      baseRevision: 1,
      expectedEntityRevisions: { [A]: 1, [B]: 1 },
    });
    expect(old.ledger.revision).toBe(1);
    expect(updated.ledger.revision).toBe(2);
    expect(updated.totalMinor).toBe(old.totalMinor);
    expect(updated.ledger.postings.map((p) => p.signedMinor)).toEqual([-100000, 100000]);
    expect(gateway.writeBlocked).toBe(false);
    expect(fetcher.mock.calls[2]![0]).toContain('/api/finance/v1/commands');
    const options = fetcher.mock.calls[2]![1] as RequestInit;
    expect(options.headers).toMatchObject({
      'If-Match': '"fh.1.1.example"',
      'Idempotency-Key': MUTATION,
    });
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({
      schema_version: 1,
      action: 'account.transfer',
      client_mutation_id: MUTATION,
      base_revision: 1,
      expected_entity_revisions: { [A]: 1, [B]: 1 },
      payload: { amount_minor: 100000, from_account_id: A, to_account_id: B },
    });
    expect(body.profile_id).toBeUndefined();
    expect(body.actor_user_id).toBeUndefined();
  });

  it('refuses a partial page or a cross-profile snapshot rather than showing a fake balance', async () => {
    const partial = sequence(
      reply({ ok: true, profile_id: PROFILE }),
      reply({ ...state(), next_cursor: 'incomplete' }, 206),
    );
    await expect(
      new AccountsFinanceGateway(partial, 'https://fh.example').open(ACTOR),
    ).rejects.toMatchObject({ kind: 'error' });
    const foreign = sequence(
      reply({ ok: true, profile_id: PROFILE }),
      reply({ ...state(), profile_id: B }),
    );
    await expect(
      new AccountsFinanceGateway(foreign, 'https://fh.example').open(ACTOR),
    ).rejects.toMatchObject({ kind: 'error' });
  });

  it('locks further mutations after an ambiguous timeout, even after reading current state', async () => {
    const fetcher = sequence(
      reply({ ok: true, profile_id: PROFILE }),
      reply(state()),
      new Error('network disappeared after request body'),
      reply(state()),
    );
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example', () => MUTATION);
    await gateway.open(ACTOR);
    const transfer = () =>
      gateway.transfer({
        fromAccountId: A,
        toAccountId: B,
        amountMinor: 100000,
        occurredOn: '2026-11-12',
        baseRevision: 1,
        expectedEntityRevisions: { [A]: 1, [B]: 1 },
      });
    await expect(transfer()).rejects.toMatchObject({ kind: 'offline' });
    await gateway.refresh(ACTOR);
    expect(gateway.writeBlocked).toBe(true);
    await expect(transfer()).rejects.toMatchObject({ kind: 'conflict' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('refuses auth loss and cannot bootstrap with arbitrary client actor identity', async () => {
    const denied = sequence(reply({ code: 'unauthenticated' }, 401));
    await expect(
      new AccountsFinanceGateway(denied, 'https://fh.example').open(ACTOR),
    ).rejects.toMatchObject({ kind: 'locked' });
    const untouched = sequence();
    await expect(
      new AccountsFinanceGateway(untouched, 'https://fh.example').open('arbitrary'),
    ).rejects.toMatchObject({ kind: 'locked' });
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe('#33 candidate v2 boundary is never treated as an approved production API', () => {
  it('serializes an explicit-zero account creation with no client profile or actor claims', async () => {
    const newAccount = '00000000-0000-4000-8000-0000000000af';
    const created = {
      ...state(2),
      entities: [
        ...state(2).entities,
        {
          id: newAccount,
          kind: 'account',
          entity_revision: 1,
          data: {
            name: 'Наличные',
            type: 'cash',
            currency: 'RUB',
            opening_minor: 0,
            balance_minor: 0,
            reserved_minor: 0,
            available_minor: 0,
            archived_at: null,
          },
        },
      ],
    };
    const ids = [newAccount, MUTATION];
    const fetcher = sequence(
      reply({ ok: true, profile_id: PROFILE }),
      reply(state()),
      reply(
        {
          schema_version: 2,
          client_mutation_id: MUTATION,
          revision: 2,
          replayed: false,
          changes: [{ revision: 2, ordinal: 0 }],
        },
        201,
        '"fh.1.2.example"',
      ),
      reply(created, 200, '"fh.1.2.example"'),
    );
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example', () => ids.shift()!);
    await gateway.open(ACTOR);
    const verified = await gateway.create({
      baseRevision: 1,
      name: 'Наличные',
      kind: 'cash',
      openingMinor: 0,
    });
    expect(verified.totalMinor).toBe(600000);
    expect(verified.ledger.accounts).toHaveLength(3);
    expect(gateway.writeBlocked).toBe(false);
    expect(fetcher.mock.calls[2]![0]).toContain('/api/finance/v2/commands');
    const command = JSON.parse(String((fetcher.mock.calls[2]![1] as RequestInit).body));
    expect(command).toEqual({
      schema_version: 2,
      client_mutation_id: MUTATION,
      base_revision: 1,
      action: 'account.create',
      expected_entity_revisions: {},
      payload: {
        id: newAccount,
        name: 'Наличные',
        kind: 'cash',
        currency: 'RUB',
        opening_minor: 0,
      },
    });
  });

  it('fails closed and does not enable writes when the candidate v2 route is disabled', async () => {
    const ids = ['00000000-0000-4000-8000-0000000000af', MUTATION];
    const fetcher = sequence(
      reply({ ok: true, profile_id: PROFILE }),
      reply(state()),
      reply({ detail: 'Not Found' }, 404),
    );
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example', () => ids.shift()!);
    await gateway.open(ACTOR);
    await expect(
      gateway.create({ baseRevision: 1, name: 'Наличные', kind: 'cash', openingMinor: 0 }),
    ).rejects.toMatchObject({ kind: 'error' });
    expect(gateway.writeBlocked).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});


describe('#33 authoritative refresh concurrency fences', () => {
  it('rejects the older of two GET responses instead of rolling balances backwards', async () => {
    let delayed: ((reply: Response) => void) | undefined;
    let calls = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const index = calls++;
      if (index === 0) return reply({ ok: true, profile_id: PROFILE });
      if (index === 1) return reply(state());
      if (index === 2) {
        return await new Promise<Response>((resolve) => {
          delayed = resolve;
        });
      }
      if (index === 3) return reply(state(2, true), 200, '"fh.1.2.example"');
      throw new Error('Unexpected GET');
    });
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example');
    await gateway.open(ACTOR);
    const earlier = gateway.refresh(ACTOR);
    const later = await gateway.refresh(ACTOR);
    expect(later.ledger.revision).toBe(2);
    expect(gateway.writeBlocked).toBe(false);
    expect(delayed).toBeTypeOf('function');
    delayed!(reply(state()));
    await expect(earlier).rejects.toMatchObject({ kind: 'conflict' });
    expect(gateway.writeBlocked).toBe(false);
    expect(calls).toBe(4);
  });

  it('a pre-POST server GET cannot overwrite a verified transfer after its late response', async () => {
    let delayed: ((reply: Response) => void) | undefined;
    let calls = 0;
    const ack = {
      schema_version: 1, client_mutation_id: MUTATION, revision: 2,
      replayed: false, changes: [{ revision: 2, ordinal: 0 }],
    };
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const index = calls++;
      if (index === 0) return reply({ ok: true, profile_id: PROFILE });
      if (index === 1) return reply(state());
      if (index === 2) {
        return await new Promise<Response>((resolve) => {
          delayed = resolve;
        });
      }
      if (index === 3) return reply(ack, 201, '"fh.1.2.example"');
      if (index === 4) return reply(state(2, true), 200, '"fh.1.2.example"');
      throw new Error('Unexpected finance request');
    });
    const gateway = new AccountsFinanceGateway(fetcher, 'https://fh.example', () => MUTATION);
    await gateway.open(ACTOR);
    const stale = gateway.refresh(ACTOR);
    const operation = {
      fromAccountId: A, toAccountId: B,
      amountMinor: 100000, occurredOn: '2026-11-12',
      baseRevision: 1, expectedEntityRevisions: { [A]: 1, [B]: 1 },
    };
    const after = await gateway.transfer(operation);
    expect(after.ledger.revision).toBe(2);
    expect(after.totalMinor).toBe(600000);
    delayed!(reply(state()));
    await expect(stale).rejects.toMatchObject({ kind: 'conflict' });
    expect(gateway.writeBlocked).toBe(false);
    await expect(gateway.transfer(operation)).rejects.toMatchObject({ kind: 'conflict' });
    expect(calls).toBe(5);
  });
});
