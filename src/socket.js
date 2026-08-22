import { io } from 'socket.io-client';

export const SERVER_URL = 'https://voiceover-challenge-production.up.railway.app';

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
