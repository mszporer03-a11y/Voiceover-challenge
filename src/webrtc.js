import { socket } from './socket.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const TALK_THRESHOLD = 0.09;
const CHUNK_SIZE = 16 * 1024;
const BUFFERED_AMOUNT_HIGH = 1 * 1024 * 1024;

/** remoteId -> { pc, audioEl, dc, polite, makingOffer, analyser, dataArray, rafId, incomingFile } */
const peers = new Map();

let localStream = null;
let onTalkingChangeCb = () => {};
let onDataChannelOpenCb = () => {};
let onFileReceivedCb = () => {};
let onFileProgressCb = () => {};

export function initWebRTC({ onTalkingChange, onDataChannelOpen, onFileReceived, onFileProgress } = {}) {
  onTalkingChangeCb = onTalkingChange || (() => {});
  onDataChannelOpenCb = onDataChannelOpen || (() => {});
  onFileReceivedCb = onFileReceived || (() => {});
  onFileProgressCb = onFileProgress || (() => {});

  socket.on('room-update', (snapshot) => {
    reconcilePeers(snapshot.players.map((p) => p.id));
  });

  socket.on('webrtc-signal', ({ from, data }) => handleSignal(from, data));

  socket.on('disconnect', () => {
    [...peers.keys()].forEach(removePeer);
  });

  // Autoplay of remote <audio> elements can be blocked without a user
  // gesture; retry once the player interacts with the page.
  const unlockAudio = () => {
    peers.forEach(({ audioEl }) => audioEl.play().catch(() => {}));
  };
  window.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
}

function reconcilePeers(currentIds) {
  const selfId = socket.id;
  const idSet = new Set(currentIds.filter((id) => id !== selfId));

  [...peers.keys()].forEach((id) => {
    if (!idSet.has(id)) removePeer(id);
  });

  idSet.forEach((id) => {
    if (!peers.has(id)) createPeer(id);
  });
}

function sendSignal(to, data) {
  socket.emit('webrtc-signal', { to, data });
}

function createPeer(id) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const polite = socket.id > id;

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.dataset.peerId = id;
  document.body.appendChild(audioEl);

  const entry = {
    pc,
    audioEl,
    dc: null,
    polite,
    makingOffer: false,
    analyser: null,
    dataArray: null,
    rafId: null,
    incomingFile: null,
  };
  peers.set(id, entry);

  // Always negotiate a bidirectional audio channel, even if this player
  // hasn't enabled their microphone yet — replaceTrack() attaches real
  // audio later without needing a fresh round of signaling.
  const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const localTrack = localStream?.getAudioTracks()[0];
  if (localTrack) transceiver.sender.replaceTrack(localTrack);

  // Exactly one side creates the data channel (deterministic by id compare,
  // same trick as the "polite peer" role) — the other receives it via
  // ondatachannel. Used to transfer clip videos and dub recordings P2P,
  // so those never touch the signaling server.
  if (!polite) {
    setupDataChannel(id, pc.createDataChannel('media', { ordered: true }));
  } else {
    pc.ondatachannel = (event) => setupDataChannel(id, event.channel);
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(id, { candidate });
  };

  pc.ontrack = (event) => {
    const [remoteStream] = event.streams;
    // A transceiver negotiated before either side has enabled their mic
    // carries no MediaStream yet — nothing to attach until a real track
    // arrives via setLocalStream() on the other end (fires ontrack again).
    if (!remoteStream) return;
    audioEl.srcObject = remoteStream;
    audioEl.play().catch(() => {});
    setupTalkingDetection(id, remoteStream);
  };

  pc.onnegotiationneeded = async () => {
    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(id, { description: pc.localDescription });
    } catch (err) {
      console.error('Falha ao negociar conexão de áudio:', err);
    } finally {
      entry.makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removePeer(id);
    }
  };

  return entry;
}

function setupDataChannel(id, dc) {
  dc.binaryType = 'arraybuffer';
  const entry = peers.get(id);
  if (!entry) return;
  entry.dc = dc;

  dc.onopen = () => onDataChannelOpenCb(id);

  dc.onmessage = (event) => {
    if (typeof event.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'file-start') {
        entry.incomingFile = { fileId: msg.fileId, meta: msg.meta, size: msg.size, received: 0, chunks: [] };
      } else if (msg.type === 'file-end' && entry.incomingFile?.fileId === msg.fileId) {
        const file = entry.incomingFile;
        entry.incomingFile = null;
        const blob = new Blob(file.chunks, { type: file.meta?.mime || 'application/octet-stream' });
        onFileReceivedCb(id, file.meta, blob);
      }
      return;
    }

    const file = entry.incomingFile;
    if (!file) return;
    file.chunks.push(event.data);
    file.received += event.data.byteLength;
    onFileProgressCb(id, file.meta, file.size ? file.received / file.size : 0);
  };
}

