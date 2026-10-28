/* Hoop Lab service worker: lets the site install as an app and open offline with the last data it saw.

   Pages      network first, cached copy when offline (game.html?id=… falls back to the cached game.html).
   data/*.json network first, cached copy when offline; cached answers carry an x-hooplab-cached header so the
              page can show "Offline · data from …".
   Assets     cache first by full URL. The deploy tags asset links with ?v=<commit>, so a new deploy asks for
              new URLs and never gets an old script.
   Other sites (ESPN logos and headshots) are left to the browser.

   VERSION is replaced with the commit hash by the deploy workflow; each deploy gets fresh caches and the
   old ones are deleted when the new worker takes over. */
'use strict';

const VERSION = 'dev';
const CACHE = `hooplab-${VERSION}`;
const PAGES = ['./', 'index.html', 'game.html', 'player.html', 'players.html', 'props.html', 'standings.html',
  'team.html', 'trends.html', 'picks.html', 'model.html'];
const ASSETS = ['assets/style.css', 'assets/common.js', 'assets/context.js', 'assets/insights.js', 'assets/pbp.js', 'assets/picks.js', 'assets/lines.js', 'assets/model.js'];
const STATIC = ['manifest.webmanifest', 'assets/icon.svg', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
  'assets/icons/apple-touch-icon.png'];

/* URLs to precache. Asset links carry ?v=<VERSION> after a deploy, so precache them under that exact URL. */
function shellUrls(version = VERSION) {
  const tag = version === 'dev' ? '' : `?v=${version}`;
  return [...PAGES, ...ASSETS.map(a => a + tag), ...STATIC];
}

/* Which strategy a request gets: 'page', 'data', 'asset' or 'none' (let the browser handle it). */
function route(url, scope, mode) {
  const u = new URL(url), s = new URL(scope);
  if (u.origin !== s.origin || !u.pathname.startsWith(s.pathname)) return 'none';
  const path = u.pathname.slice(s.pathname.length);
  if (path === 'sw.js') return 'none';
  if (mode === 'navigate' || path === '' || path.endsWith('.html')) return 'page';
  if (path.startsWith('data/')) return 'data';
  return 'asset';
}

async function networkFirst(request, fallbackPage) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: !!fallbackPage }) ||
      (fallbackPage && await cache.match(fallbackPage));
    if (!hit) throw err;
    if (fallbackPage) return hit;
    const headers = new Headers(hit.headers);
    headers.set('x-hooplab-cached', '1');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  self.addEventListener('install', e => {
    // allSettled: a page another branch hasn't shipped yet shouldn't stop the install.
    e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(shellUrls().map(u => c.add(u)))).then(() => self.skipWaiting()));
  });
  self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('hooplab-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
  });
  self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    const kind = route(e.request.url, self.registration.scope, e.request.mode);
    if (kind === 'page') e.respondWith(networkFirst(e.request, 'index.html'));
    else if (kind === 'data') e.respondWith(networkFirst(e.request));
    else if (kind === 'asset') e.respondWith(cacheFirst(e.request));
  });
}

if (typeof module !== 'undefined') module.exports = { route, shellUrls };
