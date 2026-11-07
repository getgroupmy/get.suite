import { recordActivity } from './fileactivity.js';
// Live co-editing for Docs: several people type in the same document at once and see each other's
// cursors. Each open document is a "room" holding the shared Yjs document; browsers connect over
// a WebSocket at /ws/collab/<file id> and speak the standard y-websocket protocol (sync and
// awareness). Viewers receive changes but can't send any. The room saves the document in its usual
// JSON form a couple of seconds after each change and when the last person leaves, so everything
// else (version history, search, export) keeps working on the stored JSON.
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { indexSoon } from './search.js';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { q } from './db.js';
import { roleFor, atLeast, audienceFor } from './access.js';
import { docFromJson, jsonFromDoc, sheetDocFromJson, jsonFromSheetDoc, deckDocFromJson, jsonFromDeckDoc } from './collabdoc.js';
import { snapshotIfNewSession } from './routes/files.js';
import { sendTo } from './hub.js';

const MESSAGE_SYNC = 0, MESSAGE_AWARENESS = 1;
const SAVE_DELAY_MS = Number(process.env.COLLAB_SAVE_MS || 2000);
const FIELD = 'default'; // TipTap's Collaboration extension reads this fragment
const rooms = new Map(); // fileId -> room

if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'ydoc')) q('ALTER TABLE files ADD COLUMN ydoc BLOB').run();

// Documents are a TipTap fragment; spreadsheets a list of sheets with cell maps.
const KINDS = {
  doc: { fromJson: (j) => docFromJson(j, FIELD), toJson: (d) => jsonFromDoc(d, FIELD) },
  sheet: { fromJson: sheetDocFromJson, toJson: jsonFromSheetDoc },
  slides: { fromJson: deckDocFromJson, toJson: jsonFromDeckDoc },
};
export const CO_EDITED = Object.keys(KINDS);

function loadDoc(fileId, kind) {
  const k = KINDS[kind];
  const f = q('SELECT content, ydoc FROM files WHERE id = ?').get(fileId);
  if (f.ydoc) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(f.ydoc));
    // A JSON change made outside co-editing (restoring a version, an old client) wins: rebuild.
    // (Stored JSON and the shared form agree on everything but how empty values are written.)
    if (JSON.stringify(k.toJson(doc)) === JSON.stringify(k.toJson(k.fromJson(JSON.parse(f.content))))) return doc;
  }
  return k.fromJson(JSON.parse(f.content || '{}'));
}

function save(room) {
  if (!room.dirty) return;
  room.dirty = false;
  clearTimeout(room.timer);
  const json = JSON.stringify(KINDS[room.kind].toJson(room.doc));
  const by = room.lastEditor;
  snapshotIfNewSession(room.fileId, by);
  q('UPDATE files SET content = ?, size = ?, ydoc = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(json, Buffer.byteLength(json), Buffer.from(Y.encodeStateAsUpdate(room.doc)), Date.now(), by, room.fileId);
  if (by) recordActivity(room.fileId, by, 'edit');
  indexSoon();
  const version = q('SELECT version FROM files WHERE id = ?').get(room.fileId)?.version;
  // Drive lists refresh; open editors are already up to date.
  sendTo(audienceFor(room.fileId), { type: 'content-changed', id: room.fileId, version, by, collab: true });
}

function getRoom(fileId, kind) {
  let room = rooms.get(fileId);
  if (room) return room;
  const doc = loadDoc(fileId, kind);
  room = { fileId, kind, doc, awareness: new awarenessProtocol.Awareness(doc), conns: new Map(), dirty: false, timer: null, lastEditor: null };
  room.awareness.setLocalState(null); // the server isn't a participant
  doc.on('update', (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const ws of room.conns.keys()) if (ws !== origin) send(room, ws, msg);
    if (origin && room.conns.get(origin)) room.lastEditor = room.conns.get(origin).userId;
    room.dirty = true;
    clearTimeout(room.timer);
    room.timer = setTimeout(() => save(room), SAVE_DELAY_MS);
    room.timer.unref?.();
  });
  room.awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const owner = room.conns.get(origin);
    if (owner) { for (const id of added) owner.clients.add(id); for (const id of removed) owner.clients.delete(id); }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const ws of room.conns.keys()) send(room, ws, msg);
  });
  rooms.set(fileId, room);
  return room;
}

function send(room, ws, msg) {
  if (ws.readyState !== 1) { leave(room, ws); return; }
  ws.send(msg, (err) => { if (err) leave(room, ws); });
}

function leave(room, ws) {
  const c = room.conns.get(ws);
  if (!c) return;
  room.conns.delete(ws);
  awarenessProtocol.removeAwarenessStates(room.awareness, [...c.clients], null);
  if (!room.conns.size) {
    save(room);
    room.doc.destroy();
    rooms.delete(room.fileId);
  }
  try { ws.close(); } catch {}
}

/** Everyone editing this document starts again from what's stored (after a version is restored). */
export function resetRoom(fileId) {
  const room = rooms.get(fileId);
  if (!room) { q('UPDATE files SET ydoc = NULL WHERE id = ?').run(fileId); return; }
  clearTimeout(room.timer);
  room.dirty = false;
  rooms.delete(fileId);
  q('UPDATE files SET ydoc = NULL WHERE id = ?').run(fileId);
  for (const ws of room.conns.keys()) { try { ws.close(4000, 'reload'); } catch {} }
  room.doc.destroy();
}
export const editorsOf = (fileId) => [...(rooms.get(fileId)?.conns.values() || [])].map((c) => c.userId);
export function saveAll() { for (const room of rooms.values()) save(room); }
/** Write one file's open editing session to the database now (if anything changed). */
export function saveNow(fileId) { const room = rooms.get(fileId); if (room) save(room); }

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

/** Called by the hub for /ws/collab/<id> upgrades, with the signed-in user. */
export function handleCollabUpgrade(req, socket, head, user) {
  const fileId = decodeURIComponent((req.url.split('?')[0].split('/')[3] || ''));
  const f = fileId && q('SELECT id, kind, trashed FROM files WHERE id = ?').get(fileId);
  const role = f && roleFor(f.id, user.id);
  if (!f || !KINDS[f.kind] || f.trashed || !role) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getRoom(f.id, f.kind);
    room.conns.set(ws, { userId: user.id, canEdit: atLeast(role, 'editor'), clients: new Set() });
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data) => {
      try {
        const c = room.conns.get(ws);
        if (!c) return;
        const dec = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(dec);
        if (type === MESSAGE_SYNC) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          // Viewers may ask for the document (step 1) but their changes (step 2, updates) are ignored.
          const sub = decoding.peekVarUint(dec);
          if (sub !== syncProtocol.messageYjsSyncStep1 && !c.canEdit) return;
          syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
          if (encoding.length(enc) > 1) send(room, ws, encoding.toUint8Array(enc));
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
        }
      } catch (e) { console.error('[collab]', e.message); }
    });
    ws.on('close', () => leave(room, ws));
    // Start the conversation: our state vector (step 1), and who else is here.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    send(room, ws, encoding.toUint8Array(enc));
    const states = room.awareness.getStates();
    if (states.size) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      send(room, ws, encoding.toUint8Array(a));
    }
  });
}
