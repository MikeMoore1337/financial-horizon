import { useCallback, useEffect, useMemo, useState } from 'react';
import { Accounts, type AccountsProps } from './Accounts';
import { AccountsFinanceGateway, FinanceBridgeError } from './accounts-finance-gateway';
import type { AccountServerView } from '../domain/accounts/server-snapshot.ts';

/** Review-only integration point. The production app.js never routes here. */
export interface ConnectedAccountsProps {
  verifiedActorUserId: string | null;
  onBack: () => void;
}

export function ConnectedAccounts({ verifiedActorUserId, onBack }: ConnectedAccountsProps) {
  const gateway = useMemo(() => new AccountsFinanceGateway(), [verifiedActorUserId]);
  const [serverView, setServerView] = useState<AccountServerView | null>(null);
  const [status, setStatus] = useState<AccountsProps['status']>('locked');
  const [blocked, setBlocked] = useState(true);

  const fail = useCallback((error: unknown) => {
    const kind = error instanceof FinanceBridgeError ? error.kind : 'error';
    setStatus(kind);
    setBlocked(true);
    if (kind === 'locked' || kind === 'error') setServerView(null);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setServerView(null);
    setBlocked(true);
    setStatus(verifiedActorUserId ? 'loading' : 'locked');
    if (verifiedActorUserId) {
      void gateway.open(verifiedActorUserId, abort.signal).then(view => {
        if (abort.signal.aborted) return;
        setServerView(view);
        setBlocked(false);
        setStatus('ready');
      }).catch(error => { if (!abort.signal.aborted) fail(error); });
    }
    return () => { abort.abort(); gateway.invalidate(); };
  }, [gateway, verifiedActorUserId, fail]);

  const refresh = useCallback(() => {
    if (!verifiedActorUserId) return;
    setStatus('loading');
    void gateway.refresh(verifiedActorUserId).then(view => {
      setServerView(view);
      // A refresh does NOT release a prior ambiguous write.
      setBlocked(gateway.writeBlocked);
      setStatus('ready');
    }).catch(fail);
  }, [gateway, verifiedActorUserId, fail]);

  const commit = useCallback(async (run: () => Promise<AccountServerView>) => {
    try {
      const view = await run();
      setServerView(view);
      setBlocked(gateway.writeBlocked);
      setStatus('ready');
    } catch (error) {
      fail(error);
      throw error;
    }
  }, [gateway, fail]);

  return <Accounts
    snapshot={serverView?.ledger ?? null}
    activeProfileId={gateway.profileId}
    reservedMinorByAccount={serverView?.reservedMinorByAccount ?? null}
    status={status}
    writable={status === 'ready' && !blocked && !gateway.writeBlocked}
    onBack={onBack}
    onRefresh={refresh}
    onCreate={input => commit(() => gateway.create(input))}
    onUpdate={input => commit(() => gateway.update(input))}
    onTransfer={input => commit(() => gateway.transfer(input))}
    onArchive={input => commit(() => gateway.archive(input))}
    onUnarchive={input => commit(() => gateway.archive(input, true))}
  />;
}
