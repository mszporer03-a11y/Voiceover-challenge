import { socket } from './socket.js';
import { sendFileToAllPeers } from './webrtc.js';
import { fetchCloudClipBlob } from './cloudClips.js';
import {
  createResources,
  renderGalleryScreen,
  runGuidedRecording,
  renderResultScreen,
  el,
} from './dubShared.js';

// Orchestrates a full round of online dubbing inside a Socket.io room, in
// any of the 3 modes also offered locally (multiplayerMode.js):
//   - same-clip: everyone dubs the whole clip, all at the same time.
//   - coop: one clip, its characters split across players, one at a time.
//   - different-clips: host assigns a different clip to each player, all
//     dubbing at the same time.
// Host picks clip(s) from their local gallery -> sent peer-to-peer (WebRTC
// data channels, see webrtc.js) to everyone else -> players dub their
// assigned clip/segments (reusing the same guided-recording screen as
// Solo/Multiplayer local) -> recordings are relayed P2P to everyone ->
// each dub is presented for playback -> vote (15s max) -> server-tallied
// scoreboard. The server only ever sees clip *metadata* and small
// coordination messages — video/audio stays P2P.

const MODES = [
  { id: 'same-clip', label: 'Mesmo clipe', description: 'Todo mundo dubla o mesmo clipe inteiro, todos ao mesmo tempo.' },
  { id: 'coop', label: 'Cooperativo', description: 'Um clipe só, personagens divididos entre os jogadores.' },
  {
    id: 'different-clips',
    label: 'Clipes diferentes',
    description: 'Cada jogador dubla um clipe escolhido pelo anfitrião só pra ele.',
  },
];

let overlayEl = null;
let cardEl = null;
let resources = null;

let latestSnapshot = null;
let selectedModeId = 'same-clip';
let clipQueue = []; // clips being picked by the host before select-clips is sent
let sharedClips = []; // clipIndex -> { name, durationSec, segments, characters, videoBlob }
let clipReadySent = false;
let autoSkipSent = false; // guards the "no lines assigned" auto turn-done from firing more than once

// True while runGuidedRecording owns cardEl for this client — a room-update
// (or a P2P file landing) can arrive at any moment now that every player
// records at the same time, and re-rendering over it would yank away the
// mic/video the player is actively using mid-take.
let recordingInProgress = false;

// Presentation stage shown before the score form (task: "clipes devem ser
// apresentados antes da votação") — built once per VOTING round.
let presentationQueue = null; // array of playerIds, or ['__coop__'] for the merged team dub
let presentationIndex = 0;
let presentationDone = false;

// True while the score form is up for this client — guards it the same way
// as recordingInProgress, so another player's vote landing mid-broadcast
// doesn't reset inputs the player is still filling in (or restart their
// countdown).
let votingFormActive = false;
let voteTimerInterval = null;

/** playerId -> Map(segmentId -> Blob) */
const allRecordings = new Map();
const receiveProgress = new Map(); // peerId -> 0..1 (current clip transfer progress)

export function initOnlineGame({ overlayId, openBtnId } = {}) {
  overlayEl = document.getElementById(overlayId || 'online-game-overlay');
  if (!overlayEl) return null;

  overlayEl.innerHTML = `<div class="menu-backdrop"></div><div class="menu-card solo-card"></div>`;
  cardEl = overlayEl.querySelector('.solo-card');
  resources = createResources();

  document.getElementById(openBtnId || 'online-game-btn')?.addEventListener('click', open);

  socket.on('room-update', (snapshot) => {
    const roundChanged = latestSnapshot?.clips !== snapshot.clips;
    latestSnapshot = snapshot;
    if (snapshot.gameState === 'LOBBY') resetRoundState();
    else if (roundChanged) receiveProgress.clear();
    if (overlayEl.classList.contains('menu-hidden')) return;
    maybeAutoConfirmClipReady();
    maybeFetchCloudClips();
    render();
  });

  return { open, close, handleFileReceived, handleFileProgress };
}

function resetRoundState() {
  sharedClips = [];
  clipReadySent = false;
  autoSkipSent = false;
  recordingInProgress = false;
  presentationQueue = null;
  presentationIndex = 0;
  presentationDone = false;
  votingFormActive = false;
  clearVoteTimer();
  allRecordings.clear();
  receiveProgress.clear();
  fetchingCloudClips.clear();
}

