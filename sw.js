/* Кэшируем только неизменяемую оболочку приложения. Финансовые записи не попадают в CacheStorage. */
const CACHE='financial-horizon-shell-v18-auth-scopes';
const ASSETS=['./','./index.html','./styles.css?rev=ios27-chrome-v17','./app.js?rev=auth-scopes-v18','./auth-session.js','./theme-bootstrap.js?rev=ios27-chrome-v17','./account.html','./account.css','./account.js?rev=auth-scopes-v18','./excel-import.js','./finance.js','./storage.js','./backup.js','./schedule.js','./manifest.webmanifest','./assets/brand/logo-compact-light.svg','./assets/brand/logo-compact-dark.svg','./assets/brand/favicon.svg','./assets/brand/favicon.ico','./assets/brand/favicon-32.png','./assets/brand/apple-touch-icon-180.png','./assets/icons/log-out.svg','./assets/brand/symbol.svg','./assets/brand/pwa-192.png','./assets/brand/pwa-512.png','./assets/brand/pwa-maskable-512.png'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('financial-horizon-shell-')).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
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
