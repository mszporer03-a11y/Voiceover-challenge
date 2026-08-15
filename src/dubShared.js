import { addClip, updateClip, deleteClip, getAllClips } from './db.js';
import { decodeVideoAudio, detectSpeechSegments, estimateCharacterClusters } from './audioAnalysis.js';
import { getMonoSamples, computePeaks, drawWaveform } from './waveform.js';
import { mountWaveformEditor } from './waveformEditor.js';
import { exportDubbedVideo, downloadBlob } from './exportVideo.js';
import { listCloudClips, uploadClipToCloud, fetchCloudClipBlob, deleteCloudClip } from './cloudClips.js';

// Peças reaproveitáveis entre o Modo Solo e os modos Multiplayer local:
// galeria/tagging de clipes, tela de "ver original", gravação guiada fala
// por fala, e resultado com áudio sincronizado. Cada `render*` substitui o
// conteúdo de `cardEl` e liga seus próprios eventos; navegação entre telas
// acontece via callbacks (onContinue/onDone/onCancel/...) passados por quem
// chama, o que deixa o fluxo (solo, cooperativo, sequencial) livre pra
// cada módulo específico decidir.

export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export function seekTo(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

export function playRange(video, start, end) {
  return new Promise(async (resolve) => {
    await seekTo(video, start);
    const onTime = () => {
      if (video.currentTime >= end) {
        video.pause();
        video.removeEventListener('timeupdate', onTime);
        resolve();
      }
    };
    video.addEventListener('timeupdate', onTime);
    video.play().catch(() => resolve());
  });
}

export async function captureThumbnail(video) {
  const midpoint = Math.min(video.duration / 2 || 0, 1.5);
  await seekTo(video, midpoint);
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 180;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

/**
 * Estado por sessão (mic + object URLs + rAF ativos) — cada modo (solo,
 * multiplayer) cria o seu, pra não compartilhar recursos "ao vivo" entre
 * fluxos diferentes.
 */
export function createResources() {
  const objectUrls = [];
  const rafIds = new Set();
  let micStream = null;
  let audioCtx = null;

  return {
    trackUrl(url) {
      objectUrls.push(url);
      return url;
    },
    async getMicStream() {
      const isLive = micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live');
      if (!isLive) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return micStream;
    },
    getAudioContext() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx;
    },
    trackRaf(id) {
      rafIds.add(id);
      return id;
    },
    untrackRaf(id) {
      rafIds.delete(id);
    },
    teardown() {
      rafIds.forEach((id) => cancelAnimationFrame(id));
      rafIds.clear();
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
      if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
      }
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.length = 0;
    },
  };
}

// ---------- Galeria (listar / adicionar / remover clipes) ----------

// Junta clipes locais (IndexedDB) com clipes compartilhados na nuvem que
// este aparelho ainda não baixou, numa lista só — não existe mais "galeria
// local" vs. "galeria da nuvem": todo clipe aparece uma vez, é jogável, e
// entra no sorteio aleatório (baixando sob demanda se só existir na nuvem).
export async function getMergedGalleryClips() {
  const localClips = await getAllClips();
  let cloudClips = [];
  try {
    cloudClips = await listCloudClips();
  } catch {
    // nuvem não configurada ou indisponível — segue só com os locais
  }
  const localHashes = new Set(localClips.map((c) => c.cloudHash).filter(Boolean));
  const merged = localClips.map((clip) => ({ kind: 'local', clip, sortAt: clip.createdAt }));
  cloudClips.forEach((entry) => {
    if (localHashes.has(entry.hash)) return; // já tem cópia local, não duplica
    merged.push({ kind: 'cloud', entry, sortAt: entry.updatedAt });
  });
  merged.sort((a, b) => b.sortAt - a.sortAt);
  return merged;
}

// Garante que um item da lista combinada vire um clipe local de verdade
// (baixando da nuvem e salvando no IndexedDB se ainda for só uma entrada
// remota) — usado tanto ao clicar em "Jogar"/"Editar" quanto no sorteio.
async function resolveMergedClip(item) {
  if (item.kind === 'local') return item.clip;
  const entry = item.entry;
  const videoBlob = await fetchCloudClipBlob(entry.url);
  const video = document.createElement('video');
  video.src = URL.createObjectURL(videoBlob);
  await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  const thumbnailDataUrl = await captureThumbnail(video);
  URL.revokeObjectURL(video.src);
  return addClip({
    name: entry.name,
    videoBlob,
    thumbnailDataUrl,
    durationSec: entry.durationSec || video.duration,
    segments: entry.segments,
    characters: entry.characters || [],
    cloudHash: entry.hash,
    cloudUrl: entry.url,
  });
}

