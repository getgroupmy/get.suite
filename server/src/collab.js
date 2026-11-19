import crypto from 'node:crypto';
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
import { trackSession } from './livesessions.js';
import { roleFor, atLeast, audienceFor } from './access.js';
import { docFromJson, jsonFromDoc, sheetDocFromJson, jsonFromSheetDoc, deckDocFromJson, jsonFromDeckDoc, applyDeckJson, applySheetJson, appendToYDoc, appendToJson, markQuoteInYDoc, replaceInYDoc, replaceInJson, markQuoteInJson, suggestionsInJson, suggestionsInYDoc, resolveSuggestionsInJson, resolveSuggestionsInYDoc, onlyOwnSuggestions } from './collabdoc.js';
import { snapshotIfNewSession } from './routes/files.js';
import { sendTo } from './hub.js';
import { notify } from './notifications.js';
import { brokenProtections, mayEdit } from './sheetprotect.js';

const MESSAGE_SYNC = 0, MESSAGE_AWARENESS = 1;
const SAVE_DELAY_MS = Number(process.env.COLLAB_SAVE_MS || 2000);
const FIELD = 'default'; // TipTap's Collaboration extension reads this fragment
const rooms = new Map(); // fileId -> room

if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'ydoc')) q('ALTER TABLE files ADD COLUMN ydoc BLOB').run();
// A fingerprint of the JSON the shared form was saved with: while the JSON is unchanged, the shared form is used as it
// is, without rebuilding the document a second time to compare (seconds for a sheet of hundreds of thousands of cells).
if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'ydoc_of')) q('ALTER TABLE files ADD COLUMN ydoc_of TEXT').run();
export const fingerprint = (json) => crypto.createHash('sha256').update(json || '').digest('base64url');

// Documents are a TipTap fragment; spreadsheets a list of sheets with cell maps.
const KINDS = {
  doc: { fromJson: (j) => docFromJson(j, FIELD), toJson: (d) => jsonFromDoc(d, FIELD) },
  sheet: { fromJson: sheetDocFromJson, toJson: jsonFromSheetDoc },
  slides: { fromJson: deckDocFromJson, toJson: jsonFromDeckDoc },
};
export const CO_EDITED = Object.keys(KINDS);

// Each shared form has a generation, set when it's built (from the JSON): a browser that kept a copy (offline) says which
// generation it has when it connects, and is turned away (4001) if the document was rebuilt meanwhile, so an old copy is
// never merged into a new one (which would repeat the text).
export const genOf = (doc) => doc.getMap('meta').get('gen') || null;
function stamp(doc) { if (!genOf(doc)) doc.getMap('meta').set('gen', crypto.randomBytes(9).toString('base64url')); return doc; }

