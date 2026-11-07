import { type ReactNode } from 'react';

export type AuthAccess =
  | { kind: 'guest' }
  | { kind: 'account'; accountId: string; verifiedUserId: string | null; sessionValid: boolean }
  | { kind: 'blocked' };

/** Read-only presentation gate. Existing verified email-session/IndexedDB scope
 * checks remain the authoritative access decision; no fetches or storage effects.
 */
export function isAuthorized(access: AuthAccess): boolean {
  if (access.kind === 'guest') return true;
  if (access.kind === 'blocked') return false;
  return Boolean(
    access.sessionValid && access.accountId && access.verifiedUserId === access.accountId,
  );
}

export function AuthBoundary({ access, children }: { access: AuthAccess; children: ReactNode }) {
  return isAuthorized(access) ? <>{children}</> : null;
}
