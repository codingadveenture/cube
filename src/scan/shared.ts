// Files shared to the app through the Android share target. public/sw.js stores each file in
// the "shared-files" cache; this module reads them back once and deletes them.
export const SHARED_CACHE = 'shared-files';

export interface SharedFile {
  label: string;
  text: string;
}

let inFlight: Promise<SharedFile[]> | null = null;

/**
 * Read and delete every shared file. Concurrent calls share one read, so no file is taken twice:
 * a call made while another is reading resolves to null.
 */
export function takeSharedFiles(): Promise<SharedFile[] | null> {
  if (inFlight) return inFlight.then(() => null);
  inFlight = readAndDelete().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function readAndDelete(): Promise<SharedFile[]> {
  if (!('caches' in window)) return [];
  const cache = await caches.open(SHARED_CACHE);
  const requests = await cache.keys();
  const files: SharedFile[] = [];
  for (const req of requests) {
    const res = await cache.match(req);
    if (res) {
      const header = res.headers.get('X-File-Name');
      const label = header ? decodeURIComponent(header) : `Shared file ${files.length + 1}`;
      files.push({ label, text: await res.text() });
    }
    await cache.delete(req);
  }
  return files;
}
