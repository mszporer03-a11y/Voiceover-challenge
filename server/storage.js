import { UTApi, UTFile } from 'uploadthing/server';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// UploadThing: free tier, no credit card required to enable (unlike
// Cloudflare R2). The video binary lives there; the small metadata index
// (name/segments/characters per clip) lives in a JSON file on this
// server's own disk, since UploadThing itself is blob storage, not a
// database, and its docs explicitly recommend not using it as one.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'data', 'clips-index.json');

export const cloudEnabled = Boolean(process.env.UPLOADTHING_TOKEN);

const utapi = cloudEnabled ? new UTApi() : null;

let indexCache = null;

async function readIndex() {
  if (indexCache) return indexCache;
  try {
    indexCache = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  } catch {
    indexCache = [];
  }
  return indexCache;
}

async function writeIndex(list) {
  indexCache = list;
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

export async function uploadAndRegisterClip({ hash, ext, buffer, contentType, name, durationSec, segments, characters }) {
  return withLock(async () => {
    const list = await readIndex();
    const existing = list.find((c) => c.hash === hash);
    if (existing) return existing; // já enviado antes (dedupe por hash)

    const file = new UTFile([buffer], `${hash}.${ext}`, { type: contentType, customId: hash });
    const { data, error } = await utapi.uploadFiles(file);
    if (error) throw new Error(error.message || 'Falha ao enviar pro UploadThing.');

    const entry = {
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
