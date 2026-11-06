import { WebSocketServer } from 'ws';
import { userFromToken, tokenFromReq } from './auth.js';
import { handleCollabUpgrade } from './collab.js';

/** Live push channel: userId -> Set<WebSocket>. */
const clients = new Map();
const presence = new Set();
/** Called with (userId, true) when a user's first live connection opens, (userId, false) when the last closes. */
export function onPresence(fn) { presence.add(fn); return () => presence.delete(fn); }
const announce = (userId, online) => { for (const fn of presence) { try { fn(userId, online); } catch (e) { console.error(e); } } };

export function attachHub(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    const user = userFromToken(tokenFromReq(req));
    if (!user || user.needs_two_factor) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    if (req.url.startsWith('/ws/collab/')) return handleCollabUpgrade(req, socket, head, user); // co-editing a document
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = clients.get(user.id);
      const first = !set;
      if (!set) clients.set(user.id, (set = new Set()));
      set.add(ws);
      if (first) announce(user.id, true);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => {
        set.delete(ws);
        if (!set.size && clients.get(user.id) === set) { clients.delete(user.id); announce(user.id, false); }
      });
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
