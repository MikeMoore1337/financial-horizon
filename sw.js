/* Кэшируем только неизменяемую оболочку приложения. Финансовые записи не попадают в CacheStorage. */
const CACHE='financial-horizon-shell-v20-auth-sessions';
const ASSETS=['./','./index.html','./styles.css?rev=auth-sessions-v20','./app.js?rev=auth-sessions-v20','./auth-session.js?rev=auth-scopes-v18','./theme-bootstrap.js?rev=ios27-chrome-v17','./account.html','./account.css?rev=auth-sessions-v20','./account.js?rev=auth-sessions-v20','./excel-import.js','./finance.js','./storage.js?rev=auth-scopes-v18','./backup.js','./schedule.js','./manifest.webmanifest','./assets/brand/logo-compact-light.svg','./assets/brand/logo-compact-dark.svg','./assets/brand/favicon.svg','./assets/brand/favicon.ico','./assets/brand/favicon-32.png','./assets/brand/apple-touch-icon-180.png','./assets/icons/log-out.svg','./assets/brand/symbol.svg','./assets/brand/pwa-192.png','./assets/brand/pwa-512.png','./assets/brand/pwa-maskable-512.png'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('financial-horizon-shell-')).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 const url=new URL(request.url);
 // Auth/session API must bypass CacheStorage and this service worker entirely.
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(request.mode==='navigate'){
  event.respondWith(fetch(request).catch(async()=>{
   // Never substitute the ledger for the sign-in screen when offline.
   const pathname=new URL(request.url).pathname;
   const fallback=pathname.endsWith('/account.html')?'./account.html':'./index.html';
   return (await caches.match(fallback))||Response.error();
  }));
  return;
 }
 event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
