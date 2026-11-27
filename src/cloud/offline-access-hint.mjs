/** An untrusted navigation hint, never an auth credential or encryption key. */
const KEY = 'fh-offline-sync-actor-v1';
const USER = /^[a-f0-9]{32}$/;

export function rememberOfflineActor(actor) {
  if (!USER.test(actor || '')) throw Error('Некорректный локальный профиль');
  try { globalThis.localStorage?.setItem(KEY, actor); } catch { /* Storage may be unavailable. */ }
}

export function readOfflineActor() {
  try {
    const actor = globalThis.localStorage?.getItem(KEY);
    return USER.test(actor || '') ? actor : null;
  } catch { return null; }
}

export function forgetOfflineActor(actor = null) {
  try {
    if (actor === null || globalThis.localStorage?.getItem(KEY) === actor) {
      globalThis.localStorage?.removeItem(KEY);
    }
  } catch { /* Never prevent session revocation. */ }
}
