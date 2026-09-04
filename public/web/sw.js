/**
 * ScribblePDF service worker — offline shell for the PWA build.
 *
 * Plain JS on purpose: it has no imports, so bundling it would buy nothing and
 * cost a second tsconfig for the worker global scope.
 *
 * The precache list and cache version are substituted by build.mjs, because the
 * app chunks carry content hashes that are only known after the bundle is built.
 * (The placeholder tokens are deliberately not written out in this comment: a
 * plain string replace would substitute the first occurrence, which would be
 * here rather than in the code below.)
 *
 * Two tiers:
 *   precache  the shell — HTML, JS, CSS, icons, the pdf.js worker and the
 *             Hebrew font. Everything needed to open a PDF with no network.
 *   runtime   pdf.js cmaps and standard fonts (~2.6 MB). Only a minority of
 *             documents touch these, so they are cached the first time they are
 *             actually requested rather than forced on every install.
 */
const CACHE = 'scribblepdf-__CACHE_VERSION__';
const PRECACHE = __PRECACHE__;

/** Large, rarely needed assets: cache on first use instead of up front. */
const RUNTIME_PATTERN = /\/vendor\/(cmaps|standard_fonts)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll is atomic — one 404 would fail the whole install — so add
      // individually and let a missing optional asset be skipped.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('scribblepdf-') && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, then this exact URL from the cache, and only
  // then the app shell. Trying the URL before the shell is what lets /privacy
  // resolve to the policy offline instead of silently rendering the editor.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match('./')) ||
          (await cache.match('index.html')) ||
          Response.error()
        );
      }),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);
      // Only these are worth growing the cache for at runtime; everything else
      // was either precached or is not ours to keep.
      if (response.ok && RUNTIME_PATTERN.test(url.pathname)) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })(),
  );
});
