import { WebSocketServer } from 'ws';
import { userFromToken, tokenFromReq } from './auth.js';

/** Live push channel: userId -> Set<WebSocket>. */
const clients = new Map();

export function attachHub(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    const user = userFromToken(tokenFromReq(req));
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = clients.get(user.id);
      if (!set) clients.set(user.id, (set = new Set()));
      set.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => { set.delete(ws); if (!set.size) clients.delete(user.id); });
      ws.on('message', () => {}); // client -> server traffic goes through the REST API
    });
  });
  const ping = setInterval(() => {
    for (const set of clients.values()) for (const ws of set) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30e3);
  ping.unref();
  return wss;
}

export function sendTo(userIds, payload) {
  const data = JSON.stringify(payload);
  for (const id of userIds) for (const ws of clients.get(id) ?? []) if (ws.readyState === 1) ws.send(data);
}

export function broadcast(payload) {
  sendTo(clients.keys(), payload);
}

export function onlineUserIds() {
  return [...clients.keys()];
}