export function loadDoc(fileId, kind) {
  const k = KINDS[kind];
  const f = q('SELECT content, ydoc, ydoc_of FROM files WHERE id = ?').get(fileId);
  if (f.ydoc) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(f.ydoc));
    const keep = () => { if (!genOf(doc)) { stamp(doc); q('UPDATE files SET ydoc = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), fileId); } return doc; };
    if (f.ydoc_of && f.ydoc_of === fingerprint(f.content)) return keep(); // the JSON is what it was saved with
    // A JSON change made outside co-editing (restoring a version, an old client) wins: rebuild.
    // (Stored JSON and the shared form agree on everything but how empty values are written.)
    if (JSON.stringify(k.toJson(doc)) === JSON.stringify(k.toJson(k.fromJson(JSON.parse(f.content))))) {
      q('UPDATE files SET ydoc_of = ? WHERE id = ?').run(fingerprint(f.content), fileId);
      return keep();
    }
  }
  // Built from the JSON: kept with its fingerprint, so the next opening skips the build (not an edit: the version stays).
  const doc = stamp(k.fromJson(JSON.parse(f.content || '{}')));
  q('UPDATE files SET ydoc = ?, ydoc_of = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), fingerprint(f.content), fileId);
  return doc;
}

// Suggested edits by someone other than the owner: the owner is told (as for a new comment on their file), once per
// person and document every 10 minutes however many they make.
const SUGGEST_TELL_MS = 10 * 60e3;
const toldOfSuggestions = new Map(); // `${fileId}:${userId}` → when
export const describeSuggestion = (x) => { const qq = (t) => `“${t.length > 60 ? `${t.slice(0, 60)}…` : t}”`; return x.inserted && x.deleted ? `Replace ${qq(x.deleted)} with ${qq(x.inserted)}` : x.inserted ? `Add ${qq(x.inserted)}` : `Delete ${qq(x.deleted)}`; };
export function tellOfSuggestions(fileId, before, after) {
  const known = new Set((before || []).map((x) => x.id));
  const fresh = (after || []).filter((x) => !known.has(x.id) && x.by);
  if (!fresh.length) return;
  const f = q('SELECT id, name, owner_id FROM files WHERE id = ?').get(fileId);
  if (!f?.owner_id) return;
  for (const by of new Set(fresh.map((x) => x.by))) {
    if (by === f.owner_id) continue;
    const key = `${fileId}:${by}`;
    if (Date.now() - (toldOfSuggestions.get(key) || 0) < SUGGEST_TELL_MS) continue;
    toldOfSuggestions.set(key, Date.now());
    const theirs = fresh.filter((x) => x.by === by), name = theirs[0].name || q('SELECT name FROM users WHERE id = ?').get(by)?.name || 'Someone';
    notify([f.owner_id], { kind: 'reply', title: `${name} suggested edits in “${f.name}”`, body: theirs.slice(0, 3).map(describeSuggestion).join(' · '), link: `/docs/${f.id}`, actor: name });
  }
}

function save(room) {
  if (!room.dirty) return;
  room.dirty = false;
  clearTimeout(room.timer);
  const json = JSON.stringify(KINDS[room.kind].toJson(room.doc));
  const by = room.lastEditor;
  if (room.kind === 'doc') { const now = suggestionsInJson(JSON.parse(json)); tellOfSuggestions(room.fileId, room.suggestions, now); room.suggestions = now; }
  snapshotIfNewSession(room.fileId, by);
  q('UPDATE files SET content = ?, size = ?, ydoc = ?, ydoc_of = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(json, Buffer.byteLength(json), Buffer.from(Y.encodeStateAsUpdate(room.doc)), fingerprint(json), Date.now(), by, room.fileId);
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
  if (kind === 'doc') room.suggestions = suggestionsInYDoc(doc, FIELD); // (those already there aren't news)
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

/** Would this sync message (step 2 or an update) change a protected range `c` may not edit? */
function breaksProtection(room, c, data) {
  const before = jsonFromSheetDoc(room.doc);
  const guarded = before.sheets.some((s) => (s.protected || []).some((p) => !p.warn && !mayEdit(p, c.userId, c.ownerId)));
  if (!guarded) return false;
  const dec = decoding.createDecoder(new Uint8Array(data));
  decoding.readVarUint(dec); // message type
  decoding.readVarUint(dec); // sync step 2 or update
  const update = decoding.readVarUint8Array(dec);
  const trial = new Y.Doc();
  Y.applyUpdate(trial, Y.encodeStateAsUpdate(room.doc));
  Y.applyUpdate(trial, update);
  const after = jsonFromSheetDoc(trial);
  trial.destroy();
  return brokenProtections(before, after, c.userId, c.ownerId).length > 0;
}

/** A commenter's sync message (step 2 or an update): true if it only adds or changes their own suggestions. */
function suggestsOnly(room, c, data) {
  const dec = decoding.createDecoder(new Uint8Array(data));
  decoding.readVarUint(dec); // message type
  decoding.readVarUint(dec); // sync step 2 or update
  const update = decoding.readVarUint8Array(dec);
  const trial = new Y.Doc();
  Y.applyUpdate(trial, Y.encodeStateAsUpdate(room.doc));
  Y.applyUpdate(trial, update);
  const ok = onlyOwnSuggestions(jsonFromDoc(room.doc, FIELD), jsonFromDoc(trial, FIELD), c.userId);
  trial.destroy();
  if (!ok) console.warn('[collab] ignored a change by a commenter that was more than suggestions', c.userId);
  return ok;
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

// What each open connection may do is decided when it opens. When that changes (unshared, made a viewer or
// an editor, the file locked, unlocked or trashed, a group or folder share changed), the connection closes
// with 4000, and the editor opens again with what the person may do now (or the "no access" page).
const rightsOf = (room, userId) => {
  const f = q('SELECT trashed, locked_at FROM files WHERE id = ?').get(room.fileId);
  const role = f && !f.trashed ? roleFor(room.fileId, userId) : null;
  return { role, canEdit: !!role && atLeast(role, 'editor') && !f.locked_at, canSuggest: !!role && room.kind === 'doc' && role === 'commenter' && !f.locked_at };
};
/** Close the connections whose rights have changed. Returns how many. */
export function recheckAccess() {
  let n = 0;
  for (const room of [...rooms.values()]) {
    for (const [ws, c] of [...room.conns]) {
      const cur = rightsOf(room, c.userId);
      if (cur.role && cur.canEdit === c.canEdit && cur.canSuggest === c.canSuggest) continue;
      n++;
      room.conns.get(ws).canEdit = false; // nothing more from it, whatever arrives before it's closed
      room.conns.get(ws).canSuggest = false;
      try { ws.close(4000, cur.role ? 'access changed' : 'no access'); } catch { /* gone */ }
    }
  }
  return n;
}
let recheckTimer = null;
export function recheckSoon() { if (!recheckTimer) recheckTimer = setTimeout(() => { recheckTimer = null; recheckAccess(); }, 0); }
setInterval(recheckAccess, 5000).unref();

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
/**
 * Change a spreadsheet from the server (form responses arriving): `fn(json)` gives its new content.
 * Open in someone's browser, the change reaches them live; otherwise it's saved straight away.
 */
export function changeSheet(fileId, fn, by = null) {
  const room = rooms.get(fileId);
  if (room) {
    const next = fn(jsonFromSheetDoc(room.doc));
    if (!next) return;
    applySheetJson(room.doc, next); // sent to everyone in the room by its update handler
    room.lastEditor = by || room.lastEditor;
    return;
  }
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'sheet' AND trashed = 0").get(fileId);
  if (!f) return;
  const next = fn(JSON.parse(f.content || '{}'));
  if (!next) return;
  const json = JSON.stringify(next);
  q('UPDATE files SET content = ?, size = ?, ydoc = NULL, version = version + 1, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?')
    .run(json, Buffer.byteLength(json), Date.now(), by, fileId);
  indexSoon();
  const version = q('SELECT version FROM files WHERE id = ?').get(fileId)?.version;
  sendTo(audienceFor(fileId), { type: 'content-changed', id: fileId, version, by });
}
/** The same for a presentation: `fn` gets its content and gives the changed one (or nothing to leave it). */
export function changeDeck(fileId, fn, by = null) {
  const room = rooms.get(fileId);
  if (room) {
    const next = fn(jsonFromDeckDoc(room.doc));
    if (!next) return;
    applyDeckJson(room.doc, next); // sent to everyone in the room by its update handler
    room.lastEditor = by || room.lastEditor;
    return;
  }
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'slides' AND trashed = 0").get(fileId);
  if (!f) return;
  const next = fn(JSON.parse(f.content || '{}'));
  if (!next) return;
  const json = JSON.stringify(next);
  q('UPDATE files SET content = ?, size = ?, ydoc = NULL, version = version + 1, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?')
    .run(json, Buffer.byteLength(json), Date.now(), by, fileId);
  indexSoon();
  const version = q('SELECT version FROM files WHERE id = ?').get(fileId)?.version;
  sendTo(audienceFor(fileId), { type: 'content-changed', id: fileId, version, by });
}
/**
 * Add blocks to the end of a document (or one of its tabs) from the server (an assistant adding notes).
 * Open in someone's browser, they appear live; otherwise it's saved straight away. Returns the tab's title or null.
 */
export function appendToDocument(fileId, nodes, tab = null, by = null) {
  const room = rooms.get(fileId);
  if (room) {
    const title = appendToYDoc(room.doc, nodes, tab, FIELD); // sent to everyone in the room by its update handler
    room.lastEditor = by || room.lastEditor;
    return title;
  }
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'doc' AND trashed = 0").get(fileId);
  const out = appendToJson(JSON.parse(f.content || '{}'), nodes, tab);
  const json = JSON.stringify(out.json);
  q('UPDATE files SET content = ?, size = ?, ydoc = NULL, version = version + 1, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?')
    .run(json, Buffer.byteLength(json), Date.now(), by, fileId);
  indexSoon();
  const version = q('SELECT version FROM files WHERE id = ?').get(fileId)?.version;
  sendTo(audienceFor(fileId), { type: 'content-changed', id: fileId, version, by });
  return out.tab;
}
/** Mark the words a comment is about (the first place they appear) in a document, live for anyone editing it. */
export function markCommentInDocument(fileId, quote, commentId) {
  const room = rooms.get(fileId);
  if (room) return markQuoteInYDoc(room.doc, quote, commentId, FIELD);
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'doc' AND trashed = 0").get(fileId);
  if (!f) return false;
  const out = markQuoteInJson(JSON.parse(f.content || '{}'), quote, commentId);
  if (!out.found) return false;
  const json = JSON.stringify(out.json);
  q('UPDATE files SET content = ?, size = ?, ydoc = NULL, version = version + 1 WHERE id = ?').run(json, Buffer.byteLength(json), fileId);
  const version = q('SELECT version FROM files WHERE id = ?').get(fileId)?.version;
  sendTo(audienceFor(fileId), { type: 'content-changed', id: fileId, version });
  return true;
}
/** Find and replace in a document's text, live for anyone editing it: the number of places changed. */
export function replaceInDocument(fileId, find, replace, opts = {}, by = null) {
  const room = rooms.get(fileId);
  if (room) { const { count } = replaceInYDoc(room.doc, find, replace, { ...opts, field: FIELD }); if (count) room.lastEditor = by || room.lastEditor; return count; }
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'doc' AND trashed = 0").get(fileId);
  if (!f) return 0;
  const before = JSON.parse(f.content || '{}');
  const out = replaceInJson(before, find, replace, opts);
  if (!out.count) return 0;
  if (opts.suggest) tellOfSuggestions(fileId, suggestionsInJson(before), suggestionsInJson(out.json));
  const json = JSON.stringify(out.json);
  q('UPDATE files SET content = ?, size = ?, ydoc = NULL, version = version + 1, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?').run(json, Buffer.byteLength(json), Date.now(), by, fileId);
  indexSoon();
  const version = q('SELECT version FROM files WHERE id = ?').get(fileId)?.version;
  sendTo(audienceFor(fileId), { type: 'content-changed', id: fileId, version, by });
  return out.count;
}
/** A document's pending suggestions, as anyone editing it sees them now. */
export function suggestionsOf(fileId) {
  const room = rooms.get(fileId);
  if (room) return suggestionsInYDoc(room.doc, FIELD);
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'doc'").get(fileId);
  try { return f ? suggestionsInJson(JSON.parse(f.content || '{}')) : []; } catch { return []; }
}
/** Someone's documents with other people's suggestions waiting, latest first: [{ file: { id, name, kind }, count, from: [names], at, link }]. */
export function suggestionsWaitingFor(userId) {
  const docs = q(`SELECT id, name, kind FROM files WHERE owner_id = ? AND kind = 'doc' AND trashed = 0
                  AND (content LIKE '%suggestInsert%' OR content LIKE '%suggestDelete%') LIMIT 200`).all(userId);
  const out = [];
  for (const f of docs) {
    const theirs = suggestionsOf(f.id).filter((x) => x.by !== userId);
    if (!theirs.length) continue;
    out.push({ file: f, count: theirs.length, from: [...new Set(theirs.map((x) => x.name || 'Someone'))], at: Math.max(...theirs.map((x) => x.at || 0)), link: `/docs/${f.id}` });
  }
  return out.sort((a, b) => b.at - a.at);
}
/** Accept or reject the chosen suggestions, live for anyone editing: how many. */
export function resolveSuggestions(fileId, pick, accept, by = null) {
  const room = rooms.get(fileId);
  if (room) { const { count } = resolveSuggestionsInYDoc(room.doc, pick, accept, FIELD); if (count) room.lastEditor = by || room.lastEditor; return count; }
  const f = q("SELECT content FROM files WHERE id = ? AND kind = 'doc' AND trashed = 0").get(fileId);
  if (!f) return 0;
  const out = resolveSuggestionsInJson(JSON.parse(f.content || '{}'), pick, accept);
  if (!out.count) return 0;
  const json = JSON.stringify(out.json);
  q('UPDATE files SET content = ?, size = ?, ydoc = NULL, version = version + 1, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?').run(json, Buffer.byteLength(json), Date.now(), by, fileId);
  indexSoon();
  const version = q('SELECT version FROM files WHERE id = ?').get(fileId)?.version;
  sendTo(audienceFor(fileId), { type: 'content-changed', id: fileId, version, by });
  return out.count;
}
/** Write one file's open editing session to the database now (if anything changed). */
export function saveNow(fileId) { const room = rooms.get(fileId); if (room) save(room); }

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

/** Called by the hub for /ws/collab/<id> upgrades, with the signed-in user. */
export function handleCollabUpgrade(req, socket, head, user) {
  const fileId = decodeURIComponent((req.url.split('?')[0].split('/')[3] || ''));
  const f = fileId && q('SELECT id, kind, trashed, locked_at, owner_id FROM files WHERE id = ?').get(fileId);
  const role = f && roleFor(f.id, user.id);
  if (!f || !KINDS[f.kind] || f.trashed || !role) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  const knownGen = new URLSearchParams(req.url.split('?')[1] || '').get('gen');
  wss.handleUpgrade(req, socket, head, (ws) => {
    trackSession(ws, req.sessionToken);
    const room = getRoom(f.id, f.kind);
    // A kept copy of an older generation: not merged (see genOf).
    if (knownGen && knownGen !== genOf(room.doc)) { try { ws.close(4001, 'rebuilt'); } catch {} return; }
    room.conns.set(ws, { userId: user.id, ownerId: f.owner_id, canEdit: atLeast(role, 'editor') && !f.locked_at, canSuggest: f.kind === 'doc' && role === 'commenter' && !f.locked_at, clients: new Set() });
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
          // Commenters on a document may suggest edits: their change is taken only if it's nothing but their own suggestions.
          if (sub !== syncProtocol.messageYjsSyncStep1 && !c.canEdit && !(c.canSuggest && suggestsOnly(room, c, data))) return;
          // Protected sheet ranges: a change to cells this person may not edit is refused, and
          // their editor starts again from what's stored (the browser normally stops it first).
          if (sub !== syncProtocol.messageYjsSyncStep1 && room.kind === 'sheet' && breaksProtection(room, c, data)) {
            console.warn('[collab] refused a change to a protected range by', c.userId);
            try { ws.close(4000, 'protected'); } catch {}
            return;
          }
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
