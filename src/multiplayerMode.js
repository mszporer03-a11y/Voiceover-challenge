import { getAllClips, getRandomClip } from './db.js';
import {
  createResources,
  renderGalleryScreen,
  renderViewOriginalScreen,
  runGuidedRecording,
  renderResultScreen,
  formatTime,
  el,
} from './dubShared.js';

// Multiplayer local (mesmo aparelho, sem servidor): 3 modos que reaproveitam
// as telas de dubShared.js. `renderSetup` escolhe modo + jogadores, cada
// `run*Mode` orquestra a sequência de telas daquele modo, e todos convergem
// pra `runVoting` + `showScoreboard` no final.

const MODES = [
  { id: 'coop', label: 'Cooperativo', description: 'Um clipe só, personagens divididos entre os jogadores.' },
  { id: 'same-clip', label: 'Mesmo clipe', description: 'Todos dublam o mesmo clipe inteiro, um de cada vez.' },
  {
    id: 'different-clips',
    label: 'Clipes diferentes',
    description: 'Cada jogador dubla um clipe diferente sorteado da galeria.',
  },
];

let overlayEl = null;
let cardEl = null;
let resources = null;

const setupState = {
  modeId: 'coop',
  players: [makePlayer('Jogador 1'), makePlayer('Jogador 2')],
};

export function initMultiplayerMode({ openBtnId, overlayId } = {}) {
  overlayEl = document.getElementById(overlayId || 'multiplayer-overlay');
  if (!overlayEl) return;

  overlayEl.innerHTML = `
    <div class="menu-backdrop"></div>
    <div class="menu-card solo-card"></div>
  `;
  cardEl = overlayEl.querySelector('.solo-card');
  resources = createResources();

  const openBtn = document.getElementById(openBtnId || 'multiplayer-mode-btn');
  openBtn?.addEventListener('click', () => {
    openOverlay();
    renderSetup();
  });
}

function openOverlay() {
  overlayEl.classList.remove('menu-hidden');
}

function closeOverlay() {
  resources.teardown();
  overlayEl.classList.add('menu-hidden');
}