function clearVoteTimer() {
  if (voteTimerInterval) {
    clearInterval(voteTimerInterval);
    voteTimerInterval = null;
  }
}

function open() {
  overlayEl.classList.remove('menu-hidden');
  maybeAutoConfirmClipReady();
  maybeFetchCloudClips();
  render();
}

function close() {
  overlayEl.classList.add('menu-hidden');
}

function isHost() {
  return latestSnapshot && socket.id === latestSnapshot.hostId;
}

function myName() {
  return latestSnapshot?.players.find((p) => p.id === socket.id)?.name || 'Você';
}

function playerName(id) {
  return latestSnapshot?.players.find((p) => p.id === id)?.name || '???';
}

// ---------- P2P transfer callbacks (wired from initWebRTC in main.js) ----------

function handleFileReceived(fromId, meta, blob) {
  if (meta.kind === 'clip') {
    finalizeReceivedClip(meta.clipIndex, blob);
    return;
  }
  if (meta.kind === 'recording') {
    if (!allRecordings.has(meta.playerId)) allRecordings.set(meta.playerId, new Map());
    allRecordings.get(meta.playerId).set(meta.segmentId, blob);
  }
  render();
}

function handleFileProgress(fromId, meta, progress) {
  if (meta.kind === 'clip') receiveProgress.set(fromId, progress);
  render();
}

async function finalizeReceivedClip(clipIndex, blob) {
  const video = document.createElement('video');
  video.src = URL.createObjectURL(blob);
  await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  URL.revokeObjectURL(video.src);

  const meta = latestSnapshot?.clips?.[clipIndex];
  sharedClips[clipIndex] = {
    name: meta?.name || `Clipe ${clipIndex + 1}`,
    durationSec: meta?.durationSec || video.duration,
    segments: meta?.segments || [],
    characters: meta?.characters || [],
    videoBlob: blob,
  };
  maybeAutoConfirmClipReady();
  render();
}

function maybeAutoConfirmClipReady() {
  if (clipReadySent || isHost() || latestSnapshot?.gameState !== 'PICKING') return;
  const total = latestSnapshot?.clips?.length || 0;
  if (!total || sharedClips.filter(Boolean).length < total) return;
  clipReadySent = true;
  socket.emit('clip-ready');
}

// Clipes já compartilhados na galeria da nuvem (cloudUrl) chegam pra cada
// jogador via HTTP direto do R2, em vez de esperar a transferência P2P do
// host — mais rápido e reaproveita o mesmo objeto pra futuras partidas.
const fetchingCloudClips = new Set();
async function maybeFetchCloudClips() {
  if (isHost() || latestSnapshot?.gameState !== 'PICKING') return;
  const clips = latestSnapshot.clips || [];
  for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
    const meta = clips[clipIndex];
    if (!meta?.cloudUrl || sharedClips[clipIndex] || fetchingCloudClips.has(clipIndex)) continue;
    fetchingCloudClips.add(clipIndex);
    try {
      const blob = await fetchCloudClipBlob(meta.cloudUrl);
      sharedClips[clipIndex] = {
        name: meta.name,
        durationSec: meta.durationSec,
        segments: meta.segments,
        characters: meta.characters,
        videoBlob: blob,
      };
      maybeAutoConfirmClipReady();
      render();
    } catch {
      // tenta de novo no próximo room-update
    } finally {
      fetchingCloudClips.delete(clipIndex);
    }
  }
}

// ---------- Rendering ----------

function render() {
  if (!cardEl || !latestSnapshot) return;
  // Don't rebuild the card out from under an active recording or an
  // in-progress vote — see the flags' declarations for why.
  if (recordingInProgress || votingFormActive) return;
  switch (latestSnapshot.gameState) {
    case 'PICKING':
      return renderPicking();
    case 'DUBBING':
      return renderDubbing();
    case 'VOTING':
      return renderVoting();
    case 'RESULTS':
      return renderResults();
    default:
      return renderLobby();
  }
}

