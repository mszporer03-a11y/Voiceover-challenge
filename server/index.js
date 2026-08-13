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

/**
 * roomId -> {
 *   players: Map(socketId -> { name }),
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

// TEMP: diagnóstico do UPLOADTHING_TOKEN sem expor o valor em si — remover
// depois de descobrir por que a validação do SDK está rejeitando o token.
app.get('/api/_debug/token', (req, res) => {
  const raw = process.env.UPLOADTHING_TOKEN || '';
  let decoded = null;
  let parseError = null;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    parseError = e.message;
  }
  res.json({
    length: raw.length,
    hasWhitespaceOrQuotes: /[\s"']/.test(raw),
    containsLiteralVarName: raw.includes('UPLOADTHING_TOKEN'),
    decodedKeys: decoded ? Object.keys(decoded) : null,
    apiKeyStartsWithSk: decoded ? String(decoded.apiKey || '').startsWith('sk_') : null,
    apiKeyLength: decoded ? String(decoded.apiKey || '').length : null,
    apiKeyPrefix: decoded ? String(decoded.apiKey || '').slice(0, 4) : null,
    appIdLength: decoded ? String(decoded.appId || '').length : null,
    regions: decoded ? decoded.regions : null,
    parseError,
  });
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
  const { hash, ext, name, durationSec } = req.body || {};
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
      durationSec: Number(durationSec) || 0,
      segments,
      characters,
    });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Falha ao enviar clipe.' });
  }
});

app.delete('/api/clips/:hash', async (req, res) => {
  if (!cloudEnabled) return res.status(503).json({ error: 'Armazenamento em nuvem não configurado.' });
  try {
    await deleteCloudClip(req.params.hash);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Falha ao remover clipe.' });
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

// Decides, per player, which clip they dub and which of its segments are
// theirs — the one place all 3 online modes actually differ.
function computeAssignments(modeId, clips, turnOrder) {
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
    turnOrder.forEach((id, i) => {
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
  room.votes = new Map();
  room.scoreboard = null;
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit('room-update', roomSnapshot(room));
}

io.on('connection', (socket) => {
  let currentRoomId = null;

  function joinRoom(roomId, playerName, callback, { asHost } = {}) {
    const room = rooms.get(roomId);
    if (!room) {
      callback?.({ error: 'Sala não encontrada.' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      callback?.({ error: 'Sala cheia (máximo de 8 jogadores).' });
      return;
    }

    socket.join(roomId);
    currentRoomId = roomId;
    room.players.set(socket.id, {
      name: playerName?.trim() || `Jogador ${room.players.size + 1}`,
    });
    if (asHost) room.hostId = socket.id;

    callback?.({ roomId, ...roomSnapshot(room) });
    broadcastRoom(roomId);
  }

  socket.on('create-room', (playerName, callback) => {
    let roomId = makeRoomId();
    while (rooms.has(roomId)) roomId = makeRoomId();
    const room = { players: new Map(), hostId: socket.id };
    resetRoomGame(room);
    rooms.set(roomId, room);
    joinRoom(roomId, playerName, callback, { asHost: true });
  });

  socket.on('join-room', ({ roomId, playerName } = {}, callback) => {
    joinRoom(String(roomId || '').toUpperCase(), playerName, callback);
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
    if (!room || room.gameState !== 'PICKING') return;
    room.clipReadyIds.add(socket.id);
    if ([...room.players.keys()].every((id) => room.clipReadyIds.has(id))) {
      room.gameState = 'DUBBING';
      room.turnOrder = shuffle([...room.players.keys()]);
      room.turnIndex = 0;
      room.assignments = computeAssignments(room.modeId, room.clips, room.turnOrder);
    }
    broadcastRoom(currentRoomId);
  });

  // Current-turn player finished recording (and has broadcast their
  // recordings to peers P2P) — advance the turn (skipping anyone with no
  // segments assigned, e.g. a coop player whose character has no lines),
  // or move to voting once everyone's had their turn.
  socket.on('turn-done', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.gameState !== 'DUBBING') return;
    if (room.turnOrder[room.turnIndex] !== socket.id) return;
    do {
      room.turnIndex += 1;
    } while (
      room.turnIndex < room.turnOrder.length &&
      room.assignments[room.turnOrder[room.turnIndex]]?.segmentIds.length === 0
    );
    if (room.turnIndex >= room.turnOrder.length) {
      room.gameState = 'VOTING';
      room.votes = new Map();
    }
    broadcastRoom(currentRoomId);
  });

  socket.on('submit-votes', (scores) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.gameState !== 'VOTING' || !scores || typeof scores !== 'object') return;
    const clean = new Map();
    Object.entries(scores).forEach(([rateeId, value]) => {
      if (room.players.has(rateeId) && rateeId !== socket.id) {
        clean.set(rateeId, Math.max(0, Math.min(10, Math.round(Number(value)) || 0)));
      }
    });
    room.votes.set(socket.id, clean);

    if ([...room.players.keys()].every((id) => room.votes.has(id))) {
      const totals = new Map([...room.players.keys()].map((id) => [id, 0]));
      room.votes.forEach((scoresGiven) => {
        scoresGiven.forEach((value, rateeId) => {
          totals.set(rateeId, (totals.get(rateeId) || 0) + value);
        });
      });
      room.scoreboard = [...totals.entries()]
        .map(([playerId, score]) => ({ playerId, name: room.players.get(playerId)?.name, score }))
        .sort((a, b) => b.score - a.score);
      room.gameState = 'RESULTS';
    }
    broadcastRoom(currentRoomId);
  });

  socket.on('play-again', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;
    resetRoomGame(room);
    broadcastRoom(currentRoomId);
  });

  // A player loaded a local clip that matches an entry in the shared
  // "biblioteca de paródias". Broadcast the clip id so every other client
  // plays its own pre-loaded copy of that same clip.
  socket.on('clip-loaded', (clipMeta) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('play-clip', { from: socket.id, ...clipMeta });
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
    if (!room) return;
    room.players.delete(socket.id);
    room.turnOrder = room.turnOrder.filter((id) => id !== socket.id);
    room.clipReadyIds?.delete(socket.id);
    room.votes?.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(currentRoomId);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }
    if (room.gameState === 'DUBBING' && room.turnIndex >= room.turnOrder.length) {
      room.gameState = 'VOTING';
      room.votes = new Map();
    }
    broadcastRoom(currentRoomId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Socket.io server rodando em http://localhost:${PORT}`);
});
