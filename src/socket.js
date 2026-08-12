import { io } from 'socket.io-client';

const SERVER_URL = 'https://voiceover-challenge-production.up.railway.app';

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