async function handleSignal(from, data) {
  let entry = peers.get(from) || createPeer(from);

  try {
    if (data.description) {
      const { description } = data;
      const offerCollision =
        description.type === 'offer' &&
        (entry.makingOffer || entry.pc.signalingState !== 'stable');

      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;

      await entry.pc.setRemoteDescription(description);
      await flushPendingCandidates(entry);
      if (description.type === 'offer') {
        await entry.pc.setLocalDescription();
        sendSignal(from, { description: entry.pc.localDescription });
      }
    } else if (data.candidate) {
      // ICE candidates can arrive (and be processed) before the offer/answer
      // that precedes them finishes setRemoteDescription, since socket.io
      // dispatches events without waiting on async listeners. Queue them
      // instead of failing with "remote description was null".
      if (!entry.pc.remoteDescription) {
        (entry.pendingCandidates ??= []).push(data.candidate);
        return;
      }
      try {
        await entry.pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!entry.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error('Erro de sinalização WebRTC:', err);
  }
}

async function flushPendingCandidates(entry) {
  if (!entry.pendingCandidates?.length) return;
  const queued = entry.pendingCandidates;
  entry.pendingCandidates = [];
  for (const candidate of queued) {
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('Erro ao aplicar candidato ICE pendente:', err);
    }
  }
}

function setupTalkingDetection(id, stream) {
  const entry = peers.get(id);
  if (!entry || !stream.getAudioTracks().length) return;

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  entry.analyser = analyser;
  entry.dataArray = new Uint8Array(analyser.fftSize);

  let wasTalking = false;
  const tick = () => {
    if (!peers.has(id)) return;
    analyser.getByteTimeDomainData(entry.dataArray);
    let sumSquares = 0;
    for (let i = 0; i < entry.dataArray.length; i++) {
      const normalized = (entry.dataArray[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / entry.dataArray.length);
    const talking = rms > TALK_THRESHOLD;
    if (talking !== wasTalking) {
      wasTalking = talking;
      onTalkingChangeCb(id, talking);
    }
    entry.rafId = requestAnimationFrame(tick);
  };
  tick();
}

function removePeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  if (entry.rafId) cancelAnimationFrame(entry.rafId);
  entry.dc?.close();
  entry.pc.close();
  entry.audioEl.remove();
  peers.delete(id);
  onTalkingChangeCb(id, false);
}

/** Attach (or replace) the local mic track on every active peer connection. */
export function setLocalStream(stream) {
  localStream = stream;
  const track = stream.getAudioTracks()[0];
  if (!track) return;

  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find((s) => s.track === null || s.track?.kind === 'audio');
    if (sender) sender.replaceTrack(track);
    else pc.addTrack(track, stream);
  });
}

export function getConnectedPeerCount() {
  return peers.size;
}

export function isDataChannelReady(peerId) {
  return peers.get(peerId)?.dc?.readyState === 'open';
}

const DATA_CHANNEL_TIMEOUT_MS = 15000;

// The data channel can take a moment to finish its ICE/DTLS handshake after
// the peer connection is created — give it a little time to open instead of
// failing outright if the caller (e.g. the host sharing a clip) acts fast.
function waitForDataChannel(peerId) {
  const entry = peers.get(peerId);
  if (entry?.dc?.readyState === 'open') return Promise.resolve(entry);

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + DATA_CHANNEL_TIMEOUT_MS;
    const poll = setInterval(() => {
      const current = peers.get(peerId);
      if (current?.dc?.readyState === 'open') {
        clearInterval(poll);
        resolve(current);
      } else if (!current || Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`Canal de dados com ${peerId} não está pronto.`));
      }
    }, 100);
  });
}

const BUFFER_DRAIN_TIMEOUT_MS = 30000;

// Resolves once the channel has drained enough to accept more chunks. A peer
// that stops reading (tab frozen, connection half-dead) would otherwise never
// drain and leave the sender polling forever, so give up after a while and
// let the caller move on instead of hanging the round.
function waitForBufferLow(dc) {
  if (dc.bufferedAmount < BUFFERED_AMOUNT_HIGH) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + BUFFER_DRAIN_TIMEOUT_MS;
    const poll = setInterval(() => {
      if (dc.readyState !== 'open') {
        clearInterval(poll);
        reject(new Error('Canal de dados fechou durante o envio.'));
      } else if (dc.bufferedAmount < BUFFERED_AMOUNT_HIGH) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('Envio travado — o outro jogador parou de receber.'));
      }
    }, 40);
  });
}

/**
 * Sends `blob` to one peer over its data channel, chunked with backpressure
 * so large clips don't overwhelm the channel. `meta` travels ahead as JSON
 * (e.g. { mime, kind: 'clip' | 'recording', segmentId }) and is handed back
 * unchanged to the receiver's onFileReceived callback.
 */
export async function sendFileToPeer(peerId, blob, meta = {}) {
  const entry = await waitForDataChannel(peerId);
  const dc = entry.dc;
  const fileId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const buffer = await blob.arrayBuffer();

  dc.send(JSON.stringify({ type: 'file-start', fileId, meta, size: buffer.byteLength }));
  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
    await waitForBufferLow(dc);
    dc.send(buffer.slice(offset, offset + CHUNK_SIZE));
  }
  dc.send(JSON.stringify({ type: 'file-end', fileId }));
}

/** Sends `blob` to every currently connected peer; failures are per-peer and logged, not thrown. */
export function sendFileToAllPeers(blob, meta = {}) {
  return sendFilesToAllPeers([{ blob, meta }]);
}

/**
 * Sends several files to every peer, waiting on each peer's data channel
 * ONCE up front instead of per file. Sending them one call at a time meant a
 * peer whose channel never opened cost the full DATA_CHANNEL_TIMEOUT_MS for
 * every single file — with a dub of a dozen lines that's minutes of the
 * sender sitting on "enviando…" while the rest of the room waits on them.
 * Failures stay per-peer and logged, never thrown.
 */
export function sendFilesToAllPeers(files) {
  return Promise.all(
    [...peers.keys()].map(async (id) => {
      try {
        await waitForDataChannel(id);
        for (const { blob, meta } of files) {
          await sendFileToPeer(id, blob, meta);
        }
      } catch (err) {
        console.error(`Falha ao enviar arquivo(s) para ${id}:`, err);
      }
    })
  );
}