function renderLobby() {
  const list = latestSnapshot.players
    .map((p) => `<div class="mp-assign-row">${p.name}${p.id === latestSnapshot.hostId ? ' 👑' : ''}</div>`)
    .join('');

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:20px; margin-bottom:-8px;">SALA ONLINE</h2>
    <p class="menu-tagline" style="margin-bottom:-4px;">${latestSnapshot.players.length} jogador(es) na sala</p>
    <div class="mp-assign-list">${list}</div>
    ${isHost() ? '<div id="og-mode-select" class="mp-mode-select"></div>' : ''}
    <p class="menu-status">${
      isHost() ? 'Escolha o modo e o(s) clipe(s) pra começar.' : 'Aguardando o anfitrião escolher o modo e o clipe…'
    }</p>
    <div class="menu-section" style="margin-top:12px;">
      ${isHost() ? '<button id="og-pick-clip-btn" class="menu-btn-primary" type="button">🎬 Escolher clipe(s)</button>' : ''}
      <button id="og-close-btn" class="menu-link" type="button">Fechar</button>
    </div>
  `;

  if (isHost()) {
    const modeSelectEl = cardEl.querySelector('#og-mode-select');
    MODES.forEach((mode) => {
      const card = el(`
        <button type="button" class="mp-mode-card${mode.id === selectedModeId ? ' mp-mode-card-active' : ''}">
          <div class="mp-mode-title">${mode.label}</div>
          <div class="mp-mode-desc">${mode.description}</div>
        </button>
      `);
      card.addEventListener('click', () => {
        selectedModeId = mode.id;
        renderLobby();
      });
      modeSelectEl.appendChild(card);
    });
    cardEl.querySelector('#og-pick-clip-btn').addEventListener('click', openClipPicker);
  }
  cardEl.querySelector('#og-close-btn').addEventListener('click', close);
}

function openClipPicker() {
  clipQueue = [];
  if (selectedModeId === 'different-clips') {
    pickNextPlayerClip();
  } else {
    renderGalleryScreen(cardEl, resources, {
      title: 'ESCOLHER CLIPE',
      tagline: 'Esse clipe será enviado para todos na sala',
      pickLabel: '🎬 Usar este',
      closeLabel: '◀ Voltar',
      onClose: renderLobby,
      onPick: (clip) => {
        clipQueue = [clip];
        hostStartGame();
      },
    });
  }
}

function pickNextPlayerClip() {
  const players = latestSnapshot.players;
  const nextPlayer = players[clipQueue.length];
  if (!nextPlayer) {
    hostStartGame();
    return;
  }
  renderGalleryScreen(cardEl, resources, {
    title: 'ESCOLHER CLIPES',
    tagline: `Clipe de ${nextPlayer.name}${nextPlayer.id === socket.id ? ' (você)' : ''} — ${clipQueue.length + 1}/${players.length}`,
    pickLabel: '🎬 Usar este',
    closeLabel: '◀ Cancelar tudo',
    onClose: renderLobby,
    onPick: (clip) => {
      clipQueue.push(clip);
      pickNextPlayerClip();
    },
  });
}

async function hostStartGame() {
  sharedClips = [...clipQueue];
  allRecordings.clear();
  socket.emit('select-clips', {
    modeId: selectedModeId,
    clips: sharedClips.map((c) => ({
      name: c.name,
      durationSec: c.durationSec,
      segments: c.segments,
      characters: c.characters,
      cloudUrl: c.cloudUrl || null,
    })),
  });
  render();
  // Clipes já compartilhados na nuvem: os outros jogadores baixam sozinhos
  // via HTTP (maybeFetchCloudClips), não precisa mandar por WebRTC.
  await Promise.all(
    sharedClips.map((clip, clipIndex) => {
      if (clip.cloudUrl) return Promise.resolve();
      return sendFileToAllPeers(clip.videoBlob, { kind: 'clip', clipIndex, mime: clip.videoBlob.type });
    })
  );
}

function renderPicking() {
  const total = latestSnapshot.clips?.length || 0;
  const readyRows = latestSnapshot.players
    .map((p) => {
      const isMe = p.id === socket.id;
      const ready = latestSnapshot.clipReadyIds.includes(p.id);
      const status = ready
        ? '✅ pronto'
        : isMe
          ? `recebendo… ${Math.round((receiveProgress.get(latestSnapshot.hostId) || 0) * 100)}%`
          : '⏳ recebendo…';
      return `<div class="mp-assign-row">${p.name}${isMe ? ' (você)' : ''} — ${status}</div>`;
    })
    .join('');

  const modeLabel = MODES.find((m) => m.id === latestSnapshot.modeId)?.label || latestSnapshot.modeId;

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:20px; margin-bottom:-8px;">ENVIANDO CLIPE${total > 1 ? 'S' : ''}</h2>
    <p class="menu-tagline" style="margin-bottom:-4px;">${modeLabel} — ${total} clipe(s)</p>
    <div class="mp-assign-list">${readyRows}</div>
    <p class="menu-status">${isHost() ? 'Aguardando todo mundo baixar os clipes…' : 'Recebendo os clipes do anfitrião…'}</p>
  `;
}

