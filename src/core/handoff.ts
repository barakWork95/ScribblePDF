/**
 * Single-use binary handoff between the service worker and the viewer.
 *
 * WHY THIS EXISTS
 *
 * Chrome forbids any *document* from loading a `file://` subresource — the
 * renderer rejects it with "Not allowed to load local resource" before
 * extension permissions are even consulted. So `viewer.html?file=file:///…`
 * can never work, no matter what is granted.
 *
 * A service worker is not a document, so it can read the file (given the
 * "Allow access to file URLs" toggle). It then needs to hand potentially many
 * megabytes to the viewer, and the obvious routes are all wrong:
 *
 *   - `chrome.runtime.sendMessage` JSON-serialises, so an ArrayBuffer arrives
 *     as `{}`. Base64 would survive but doubles peak memory.
 *   - `URL.createObjectURL` does not exist in a service worker.
 *   - `chrome.storage.local` has a 10 MB quota and stores JSON.
 *
 * IndexedDB is shared across extension contexts on the same origin, stores
 * binary natively, and has no small quota. The worker writes the bytes under a
 * one-time token and passes only the token in the viewer URL.
 *
 * Records are single-use: `takeHandoff` reads and deletes in one transaction,
 * so the bytes never outlive the load. `sweepHandoffs` clears anything orphaned
 * by a tab that was closed before the viewer ran.
 */

const DB_NAME = 'scribblepdf-handoff';
const DB_VERSION = 1;
const STORE = 'files';

/** Orphans older than this are swept. Generous: a slow disk read still lands. */
const TTL_MS = 5 * 60 * 1000;

export interface HandoffRecord {
  token: string;
  /** Display name, e.g. "contract.pdf". */
  name: string;
  /** Original file:// URL, so "Exit editor" still has somewhere to go. */
  sourceUrl: string;
  bytes: ArrayBuffer;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'token' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

/** Wrap a transaction so the promise settles on the *transaction*, not the request. */
function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result: T | undefined;
    const request = run(tx.objectStore(STORE));
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
  });
}

export function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function putHandoff(record: HandoffRecord): Promise<void> {
  const db = await openDb();
  try {
    await transact(db, 'readwrite', (store) => store.put(record));
  } finally {
    db.close();
  }
}

/**
 * Read a record and delete it in the same transaction, so a token can never be
 * used twice and the bytes do not linger on disk after the document loads.
 */
export async function takeHandoff(token: string): Promise<HandoffRecord | null> {
  const db = await openDb();
  try {
    let record: HandoffRecord | undefined;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const get = store.get(token) as IDBRequest<HandoffRecord | undefined>;
      get.onsuccess = () => {
        record = get.result;
        if (record) store.delete(token);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('handoff read failed'));
    });
    if (!record) return null;
    // An orphan this old belongs to a tab that never opened; treat it as gone.
    return Date.now() - record.createdAt > TTL_MS ? null : record;
  } finally {
    db.close();
  }
}

/** Drop records orphaned by a tab that closed before the viewer ran. */
export async function sweepHandoffs(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const cursorRequest = store.openCursor();
      const cutoff = Date.now() - TTL_MS;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as HandoffRecord;
        if (value.createdAt < cutoff) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('handoff sweep failed'));
    });
  } finally {
    db.close();
  }
}