/** Sorteia um clipe entre TODOS os disponíveis — locais e da nuvem ainda não
 * baixados neste aparelho — baixando-o primeiro se for preciso. */
export async function getRandomAnyClip() {
  const merged = await getMergedGalleryClips();
  if (!merged.length) return null;
  const pick = merged[Math.floor(Math.random() * merged.length)];
  return resolveMergedClip(pick);
}

export async function renderGalleryScreen(cardEl, resources, opts = {}) {
  const { title, tagline, onPick, onClose, pickLabel, closeLabel, extraButtons = [] } = opts;

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">${title ?? 'GALERIA'}</h2>
    <p class="menu-tagline">${tagline ?? 'Escolha um clipe ou adicione um novo à galeria'}</p>
    <div id="dub-gallery-grid" class="solo-gallery-grid"><p class="menu-status">Carregando galeria…</p></div>
    <div class="menu-section">
      <label class="menu-btn-secondary" for="dub-add-input">🎬 Adicionar clipe</label>
      <input id="dub-add-input" type="file" accept=".mp4,.webm,video/mp4,video/webm" hidden />
      ${extraButtons
        .map(
          (b, i) =>
            `<button id="dub-gallery-extra-${i}" class="${b.className ?? 'menu-btn-primary'}" type="button" disabled>${b.label}</button>`
        )
        .join('')}
      ${onClose ? `<button id="dub-gallery-close-btn" class="menu-link" type="button">${closeLabel ?? 'Fechar'}</button>` : ''}
    </div>
  `;

  const refresh = () => renderGalleryScreen(cardEl, resources, opts);

  if (onClose) cardEl.querySelector('#dub-gallery-close-btn').addEventListener('click', onClose);

  extraButtons.forEach((b, i) => {
    cardEl.querySelector(`#dub-gallery-extra-${i}`)?.addEventListener('click', () => b.onClick());
  });

  cardEl.querySelector('#dub-add-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      renderTaggingScreen(cardEl, resources, file, { onSaved: refresh, onCancel: refresh });
    }
  });

  const items = await getMergedGalleryClips();
  const grid = cardEl.querySelector('#dub-gallery-grid');
  if (!grid) return; // tela já mudou enquanto carregava

  extraButtons.forEach((b, i) => {
    const btn = cardEl.querySelector(`#dub-gallery-extra-${i}`);
    if (btn) btn.disabled = items.length === 0;
  });

  if (!items.length) {
    grid.innerHTML = `<p class="menu-status">Nenhum clipe na galeria ainda. Adicione um pra começar!</p>`;
    return;
  }

  grid.innerHTML = '';
  items.forEach((item) => {
    const isLocal = item.kind === 'local';
    const data = isLocal ? item.clip : item.entry;
    const characterCount = (data.characters || []).length;
    const segmentCount = (data.segments || []).length;
    const card = el(`
      <div class="solo-clip-card">
        ${
          isLocal
            ? `<img src="${data.thumbnailDataUrl}" alt="${data.name}" />`
            : `<div class="solo-clip-thumb-placeholder" title="Ainda só na nuvem — baixa ao jogar/editar">☁</div>`
        }
        <div class="solo-clip-name">${data.name}</div>
        <div class="solo-clip-meta">${characterCount} personagem(ns) · ${segmentCount} fala(s)</div>
        <div class="solo-clip-actions">
          <button class="menu-btn-secondary solo-clip-play" type="button">${pickLabel ?? '▶ Jogar'}</button>
          <button class="menu-link solo-clip-edit" type="button">✏ Editar falas</button>
          <button class="menu-link solo-clip-delete" type="button">${isLocal ? 'Remover' : 'Remover da nuvem'}</button>
        </div>
      </div>
    `);

    const playBtn = card.querySelector('.solo-clip-play');
    const editBtn = card.querySelector('.solo-clip-edit');
    const deleteBtn = card.querySelector('.solo-clip-delete');
    const playLabel = playBtn.textContent;

    // Clipes só-na-nuvem baixam (e salvam localmente) na hora, tanto pra
    // jogar quanto pra editar — não existe mais um botão "Baixar" à parte.
    async function withDownload(run) {
      playBtn.disabled = true;
      editBtn.disabled = true;
      if (!isLocal) playBtn.textContent = '⬇ Baixando…';
      try {
        const clip = await resolveMergedClip(item);
        run(clip);
      } catch (err) {
        alert(`Falha ao baixar clipe: ${err.message}`);
      } finally {
        playBtn.disabled = false;
        editBtn.disabled = false;
        playBtn.textContent = playLabel;
      }
    }

    playBtn.addEventListener('click', () => withDownload((clip) => onPick?.(clip)));
    editBtn.addEventListener('click', () =>
      withDownload((clip) => renderEditTaggingScreen(cardEl, resources, clip, { onSaved: refresh, onCancel: refresh }))
    );
    deleteBtn.addEventListener('click', async () => {
      if (isLocal) {
        await deleteClip(data.id);
      } else {
        if (!confirm(`Remover "${data.name}" da nuvem?`)) return;
        try {
          await deleteCloudClip(data.hash);
        } catch (err) {
          alert(`Falha ao remover: ${err.message}`);
          return;
        }
      }
      refresh();
    });

    grid.appendChild(card);
  });
}

