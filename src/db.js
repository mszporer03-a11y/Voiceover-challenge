// Galeria de clipes persistida no navegador via IndexedDB.
// Cada clipe guarda o vídeo original (Blob), uma thumbnail (data URL) e a
// lista de trechos de fala já revisada/taggeada pelo jogador.
const DB_NAME = 'voiceover-challenge';
const DB_VERSION = 2;
const STORE_NAME = 'clips';
const TOPBAR_STORE_NAME = 'topbarClips';

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
      if (!db.objectStoreNames.contains(TOPBAR_STORE_NAME)) {
        db.createObjectStore(TOPBAR_STORE_NAME, { keyPath: 'clipId' });
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

export async function getRandomClip() {
  const clips = await getAllClips();
  if (!clips.length) return null;
  return clips[Math.floor(Math.random() * clips.length)];
}

export async function deleteClip(id) {
  await withStore(STORE_NAME, 'readwrite', (store) => store.delete(id));
}

// ---------- Clipes da barra superior (upload rápido, sem tagging) ----------
// Guardados por clipId da biblioteca de paródias, para reaparecerem
// automaticamente da próxima vez que o site for aberto.

export async function saveTopbarClip(clipId, file) {
  const record = { clipId, fileName: file.name, blob: file, updatedAt: Date.now() };
  await withStore(TOPBAR_STORE_NAME, 'readwrite', (store) => store.put(record));
  return record;
}

export async function getAllTopbarClips() {
  const clips = await withStore(TOPBAR_STORE_NAME, 'readonly', (store) => store.getAll());
  return clips.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteTopbarClip(clipId) {
  await withStore(TOPBAR_STORE_NAME, 'readwrite', (store) => store.delete(clipId));
}
