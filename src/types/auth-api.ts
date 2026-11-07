/**
 * Existing email-auth HTTP contract only. The cloud sync protocol and revision
 * semantics are owned by Issue #65 and deliberately not defined here.
 */
declare const accountIdBrand: unique symbol;
export type AuthAccountId = string & { readonly [accountIdBrand]: '32-hex-server-account-id' };

export interface EmailAuthIdentity {
  id: AuthAccountId; // Verified, server-issued 32-character hexadecimal account identifier.
  email: string;
}

export interface EmailAuthSessionResponse {
  user: EmailAuthIdentity | null;
}

export interface EmailAuthConfigResponse {
  enabled: boolean;
  sitekey: string;
  capabilities?: {
    revoke_other_sessions?: boolean;
    email_change?: boolean;
  };
}

export type HttpFailure = {
  detail: string | { message?: string };
};
