import { SERVER_URL } from './socket.js';

// Galeria compartilhada: vídeos vivem no Cloudflare R2, o servidor só guarda
// metadados. Upload é direto navegador -> R2 via URL assinada (o servidor
// nunca vê o binário), deduplicado por hash de conteúdo pra não subir o
// mesmo clipe duas vezes.

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFromType(type) {
  if (type && type.includes('mp4')) return 'mp4';
  return 'webm';
}

async function asJson(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erro ${res.status}`);
  }
  return res.json();
}

export async function listCloudClips() {
  const res = await fetch(`${SERVER_URL}/api/clips`);
  const { clips } = await asJson(res);
  return clips;
}

/**
 * @param {{ name, videoBlob, durationSec, segments, characters }} clip
 * @param {(progress:number) => void} [onProgress]
 */
export async function uploadClipToCloud(clip, onProgress) {
  const hash = await sha256Hex(clip.videoBlob);
  const ext = extFromType(clip.videoBlob.type);

  const { key, url, exists } = await asJson(
    await fetch(`${SERVER_URL}/api/clips/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash, ext, contentType: clip.videoBlob.type || 'video/webm' }),
    })
  );

  if (!exists) {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', clip.videoBlob.type || 'video/webm');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload falhou (${xhr.status})`));
      xhr.onerror = () => reject(new Error('Upload falhou — verifique CORS do bucket R2.'));
      xhr.send(clip.videoBlob);
    });
  }
  onProgress?.(1);

  return asJson(
    await fetch(`${SERVER_URL}/api/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hash,
        key,
        name: clip.name,
        durationSec: clip.durationSec,
        segments: clip.segments,
        characters: clip.characters,
        sizeBytes: clip.videoBlob.size,
      }),
    })
  );
}

export async function fetchCloudClipBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Falha ao baixar clipe da nuvem.');
  return res.blob();
}

export async function deleteCloudClip(hash) {
  await asJson(await fetch(`${SERVER_URL}/api/clips/${hash}`, { method: 'DELETE' }));
}