function renderDubbing() {
  return latestSnapshot.modeId === 'coop' ? renderSequentialDubbing() : renderSimultaneousDubbing();
}

// 'coop': one clip, characters split across players — still one at a time
// so it reads like a shared performance, in turnOrder order.
function renderSequentialDubbing() {
  const currentPlayerId = latestSnapshot.currentPlayerId;
  const myTurn = currentPlayerId === socket.id;
  const assignment = latestSnapshot.assignments?.[currentPlayerId];
  const clip = assignment ? sharedClips[assignment.clipIndex] : null;

  if (!clip) {
    cardEl.innerHTML = `
      <h2 class="menu-logo" style="font-size:20px;">DUBLANDO</h2>
      <p class="menu-status">Carregando clipe…</p>
    `;
    return;
  }

  if (!myTurn) {
    cardEl.innerHTML = `
      <h2 class="menu-logo" style="font-size:20px;">DUBLANDO</h2>
      <p class="menu-tagline">${clip.name}</p>
      <p class="menu-status">É a vez de <strong>${playerName(currentPlayerId)}</strong> — aguarde sua vez.</p>
      <div class="mp-assign-list">
        ${latestSnapshot.turnOrder
          .map(
            (id, i) =>
              `<div class="mp-assign-row">${i + 1}. ${playerName(id)}${id === socket.id ? ' (você)' : ''}${
                i === latestSnapshot.turnIndex ? ' 🎙' : ''
              }</div>`
          )
          .join('')}
      </div>
    `;
    return;
  }

  if (assignment.segmentIds.length === 0) {
    cardEl.innerHTML = `
      <h2 class="menu-logo" style="font-size:20px;">DUBLANDO</h2>
      <p class="menu-status">Seu personagem não tem falas nesse clipe — passando a vez…</p>
    `;
    socket.emit('turn-done');
    return;
  }

  const myClip = {
    ...clip,
    segments: clip.segments.filter((s) => assignment.segmentIds.includes(s.id)),
  };

  recordingInProgress = true;
  runGuidedRecording(cardEl, resources, myClip, {
    titleText: `DUBLANDO — ${myName()}`,
    onDone: async (recordings) => {
      allRecordings.set(socket.id, recordings);
      cardEl.innerHTML = `
        <h2 class="menu-logo" style="font-size:20px;">ENVIANDO SUA DUBLAGEM</h2>
        <p class="menu-status">Compartilhando com os outros jogadores…</p>
      `;
      for (const [segmentId, blob] of recordings) {
        await sendFileToAllPeers(blob, { kind: 'recording', playerId: socket.id, segmentId });
      }
      recordingInProgress = false;
      socket.emit('turn-done');
    },
  });
}

