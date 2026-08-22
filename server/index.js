import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { cloudEnabled, listClips, uploadAndRegisterClip, deleteClip as deleteCloudClip } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 8;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// Grace period between a socket dropping and the player actually being
// removed from the room — long enough to survive a brief WebSocket hiccup
// (e.g. reconnecting mid clip-transfer) via rejoin-room, without leaving a
// truly-gone player blocking "everyone ready/done" checks for too long.
const DISCONNECT_GRACE_MS = 12000;

/**
 * roomId -> {
 *   players: Map(socketId -> { name, token }),
 *   pendingDisconnects: Map(socketId -> Timeout),
 *   hostId: string,
 *   gameState: 'LOBBY' | 'PICKING' | 'DUBBING' | 'VOTING' | 'RESULTS',
 *   modeId: 'same-clip' | 'coop' | 'different-clips',
 *   clips: Array<{ name, durationSec, segments, characters }>,
 *   clipReadyIds: Set<string>,   // players who confirmed they received all clips P2P
 *   turnOrder: string[],
 *   turnIndex: number,
 *   assignments: { [playerId]: { clipIndex, segmentIds: string[] } },
 *   votes: Map(raterId -> Map(rateeId -> score)),
 *   scoreboard: Array<{ playerId, name, score }> | null,
 * }
 */
const rooms = new Map();

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, cloud: cloudEnabled });
});

// Galeria compartilhada via UploadThing (free, sem cartão de crédito
// exigido). O vídeo sobe pro nosso servidor (multipart) e é repassado pro
// UploadThing dali; metadados (nome, falas, personagens) ficam num índice
// local em disco, deduplicado por hash de conteúdo do próprio arquivo.
app.get('/api/clips', async (req, res) => {
  if (!cloudEnabled) return res.status(503).json({ error: 'Armazenamento em nuvem não configurado.' });
  try {
    res.json({ clips: await listClips() });
  } catch {
    res.status(500).json({ error: 'Falha ao listar clipes da nuvem.' });
  }
});

app.post('/api/clips', upload.single('video'), async (req, res) => {
  if (!cloudEnabled) return res.status(503).json({ error: 'Armazenamento em nuvem não configurado.' });
  const { hash, ext, name, durationSec, thumbnailDataUrl } = req.body || {};
  let segments, characters;
  try {
    segments = JSON.parse(req.body?.segments || '[]');
    characters = JSON.parse(req.body?.characters || '[]');
  } catch {
    return res.status(400).json({ error: 'segments/characters inválidos.' });
  }
  if (!hash || !ext || !req.file || !Array.isArray(segments)) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }
  try {
    const entry = await uploadAndRegisterClip({
      hash,
      ext,
      buffer: req.file.buffer,
      contentType: req.file.mimetype || 'video/webm',
      name: name || 'Clipe sem nome',
      thumbnailDataUrl: thumbnailDataUrl || null,
      durationSec: Number(durationSec) || 0,
      segments,
      characters,
    });
    res.json(entry);
  } catch (err) {
    console.error('Falha ao enviar clipe:', err);
    res.status(500).json({ error: err.message || 'Falha ao enviar clipe.' });
  }
});

app.delete('/api/clips/:hash', async (req, res) => {
  if (!cloudEnabled) return res.status(503).json({ error: 'Armazenamento em nuvem não configurado.' });
  try {
    await deleteCloudClip(req.params.hash);
    res.json({ ok: true });
  } catch (err) {
    console.error('Falha ao remover clipe:', err);
    res.status(500).json({ error: err.message || 'Falha ao remover clipe.' });
  }
});

// Serve the built game client (npm run build -> dist/), so visiting the
// server URL directly loads the actual game instead of "Cannot GET /".
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get(/^(?!\/health|\/socket\.io|\/api).*/, (req, res, next) => {
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next();
  });
});

function makeRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 'same-clip' and 'different-clips' let every player record at once (gated
// by a doneIds readiness set); 'coop' still goes one at a time via
// turnOrder/turnIndex, since it's meant to feel like a shared performance.
function isSimultaneousMode(modeId) {
  return modeId === 'same-clip' || modeId === 'different-clips';
}

// Decides, per player, which clip they dub and which of its segments are
// theirs — the one place all 3 online modes actually differ.
// `playerOrder` is the room's player list order (what the host saw while
// picking); `turnOrder` is the shuffled speaking order.
function computeAssignments(modeId, clips, turnOrder, playerOrder) {
  const assignments = {};

  if (modeId === 'coop') {
    const characters = shuffle(clips[0]?.characters || []);
    const charsByPlayer = new Map(turnOrder.map((id) => [id, []]));
    characters.forEach((char, i) => charsByPlayer.get(turnOrder[i % turnOrder.length]).push(char));
    turnOrder.forEach((id) => {
      const myChars = new Set(charsByPlayer.get(id));
      assignments[id] = {
        clipIndex: 0,
        segmentIds: clips[0].segments.filter((s) => myChars.has(s.character)).map((s) => s.id),
      };
    });
    return assignments;
  }

  if (modeId === 'different-clips') {
    // The host picked one clip per player walking the room's player list in
    // order ("Clipe de Fulano — 2/3"), so clip i belongs to player i of that
    // same list. Indexing by the *shuffled* turnOrder instead would hand
    // players someone else's clip.
    playerOrder.forEach((id, i) => {
      const clipIndex = i % clips.length;
      assignments[id] = { clipIndex, segmentIds: clips[clipIndex].segments.map((s) => s.id) };
    });
    return assignments;
  }

  // same-clip: everyone dubs every segment of the one shared clip.
  turnOrder.forEach((id) => {
    assignments[id] = { clipIndex: 0, segmentIds: clips[0].segments.map((s) => s.id) };
  });
  return assignments;
}

function roomSnapshot(room) {
  return {
    gameState: room.gameState,
    hostId: room.hostId,
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name })),
    modeId: room.modeId,
    clips: room.clips,
    clipReadyIds: [...room.clipReadyIds],
    turnOrder: room.turnOrder,
    turnIndex: room.turnIndex,
    currentPlayerId: room.turnOrder[room.turnIndex] ?? null,
    assignments: room.assignments,
    doneIds: [...room.doneIds],
    scoreboard: room.scoreboard,
  };
}

function resetRoomGame(room) {
  room.gameState = 'LOBBY';
  room.modeId = 'same-clip';
  room.clips = [];
  room.clipReadyIds = new Set();
  room.turnOrder = [];
  room.turnIndex = 0;
  room.assignments = {};
  room.doneIds = new Set();
  room.votes = new Map();
  room.scoreboard = null;
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit('room-update', roomSnapshot(room));
}

// ---------- Round state transitions ----------
// Each gate the room waits behind ("everyone got the clip", "everyone
// recorded", "everyone voted") lives in one function, so the event handlers
// and the player-left path can't drift apart on what counts as ready.

function startDubbing(room) {
  room.gameState = 'DUBBING';
  room.turnOrder = shuffle([...room.players.keys()]);
  room.turnIndex = 0;
  room.assignments = computeAssignments(room.modeId, room.clips, room.turnOrder, [...room.players.keys()]);
  room.doneIds = new Set();
}

function startVoting(room) {
  room.gameState = 'VOTING';
  room.votes = new Map();
}

function tallyVotes(room) {
  const totals = new Map([...room.players.keys()].map((id) => [id, 0]));
  room.votes.forEach((scoresGiven) => {
    scoresGiven.forEach((value, rateeId) => {
      if (totals.has(rateeId)) totals.set(rateeId, totals.get(rateeId) + value);
    });
  });
  room.scoreboard = [...totals.entries()]
    .map(([playerId, score]) => ({ playerId, name: room.players.get(playerId)?.name, score }))
    .sort((a, b) => b.score - a.score);
  room.gameState = 'RESULTS';
}

