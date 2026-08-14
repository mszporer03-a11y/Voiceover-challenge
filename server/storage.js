import { UTApi, UTFile } from 'uploadthing/server';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// UploadThing: free tier, no credit card required to enable (unlike
// Cloudflare R2). The video binary lives there; the small metadata index
// (name/segments/characters per clip) *also* lives there, as its own JSON
// file — NOT on this server's own disk. Hosts like Railway wipe local disk
// on every redeploy/restart, so a disk-only index silently "forgets" every
// clip that was ever shared even though the videos are still safe in
// UploadThing. Local disk is only used as a fallback when running without a
// token (no cloud configured at all, e.g. local dev).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'data', 'clips-index.json');
// Fixed customId acting as a "pointer" to the current index file: we always
// delete the previous one before uploading the next, so at most one file
// ever holds this customId — a cheap, direct lookup instead of scanning
// every file in the app to find it.
const INDEX_CUSTOM_ID = 'clips-index';

export const cloudEnabled = Boolean(process.env.UPLOADTHING_TOKEN);

const utapi = cloudEnabled ? new UTApi() : null;

let indexCache = null;

async function loadIndexFromCloud() {
  try {
    const [entry] = await utapi.getFileUrls(INDEX_CUSTOM_ID, { keyType: 'customId' });
    if (!entry?.url) return [];
    const res = await fetch(entry.url);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error('Falha ao carregar índice de clipes da nuvem:', err);
    return [];
  }
}

async function saveIndexToCloud(list) {
  // Libera o customId de novo (se já existia) antes de subir a versão nova.
  await utapi.deleteFiles(INDEX_CUSTOM_ID, { keyType: 'customId' }).catch(() => {});
  const file = new UTFile([JSON.stringify(list)], 'clips-index.json', {
    type: 'application/json',
    customId: INDEX_CUSTOM_ID,
  });
  const { error } = await utapi.uploadFiles(file);
  if (error) throw new Error(error.message || 'Falha ao salvar índice de clipes na nuvem.');
}

async function readIndex() {
  if (indexCache) return indexCache;
  if (cloudEnabled) {
    indexCache = await loadIndexFromCloud();
    return indexCache;
  }
  try {
    indexCache = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  } catch {
    indexCache = [];
  }
  return indexCache;
}

async function writeIndex(list) {
  indexCache = list;
  if (cloudEnabled) {
    await saveIndexToCloud(list);
    return;
  }
  await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(list), 'utf8');
}

// Serializa leituras/escritas (read-modify-write) num único processo Node.
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(
    () => {},
    () => {}
  );
  return run;
}

export async function listClips() {
  return readIndex();
}

export async function findClipByHash(hash) {
  const list = await readIndex();
  return list.find((c) => c.hash === hash) || null;
}

// Se o vídeo já estiver no UploadThing sob esse customId (hash) mas sumiu do
// índice — exatamente o que acontecia antes desse arquivo existir, quando o
// índice vivia só no disco e era perdido a cada redeploy — recupera a
// entrada em vez de falhar com "customId já existe".
async function recoverOrphanedUpload(hash, ext, name, durationSec, segments, characters) {
  const [entry] = await utapi.getFileUrls(hash, { keyType: 'customId' });
  if (!entry?.url) return null;
  let sizeBytes = 0;
  try {
    const head = await fetch(entry.url, { method: 'HEAD' });
    sizeBytes = Number(head.headers.get('content-length')) || 0;
  } catch {
    // tamanho é só cosmético (exibido na galeria) — segue sem ele
  }
  return {
    hash,
    key: entry.key,
    url: entry.url,
    name,
    durationSec,
    segments,
    characters,
    sizeBytes,
    updatedAt: Date.now(),
  };
}

export async function uploadAndRegisterClip({ hash, ext, buffer, contentType, name, durationSec, segments, characters }) {
  return withLock(async () => {
    const list = await readIndex();
    const existing = list.find((c) => c.hash === hash);
    if (existing) return existing; // já enviado antes (dedupe por hash)

    const file = new UTFile([buffer], `${hash}.${ext}`, { type: contentType, customId: hash });
    const { data, error } = await utapi.uploadFiles(file);

    let entry;
    if (error) {
      entry = await recoverOrphanedUpload(hash, ext, name, durationSec, segments, characters);
      if (!entry) throw new Error(error.message || 'Falha ao enviar pro UploadThing.');
    } else {
      entry = {
        hash,
        key: data.key,
        url: data.url,
        name,
        durationSec,
        segments,
        characters,
        sizeBytes: data.size,
        updatedAt: Date.now(),
      };
    }

    list.unshift(entry);
    await writeIndex(list);
    return entry;
  });
}

export function deleteClip(hash) {
  return withLock(async () => {
    const list = await readIndex();
    const entry = list.find((c) => c.hash === hash);
    await writeIndex(list.filter((c) => c.hash !== hash));
    if (entry) {
      await utapi.deleteFiles(entry.key).catch(() => {});
    }
  });
}
