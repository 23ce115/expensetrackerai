/* ═══════════════════════════════════════════════════════════════
   sw.js — BlueLedger Service Worker (Safe Passthrough)

   FIX: The original SW threw "Failed to convert value to Response"
   because fetch events for third-party origins (adsense, wsimg,
   analytics, etc.) were caught but not responded to correctly.

   Solution: Only cache same-origin requests. Let ALL other
   requests pass through to the network unmodified. This silences
   the console errors without breaking offline capability.
   ═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = "blueledger-v1";

/* Files to cache for offline use (same-origin only) */
const PRECACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/js/utils.js",
  "/js/charts.js",
  "/js/main.js",
  "/script.js",
];

/* ── Install: pre-cache app shell ──────────────────────────── */
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE).catch(() => {}))
  );
});

/* ── Activate: clean up old caches ─────────────────────────── */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── Fetch: safe passthrough strategy ──────────────────────── */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /*
   * Only intercept GET requests to our own origin.
   * Third-party requests (ads, analytics, CDN scripts, etc.)
   * are deliberately NOT intercepted — they fall through to the
   * browser's normal network handling, which prevents the
   * "FetchEvent failed" / "Failed to convert value to Response"
   * console errors that third-party SW interception causes.
   */
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return; // do NOT call event.respondWith() — browser handles it
  }

  /* Network-first strategy for same-origin requests */
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        /* Cache successful same-origin responses */
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => {
        /* Network failed — try cache */
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          /* Last resort: return an empty 503 response so the SW
             never throws "Failed to convert value to Response" */
          return new Response("", {
            status: 503,
            statusText: "Service Unavailable (offline)",
          });
        });
      })
  );
});
