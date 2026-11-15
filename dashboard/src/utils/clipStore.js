/* Event clips live only in this browser's IndexedDB, never on the gateway or the network. */
const DB_NAME = "elly_clips";
const STORE = "clips";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(result?.result ?? result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export const saveClip = (clip) => tx("readwrite", (s) => s.add(clip));
export const deleteClip = (id) => tx("readwrite", (s) => s.delete(id));
export const clearClips = () => tx("readwrite", (s) => s.clear());

export async function listClips() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      db.close();
      resolve(req.result.sort((a, b) => b.ts - a.ts));
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/* Delete everything older than the retention window; returns how many were removed. */
export async function pruneClips(retentionMin) {
  const cutoff = Date.now() - retentionMin * 60 * 1000;
  const all = await listClips();
  const old = all.filter((c) => c.ts < cutoff);
  for (const c of old) await deleteClip(c.id);
  return old.length;
}
