/**
 * Platform adapter for the plain web / PWA host.
 *
 * Assets resolve relative to the document, so the same build works from a
 * domain root, from a GitHub Pages project subpath, and from a local file.
 *
 * Storage is IndexedDB rather than localStorage: saved signatures are PNG data
 * URLs, which are far too big to be comfortable in a 5 MB synchronous store
 * that blocks the main thread on every read.
 */
import type { KeyValueStore, Platform } from '@/core/platform';

const DB_NAME = 'scribblepdf-web';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

const webStorage: KeyValueStore = {
  async get(keys) {
    const wanted = typeof keys === 'string' ? [keys] : keys;
    const db = await openDb();
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const out: Record<string, unknown> = {};
        for (const key of wanted) {
          const request = store.get(key);
          // Absent keys stay absent, matching chrome.storage.local's behaviour.
          request.onsuccess = () => {
            if (request.result !== undefined) out[key] = request.result;
          };
        }
        tx.oncomplete = () => resolve(out);
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('read failed'));
      });
    } finally {
      db.close();
    }
  },

  async set(items) {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const [key, value] of Object.entries(items)) store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      });
    } finally {
      db.close();
    }
  },
};

export const webPlatform: Platform = {
  // document.baseURI keeps this correct under a Pages project subpath such as
  // /ScribblePDF/, where a leading-slash URL would resolve to the wrong origin.
  assetUrl: (path) => new URL(path.replace(/^\//, ''), document.baseURI).href,
  storage: webStorage,
  isExtension: false,
};