function everyoneHasClips(room) {
  return [...room.players.keys()].every((id) => room.clipReadyIds.has(id));
}

function everyoneRecorded(room) {
  if (isSimultaneousMode(room.modeId)) {
    return [...room.players.keys()].every(
      (id) => room.doneIds.has(id) || room.assignments[id]?.segmentIds.length === 0
    );
  }
  return room.turnIndex >= room.turnOrder.length;
}

function everyoneVoted(room) {
  return [...room.players.keys()].every((id) => room.votes.has(id));
}

// Re-checks whatever gate the room is currently sitting behind. Called after
// a player leaves: without it the room keeps waiting on someone who is no
// longer here (a clip they'll never confirm, a take they'll never record, a
// vote they'll never cast) and the round hangs for everyone else.
function advanceRoomIfReady(room) {
  if (!room.players.size) return;
  if (room.gameState === 'PICKING' && everyoneHasClips(room)) startDubbing(room);
  else if (room.gameState === 'DUBBING' && everyoneRecorded(room)) startVoting(room);
  else if (room.gameState === 'VOTING' && everyoneVoted(room)) tallyVotes(room);
}

io.on('connection', (socket) => {
  let currentRoomId = null;

  function joinRoom(roomId, playerName, playerToken, callback, { asHost } = {}) {
    const room = rooms.get(roomId);
    if (!room) {
      callback?.({ error: 'Sala não encontrada.' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      callback?.({ error: 'Sala cheia (máximo de 8 jogadores).' });
      return;
    }
    // A player who shows up after the round started has no clip, no
    // assignment and no vote — and every "waiting on everyone" gate would
    // then wait on them forever, hanging the round for the whole room.
    // They wait for the next round instead. (Reconnecting players come back
    // through rejoin-room, which keeps their existing seat.)
    if (!asHost && room.gameState !== 'LOBBY') {
      callback?.({ error: 'A partida já começou — espere a rodada atual terminar.' });
      return;
    }

    socket.join(roomId);
    currentRoomId = roomId;
    room.players.set(socket.id, {
      name: playerName?.trim() || `Jogador ${room.players.size + 1}`,
      token: playerToken || null,
    });
    if (asHost) room.hostId = socket.id;

    callback?.({ roomId, ...roomSnapshot(room) });
    broadcastRoom(roomId);
  }

  // `payload` used to be just the player's name; a browser still running the
  // previously deployed bundle keeps sending that, so accept both shapes.
  socket.on('create-room', (payload, callback) => {
    const { playerName, playerToken } = typeof payload === 'string' ? { playerName: payload } : payload || {};
    let roomId = makeRoomId();
    while (rooms.has(roomId)) roomId = makeRoomId();
    const room = { players: new Map(), pendingDisconnects: new Map(), hostId: socket.id };
    resetRoomGame(room);
    rooms.set(roomId, room);
    joinRoom(roomId, playerName, playerToken, callback, { asHost: true });
  });

  socket.on('join-room', ({ roomId, playerName, playerToken } = {}, callback) => {
    joinRoom(String(roomId || '').toUpperCase(), playerName, playerToken, callback);
  });

  // A client whose socket dropped (network hiccup, tab backgrounded, etc.)
  // and reconnected with a brand-new socket.id calls this instead of
  // join-room, so it re-takes its old seat instead of showing up as a new
  // player — see the 'disconnect' handler below for the other half of this.
  socket.on('rejoin-room', ({ roomId, playerToken } = {}, callback) => {
    const normalizedRoomId = String(roomId || '').toUpperCase();
    const room = rooms.get(normalizedRoomId);
    if (!room) {
      callback?.({ error: 'Sala não encontrada.' });
      return;
    }

    let oldSocketId = null;
    for (const id of room.pendingDisconnects.keys()) {
      if (playerToken && room.players.get(id)?.token === playerToken) {
        oldSocketId = id;
        break;
      }
    }
    if (!oldSocketId) {
      callback?.({ error: 'Não foi possível reconectar à sala (tempo esgotado).' });
      return;
    }

    clearTimeout(room.pendingDisconnects.get(oldSocketId));
    room.pendingDisconnects.delete(oldSocketId);

    // Re-key every piece of per-player state from the old socket.id to the
    // new one so the reconnecting client resumes exactly where it left off.
    // The player list is rebuilt in place rather than delete+set, because
    // its order is what the host saw while picking a clip per player in
    // 'different-clips' — moving them to the end would shift the clips.
    const rekeyed = new Map();
    room.players.forEach((data, id) => rekeyed.set(id === oldSocketId ? socket.id : id, data));
    room.players = rekeyed;

    if (room.hostId === oldSocketId) room.hostId = socket.id;
    room.turnOrder = room.turnOrder.map((id) => (id === oldSocketId ? socket.id : id));
    if (room.clipReadyIds.delete(oldSocketId)) room.clipReadyIds.add(socket.id);
    if (room.doneIds.delete(oldSocketId)) room.doneIds.add(socket.id);
    if (room.assignments[oldSocketId]) {
      room.assignments[socket.id] = room.assignments[oldSocketId];
      delete room.assignments[oldSocketId];
    }
    if (room.votes.has(oldSocketId)) {
      room.votes.set(socket.id, room.votes.get(oldSocketId));
      room.votes.delete(oldSocketId);
    }
    room.votes.forEach((scoresGiven) => {
      if (scoresGiven.has(oldSocketId)) {
        scoresGiven.set(socket.id, scoresGiven.get(oldSocketId));
        scoresGiven.delete(oldSocketId);
      }
    });
    room.scoreboard?.forEach((entry) => {
      if (entry.playerId === oldSocketId) entry.playerId = socket.id;
    });

    socket.join(normalizedRoomId);
    currentRoomId = normalizedRoomId;

    callback?.({ roomId: normalizedRoomId, ...roomSnapshot(room) });
    broadcastRoom(normalizedRoomId);
  });

  // Host announces which clip(s) the room will dub, and in what mode. Only
  // metadata travels through the server — the actual video(s) are sent
  // peer-to-peer over WebRTC data channels, so the server never stores or
  // sees user media.
  socket.on('select-clips', ({ modeId, clips } = {}) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;
    if (!Array.isArray(clips) || !clips.length || !clips.every((c) => c?.segments?.length)) return;
    if (!['same-clip', 'coop', 'different-clips'].includes(modeId)) return;
    if (modeId !== 'different-clips' && clips.length !== 1) return;

    room.gameState = 'PICKING';
    room.modeId = modeId;
    room.clips = clips.map((c) => ({
      name: c.name || 'Clipe sem nome',
      durationSec: c.durationSec || 0,
      segments: c.segments,
      characters: c.characters || [],
      // Se o clipe já foi compartilhado na galeria da nuvem, os outros
      // jogadores baixam direto do R2 em vez de receber via WebRTC P2P.
      cloudUrl: c.cloudUrl || null,
    }));
    room.clipReadyIds = new Set([room.hostId]);
    broadcastRoom(currentRoomId);
  });

  // A non-host player confirms they received & decoded every clip P2P.
  socket.on('clip-ready', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.gameState !== 'PICKING' || !room.players.has(socket.id)) return;
    room.clipReadyIds.add(socket.id);
    if (everyoneHasClips(room)) startDubbing(room);
    broadcastRoom(currentRoomId);
  });

  // A player finished recording (and has broadcast their recordings to
  // peers P2P). In 'same-clip'/'different-clips' everyone records at once,
  // so this just marks that player done and moves to voting once every
  // player who actually has lines is done. 'coop' keeps the old one-at-a-
  // time turn order instead.
  socket.on('turn-done', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.gameState !== 'DUBBING') return;

    if (isSimultaneousMode(room.modeId)) {
      if (!room.players.has(socket.id)) return;
      room.doneIds.add(socket.id);
      if (everyoneRecorded(room)) startVoting(room);
      broadcastRoom(currentRoomId);
      return;
    }

    if (room.turnOrder[room.turnIndex] !== socket.id) return;
    do {
      room.turnIndex += 1;
    } while (
      room.turnIndex < room.turnOrder.length &&
      room.assignments[room.turnOrder[room.turnIndex]]?.segmentIds.length === 0
    );
    if (everyoneRecorded(room)) startVoting(room);
    broadcastRoom(currentRoomId);
  });

  socket.on('submit-votes', (scores) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.gameState !== 'VOTING' || !room.players.has(socket.id)) return;
    if (!scores || typeof scores !== 'object') return;
    const clean = new Map();
    Object.entries(scores).forEach(([rateeId, value]) => {
      if (room.players.has(rateeId) && rateeId !== socket.id) {
        clean.set(rateeId, Math.max(0, Math.min(10, Math.round(Number(value)) || 0)));
      }
    });
    room.votes.set(socket.id, clean);

    if (everyoneVoted(room)) tallyVotes(room);
    broadcastRoom(currentRoomId);
  });

  socket.on('play-again', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;
    resetRoomGame(room);
    broadcastRoom(currentRoomId);
  });

  // Opaque WebRTC signaling relay (SDP offers/answers + ICE candidates).
  // The server never inspects the payload, it just forwards it to the
  // intended peer so two clients in the same room can negotiate a direct
  // audio/data connection with each other.
  socket.on('webrtc-signal', ({ to, data } = {}) => {
    if (!to || !currentRoomId) return;
    io.to(to).emit('webrtc-signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.players.has(socket.id)) return;

    // Don't drop the player immediately — give them a window to reconnect
    // and call rejoin-room (see above) before treating this as a real exit.
    // Otherwise a brief network hiccup right as the host picks a clip reads
    // to everyone else as that player getting kicked from the room.
    const roomId = currentRoomId;
    const disconnectedSocketId = socket.id;
    const timeout = setTimeout(() => {
      finalizeDisconnect(roomId, disconnectedSocketId);
    }, DISCONNECT_GRACE_MS);
    room.pendingDisconnects.set(socket.id, timeout);
  });
});