// 'same-clip'/'different-clips': everyone records at the same time — each
// player renders their own recording screen right away instead of waiting
// for a turn, and just watches a "who's done" list once they've submitted.
function renderSimultaneousDubbing() {
  const myId = socket.id;
  const assignment = latestSnapshot.assignments?.[myId];
  const clip = assignment ? sharedClips[assignment.clipIndex] : null;
  const doneIds = latestSnapshot.doneIds || [];
  const amDone = doneIds.includes(myId);

  if (!clip) {
    cardEl.innerHTML = `
      <h2 class="menu-logo" style="font-size:20px;">DUBLANDO</h2>
      <p class="menu-status">Carregando clipe…</p>
    `;
    return;
  }

  function waitingRows() {
    return latestSnapshot.players
      .map((p) => {
        const pDone = doneIds.includes(p.id) || latestSnapshot.assignments?.[p.id]?.segmentIds.length === 0;
        return `<div class="mp-assign-row">${p.name}${p.id === myId ? ' (você)' : ''} — ${
          pDone ? '✅ pronto' : '🎙 gravando…'
        }</div>`;
      })
      .join('');
  }

  if (assignment.segmentIds.length === 0) {
    if (!amDone && !autoSkipSent) {
      autoSkipSent = true;
      socket.emit('turn-done');
    }
    cardEl.innerHTML = `
      <h2 class="menu-logo" style="font-size:20px;">DUBLANDO</h2>
      <p class="menu-status">Você não tem falas nesse clipe — aguardando os outros jogadores…</p>
      <div class="mp-assign-list">${waitingRows()}</div>
    `;
    return;
  }

  if (amDone) {
    cardEl.innerHTML = `
      <h2 class="menu-logo" style="font-size:20px;">DUBLANDO</h2>
      <p class="menu-tagline">Sua dublagem foi enviada!</p>
      <p class="menu-status">Aguardando os outros jogadores terminarem…</p>
      <div class="mp-assign-list">${waitingRows()}</div>
    `;
    return;
  }

  const myClip = {
    ...clip,
    segments: clip.segments.filter((s) => assignment.segmentIds.includes(s.id)),
  };

  recordingInProgress = true;
  runGuidedRecording(cardEl, resources, myClip, {
    titleText: `DUBLANDO — ${myName()}`,
    onDone: async (recordings) => {
      allRecordings.set(myId, recordings);
      cardEl.innerHTML = `
        <h2 class="menu-logo" style="font-size:20px;">ENVIANDO SUA DUBLAGEM</h2>
        <p class="menu-status">Compartilhando com os outros jogadores…</p>
      `;
      for (const [segmentId, blob] of recordings) {
        await sendFileToAllPeers(blob, { kind: 'recording', playerId: myId, segmentId });
      }
      recordingInProgress = false;
      socket.emit('turn-done');
    },
  });
}

const VOTE_TIME_LIMIT_SEC = 15;

function renderVoting() {
  return presentationDone ? renderVoteForm() : renderPresentation();
}

// Plays back every dubbed clip before voting opens — each other player's
// take (or, in coop, the one merged team dub), one at a time.
function renderPresentation() {
  if (!presentationQueue) {
    presentationQueue =
      latestSnapshot.modeId === 'coop'
        ? ['__coop__']
        : latestSnapshot.players.filter((p) => p.id !== socket.id).map((p) => p.id);
    presentationIndex = 0;
  }

  if (!presentationQueue.length) {
    presentationDone = true;
    return renderVoteForm();
  }

  const isLast = presentationIndex === presentationQueue.length - 1;
  const nextLabel = isLast ? 'Ir para votação 🗳' : 'Próxima dublagem ▶';
  const goNext = () => {
    if (isLast) presentationDone = true;
    else presentationIndex += 1;
    render();
  };

  const current = presentationQueue[presentationIndex];
  const stepLabel = `Assistindo ${presentationIndex + 1}/${presentationQueue.length}`;

  if (current === '__coop__') {
    const merged = new Map();
    allRecordings.forEach((segMap) => segMap.forEach((blob, segId) => merged.set(segId, blob)));
    renderResultScreen(cardEl, resources, sharedClips[0], merged, {
      title: 'Dublagem da equipe',
      tagline: `${stepLabel} — ${sharedClips[0]?.name || ''}`,
      actions: [{ label: nextLabel, onClick: goNext }],
    });
    return;
  }

  const clipIndex = latestSnapshot.assignments?.[current]?.clipIndex ?? 0;
  const clip = sharedClips[clipIndex];
  const recordings = allRecordings.get(current) || new Map();
  renderResultScreen(cardEl, resources, clip, recordings, {
    title: `Dublagem de ${playerName(current)}`,
    tagline: `${stepLabel} — ${clip?.name || ''}`,
    actions: [{ label: nextLabel, onClick: goNext }],
  });
}

