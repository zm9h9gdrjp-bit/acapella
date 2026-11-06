// IndexedDB persistence: projects (JSON) and audio (Float32Array PCM channels).
const DB_NAME = 'acapella-studio';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  saveProject: (p) => tx('projects', 'readwrite', s => s.put(structuredClone(p))),
  getProject: (id) => tx('projects', 'readonly', s => s.get(id)),
  listProjects: () => tx('projects', 'readonly', s => s.getAll()),
  deleteProject: (id) => tx('projects', 'readwrite', s => s.delete(id)),
  // audio: { id, sampleRate, channels: Float32Array[] }
  saveAudio: (a) => tx('audio', 'readwrite', s => s.put(a)),
  getAudio: (id) => tx('audio', 'readonly', s => s.get(id)),
  listAudioIds: () => tx('audio', 'readonly', s => s.getAllKeys()),
  deleteAudio: (id) => tx('audio', 'readwrite', s => s.delete(id)),
};

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}
