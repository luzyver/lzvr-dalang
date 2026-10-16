// The SQL editor's memory of what it read about a database (its tables and the columns read so far, the databases of a
// server), kept in this browser's IndexedDB so the tree and completion show at once on the next visit. Entries are
// { key, data, at }; keys start with the connection's id and a slash. Every call resolves, also where IndexedDB is not
// there (private mode): then nothing is remembered.

let opening = null;
function open() {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open('dalang-sql', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('read', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return opening;
}

/** Runs `fn(store)` in a transaction; resolves with what its request gave (or null). */
async function use(mode, fn) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('read', mode);
      const req = fn(tx.objectStore('read'));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** { data, at } or null. */
export const cacheGet = (key) => use('readonly', (s) => s.get(key));
export const cachePut = (key, data, at) => use('readwrite', (s) => s.put({ key, data, at }));
/** Forgets everything of one connection (its address or database changed, or it went). */
export const cacheForget = (connId) => use('readwrite', (s) => s.delete(IDBKeyRange.bound(`${connId}/`, `${connId}/￿`)));
