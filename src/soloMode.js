import { getRandomClip } from './db.js';
import {
  createResources,
  renderGalleryScreen,
  renderViewOriginalScreen,
  runGuidedRecording,
  renderResultScreen,
} from './dubShared.js';

// Controlador de tela cheia do Modo Solo: galeria -> ver clipe original ->
// gravação guiada fala por fala -> resultado. As telas em si vêm de
// dubShared.js (reaproveitadas também pelo Multiplayer local); aqui só
// orquestra a ordem específica do fluxo solo.

let overlayEl = null;
let cardEl = null;
let resources = null;

export function initSoloMode({ openBtnId, overlayId } = {}) {
  overlayEl = document.getElementById(overlayId || 'solo-overlay');
  if (!overlayEl) return;

  overlayEl.innerHTML = `
    <div class="menu-backdrop"></div>
    <div class="menu-card solo-card"></div>
  `;
  cardEl = overlayEl.querySelector('.solo-card');
  resources = createResources();

  const openBtn = document.getElementById(openBtnId || 'solo-mode-btn');
  openBtn?.addEventListener('click', openGallery);
}

/** Abre o overlay do Modo Solo direto na galeria — reaproveitado pelo botão "Galeria" do menu principal. */
export function openGallery() {
  openOverlay();
  renderGallery();
}

function openOverlay() {
  overlayEl.classList.remove('menu-hidden');
}

function closeOverlay() {
  resources.teardown();
  overlayEl.classList.add('menu-hidden');
}

function renderGallery() {
  renderGalleryScreen(cardEl, resources, {
    title: 'MODO SOLO',
    tagline: 'Escolha um clipe ou adicione um novo à galeria',
    onPick: (clip) => renderViewOriginal(clip),
    onClose: closeOverlay,
    extraButtons: [
      {
        label: '🎲 Sortear e jogar',
        onClick: async () => {
          const clip = await getRandomClip();
          if (clip) renderViewOriginal(clip);
        },
      },
    ],
  });
}

function renderViewOriginal(clip) {
  renderViewOriginalScreen(cardEl, resources, clip, {
    onContinue: () => renderRecording(clip),
    onBack: () => renderGallery(),
    backLabel: 'Voltar à galeria',
  });
}

function renderRecording(clip) {
  runGuidedRecording(cardEl, resources, clip, {
    titleText: 'DUBLANDO',
    onDone: (recordings) => renderResult(clip, recordings),
    onCancel: () => renderGallery(),
    cancelLabel: 'Cancelar e voltar à galeria',
  });
}

function renderResult(clip, recordings) {
  renderResultScreen(cardEl, resources, clip, recordings, {
    title: 'SUA DUBLAGEM',
    tagline: `${clip.name} — redublado por você`,
    actions: [
      {
        label: '🎲 Jogar outro clipe',
        onClick: async () => {
          const next = await getRandomClip();
          if (next) renderViewOriginal(next);
          else renderGallery();
        },
      },
      {
        label: 'Voltar à galeria',
        className: 'menu-link',
        onClick: () => renderGallery(),
      },
    ],
  });
}
