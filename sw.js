/*
 * Service worker: makes the app installable and fully usable offline.
 *
 * It caches this site's own static files only. It never caches, proxies, or
 * inspects anything to do with Google sign-in or Drive — those requests are
 * passed straight through to the network, browser to Google.
 */

var CACHE = 'opt-tracker-v2';

// The document reader's libraries (vendor/) are several megabytes, so they are not
// downloaded at install time. They are cached the first time someone scans a document,
// in a separate cache that survives app updates.
var VENDOR_CACHE = 'opt-tracker-vendor-v1';

var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'scan-core.js',
  'scan-ui.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE || key === VENDOR_CACHE ? null : caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;

  var url = new URL(request.url);

  // Anything off-origin (Google Identity Services, the Drive API) goes straight
  // to the network and is never stored here.
  if (url.origin !== self.location.origin) return;

  var scope = new URL(self.registration.scope).pathname;

  // Navigations: serve the cached shell when offline so the app always opens.
  if (request.mode === 'navigate') {
    // Only a successful load of the app page itself may replace the cached shell; otherwise
    // visiting a 404 or any other page on this site would become the offline app.
    var isShell = url.pathname === scope || url.pathname === scope + 'index.html';
    event.respondWith(
      fetch(request).then(function (response) {
        if (isShell && response.ok && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put('index.html', copy); });
        }
        return response;
      }).catch(function () {
        return caches.match('index.html').then(function (cached) {
          return cached || caches.match('./');
        });
      })
    );
    return;
  }

  // Reader libraries: versioned files, so cache on first use and never re-download.
  if (url.pathname.indexOf(scope + 'vendor/') === 0) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          return cached || fetch(request).then(function (response) {
            if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

  // Static assets: cache first, then refresh the copy in the background.
  event.respondWith(
    caches.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || network;
    })
  );
});
