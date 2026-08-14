import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

// ---------- Game show podium + floating "TV screen" (ambient set dressing
// behind the menu — the game itself plays entirely in the modal overlays
// below, not on this screen) ----------

scene.add(makePodium());

const { tvGroup } = makeTvScreen();
scene.add(tvGroup);

// ---------- Voice chat microphone (used inside online rooms) ----------

const SPEAK_THRESHOLD = 0.09;

const voiceMicBtn = document.getElementById('voice-mic-btn');

let analyser = null;
let audioDataArray = null;
let wasSelfSpeaking = false;

voiceMicBtn.addEventListener('click', async () => {
  if (analyser) return;
  try {
    voiceMicBtn.textContent = 'Conectando...';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    audioDataArray = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    setLocalStream(stream);

    voiceMicBtn.textContent = '🎤 Microfone ativo';
    voiceMicBtn.classList.add('active');
  } catch {
    voiceMicBtn.textContent = '🎤 Permissão negada';
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

// ---------- Online rooms (Socket.io) ----------

const onlineRoomOverlay = document.getElementById('online-room-overlay');
const onlineLeaveBtn = document.getElementById('online-leave-btn');

const network = initNetwork({
  onJoinedRoom() {
    onlineRoomOverlay.classList.remove('menu-hidden');
  },
});

onlineLeaveBtn.addEventListener('click', () => {
  network.leaveRoom();
  onlineRoomOverlay.classList.add('menu-hidden');
});

// A partida em si abre por cima da sala (mesmo z-index de overlay) — some
// a sala enquanto ela estiver aberta, e volta a mostrá-la quando o jogador
// fecha a partida e cai de novo no lobby.
document.getElementById('online-game-btn').addEventListener('click', () => {
  onlineRoomOverlay.classList.add('menu-hidden');
});
document.getElementById('online-game-overlay').addEventListener('click', (event) => {
  if (event.target.closest('#og-close-btn')) onlineRoomOverlay.classList.remove('menu-hidden');
});

// ---------- Online multiplayer game (rounds over the same room) ----------

const onlineGame = initOnlineGame({ overlayId: 'online-game-overlay', openBtnId: 'online-game-btn' });

// ---------- WebRTC voice chat + P2P clip/recording transfer ----------

initWebRTC({
  onTalkingChange: network.setPeerTalking,
  onFileReceived: onlineGame?.handleFileReceived,
  onFileProgress: onlineGame?.handleFileProgress,
});

// ---------- Main menu ----------

const toggleOnlineBtn = document.getElementById('toggle-online-btn');
const menuOnlineForm = document.getElementById('menu-online-form');
const howToPlayToggle = document.getElementById('how-to-play-toggle');
const howToPlayList = document.getElementById('how-to-play');
const menuGalleryBtn = document.getElementById('menu-gallery-btn');

toggleOnlineBtn.addEventListener('click', () => {
  menuOnlineForm.hidden = !menuOnlineForm.hidden;
});

howToPlayToggle.addEventListener('click', () => {
  howToPlayList.hidden = !howToPlayList.hidden;
  howToPlayToggle.textContent = howToPlayList.hidden ? 'Como jogar ▾' : 'Como jogar ▴';
});

menuGalleryBtn.addEventListener('click', () => openGallery());

// ---------- Modo Solo / Multiplayer Local ----------
// (Abrem como overlays por cima do menu — o menu principal nunca precisa
// ser escondido pra esses dois, só a sala online tem uma tela própria.)

initSoloMode({ openBtnId: 'solo-mode-btn', overlayId: 'solo-overlay' });
initMultiplayerMode({ openBtnId: 'multiplayer-mode-btn', overlayId: 'multiplayer-overlay' });

// ---------- Animation loop ----------

const clock = new THREE.Clock();

function animate() {
  const t = clock.getElapsedTime();

  tvGroup.position.y = 3.4 + Math.sin(t * 0.9) * 0.15;
  tvGroup.rotation.y = Math.sin(t * 0.35) * 0.08;

  pinkLight.intensity = 5 + Math.sin(t * 2) * 1.5;
  blueLight.intensity = 5 + Math.cos(t * 2.3) * 1.5;

  if (analyser) {
    const isSpeaking = readMicVolume() > SPEAK_THRESHOLD;
    if (socket.id && isSpeaking !== wasSelfSpeaking) {
      wasSelfSpeaking = isSpeaking;
      network.setPeerTalking(socket.id, isSpeaking);
    }
  }

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

  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.0, 2.2),
    new THREE.MeshStandardMaterial({
      color: 0x050510,
      emissive: 0x0a0a2a,
      emissiveIntensity: 1,
      roughness: 0.4,
    })
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

  return { tvGroup };
}