function finalizeDisconnect(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.pendingDisconnects.delete(socketId);
  if (!room.players.delete(socketId)) return;

  // Dropping someone earlier in the turn order shifts everyone after them
  // down a slot — without adjusting turnIndex the room would skip the
  // player who is actually up next (or run off the end of the list).
  const turnPos = room.turnOrder.indexOf(socketId);
  room.turnOrder = room.turnOrder.filter((id) => id !== socketId);
  if (turnPos !== -1 && turnPos < room.turnIndex) room.turnIndex -= 1;

  room.clipReadyIds?.delete(socketId);
  room.doneIds?.delete(socketId);
  room.votes?.delete(socketId);
  room.votes?.forEach((scoresGiven) => scoresGiven.delete(socketId));
  delete room.assignments[socketId];

  if (room.players.size === 0) {
    rooms.delete(roomId);
    return;
  }
  if (room.hostId === socketId) {
    room.hostId = room.players.keys().next().value;
  }
  // In coop the leaver may have been the player everyone was waiting on —
  // skip ahead past anyone left with no lines so the turn lands on someone
  // who can actually record.
  while (
    room.gameState === 'DUBBING' &&
    !isSimultaneousMode(room.modeId) &&
    room.turnIndex < room.turnOrder.length &&
    room.assignments[room.turnOrder[room.turnIndex]]?.segmentIds.length === 0
  ) {
    room.turnIndex += 1;
  }

  advanceRoomIfReady(room);
  broadcastRoom(roomId);
}

httpServer.listen(PORT, () => {
  console.log(`Socket.io server rodando em http://localhost:${PORT}`);
});
