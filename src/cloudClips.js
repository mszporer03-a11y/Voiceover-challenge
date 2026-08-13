import { SERVER_URL } from './socket.js';

// Galeria compartilhada: vídeos vivem no UploadThing (free, sem cartão de
// crédito), metadados ficam no nosso servidor. Upload é multipart direto
// pro nosso servidor, que repassa pro UploadThing — dedup por hash de
// conteúdo pra não subir o mesmo clipe duas vezes.

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

  const form = new FormData();
  form.append('hash', hash);
  form.append('ext', ext);
  form.append('name', clip.name);
  form.append('durationSec', String(clip.durationSec || 0));
  form.append('segments', JSON.stringify(clip.segments));
  form.append('characters', JSON.stringify(clip.characters));
  form.append('video', clip.videoBlob, `${hash}.${ext}`);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SERVER_URL}/api/clips`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Erro ${xhr.status}`));
      } catch {
        reject(new Error(`Erro ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload falhou.'));
    xhr.send(form);
  });
}

export async function fetchCloudClipBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Falha ao baixar clipe da nuvem.');
  return res.blob();
}

export async function deleteCloudClip(hash) {
  await asJson(await fetch(`${SERVER_URL}/api/clips/${hash}`, { method: 'DELETE' }));
}
