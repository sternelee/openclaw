// OpenClaw Control UI - Service Worker
// Provides offline caching and PWA functionality

const CACHE_VERSION = 'openclaw-v1';
const CACHE_NAME = `${CACHE_VERSION}::static`;
const RUNTIME_CACHE = `${CACHE_VERSION}::runtime`;

// Resources to cache immediately on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

// Install event - precache essential resources
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Install event');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Precaching static resources');
      return cache.addAll(PRECACHE_URLS).catch((error) => {
        console.warn('[ServiceWorker] Precache failed for some resources:', error);
        // Continue even if some resources fail to cache
        return Promise.resolve();
      });
    })
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate event');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => {
            // Delete old cache versions
            return cacheName.startsWith('openclaw-') && 
                   cacheName !== CACHE_NAME && 
                   cacheName !== RUNTIME_CACHE;
          })
          .map((cacheName) => {
            console.log('[ServiceWorker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
      );
    })
  );
  // Take control immediately
  return self.clients.claim();
});

// Fetch event - serve from cache when offline
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip WebSocket and non-HTTP requests
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // Network-first strategy for API/WebSocket connections
  if (url.pathname.startsWith('/api') || url.pathname.includes('ws://')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'Network unavailable' }),
          { 
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached response and update in background
        fetch(request)
          .then((response) => {
            if (response.ok) {
              caches.open(RUNTIME_CACHE).then((cache) => {
                cache.put(request, response);
              });
            }
          })
          .catch(() => {
            // Ignore fetch errors in background update
          });
        return cachedResponse;
      }

      // Not in cache, fetch from network
      return fetch(request)
        .then((response) => {
          // Cache successful responses for static assets
          if (response.ok && (
            request.url.includes('.js') ||
            request.url.includes('.css') ||
            request.url.includes('.html') ||
            request.url.includes('.png') ||
            request.url.includes('.svg') ||
            request.url.includes('.woff')
          )) {
            const responseToCache = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        })
        .catch((error) => {
          console.error('[ServiceWorker] Fetch failed:', error);
          // Return offline page if available
          return caches.match('/index.html').then((response) => {
            return response || new Response('Offline', { 
              status: 503,
              statusText: 'Service Unavailable'
            });
          });
        });
    })
  );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
