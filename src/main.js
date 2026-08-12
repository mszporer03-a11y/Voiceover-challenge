import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PARODY_LIBRARY } from './library.js';
import { saveTopbarClip, getAllTopbarClips } from './db.js';
import { initNetwork } from './network.js';
import { socket } from './socket.js';
import { initWebRTC, setLocalStream } from './webrtc.js';
import { initSoloMode, openGallery } from './soloMode.js';
import { initMultiplayerMode } from './multiplayerMode.js';
import { initOnlineGame } from './onlineGame.js';

// ---------- Renderer / Scene / Camera ----------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = makeNeonSkyTexture();
scene.fog = new THREE.Fog(0x1a0033, 12, 40);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  200
);
camera.position.set(0, 3.2, 9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 18;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

// ---------- Lights ----------

scene.add(new THREE.AmbientLight(0x442266, 0.8));

const pinkLight = new THREE.PointLight(0xff2ec4, 6, 30);
pinkLight.position.set(-6, 5, 4);
scene.add(pinkLight);

const blueLight = new THREE.PointLight(0x2ec4ff, 6, 30);
blueLight.position.set(6, 5, -2);
scene.add(blueLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
keyLight.position.set(0, 10, 8);
scene.add(keyLight);

// ---------- Synthwave grid floor ----------

scene.add(makeGridFloor());

// ---------- Game show podium ----------

const podium = makePodium();
scene.add(podium);

// ---------- Floating "TV screen" cube ----------

const { tvGroup, screenMaterial, screenMesh } = makeTvScreen();
scene.add(tvGroup);

// ---------- Local players (same-keyboard multiplayer) ----------

const players = [
  { name: 'Jogador 1', color: 0xff2ec4, x: -2.6, avatar: null, velocityY: 0, hopY: 0 },
  { name: 'Jogador 2', color: 0x2ec4ff, x: 2.6, avatar: null, velocityY: 0, hopY: 0 },
];

players.forEach((player) => {
  const avatar = makeAvatar(player.color, player.name);
  avatar.position.set(player.x, 0, 2.4);
  scene.add(avatar);
  player.avatar = avatar;
});

let activePlayerIndex = 0;

const turnRing = new THREE.Mesh(
  new THREE.RingGeometry(0.55, 0.7, 32),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  })
);
turnRing.rotation.x = -Math.PI / 2;
scene.add(turnRing);

const turnIndicatorEl = document.getElementById('turn-indicator');

function setActivePlayer(index) {
  activePlayerIndex = index;
  const player = players[activePlayerIndex];
  turnIndicatorEl.textContent = `${player.name} na vez`;
  turnRing.material.color.set(player.color);
}
setActivePlayer(0);

window.addEventListener('keydown', (event) => {
  if (event.key === '1') setActivePlayer(0);
  if (event.key === '2') setActivePlayer(1);
});

// ---------- Microphone volume detection (Web Audio API) ----------

const JUMP_IMPULSE = 3.2;
const GRAVITY = 14;
const SPEAK_THRESHOLD = 0.09;

const micBtn = document.getElementById('mic-btn');
const volumeFillEl = document.getElementById('volume-fill');

let analyser = null;
let audioDataArray = null;
let currentVolume = 0;

micBtn.addEventListener('click', async () => {
  if (analyser) return;
  try {
    micBtn.textContent = 'Conectando...';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    audioDataArray = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    setLocalStream(stream);

    micBtn.textContent = '🎤 Microfone ativo';
    micBtn.classList.add('active');
  } catch (err) {
    micBtn.textContent = '🎤 Permissão negada';
  }
});

function readMicVolume() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(audioDataArray);
  let sumSquares = 0;
  for (let i = 0; i < audioDataArray.length; i++) {
    const normalized = (audioDataArray[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / audioDataArray.length);
}

// ---------- Video upload -> VideoTexture ----------

const clipInput = document.getElementById('clip-input');
const clipLibrarySelect = document.getElementById('clip-library-select');
const uploadStatus = document.getElementById('upload-status');
let currentVideo = null;
let currentVideoUrl = null;
// O menu principal começa aberto; nenhum vídeo/áudio deve tocar por trás
// dele até o jogador efetivamente entrar no jogo (ver dismissMenu/openMenu).
let isMenuOpen = true;

// clipId -> File, so a locally-tagged clip can be replayed automatically
// when another player in the room broadcasts the same library id.
const localClipCache = new Map();

PARODY_LIBRARY.forEach((entry) => {
  const option = document.createElement('option');
  option.value = entry.id;
  option.textContent = entry.name;
  clipLibrarySelect.appendChild(option);
});

clipInput.addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const clipId = clipLibrarySelect.value;
  localClipCache.set(clipId, file);
  playClipFile(file, `Reproduzindo "${file.name}"`);
  network.notifyClipLoaded(clipId);
  saveTopbarClip(clipId, file).catch((err) => console.error('Falha ao salvar clipe localmente:', err));
});

