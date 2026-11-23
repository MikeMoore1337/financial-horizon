declare module '*storage.js?rev=auth-scopes-v18' {
  export function pendingOnlinePayment(
    userId: string,
    action: 'read' | 'create' | 'clear',
    value?: unknown,
  ): Promise<unknown>;
}
