// db.ts: the camera session's shots in IndexedDB (database cube-camera, store shots), so a session
// survives reloads and the photos (Blobs) do not crowd localStorage. Kept thin on purpose: the
// logic lives in shots.ts, which is tested.
import { reviveShot, sortShots, type Shot } from './shots';

const DB_NAME = 'cube-camera';
const DB_VERSION = 1;
const STORE = 'shots';

let opening: Promise<IDBDatabase> | null = null;

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    });
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(STORE, mode).objectStore(STORE);
}

/** Every shot of the session, newest first. */
export async function loadShots(): Promise<Shot[]> {
  const rows = await done((await store('readonly')).getAll());
  return sortShots(rows.map(reviveShot).filter((s): s is Shot => s !== null));
}

export async function putShot(shot: Shot): Promise<void> {
  await done((await store('readwrite')).put(shot));
}

export async function deleteShot(id: string): Promise<void> {
  await done((await store('readwrite')).delete(id));
}

export async function clearShots(): Promise<void> {
  await done((await store('readwrite')).clear());
}