// Recarrega os clipes já enviados anteriormente (guardados no IndexedDB do
// navegador) para não precisar subi-los de novo a cada visita.
(async () => {
  try {
    const savedClips = await getAllTopbarClips();
    if (!savedClips.length) return;
    savedClips.forEach((entry) => localClipCache.set(entry.clipId, entry.blob));

    const currentSelection = clipLibrarySelect.value;
    const match = savedClips.find((entry) => entry.clipId === currentSelection) || savedClips[0];
    clipLibrarySelect.value = match.clipId;
    playClipFile(match.blob, `Reproduzindo "${match.fileName}" (salvo localmente)`);
  } catch (err) {
    console.error('Falha ao carregar clipes salvos:', err);
  }
})();

function playClipFile(file, playingStatusText) {
  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  if (currentVideo) currentVideo.pause();

  const video = document.createElement('video');
  video.loop = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';

  currentVideoUrl = URL.createObjectURL(file);
  video.src = currentVideoUrl;
  currentVideo = video;

  uploadStatus.textContent = `Carregando "${file.name}"…`;

  video.addEventListener('loadeddata', () => {
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    screenMaterial.map = texture;
    screenMaterial.emissiveMap = texture;
    screenMaterial.color.set(0xffffff);
    screenMaterial.emissive.set(0x222222);
    screenMaterial.needsUpdate = true;

    // Não toca (nem o áudio) enquanto o menu principal estiver aberto por
    // cima — dismissMenu() retoma quando o jogador realmente entrar no jogo.
    if (!isMenuOpen) video.play();
    uploadStatus.textContent = playingStatusText;
  });

  video.addEventListener('error', () => {
    uploadStatus.textContent = 'Não foi possível carregar esse clipe.';
  });
}

// ---------- Online rooms (Socket.io) ----------

const network = initNetwork({
  onPlayRemoteClip(clipId, clipName) {
    const cachedFile = localClipCache.get(clipId);
    if (cachedFile) {
      playClipFile(cachedFile, `Acompanhando: "${clipName}"`);
    } else {
      uploadStatus.textContent = `Outro jogador está usando "${clipName}" — carregue esse clipe para acompanhar.`;
    }
  },
  onJoinedRoom() {
    dismissMenu();
  },
});

// ---------- Online multiplayer game (rounds over the same room) ----------

const onlineGame = initOnlineGame({ overlayId: 'online-game-overlay', openBtnId: 'online-game-btn' });

// ---------- WebRTC voice chat + P2P clip/recording transfer ----------

initWebRTC({
  onTalkingChange: network.setPeerTalking,
  onFileReceived: onlineGame?.handleFileReceived,
  onFileProgress: onlineGame?.handleFileProgress,
});
let wasSelfSpeaking = false;

// ---------- Main menu ----------

const mainMenuEl = document.getElementById('main-menu');
const playLocalBtn = document.getElementById('play-local-btn');
const toggleOnlineBtn = document.getElementById('toggle-online-btn');
const menuOnlineForm = document.getElementById('menu-online-form');
const howToPlayToggle = document.getElementById('how-to-play-toggle');
const howToPlayList = document.getElementById('how-to-play');
const menuBtn = document.getElementById('menu-btn');
const backToGameBtn = document.getElementById('back-to-game-btn');
const menuGalleryBtn = document.getElementById('menu-gallery-btn');

let gameStarted = false;

function dismissMenu() {
  gameStarted = true;
  isMenuOpen = false;
  mainMenuEl.classList.add('menu-hidden');
  backToGameBtn.hidden = false;
  currentVideo?.play().catch(() => {});
}

function openMenu() {
  isMenuOpen = true;
  mainMenuEl.classList.remove('menu-hidden');
  backToGameBtn.hidden = !gameStarted;
  currentVideo?.pause();
}

playLocalBtn.addEventListener('click', dismissMenu);
backToGameBtn.addEventListener('click', dismissMenu);
menuBtn.addEventListener('click', openMenu);

toggleOnlineBtn.addEventListener('click', () => {
  menuOnlineForm.hidden = !menuOnlineForm.hidden;
});

howToPlayToggle.addEventListener('click', () => {
  howToPlayList.hidden = !howToPlayList.hidden;
  howToPlayToggle.textContent = howToPlayList.hidden ? 'Como jogar ▾' : 'Como jogar ▴';
});

menuGalleryBtn.addEventListener('click', () => {
  dismissMenu();
  openGallery();
});

// ---------- Modo Solo / Multiplayer Local ----------

initSoloMode({ openBtnId: 'solo-mode-btn', overlayId: 'solo-overlay' });
initMultiplayerMode({ openBtnId: 'multiplayer-mode-btn', overlayId: 'multiplayer-overlay' });

// ---------- Animation loop ----------

const clock = new THREE.Clock();
let lastTime = 0;