// ---------- Adicionar clipe (tagging) ----------

async function renderTaggingScreen(cardEl, resources, file, { onSaved, onCancel } = {}) {
  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">NOVO CLIPE</h2>
    <p class="menu-status">Analisando áudio, aguarde…</p>
  `;

  const videoUrl = resources.trackUrl(URL.createObjectURL(file));
  const previewVideo = document.createElement('video');
  previewVideo.src = videoUrl;
  previewVideo.preload = 'auto';
  previewVideo.style.display = 'none';
  cardEl.appendChild(previewVideo);
  await new Promise((resolve) => previewVideo.addEventListener('loadedmetadata', resolve, { once: true }));

  let segments;
  let guesses;
  let audioBuffer = null;
  try {
    audioBuffer = await decodeVideoAudio(file);
    segments = detectSpeechSegments(audioBuffer);
    guesses = await estimateCharacterClusters(audioBuffer, segments);
  } catch {
    segments = [];
    guesses = new Map();
  }

  const rows = segments.map((seg) => ({
    id: seg.id,
    start: seg.start,
    end: seg.end,
    character: guesses.get(seg.id) || 'Personagem A',
  }));

  renderTaggingForm(cardEl, file, previewVideo, rows, { onSaved, onCancel, audioBuffer });
}

// Reabre um clipe já salvo na galeria pra reajustar a posição/duração das
// falas (ou personagem), sem precisar re-detectar tudo do zero — reaproveita
// os trechos já marcados como ponto de partida.
async function renderEditTaggingScreen(cardEl, resources, clip, { onSaved, onCancel } = {}) {
  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">EDITAR CLIPE</h2>
    <p class="menu-status">Carregando áudio, aguarde…</p>
  `;

  const videoUrl = resources.trackUrl(URL.createObjectURL(clip.videoBlob));
  const previewVideo = document.createElement('video');
  previewVideo.src = videoUrl;
  previewVideo.preload = 'auto';
  previewVideo.style.display = 'none';
  cardEl.appendChild(previewVideo);
  await new Promise((resolve) => previewVideo.addEventListener('loadedmetadata', resolve, { once: true }));

  let audioBuffer = null;
  try {
    audioBuffer = await decodeVideoAudio(clip.videoBlob);
  } catch {
    audioBuffer = null;
  }

  const rows = clip.segments.map((seg) => ({ ...seg }));

  renderTaggingForm(cardEl, clip.videoBlob, previewVideo, rows, {
    onSaved,
    onCancel,
    audioBuffer,
    clipId: clip.id,
    initialName: clip.name,
  });
}

