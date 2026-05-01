/**
 * FLISYM multiplayer presence server.
 *
 * Minimal WebSocket relay:
 *   - Each connection gets a UUID.
 *   - On connect, server sends `{type:"hello", id, peers:[...]}` listing the
 *     ids of currently connected peers (excluding self).
 *   - Clients send `{type:"state", x:[x,y,z], q:[x,y,z,w]}`; server
 *     re-broadcasts as `{type:"peer", id, x, q}` to OTHER clients.
 *   - On disconnect, server broadcasts `{type:"leave", id}`.
 *
 * No matchmaking, no auth, no persistence. Local trust model.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number.parseInt(process.env.FLISYM_PORT ?? '3030', 10);

interface Peer {
  id: string;
  socket: WebSocket;
}

const peers = new Map<string, Peer>();

const wss = new WebSocketServer({ port: PORT });

function broadcast(except: string, payload: unknown): void {
  const msg = JSON.stringify(payload);
  for (const [id, p] of peers) {
    if (id === except) continue;
    if (p.socket.readyState === p.socket.OPEN) {
      p.socket.send(msg);
    }
  }
}

wss.on('connection', (socket) => {
  const id = randomUUID();
  const otherIds = [...peers.keys()];
  peers.set(id, { id, socket });

  // Greet the new client with its assigned id and the list of peers.
  socket.send(JSON.stringify({ type: 'hello', id, peers: otherIds }));

  socket.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: unknown }).type === 'state'
    ) {
      const m = msg as { type: 'state'; x?: unknown; q?: unknown };
      // Pass-through validation: x and q should be arrays of numbers.
      if (Array.isArray(m.x) && Array.isArray(m.q)) {
        broadcast(id, { type: 'peer', id, x: m.x, q: m.q });
      }
    }
  });

  const onClose = (): void => {
    if (peers.delete(id)) {
      broadcast(id, { type: 'leave', id });
    }
  };

  socket.on('close', onClose);
  socket.on('error', onClose);
});

// eslint-disable-next-line no-console
console.log(`[flisym] presence server listening on ws://localhost:${PORT}`);