function animate() {
  const t = clock.getElapsedTime();
  const dt = Math.min(t - lastTime, 0.05);
  lastTime = t;

  tvGroup.position.y = 3.4 + Math.sin(t * 0.9) * 0.15;
  tvGroup.rotation.y = Math.sin(t * 0.35) * 0.08;

  pinkLight.intensity = 5 + Math.sin(t * 2) * 1.5;
  blueLight.intensity = 5 + Math.cos(t * 2.3) * 1.5;

  currentVolume = readMicVolume();
  volumeFillEl.style.width = `${Math.min(currentVolume / 0.4, 1) * 100}%`;

  const isSpeaking = analyser && currentVolume > SPEAK_THRESHOLD;
  if (socket.id && isSpeaking !== wasSelfSpeaking) {
    wasSelfSpeaking = isSpeaking;
    network.setPeerTalking(socket.id, isSpeaking);
  }
  const activePlayer = players[activePlayerIndex];

  players.forEach((player) => {
    const isActive = player === activePlayer;

    if (isActive && isSpeaking && player.hopY <= 0.001) {
      player.velocityY = JUMP_IMPULSE;
    }

    player.velocityY -= GRAVITY * dt;
    player.hopY = Math.max(0, player.hopY + player.velocityY * dt);
    if (player.hopY <= 0) {
      player.hopY = 0;
      player.velocityY = 0;
    }

    player.avatar.position.y = player.hopY;
    player.avatar.scale.y = isActive ? 1 + player.hopY * 0.15 : 1;

    const glow = isActive ? (isSpeaking ? 1.4 : 0.7) : 0.25;
    player.avatar.userData.setGlow(glow);
  });

  turnRing.position.set(activePlayer.x, 0.02, 2.4);

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ---------- Resize ----------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Builders ----------

function makeNeonSkyTexture() {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = 2;
  canvasEl.height = 256;
  const ctx = canvasEl.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#1a0033');
  gradient.addColorStop(0.45, '#4b0082');
  gradient.addColorStop(0.75, '#ff2ec4');
  gradient.addColorStop(1, '#ff7a3d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 256);

  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeGridFloor() {
  const grid = new THREE.GridHelper(60, 60, 0xff2ec4, 0x2ec4ff);
  grid.position.y = 0;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({
      color: 0x0a0014,
      roughness: 0.9,
      metalness: 0.1,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;

  const group = new THREE.Group();
  group.add(floor, grid);
  return group;
}

function makePodium() {
  const group = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.7, 1.6, 32),
    new THREE.MeshStandardMaterial({
      color: 0x2a1050,
      metalness: 0.6,
      roughness: 0.3,
      emissive: 0x330066,
      emissiveIntensity: 0.3,
    })
  );
  base.position.y = 0.8;

  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(1.42, 0.05, 12, 32),
    new THREE.MeshStandardMaterial({
      color: 0xff2ec4,
      emissive: 0xff2ec4,
      emissiveIntensity: 1.2,
    })
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 1.58;

  const topPlate = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, 0.08, 32),
    new THREE.MeshStandardMaterial({
      color: 0x111111,
      metalness: 0.8,
      roughness: 0.2,
    })
  );
  topPlate.position.y = 1.64;

  group.add(base, trim, topPlate);
  return group;
}

function makeAvatar(color, label) {
  const group = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.3,
  });

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.7, 6, 12),
    bodyMaterial
  );
  body.position.y = 0.75;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 16, 16),
    bodyMaterial
  );
  head.position.y = 1.4;

  const labelSprite = makeTextSprite(label);
  labelSprite.position.y = 1.95;

  group.add(body, head, labelSprite);
  group.userData.setGlow = (intensity) => {
    bodyMaterial.emissiveIntensity = intensity;
  };

  return group;
}

function makeTextSprite(text) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = 256;
  canvasEl.height = 64;
  const ctx = canvasEl.getContext('2d');
  ctx.fillStyle = 'rgba(10, 0, 20, 0.6)';
  ctx.roundRect(0, 0, 256, 64, 16);
  ctx.fill();
  ctx.font = 'bold 32px Segoe UI, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);

  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.4, 0.35, 1);
  return sprite;
}

function makeTvScreen() {
  const tvGroup = new THREE.Group();
  tvGroup.position.set(0, 3.4, -3);

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 2.6, 0.3),
    new THREE.MeshStandardMaterial({
      color: 0x1a0a2e,
      metalness: 0.7,
      roughness: 0.25,
      emissive: 0x2ec4ff,
      emissiveIntensity: 0.15,
    })
  );

  const screenMaterial = new THREE.MeshStandardMaterial({
    color: 0x050510,
    emissive: 0x0a0a2a,
    emissiveIntensity: 1,
    roughness: 0.4,
  });

  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.0, 2.2),
    screenMaterial
  );
  screenMesh.position.z = 0.16;

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(2.35, 0.04, 8, 4),
    new THREE.MeshStandardMaterial({
      color: 0xff2ec4,
      emissive: 0xff2ec4,
      emissiveIntensity: 1,
    })
  );
  rim.scale.set(0.94, 0.55, 1);
  rim.position.z = 0.17;

  tvGroup.add(frame, screenMesh, rim);

  return { tvGroup, screenMaterial, screenMesh };
}