function renderTaggingForm(cardEl, file, previewVideo, rows, { onSaved, onCancel, audioBuffer, clipId, initialName }) {
  previewVideo.style.display = '';
  previewVideo.controls = true;
  previewVideo.className = 'solo-preview-video';

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:20px; margin-bottom:-8px;">${clipId ? 'EDITAR CLIPE' : 'NOVO CLIPE'}</h2>
    <p class="menu-tagline" style="margin-bottom:-4px;">Arraste na waveform pra marcar uma fala, ou ajuste as bordas de uma existente</p>
    <input id="solo-clip-name" type="text" placeholder="Nome do clipe" value="${(initialName ?? file.name.replace(/\.[^.]+$/, '')).replace(/"/g, '&quot;')}" />
    <div id="solo-video-slot"></div>
    <div class="waveform-wrap">
      <div id="solo-waveform-overview" class="waveform-strip">
        <canvas></canvas>
        <div class="waveform-overlay"></div>
        <div class="waveform-playhead"></div>
      </div>
      <div id="solo-waveform-zoom-wrap" class="waveform-zoom-wrap" hidden>
        <div id="solo-waveform-zoom-label" class="waveform-zoom-label"></div>
        <div id="solo-waveform-zoom" class="waveform-strip waveform-strip-zoom">
          <canvas></canvas>
          <div class="waveform-overlay"></div>
        </div>
      </div>
    </div>
    <div id="solo-segments-list" class="solo-segments-list"></div>
    <datalist id="solo-character-options"></datalist>
    <div class="menu-section" style="margin-top:12px;">
      <button id="solo-add-segment-btn" class="menu-btn-secondary" type="button">+ Adicionar trecho manual</button>
      <button id="solo-save-clip-btn" class="menu-btn-primary" type="button">${clipId ? '💾 Salvar alterações' : '💾 Salvar na galeria'}</button>
      <button id="solo-cancel-tag-btn" class="menu-link" type="button">Cancelar</button>
    </div>
    <p id="solo-tag-status" class="menu-status"></p>
  `;

  cardEl.querySelector('#solo-video-slot').appendChild(previewVideo);
  previewVideo.style.maxHeight = '150px';
  const listEl = cardEl.querySelector('#solo-segments-list');
  const statusEl = cardEl.querySelector('#solo-tag-status');

  if (!rows.length) {
    statusEl.textContent = 'Nenhuma fala detectada automaticamente — adicione trechos manualmente ou marque na waveform.';
  }
  if (!audioBuffer) {
    cardEl.querySelector('#solo-waveform-overview').classList.add('waveform-strip-empty');
  }

  function updateCharacterOptions() {
    const names = [...new Set(rows.map((r) => r.character).filter(Boolean))];
    cardEl.querySelector('#solo-character-options').innerHTML = names
      .map((n) => `<option value="${n}"></option>`)
      .join('');
  }

  function renderRows() {
    listEl.innerHTML = '';
    rows.forEach((row, index) => {
      const rowEl = el(`
        <div class="solo-segment-row">
          <span class="solo-segment-index">#${index + 1}</span>
          <input class="solo-seg-start" type="number" step="0.1" min="0" value="${row.start.toFixed(2)}" title="Início (s)" />
          <input class="solo-seg-end" type="number" step="0.1" min="0" value="${row.end.toFixed(2)}" title="Fim (s)" />
          <input class="solo-seg-char" type="text" list="solo-character-options" value="${row.character}" title="Personagem" />
          <button class="solo-seg-preview menu-btn-secondary" type="button">▶</button>
          <button class="solo-seg-remove menu-link" type="button">✕</button>
        </div>
      `);
      // Editar o tempo já pula o preview pro instante certo, pra dar pra
      // ver visualmente onde aquele corte cai enquanto ajusta.
      rowEl.addEventListener('pointerdown', () => waveEditor?.setFocused(row.id));
      rowEl.querySelector('.solo-seg-start').addEventListener('input', (e) => {
        row.start = Math.max(0, parseFloat(e.target.value) || 0);
        previewVideo.currentTime = row.start;
        waveEditor?.refresh();
      });
      rowEl.querySelector('.solo-seg-end').addEventListener('input', (e) => {
        row.end = Math.max(row.start + 0.1, parseFloat(e.target.value) || row.start + 0.1);
        previewVideo.currentTime = row.end;
        waveEditor?.refresh();
      });
      rowEl.querySelector('.solo-seg-char').addEventListener('change', (e) => {
        row.character = e.target.value.trim() || 'Personagem A';
        updateCharacterOptions();
      });
      rowEl.querySelector('.solo-seg-preview').addEventListener('click', () => {
        waveEditor?.setFocused(row.id);
        playRange(previewVideo, row.start, row.end);
      });
      rowEl.querySelector('.solo-seg-remove').addEventListener('click', () => {
        rows.splice(index, 1);
        renderRows();
      });
      listEl.appendChild(rowEl);
    });
    updateCharacterOptions();
    waveEditor?.refresh();
  }

  function addRow(start, end, character) {
    const newRow = {
      id: `seg-manual-${Date.now()}`,
      start,
      end,
      character: character || rows[rows.length - 1]?.character || 'Personagem A',
    };
    rows.push(newRow);
    renderRows();
    waveEditor?.setFocused(newRow.id);
    return newRow;
  }

  let waveEditor = null;
  if (audioBuffer) {
    waveEditor = mountWaveformEditor({
      overviewEl: cardEl.querySelector('#solo-waveform-overview'),
      zoomWrapEl: cardEl.querySelector('#solo-waveform-zoom-wrap'),
      zoomLabelEl: cardEl.querySelector('#solo-waveform-zoom-label'),
      zoomEl: cardEl.querySelector('#solo-waveform-zoom'),
      samples: getMonoSamples(audioBuffer),
      sampleRate: audioBuffer.sampleRate,
      duration: previewVideo.duration || audioBuffer.duration || 0,
      rows,
      video: previewVideo,
      onRowsChanged: () => renderRows(),
      onCreateSegment: (t1, t2) => addRow(t1, t2),
    });
  }

  renderRows();

  cardEl.querySelector('#solo-add-segment-btn').addEventListener('click', () => {
    const lastEnd = rows.length ? rows[rows.length - 1].end : 0;
    addRow(lastEnd, Math.min(lastEnd + 1, previewVideo.duration || lastEnd + 1));
  });

  cardEl.querySelector('#solo-cancel-tag-btn').addEventListener('click', () => onCancel?.());

  cardEl.querySelector('#solo-save-clip-btn').addEventListener('click', async () => {
    const name = cardEl.querySelector('#solo-clip-name').value.trim() || 'Clipe sem nome';
    if (!rows.length) {
      statusEl.textContent = 'Adicione pelo menos um trecho de fala antes de salvar.';
      return;
    }
    statusEl.textContent = 'Salvando…';
    const thumbnailDataUrl = await captureThumbnail(previewVideo);
    const characters = [...new Set(rows.map((r) => r.character))];
    const payload = {
      name,
      videoBlob: file,
      thumbnailDataUrl,
      durationSec: previewVideo.duration || 0,
      segments: rows.map((r) => ({ id: r.id, start: r.start, end: r.end, character: r.character })),
      characters,
    };
    const saved = clipId ? await updateClip(clipId, payload) : await addClip(payload);

    // Todo clipe vai pra galeria da nuvem automaticamente — não existe mais
    // um passo separado de "compartilhar". Reenviar um clipe já editado
    // reaproveita o vídeo (dedupe por hash no servidor) e só atualiza as
    // falas/personagens. Se a nuvem não estiver configurada/disponível, o
    // clipe segue salvo localmente mesmo assim — isso não deve travar nada.
    statusEl.textContent = 'Salvo! Enviando pra galeria da nuvem…';
    try {
      const entry = await uploadClipToCloud(saved, (p) => {
        statusEl.textContent = `Salvo! Enviando pra galeria da nuvem… ${Math.round(p * 100)}%`;
      });
      await updateClip(saved.id, { cloudHash: entry.hash, cloudUrl: entry.url });
    } catch (err) {
      console.error('Falha ao enviar clipe pra nuvem:', err);
      statusEl.textContent = `Salvo localmente, mas não foi pra galeria da nuvem: ${err.message || 'erro desconhecido'}. Outros aparelhos não vão ver esse clipe.`;
      await new Promise((r) => setTimeout(r, 2500));
    }
    onSaved?.();
  });
}

// ---------- Ver clipe original ----------

export function renderViewOriginalScreen(cardEl, resources, clip, opts = {}) {
  const { title, tagline, onContinue, onBack, backLabel } = opts;
  const videoUrl = resources.trackUrl(URL.createObjectURL(clip.videoBlob));

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">${title ?? clip.name}</h2>
    <p class="menu-tagline">${tagline ?? 'Assista o clipe original antes de dublar'}</p>
    <video id="dub-original-video" class="solo-preview-video" src="${videoUrl}" controls autoplay></video>
    <div class="menu-section">
      <button id="dub-continue-btn" class="menu-btn-primary" type="button" disabled>▶ Já vi, continuar</button>
      <button id="dub-skip-btn" class="menu-link" type="button">Pular</button>
      ${onBack ? `<button id="dub-back-btn" class="menu-link" type="button">${backLabel ?? 'Voltar'}</button>` : ''}
    </div>
  `;

  const video = cardEl.querySelector('#dub-original-video');
  const continueBtn = cardEl.querySelector('#dub-continue-btn');
  video.addEventListener('ended', () => {
    continueBtn.disabled = false;
  });
  continueBtn.addEventListener('click', () => onContinue?.());
  cardEl.querySelector('#dub-skip-btn').addEventListener('click', () => onContinue?.());
  if (onBack) cardEl.querySelector('#dub-back-btn').addEventListener('click', onBack);
}

