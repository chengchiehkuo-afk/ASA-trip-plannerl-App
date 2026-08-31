const CACHE_NAME = 'asa-trip-planner-v94';
const ASSETS = [
  './index.html',
  './manifest.json',
  './vendor/tailwind-3.4.16.js',
  './vendor/vue-3.5.13.esm-browser.prod.js',
  './vendor/sortable-1.15.6.min.js',
  './vendor/phosphor/bold/style.css',
  './vendor/phosphor/bold/Phosphor-Bold.woff2',
  './vendor/phosphor/fill/style.css',
  './vendor/phosphor/fill/Phosphor-Fill.woff2',
  './vendor/phosphor/duotone/style.css',
  './vendor/phosphor/duotone/Phosphor-Duotone.woff2',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Noto+Sans+JP:wght@400;500;700;900&family=Noto+Sans+TC:wght@300;400;500;700&display=swap'
];

// 不快取的網址模式（API、Firestore、動態資源）
const NO_CACHE_PATTERNS = [
  'firestore.googleapis.com',
  'www.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'nominatim.openstreetmap.org',
  'api.open-meteo.com',
  'api.exchangerate-api.com',
  'firebase',
  'app.js',
  'checklist-data.js',
  'asa-trip-template.js'
];

// 需要 Network First 的檔案（確保每次開啟都拿最新版）
const NETWORK_FIRST_PATTERNS = [
  'index.html',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  // 清除舊版快取
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => clients.claim())
      .then(() => {
        // 通知所有客戶端（頁面）新版本已啟用，觸發重載
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // 如果請求符合不快取的模式，直接走網路——cache:'no-store' 是關鍵：只用預設 fetch() 仍然會被
  // 瀏覽器自己的 HTTP cache（例如 GitHub Pages 回的 Cache-Control: max-age=600）擋下來，開發者
  // 每次改完 app.js/checklist-data.js 重新部署，使用者卻要等快取過期才看得到新版，等同白改。
  const shouldSkipCache = NO_CACHE_PATTERNS.some(pattern => url.includes(pattern));
  if (shouldSkipCache) {
    event.respondWith(
      fetch(new Request(event.request, { cache: 'no-store' })).catch(() => caches.match(event.request))
    );
    return;
  }

  // index.html 和 manifest.json：Network First（優先拿最新版，離線時用快取）
  // 同樣要帶 cache:'no-store'——不然 GitHub Pages 的 Cache-Control: max-age=600 會讓瀏覽器
  // 自己的 HTTP cache 在過期前直接把舊版 index.html 生給 fetch()，SW 邏輯上是 network first
  // 但實際上根本沒發出網路請求，等同白部署（跟 app.js 當初踩的是同一個坑，見上面 app.js 那條）。
  const isNetworkFirst = NETWORK_FIRST_PATTERNS.some(pattern => url.includes(pattern));
  if (isNetworkFirst) {
    event.respondWith(
      fetch(new Request(event.request, { cache: 'no-store' }))
        .then(response => {
          // 拿到新版後更新快取
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 其餘靜態資源（字體、圖示庫等）：快取優先，找不到再走網路
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
