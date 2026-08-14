// Galeria de clipes persistida no navegador via IndexedDB.
// Cada clipe guarda o vídeo original (Blob), uma thumbnail (data URL) e a
// lista de trechos de fala já revisada/taggeada pelo jogador.
const DB_NAME = 'voiceover-challenge';
const DB_VERSION = 2;
const STORE_NAME = 'clips';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function withStore(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const result = fn(store);
        tx.oncomplete = () => resolve(result?.result ?? result);
        tx.onerror = () => reject(tx.error);
      })
  );
}

function makeId() {
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ name: string, videoBlob: Blob, thumbnailDataUrl: string,
 *   durationSec: number, segments: Array<{id:string,start:number,end:number,character:string}>,
 *   characters: string[] }} clip
 */
export async function addClip(clip) {
  const record = { id: makeId(), createdAt: Date.now(), ...clip };
  await withStore(STORE_NAME, 'readwrite', (store) => store.add(record));
  return record;
}

export async function getAllClips() {
  const clips = await withStore(STORE_NAME, 'readonly', (store) => store.getAll());
  return clips.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getClip(id) {
  return withStore(STORE_NAME, 'readonly', (store) => store.get(id));
}

export async function updateClip(id, patch) {
  const existing = await getClip(id);
  const record = { ...existing, ...patch, id, createdAt: existing?.createdAt ?? Date.now() };
  await withStore(STORE_NAME, 'readwrite', (store) => store.put(record));
  return record;
}

export async function deleteClip(id) {
  await withStore(STORE_NAME, 'readwrite', (store) => store.delete(id));
}
