import { socket, connectSocket } from './socket.js';
import { PARODY_LIBRARY } from './library.js';

const GAME_STATE_LABELS = {
  LOBBY: 'Esperando',
  PICKING: 'Enviando clipe',
  DUBBING: 'Dublando',
  VOTING: 'Votando',
  RESULTS: 'Resultado',
};

export function initNetwork({ onPlayRemoteClip, onJoinedRoom }) {
  const el = {
    nameInput: document.getElementById('player-name-input'),
    roomInput: document.getElementById('room-code-input'),
    createBtn: document.getElementById('create-room-btn'),
    joinBtn: document.getElementById('join-room-btn'),
    status: document.getElementById('online-status'),
    panel: document.getElementById('online-panel'),
    roomCode: document.getElementById('room-code-display'),
    playerList: document.getElementById('online-player-list'),
    stateBadge: document.getElementById('online-state-badge'),
  };

  let roomId = null;

  function setStatus(text) {
    el.status.textContent = text;
  }

  function renderRoom(snapshot) {
    el.roomCode.textContent = roomId ? `Sala: ${roomId}` : '';
    el.stateBadge.textContent = GAME_STATE_LABELS[snapshot.gameState] || snapshot.gameState;
    el.playerList.innerHTML = '';
    snapshot.players.forEach((p) => {
      const li = document.createElement('li');
      li.dataset.peerId = p.id;
      const dot = document.createElement('span');
      dot.className = 'mic-dot';
      li.appendChild(dot);
      li.appendChild(
        document.createTextNode(
          ' ' + p.name + (p.id === snapshot.hostId ? ' 👑' : '') + (p.id === socket.id ? ' (você)' : '')
        )
      );
      el.playerList.appendChild(li);
    });
  }

  function handleResponse(response) {
    if (response?.error) {
      setStatus(response.error);
      return;
    }
    roomId = response.roomId;
    setStatus('Conectado.');
    el.panel.hidden = false;
    renderRoom(response);
    onJoinedRoom?.(roomId);
  }

  el.createBtn.addEventListener('click', async () => {
    setStatus('Conectando ao servidor...');
    try {
      await connectSocket();
      socket.emit('create-room', el.nameInput.value, handleResponse);
    } catch {
      setStatus('Não foi possível conectar ao servidor (rode "npm run server").');
    }
  });

  el.joinBtn.addEventListener('click', async () => {
    const code = el.roomInput.value.trim();
    if (!code) {
      setStatus('Digite o código da sala.');
      return;
    }
    setStatus('Conectando ao servidor...');
    try {
      await connectSocket();
      socket.emit('join-room', { roomId: code, playerName: el.nameInput.value }, handleResponse);
    } catch {
      setStatus('Não foi possível conectar ao servidor (rode "npm run server").');
    }
  });

  socket.on('room-update', renderRoom);

  socket.on('play-clip', (clipMeta) => {
    const entry = PARODY_LIBRARY.find((c) => c.id === clipMeta.id);
    onPlayRemoteClip(clipMeta.id, entry?.name || clipMeta.id);
  });

  socket.on('disconnect', () => {
    setStatus('Desconectado do servidor.');
  });

  return {
    notifyClipLoaded(clipId) {
      if (!roomId || !socket.connected) return;
      socket.emit('clip-loaded', { id: clipId });
    },
    isInRoom() {
      return !!roomId;
    },
    setPeerTalking(peerId, talking) {
      const li = el.playerList.querySelector(`li[data-peer-id="${peerId}"]`);
      li?.querySelector('.mic-dot')?.classList.toggle('talking', talking);
    },
  };
}