// ---------- Gravação guiada fala por fala ----------

export function runGuidedRecording(cardEl, resources, clip, opts = {}) {
  const { titleText, onDone, onCancel, cancelLabel, segmentLabel } = opts;
  const videoUrl = resources.trackUrl(URL.createObjectURL(clip.videoBlob));
  const recordings = new Map();
  let index = 0;
  let activeRecorder = null;

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">${titleText ?? 'DUBLANDO'}</h2>
    <div class="dub-video-wrap">
      <video id="dub-rec-video" class="solo-preview-video" src="${videoUrl}"></video>
      <div id="dub-rec-countdown" class="dub-countdown" hidden></div>
    </div>
    <p id="dub-rec-progress" class="menu-tagline"></p>
    <div id="dub-rec-waveform" class="waveform-strip dub-rec-waveform"><canvas></canvas></div>
    <p id="dub-rec-status" class="menu-status"></p>
    <div class="menu-section">
      <button id="dub-play-original-btn" class="menu-btn-secondary" type="button">▶ Ouvir trecho original</button>
      <button id="dub-record-btn" class="menu-btn-primary" type="button">🎙 Gravar minha fala</button>
      <button id="dub-play-mine-btn" class="menu-btn-secondary" type="button" disabled>▶ Ouvir minha gravação</button>
      <button id="dub-next-btn" class="menu-btn-primary" type="button" disabled>Próxima fala ▶</button>
      ${onCancel ? `<button id="dub-cancel-btn" class="menu-link" type="button">${cancelLabel ?? 'Cancelar'}</button>` : ''}
    </div>
  `;

  const video = cardEl.querySelector('#dub-rec-video');
  const progressEl = cardEl.querySelector('#dub-rec-progress');
  const statusEl = cardEl.querySelector('#dub-rec-status');
  const recordBtn = cardEl.querySelector('#dub-record-btn');
  const playOriginalBtn = cardEl.querySelector('#dub-play-original-btn');
  const playMineBtn = cardEl.querySelector('#dub-play-mine-btn');
  const nextBtn = cardEl.querySelector('#dub-next-btn');
  const waveformCanvas = cardEl.querySelector('#dub-rec-waveform canvas');

  if (onCancel) cardEl.querySelector('#dub-cancel-btn').addEventListener('click', onCancel);

  // Waveform ao vivo do que o microfone está captando enquanto grava —
  // reaproveita o mesmo par computePeaks/drawWaveform da tela de tagging.
  let waveformAnalyser = null;
  let waveformDataArray = null;
  let waveformRafId = null;

  function ensureWaveformAnalyser(stream) {
    if (waveformAnalyser) return waveformAnalyser;
    const audioCtx = resources.getAudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    waveformAnalyser = audioCtx.createAnalyser();
    waveformAnalyser.fftSize = 1024;
    source.connect(waveformAnalyser);
    waveformDataArray = new Float32Array(waveformAnalyser.fftSize);
    return waveformAnalyser;
  }

  function startWaveformDraw(stream) {
    const analyser = ensureWaveformAnalyser(stream);
    const sampleRate = analyser.context.sampleRate;
    function draw() {
      analyser.getFloatTimeDomainData(waveformDataArray);
      const peaks = computePeaks(waveformDataArray, sampleRate, 0, waveformDataArray.length / sampleRate, 48);
      drawWaveform(waveformCanvas, peaks, { color: 'rgba(255, 46, 196, 0.85)' });
      waveformRafId = requestAnimationFrame(draw);
      resources.trackRaf(waveformRafId);
    }
    draw();
  }

  function stopWaveformDraw() {
    if (waveformRafId) {
      cancelAnimationFrame(waveformRafId);
      resources.untrackRaf(waveformRafId);
      waveformRafId = null;
    }
    waveformCanvas.getContext('2d').clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  }

  // Contagem regressiva de 3s antes de gravar de fato — dá tempo do
  // jogador se preparar depois de ver a cena/personagem certo.
  const countdownEl = cardEl.querySelector('#dub-rec-countdown');
  function runCountdown(seconds) {
    return new Promise((resolve) => {
      let remaining = seconds;
      countdownEl.hidden = false;
      countdownEl.textContent = remaining;
      statusEl.textContent = `Prepare-se… grava em ${remaining}`;
      const tick = () => {
        remaining -= 1;
        if (remaining > 0) {
          countdownEl.textContent = remaining;
          statusEl.textContent = `Prepare-se… grava em ${remaining}`;
          setTimeout(tick, 1000);
        } else {
          countdownEl.hidden = true;
          resolve();
        }
      };
      setTimeout(tick, 1000);
    });
  }

  function currentSegment() {
    return clip.segments[index];
  }

  function defaultLabel(seg, i, total) {
    return `Fala ${i + 1} de ${total} — ${seg.character} (${formatTime(seg.start)}–${formatTime(seg.end)})`;
  }

  function refreshForSegment() {
    const seg = currentSegment();
    progressEl.textContent = (segmentLabel ?? defaultLabel)(seg, index, clip.segments.length);
    statusEl.textContent = '';
    playMineBtn.disabled = !recordings.has(seg.id);
    nextBtn.disabled = !recordings.has(seg.id);
    nextBtn.textContent = index === clip.segments.length - 1 ? 'Ver resultado 🎬' : 'Próxima fala ▶';
  }
  refreshForSegment();

  playOriginalBtn.addEventListener('click', () => {
    video.muted = false;
    playRange(video, currentSegment().start, currentSegment().end);
  });

  recordBtn.addEventListener('click', async () => {
    if (activeRecorder) {
      activeRecorder.stop();
      return;
    }
    let stream;
    try {
      stream = await resources.getMicStream();
    } catch {
      statusEl.textContent = 'Não foi possível acessar o microfone.';
      return;
    }

    const seg = currentSegment();
    let videoSyncHandler = null;
    const stopVideoSync = () => {
      if (videoSyncHandler) {
        video.removeEventListener('timeupdate', videoSyncHandler);
        videoSyncHandler = null;
      }
      video.pause();
      video.muted = false;
    };

    try {
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stopVideoSync();
        stopWaveformDraw();
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        recordings.set(seg.id, blob);
        activeRecorder = null;
        recordBtn.textContent = '🎙 Gravar minha fala';
        recordBtn.classList.remove('recording');
        playOriginalBtn.disabled = false;
        statusEl.textContent = 'Gravação salva. Ouça ou avance.';
        refreshForSegment();
      };

      // O vídeo acompanha a gravação em tempo real — o jogador vê a cena
      // enquanto dubla, mudo (senão o áudio original vaza pro microfone
      // junto com a fala nova) — e a gravação para sozinha quando a fala
      // termina.
      await seekTo(video, seg.start);

      recordBtn.disabled = true;
      playOriginalBtn.disabled = true;
      await runCountdown(3);
      recordBtn.disabled = false;

      recorder.start();
      activeRecorder = recorder;
      recordBtn.textContent = '⏹ Parar gravação';
      recordBtn.classList.add('recording');
      statusEl.textContent = 'Gravando — acompanhe o vídeo…';
      startWaveformDraw(stream);

      videoSyncHandler = () => {
        if (video.currentTime >= seg.end) recorder.stop();
      };
      video.addEventListener('timeupdate', videoSyncHandler);
      video.muted = true;
      video.play().catch(() => {});
    } catch {
      recordBtn.disabled = false;
      statusEl.textContent = 'Não foi possível iniciar a gravação — tente de novo.';
    }
  });

  playMineBtn.addEventListener('click', () => {
    const blob = recordings.get(currentSegment().id);
    if (!blob) return;
    new Audio(resources.trackUrl(URL.createObjectURL(blob))).play();
  });

  nextBtn.addEventListener('click', () => {
    if (index < clip.segments.length - 1) {
      index += 1;
      refreshForSegment();
    } else {
      onDone?.(recordings);
    }
  });
}

// ---------- Resultado sincronizado ----------

export function createSyncedPlayback(video, segments, recordings, resources) {
  const triggered = new Set();
  const playingAudio = new Map();
  let rafId = null;

  function resetTriggerState() {
    triggered.clear();
    playingAudio.forEach((audio) => audio.pause());
    playingAudio.clear();
    segments.forEach((seg) => {
      if (seg.end <= video.currentTime) triggered.add(seg.id);
    });
  }

  function tick() {
    const t = video.currentTime;
    // Só abafa o áudio original enquanto uma fala redublada está tocando —
    // trechos sem gravação continuam com o áudio original audível.
    const dubbedSeg = segments.find((seg) => t >= seg.start && t < seg.end && recordings.get(seg.id));
    video.muted = !!dubbedSeg;
    segments.forEach((seg) => {
      if (t >= seg.start && t < seg.end && !triggered.has(seg.id)) {
        triggered.add(seg.id);
        const blob = recordings.get(seg.id);
        if (blob) {
          const audio = new Audio(resources.trackUrl(URL.createObjectURL(blob)));
          playingAudio.set(seg.id, audio);
          audio.play().catch(() => {});
        }
      }
    });
    rafId = requestAnimationFrame(tick);
    resources.trackRaf(rafId);
  }

  video.addEventListener('seeked', resetTriggerState);
  video.addEventListener('play', resetTriggerState);

  return {
    start() {
      tick();
    },
    stop() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        resources.untrackRaf(rafId);
        rafId = null;
      }
      playingAudio.forEach((audio) => audio.pause());
      playingAudio.clear();
    },
  };
}

export function renderResultScreen(cardEl, resources, clip, recordings, opts = {}) {
  const { title, tagline, actions = [] } = opts;
  const videoUrl = resources.trackUrl(URL.createObjectURL(clip.videoBlob));

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">${title ?? 'SUA DUBLAGEM'}</h2>
    <p class="menu-tagline">${tagline ?? `${clip.name} — redublado`}</p>
    <video id="dub-result-video" class="solo-preview-video" src="${videoUrl}" controls></video>
    <div class="menu-section" id="dub-result-actions">
      <button id="dub-replay-btn" class="menu-btn-secondary" type="button">🔁 Assistir de novo</button>
      <button id="dub-export-btn" class="menu-btn-secondary" type="button">⬇️ Baixar dublagem</button>
    </div>
    <p id="dub-export-status" class="menu-status"></p>
  `;

  const video = cardEl.querySelector('#dub-result-video');
  const playback = createSyncedPlayback(video, clip.segments, recordings, resources);
  playback.start();
  video.play().catch(() => {});

  cardEl.querySelector('#dub-replay-btn').addEventListener('click', () => {
    video.currentTime = 0;
    video.play();
  });

  const exportBtn = cardEl.querySelector('#dub-export-btn');
  const exportStatusEl = cardEl.querySelector('#dub-export-status');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportStatusEl.textContent = 'Gerando vídeo… 0%';
    try {
      const wasPlaying = !video.paused;
      video.pause();
      const blob = await exportDubbedVideo(clip, recordings, {
        onProgress: (fraction) => {
          exportStatusEl.textContent = `Gerando vídeo… ${Math.round(fraction * 100)}%`;
        },
      });
      const safeName = (clip.name || 'clipe').replace(/[^\w-]+/g, '_');
      downloadBlob(blob, `${safeName}-dublado.webm`);
      exportStatusEl.textContent = 'Download iniciado!';
      if (wasPlaying) video.play().catch(() => {});
    } catch (err) {
      exportStatusEl.textContent = err.message || 'Não foi possível gerar o vídeo.';
    } finally {
      exportBtn.disabled = false;
    }
  });

  const actionsEl = cardEl.querySelector('#dub-result-actions');
  actions.forEach(({ label, className, onClick }) => {
    const btn = el(`<button class="${className || 'menu-btn-primary'}" type="button">${label}</button>`);
    btn.addEventListener('click', () => {
      playback.stop();
      onClick();
    });
    actionsEl.appendChild(btn);
  });

  return { stop: () => playback.stop() };
}