function renderVoteForm() {
  const others = latestSnapshot.players.filter((p) => p.id !== socket.id);
  if (!others.length) {
    cardEl.innerHTML = `<h2 class="menu-logo" style="font-size:20px;">VOTAÇÃO</h2><p class="menu-status">Aguardando outros jogadores…</p>`;
    return;
  }

  votingFormActive = true;

  const rows = others
    .map(
      (p) => `
      <div class="mp-vote-row">
        <span>${p.name}</span>
        <input type="number" class="mp-vote-input" data-player-id="${p.id}" min="0" max="10" step="1" value="5" />
      </div>`
    )
    .join('');

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:20px;">VOTAÇÃO</h2>
    <p class="menu-tagline">Dê uma nota de 0 a 10 pra cada dublagem</p>
    <p id="og-vote-timer" class="mp-vote-timer"></p>
    <div class="mp-vote-list">${rows}</div>
    <div class="menu-section">
      <button id="og-vote-confirm-btn" class="menu-btn-primary" type="button">Confirmar notas</button>
    </div>
    <p id="og-vote-status" class="menu-status"></p>
  `;

  const timerEl = cardEl.querySelector('#og-vote-timer');
  const confirmBtn = cardEl.querySelector('#og-vote-confirm-btn');
  const statusEl = cardEl.querySelector('#og-vote-status');

  const submitVotes = (auto) => {
    clearVoteTimer();
    votingFormActive = false;
    const scores = {};
    cardEl.querySelectorAll('.mp-vote-input').forEach((input) => {
      scores[input.dataset.playerId] = Number(input.value) || 0;
    });
    socket.emit('submit-votes', scores);
    confirmBtn.disabled = true;
    statusEl.textContent = auto
      ? 'Tempo esgotado — notas enviadas automaticamente.'
      : 'Voto enviado — aguardando os outros jogadores…';
  };

  confirmBtn.addEventListener('click', () => submitVotes(false));

  const deadline = Date.now() + VOTE_TIME_LIMIT_SEC * 1000;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    timerEl.textContent = `⏱ ${remaining}s`;
    timerEl.classList.toggle('mp-vote-timer-urgent', remaining <= 5);
    if (remaining <= 0) submitVotes(true);
  };
  tick();
  voteTimerInterval = setInterval(tick, 250);
}

function renderResults() {
  const ranked = latestSnapshot.scoreboard || [];
  const topScore = ranked[0]?.score ?? 0;
  const isCoop = latestSnapshot.modeId === 'coop';

  const rows = ranked
    .map(
      ({ playerId, name, score }, i) => `
      <div class="mp-score-row${score === topScore ? ' mp-score-winner' : ''}">
        <span class="mp-score-rank">${i + 1}º</span>
        <span class="mp-score-name">${name}${score === topScore ? ' 🏆' : ''}</span>
        <span class="mp-score-value">${score} pts</span>
        ${isCoop ? '' : `<button class="menu-link og-watch-btn" data-player-id="${playerId}" type="button">▶ Ver</button>`}
      </div>`
    )
    .join('');

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:20px;">PLACAR FINAL</h2>
    <p class="menu-tagline">${isCoop ? sharedClips[0]?.name || '' : ''}</p>
    <div class="mp-score-list">${rows}</div>
    ${isCoop ? '<button id="og-watch-coop-btn" class="menu-btn-secondary" type="button">▶ Ver dublagem da equipe</button>' : ''}
    <div class="menu-section" style="margin-top:12px;">
      ${isHost() ? '<button id="og-play-again-btn" class="menu-btn-primary" type="button">Jogar de novo</button>' : ''}
      <button id="og-close-btn" class="menu-link" type="button">Fechar</button>
    </div>
  `;

  if (isCoop) {
    cardEl.querySelector('#og-watch-coop-btn').addEventListener('click', watchCoopResult);
  } else {
    cardEl.querySelectorAll('.og-watch-btn').forEach((btn) => {
      btn.addEventListener('click', () => watchPlayerResult(btn.dataset.playerId));
    });
  }
  if (isHost()) {
    cardEl.querySelector('#og-play-again-btn').addEventListener('click', () => socket.emit('play-again'));
  }
  cardEl.querySelector('#og-close-btn').addEventListener('click', close);
}

function watchPlayerResult(playerId) {
  const clipIndex = latestSnapshot.assignments?.[playerId]?.clipIndex ?? 0;
  const clip = sharedClips[clipIndex];
  const recordings = allRecordings.get(playerId) || new Map();
  renderResultScreen(cardEl, resources, clip, recordings, {
    title: `Dublagem de ${playerName(playerId)}`,
    tagline: clip.name,
    actions: [{ label: '◀ Voltar ao placar', className: 'menu-link', onClick: renderResults }],
  });
}

function watchCoopResult() {
  const merged = new Map();
  allRecordings.forEach((segMap) => segMap.forEach((blob, segId) => merged.set(segId, blob)));
  renderResultScreen(cardEl, resources, sharedClips[0], merged, {
    title: 'Dublagem da equipe',
    tagline: sharedClips[0]?.name,
    actions: [{ label: '◀ Voltar ao placar', className: 'menu-link', onClick: renderResults }],
  });
}
