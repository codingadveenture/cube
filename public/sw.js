// Service worker for Cube. Its only job in this slice is the Android share target:
// a CSV shared from ManaBox arrives as a POST to /cube/share-target, the files are kept in the
// "shared-files" cache, and the app opens the Scan view, which imports and deletes them.
// When nothing could be stored the Scan view opens with ?shared=0 and says so.
// No other requests are cached.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/share-target')) return;
  event.respondWith(receiveShare(event.request));
});

async function receiveShare(request) {
  let stored = 0;
  try {
    const form = await request.formData();
    // Every file part counts, whatever field name the sharing app used ("csv" is the declared one).
    const files = [];
    for (const [, value] of form.entries()) {
      if (typeof value !== 'string') files.push(value);
    }
    const cache = await caches.open('shared-files');
    const stamp = Date.now();
    await Promise.all(
      files.map(async (file, index) => {
        const headers = {
          'Content-Type': file.type || 'text/csv',
          'X-File-Name': encodeURIComponent(file.name || `shared-${index + 1}.csv`),
        };
        await cache.put(`/cube/shared/${stamp}-${index}`, new Response(file, { headers }));
        stored++;
      }),
    );
  } catch (e) {
    // Fall through to the Scan view with what was stored, if anything.
  }
  return Response.redirect(`/cube/#/scan?shared=${stored > 0 ? 1 : 0}`, 303);
}
