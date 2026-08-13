import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Cloudflare R2: S3-compatible object storage, zero egress fees, so this is
// the only place videos leave the browser other than P2P — the metadata
// index also lives here (a single JSON object) instead of a database, since
// R2 is already the free/always-on piece of infra we have.
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env;

export const cloudEnabled = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_BASE_URL
);

const s3 = cloudEnabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

const INDEX_KEY = 'clips/index.json';
let indexCache = null;

// Serializa leituras/escritas do index.json (read-modify-write) num único
// processo Node — evita duas requisições concorrentes se pisarem.
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(
    () => {},
    () => {}
  );
  return run;
}

function publicUrl(key) {
  return `${R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
}

async function readIndex() {
  if (indexCache) return indexCache;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: INDEX_KEY }));
    indexCache = JSON.parse(await res.Body.transformToString());
  } catch {
    indexCache = [];
  }
  return indexCache;
}

async function writeIndex(list) {
  indexCache = list;
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: INDEX_KEY,
      Body: JSON.stringify(list),
      ContentType: 'application/json',
    })
  );
}

export async function listClips() {
  return readIndex();
}

export async function getUploadUrl(hash, ext, contentType) {
  const key = `videos/${hash}.${ext}`;
  const exists = await s3
    .send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
    .then(() => true)
    .catch(() => false);
  if (exists) return { key, url: null, exists: true };
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, ContentType: contentType }),
    { expiresIn: 300 }
  );
  return { key, url, exists: false };
}

export function registerClip({ hash, key, name, durationSec, segments, characters, sizeBytes }) {
  return withLock(async () => {
    const list = await readIndex();
    const entry = {
      hash,
      key,
      url: publicUrl(key),
      name,
      durationSec,
      segments,
      characters,
      sizeBytes,
      updatedAt: Date.now(),
    };
    const i = list.findIndex((c) => c.hash === hash);
    if (i >= 0) list[i] = entry;
    else list.unshift(entry);
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
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: entry.key })).catch(() => {});
    }
  });
}
