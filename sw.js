/* Кэшируем только неизменяемую оболочку приложения. Финансовые записи не попадают в CacheStorage. */
const CACHE='financial-horizon-shell-v12-ios-chrome-yfc';
const ASSETS=['./','./index.html','./styles.css','./app.js','./theme-bootstrap.js','./account.html','./account.css','./account.js','./excel-import.js','./finance.js','./storage.js','./backup.js','./schedule.js','./manifest.webmanifest','./assets/brand/logo-compact-light.svg','./assets/brand/logo-compact-dark.svg','./assets/brand/favicon.svg','./assets/brand/favicon.ico','./assets/brand/favicon-32.png','./assets/brand/apple-touch-icon-180.png','./assets/brand/symbol.svg','./assets/brand/pwa-192.png','./assets/brand/pwa-512.png','./assets/brand/pwa-maskable-512.png'];
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
  event.respondWith(fetch(request).catch(()=>caches.match('./index.html')));
  return;
 }
 event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
