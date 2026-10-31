/* Fuel offline cache. The app page is fetched fresh when online (so updates arrive on the next open)
   and served from cache when offline. Libraries and fonts are cached the first time they load. */
const V='fuel-v19';
const CORE=['./','./index.html','./manifest.webmanifest','./icons/apple-touch-icon.png','./icons/icon-192.png','./usda.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url);
  if(u.hostname==='api.anthropic.com') return;
  if(r.mode==='navigate'||(u.origin===location.origin&&u.pathname.endsWith('.html'))){
    e.respondWith(fetch(r).then(res=>{const c=res.clone(); caches.open(V).then(x=>x.put('./index.html',c)); return res}).catch(()=>caches.match('./index.html')));
    return;
  }
  if(u.origin===location.origin||/(jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname)){
    e.respondWith(caches.match(r).then(hit=>{const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==='opaque')){const c=res.clone(); caches.open(V).then(x=>x.put(r,c))} return res}).catch(()=>hit); return hit||net}));
  }
});
