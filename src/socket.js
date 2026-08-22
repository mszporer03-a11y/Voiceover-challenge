import { io } from 'socket.io-client';

// Production talks to the deployed Railway server; `npm run dev` talks to a
// local one (that's what `npm run dev:all` starts, and what the connection
// error in network.js already tells the player to run) so server changes can
// actually be exercised without editing this file and risking committing it.
export const SERVER_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : 'https://voiceover-challenge-production.up.railway.app';

const PLAYER_TOKEN_KEY = 'vc-player-token';

// Stable per-device identity that survives a socket.id change (socket.io
// hands out a new socket.id on every reconnect). Sent with create-room /
// join-room / rejoin-room so the server can recognize "this is the same
// player, just reconnecting" instead of treating a network hiccup as a
// brand-new player joining.
export function getPlayerToken() {
  let token = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(PLAYER_TOKEN_KEY, token);
  }
  return token;
}

export const socket = io(SERVER_URL, { autoConnect: false });

export function connectSocket() {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }
    socket.connect();
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}