function makePlayer(name) {
  return { id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Configuração ----------

async function renderSetup() {
  const clips = await getAllClips();
  if (!cardEl) return;

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">MULTIPLAYER LOCAL</h2>
    <p class="menu-tagline">Escolha o modo e quem vai jogar (mesmo aparelho)</p>
    <div id="mp-mode-select" class="mp-mode-select"></div>
    <div id="mp-player-list" class="mp-player-list"></div>
    <button id="mp-add-player-btn" class="menu-btn-secondary" type="button">+ Adicionar jogador</button>
    <p id="mp-status" class="menu-status"></p>
    <div class="menu-section">
      <button id="mp-manage-gallery-btn" class="menu-link" type="button">
        🎬 Gerenciar galeria (${clips.length} clipe${clips.length === 1 ? '' : 's'})
      </button>
      <button id="mp-start-btn" class="menu-btn-primary" type="button">Começar</button>
      <button id="mp-close-btn" class="menu-link" type="button">Fechar</button>
    </div>
  `;

  const modeSelectEl = cardEl.querySelector('#mp-mode-select');
  MODES.forEach((mode) => {
    const card = el(`
      <button type="button" class="mp-mode-card${mode.id === setupState.modeId ? ' mp-mode-card-active' : ''}">
        <div class="mp-mode-title">${mode.label}</div>
        <div class="mp-mode-desc">${mode.description}</div>
      </button>
    `);
    card.addEventListener('click', () => {
      setupState.modeId = mode.id;
      renderSetup();
    });
    modeSelectEl.appendChild(card);
  });

  const playerListEl = cardEl.querySelector('#mp-player-list');
  setupState.players.forEach((player, i) => {
    const row = el(`
      <div class="mp-player-row">
        <input type="text" class="mp-player-name" value="${player.name}" maxlength="16" />
        <button type="button" class="menu-link mp-player-remove"${setupState.players.length <= 2 ? ' disabled' : ''}>✕</button>
      </div>
    `);
    row.querySelector('.mp-player-name').addEventListener('change', (e) => {
      player.name = e.target.value.trim() || `Jogador ${i + 1}`;
    });
    row.querySelector('.mp-player-remove').addEventListener('click', () => {
      setupState.players.splice(i, 1);
      renderSetup();
    });
    playerListEl.appendChild(row);
  });

  cardEl.querySelector('#mp-add-player-btn').addEventListener('click', () => {
    if (setupState.players.length >= 6) return;
    setupState.players.push(makePlayer(`Jogador ${setupState.players.length + 1}`));
    renderSetup();
  });

  cardEl.querySelector('#mp-manage-gallery-btn').addEventListener('click', () => openManageGallery());

  const statusEl = cardEl.querySelector('#mp-status');
  const startBtn = cardEl.querySelector('#mp-start-btn');
  if (!clips.length) {
    statusEl.textContent = 'Adicione pelo menos 1 clipe na galeria antes de começar.';
    startBtn.disabled = true;
  } else if (setupState.modeId === 'different-clips' && clips.length < setupState.players.length) {
    statusEl.textContent = `Modo "Clipes diferentes" precisa de pelo menos ${setupState.players.length} clipes na galeria (tem ${clips.length}).`;
    startBtn.disabled = true;
  } else {
    statusEl.textContent = '';
    startBtn.disabled = false;
  }

  cardEl.querySelector('#mp-close-btn').addEventListener('click', closeOverlay);
  startBtn.addEventListener('click', () => startGame(setupState.modeId, setupState.players, clips));
}

function openManageGallery() {
  const backToManage = () =>
    renderGalleryScreen(cardEl, resources, {
      title: 'GALERIA',
      tagline: 'Adicione, remova ou pré-visualize clipes — o sorteio acontece ao começar a partida',
      pickLabel: '▶ Pré-visualizar',
      closeLabel: '◀ Voltar à configuração',
      onClose: () => renderSetup(),
      onPick: (clip) =>
        renderViewOriginalScreen(cardEl, resources, clip, {
          title: clip.name,
          tagline: 'Pré-visualização',
          onContinue: backToManage,
          onBack: backToManage,
          backLabel: '◀ Voltar à galeria',
        }),
    });
  backToManage();
}

async function startGame(modeId, players, clips) {
  if (modeId === 'coop') {
    const clip = await getRandomClip();
    if (clip) runCoopMode(clip, players);
    return;
  }
  if (modeId === 'same-clip') {
    const clip = await getRandomClip();
    if (clip) runSequentialDubbing(players, () => clip);
    return;
  }
  const shuffled = shuffle(clips).slice(0, players.length);
  const clipByPlayer = new Map(players.map((p, i) => [p.id, shuffled[i]]));
  runSequentialDubbing(players, (player) => clipByPlayer.get(player.id));
}

// ---------- Cooperativo ----------

function assignCharacters(characters, players) {
  const shuffledChars = shuffle(characters);
  const byPlayer = new Map(players.map((p) => [p.id, []]));
  shuffledChars.forEach((char, i) => {
    const player = players[i % players.length];
    byPlayer.get(player.id).push(char);
  });
  const byCharacter = new Map();
  byPlayer.forEach((chars, playerId) => {
    chars.forEach((c) => byCharacter.set(c, playerId));
  });
  return { byPlayer, byCharacter };
}

function runCoopMode(clip, players) {
  const { byPlayer, byCharacter } = assignCharacters(clip.characters, players);

  const rows = players
    .map((p) => {
      const chars = byPlayer.get(p.id);
      return `<div class="mp-assign-row"><strong>${p.name}</strong> → ${
        chars.length ? chars.join(', ') : '<em>sem fala nesse clipe</em>'
      }</div>`;
    })
    .join('');

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">DIVISÃO DE PERSONAGENS</h2>
    <p class="menu-tagline">${clip.name}</p>
    <div class="mp-assign-list">${rows}</div>
    <div class="menu-section">
      <button id="mp-reveal-continue-btn" class="menu-btn-primary" type="button">Continuar ▶</button>
    </div>
  `;

  cardEl.querySelector('#mp-reveal-continue-btn').addEventListener('click', () => {
    renderViewOriginalScreen(cardEl, resources, clip, {
      tagline: 'Todo mundo assiste antes de gravar',
      onContinue: () => runCoopRecording(clip, players, byCharacter),
    });
  });
}

function runCoopRecording(clip, players, byCharacter) {
  const playerById = new Map(players.map((p) => [p.id, p]));

  runGuidedRecording(cardEl, resources, clip, {
    titleText: 'DUBLANDO EM EQUIPE',
    segmentLabel: (seg, i, total) => {
      const playerId = byCharacter.get(seg.character);
      const player = playerId ? playerById.get(playerId) : null;
      const who = player ? `Vez de ${player.name}` : 'Personagem sem jogador designado';
      return `Fala ${i + 1} de ${total} — ${who} (${seg.character}, ${formatTime(seg.start)}–${formatTime(seg.end)})`;
    },
    onDone: (recordings) => {
      renderResultScreen(cardEl, resources, clip, recordings, {
        title: 'RESULTADO COOPERATIVO',
        tagline: clip.name,
        actions: [
          {
            label: 'Ir pra votação 🗳',
            onClick: () => runVoting(players, (scores) => showScoreboard(players, scores)),
          },
        ],
      });
    },
    onCancel: () => renderSetup(),
    cancelLabel: 'Cancelar e voltar',
  });
}

// ---------- Mesmo clipe / Clipes diferentes ----------

function renderHandoff(player, onReady) {
  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">PASSA O APARELHO</h2>
    <p class="menu-tagline">É a vez de <strong>${player.name}</strong> dublar</p>
    <div class="menu-section">
      <button id="mp-handoff-ready-btn" class="menu-btn-primary" type="button">Pronto, sou ${player.name} 👋</button>
    </div>
  `;
  cardEl.querySelector('#mp-handoff-ready-btn').addEventListener('click', onReady);
}

async function runSequentialDubbing(players, getClipForPlayer) {
  const results = [];
  for (const player of players) {
    const clip = await getClipForPlayer(player);
    if (!clip) continue;

    await new Promise((resolve) => renderHandoff(player, resolve));
    await new Promise((resolve) => {
      renderViewOriginalScreen(cardEl, resources, clip, {
        title: clip.name,
        tagline: `${player.name}, assista antes de dublar`,
        onContinue: resolve,
      });
    });
    const recordings = await new Promise((resolve) => {
      runGuidedRecording(cardEl, resources, clip, {
        titleText: `DUBLANDO — ${player.name}`,
        onDone: resolve,
        onCancel: () => renderSetup(),
        cancelLabel: 'Cancelar partida',
      });
    });
    results.push({ player, clip, recordings });
  }
  renderResultsCarousel(results, players);
}

function renderResultsCarousel(results, players) {
  let i = 0;
  function showCurrent() {
    const { player, clip, recordings } = results[i];
    const isLast = i === results.length - 1;
    renderResultScreen(cardEl, resources, clip, recordings, {
      title: `Resultado de ${player.name} (${i + 1}/${results.length})`,
      tagline: clip.name,
      actions: [
        {
          label: isLast ? 'Ir pra votação 🗳' : 'Próximo resultado ▶',
          onClick: () => {
            if (isLast) runVoting(players, (scores) => showScoreboard(players, scores));
            else {
              i += 1;
              showCurrent();
            }
          },
        },
      ],
    });
  }
  showCurrent();
}

// ---------- Votação e placar (compartilhados pelos 3 modos) ----------

function runVoting(players, onDone) {
  const scores = new Map(players.map((p) => [p.id, 0]));
  let raterIndex = 0;

  function showRater() {
    const rater = players[raterIndex];
    const others = players.filter((p) => p.id !== rater.id);
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
      <h2 class="menu-logo" style="font-size:22px;">VOTAÇÃO</h2>
      <p class="menu-tagline">${rater.name}, dê uma nota de 0 a 10 pra cada jogador</p>
      <div class="mp-vote-list">${rows}</div>
      <div class="menu-section">
        <button id="mp-vote-confirm-btn" class="menu-btn-primary" type="button">Confirmar notas</button>
      </div>
    `;

    cardEl.querySelector('#mp-vote-confirm-btn').addEventListener('click', () => {
      cardEl.querySelectorAll('.mp-vote-input').forEach((input) => {
        const playerId = input.dataset.playerId;
        const value = Math.max(0, Math.min(10, Math.round(parseFloat(input.value) || 0)));
        scores.set(playerId, scores.get(playerId) + value);
      });
      raterIndex += 1;
      if (raterIndex < players.length) showRater();
      else onDone(scores);
    });
  }

  showRater();
}

function showScoreboard(players, scores) {
  const ranked = players
    .map((p) => ({ player: p, score: scores.get(p.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const topScore = ranked[0]?.score ?? 0;
  const winners = ranked.filter((r) => r.score === topScore).map((r) => r.player.name);

  const rows = ranked
    .map(
      ({ player, score }, i) => `
      <div class="mp-score-row${score === topScore ? ' mp-score-winner' : ''}">
        <span class="mp-score-rank">${i + 1}º</span>
        <span class="mp-score-name">${player.name}${score === topScore ? ' 🏆' : ''}</span>
        <span class="mp-score-value">${score} pts</span>
      </div>`
    )
    .join('');

  cardEl.innerHTML = `
    <h2 class="menu-logo" style="font-size:22px;">PLACAR FINAL</h2>
    <p class="menu-tagline">${winners.length > 1 ? `Empate entre ${winners.join(' e ')}!` : `${winners[0]} venceu!`}</p>
    <div class="mp-score-list">${rows}</div>
    <div class="menu-section">
      <button id="mp-play-again-btn" class="menu-btn-primary" type="button">Jogar de novo</button>
      <button id="mp-exit-btn" class="menu-link" type="button">Fechar</button>
    </div>
  `;

  cardEl.querySelector('#mp-play-again-btn').addEventListener('click', () => renderSetup());
  cardEl.querySelector('#mp-exit-btn').addEventListener('click', () => closeOverlay());
}
