// Workspace as an MCP server (Model Context Protocol), for AI assistants such as Claude and ChatGPT:
// POST /mcp speaks JSON-RPC 2.0 over "Streamable HTTP" (each request answered with JSON, no stream).
// It signs in with an API token (Settings → API tokens) as `Authorization: Bearer nwt_…`, and every tool
// calls Workspace's own API as that person over the loopback, so the same permissions, company rules
// and read-only tokens apply. Email is never sent from here: draft_email leaves a draft to check and send.
// search and fetch follow the shape ChatGPT's connectors and deep research expect.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { expand } from './calmath.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INNER_KEY = crypto.randomBytes(24).toString('hex'); // marks our own loopback calls (see innerIp)
const DAY = 864e5;

/** Our own calls to the API carry the caller's real address, so network rules and "last used from" see them. */
export function innerIp(req, res, next) {
  const key = req.get('x-workspace-inner');
  if (key && key === INNER_KEY && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '')) {
    const ip = String(req.get('x-workspace-ip') || '').slice(0, 64);
    if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
  }
  next();
}

/** Calls the API as the person on this MCP request. */
function apiFor(req) {
  const base = `http://127.0.0.1:${req.socket.localPort}/api`;
  const headers = { authorization: req.get('authorization'), 'x-workspace-inner': INNER_KEY, 'x-workspace-ip': req.ip || '', 'content-type': 'application/json' };
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new ToolError(data?.error || `Workspace answered ${r.status}`);
    return data;
  };
}

class ToolError extends Error {}
const PUBLIC = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const link = (p) => `${PUBLIC()}${p}`;
/** A time from the assistant: ISO text ("2026-11-20T15:00", "2026-11-20") or milliseconds. */
function timeOf(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) throw new ToolError(`${name} must be a date and time, like 2026-11-20T15:00:00Z`);
  return t;
}
const iso = (t) => (t ? new Date(t).toISOString() : null);
const words = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Plain text → a Workspace document (a paragraph per line; "# " lines as headings). */
export function docFromText(text) {
  const content = String(text || '').split(/\r?\n/).map((line) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const inner = (h ? h[2] : line) ? [{ type: 'text', text: h ? h[2] : line }] : undefined;
    return h ? { type: 'heading', attrs: { level: h[1].length }, ...(inner && { content: inner }) } : { type: 'paragraph', ...(inner && { content: inner }) };
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

const FILE_PATH = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}`, folder: (f) => `/drive/folder/${f.id}` };
const fileUrl = (f) => link((FILE_PATH[f.kind] || ((x) => `/drive?file=${x.id}`))(f));

// ---- the tools ----
export const TOOLS = [
  {
    name: 'search', title: 'Search Workspace', readOnly: true,
    description: 'Search everything the person can see in Workspace: Drive files (names and contents), email (Inbox and Sent), chat messages, tasks, notes, calendar events and contacts. Returns ids to pass to fetch.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' } }, required: ['query'] },
    async run(api, { query }) {
      const qs = encodeURIComponent(String(query || '').slice(0, 200));
      if (!String(query || '').trim()) throw new ToolError('Say what to search for');
      const safe = (p) => p.catch(() => null);
      const [files, chat, tasks, notes, events, contacts, inbox, sent] = await Promise.all([
        safe(api('GET', `/files?view=search&q=${qs}`)), safe(api('GET', `/chat/search?q=${qs}`)), safe(api('GET', `/tasks/search?q=${qs}`)),
        safe(api('GET', `/notes?q=${qs}`)), safe(api('GET', `/events/search?q=${qs}`)), safe(api('GET', '/contacts')),
        safe(api('GET', `/mail/messages?folder=INBOX&q=${qs}`)), safe(api('GET', `/mail/messages?folder=Sent&q=${qs}`)),
      ]);
      const low = String(query).toLowerCase();
      const results = [
        ...(Array.isArray(files) ? files : files?.files || []).slice(0, 10).map((f) => ({ id: `file:${f.id}`, title: f.name, url: fileUrl(f) })),
        ...[...(inbox?.messages || []).map((m) => ({ ...m, folder: 'INBOX' })), ...(sent?.messages || []).map((m) => ({ ...m, folder: 'Sent' }))].slice(0, 10)
          .map((m) => ({ id: `mail:${m.folder}:${m.uid}`, title: `${m.subject || '(no subject)'} — ${m.folder === 'Sent' ? `to ${(m.to || []).map((t) => t.address).join(', ')}` : m.from?.name || m.from?.address || ''}`, url: link(`/mail/${encodeURIComponent(m.folder)}/${m.uid}`) })),
        ...(chat || []).slice(0, 10).map((m) => ({ id: `chat:${m.channel_id}:${m.id}`, title: `${m.user_name || 'Someone'} in ${m.where}: ${words(m.body, 80)}`, url: link(`/chat/${m.channel_id}?msg=${m.parent_id || m.id}`) })),
        ...(tasks || []).slice(0, 10).map((t) => ({ id: `task:${t.id}`, title: `${t.done ? '✓ ' : ''}${t.title} (${t.list_name})`, url: link(`/tasks/${t.list_id}?task=${t.id}`) })),
        ...(notes || []).slice(0, 10).map((n) => ({ id: `note:${n.id}`, title: n.title || words(n.body || (n.items || []).map((i) => i.text).join(', '), 80) || 'Note', url: link('/notes') })),
        ...(events || []).slice(0, 10).map((e) => ({ id: `event:${e.id}`, title: `${e.title} (${iso(e.start)})`, url: link('/calendar') })),
        ...(contacts || []).filter((c) => [c.name, c.email, c.company].some((x) => String(x || '').toLowerCase().includes(low))).slice(0, 10)
          .map((c) => ({ id: `contact:${c.id}`, title: [c.name, c.email, c.company].filter(Boolean).join(' · '), url: link(`/contacts?q=${encodeURIComponent(c.name || c.email || '')}`) })),
      ];
      return { results };
    },
  },
  {
    name: 'fetch', title: 'Read an item', readOnly: true,
    description: 'Read one item found with search (or listed by another tool) in full: a file’s text, an email, a chat message, a task, a note, an event or a contact.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'An id from search, such as file:abc123 or mail:INBOX:42' } }, required: ['id'] },
    async run(api, { id }) {
      const [kind, a, b] = String(id || '').split(':');
      if (kind === 'file') {
        const r = await api('GET', `/files/${encodeURIComponent(a)}/text`);
        return { id, title: r.file.name, text: r.text || '(no text in this file)', url: fileUrl(r.file), metadata: { kind: r.file.kind, updated_at: iso(r.file.updated_at), truncated: r.truncated } };
      }
      if (kind === 'mail') {
        const uid = String(id).split(':').pop(), folder = String(id).slice(5, -(uid.length + 1));
        const m = await api('GET', `/mail/messages/${encodeURIComponent(uid)}?folder=${encodeURIComponent(folder)}`);
        const addr = (x) => [].concat(x || []).map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ');
        const head = [`From: ${addr(m.from)}`, `To: ${addr(m.to)}`, m.cc?.length ? `Cc: ${addr(m.cc)}` : null, `Date: ${iso(m.date)}`, `Subject: ${m.subject || ''}`,
          m.attachments?.length ? `Attachments: ${m.attachments.map((x) => x.filename).join(', ')}` : null].filter(Boolean).join('\n');
        return { id, title: m.subject || '(no subject)', text: `${head}\n\n${m.text || String(m.html || '').replace(/<[^>]+>/g, ' ')}`.slice(0, 100000), url: link(`/mail/${encodeURIComponent(folder)}/${uid}`), metadata: { folder } };
      }
      if (kind === 'chat') {
        const list = await api('GET', `/chat/channels/${encodeURIComponent(a)}/messages?around=${encodeURIComponent(b)}`);
        const msgs = Array.isArray(list) ? list : list.messages || [];
        const text = msgs.map((m) => `${m.id === b ? '→ ' : ''}${m.user_name || 'Someone'} (${iso(m.created_at)}): ${m.body}`).join('\n');
        return { id, title: 'Chat conversation', text, url: link(`/chat/${a}?msg=${b}`), metadata: {} };
      }
      if (kind === 'task') {
        const r = await api('GET', '/tasks/lists');
        let t = null;
        for (const l of (Array.isArray(r) ? r : r.lists || []).slice(0, 50)) {
          t = (await api('GET', `/tasks/lists/${l.id}/tasks`)).find((x) => x.id === a);
          if (t) { t.list_name ||= l.name; break; }
        }
        if (!t) throw new ToolError('Task not found');
        const text = [`${t.done ? 'Done' : 'To do'}: ${t.title}`, t.due ? `Due: ${t.due}${t.due_time ? ` ${t.due_time}` : ''}` : null, t.assignee_name ? `For: ${t.assignee_name}` : null,
          t.notes ? `Notes: ${t.notes}` : null, ...(t.steps || []).map((s) => `${s.done ? '[x]' : '[ ]'} ${s.title}`)].filter(Boolean).join('\n');
        return { id, title: t.title, text, url: link(`/tasks/${t.list_id}?task=${t.id}`), metadata: { list: t.list_name } };
      }
      if (kind === 'note') {
        const n = (await api('GET', '/notes')).find((x) => x.id === a) || (await api('GET', '/notes?archived=1')).find((x) => x.id === a);
        if (!n) throw new ToolError('Note not found');
        return { id, title: n.title || 'Note', text: n.items ? n.items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('\n') : n.body, url: link('/notes'), metadata: { labels: n.labels } };
      }
      if (kind === 'event') {
        const all = await api('GET', '/events');
        const e = (Array.isArray(all) ? all : all.events || []).find((x) => x.id === a);
        if (!e) throw new ToolError('Event not found');
        const text = [`${e.title}`, `When: ${iso(e.start)} – ${iso(e.end)}${e.all_day ? ' (all day)' : ''}`, e.location ? `Where: ${e.location}` : null,
          e.organizer_name ? `Organiser: ${e.organizer_name}` : null, e.guests?.length ? `Guests: ${e.guests.map((g) => `${g.name || g.email} (${g.status || 'invited'})`).join(', ')}` : null,
          e.description ? `\n${e.description}` : null].filter(Boolean).join('\n');
        return { id, title: e.title, text, url: link('/calendar'), metadata: { start: iso(e.start), end: iso(e.end) } };
      }
      if (kind === 'contact') {
        const c = (await api('GET', '/contacts')).find((x) => x.id === a);
        if (!c) throw new ToolError('Contact not found');
        const text = [c.name, c.email && `Email: ${c.email}`, c.phone && `Phone: ${c.phone}`, c.company && `Company: ${c.company}`, c.title && `Job title: ${c.title}`, c.address && `Address: ${c.address}`, c.notes && `Notes: ${c.notes}`].filter(Boolean).join('\n');
        return { id, title: c.name || c.email, text, url: link('/contacts'), metadata: {} };
      }
      throw new ToolError('That id isn’t one search gave (file:…, mail:…, chat:…, task:…, note:…, event:… or contact:…)');
    },
  },
  {
    name: 'list_events', title: 'Calendar events', readOnly: true,
    description: 'The person’s calendar events (their own and those they’re invited to) between two times; by default the next 7 days. Repeating events are listed once per occurrence.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Start, ISO 8601 (default: now)' }, to: { type: 'string', description: 'End, ISO 8601 (default: 7 days after from)' } } },
    async run(api, args) {
      const from = timeOf(args.from, 'from') ?? Date.now();
      const to = timeOf(args.to, 'to') ?? from + 7 * DAY;
      if (to <= from || to - from > 366 * DAY) throw new ToolError('Pick a time span of up to a year, with to after from');
      const rows = await api('GET', `/events?from=${from}&to=${to}`);
      const events = (Array.isArray(rows) ? rows : rows.events || []).flatMap((e) => expand(e, from, to)).filter((e) => e.start < to && e.end > from).sort((x, y) => x.start - y.start).slice(0, 200)
        .map((e) => ({ id: `event:${e.id}`, title: e.title, start: iso(e.start), end: iso(e.end), all_day: !!e.all_day, location: e.location || null, organizer: e.organizer_name || null, my_answer: e.my_status || null }));
      return { events };
    },
  },
  {
    name: 'create_event', title: 'Add a calendar event', readOnly: false,
    description: 'Add an event to the person’s calendar. Guests (email addresses) are invited by email.',
    inputSchema: {
      type: 'object', required: ['title', 'start', 'end'],
      properties: {
        title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 with a time zone, e.g. 2026-11-20T15:00:00+08:00' }, end: { type: 'string', description: 'ISO 8601' },
        location: { type: 'string' }, description: { type: 'string' }, guests: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite' },
      },
    },
    async run(api, a) {
      const start = timeOf(a.start, 'start'), end = timeOf(a.end, 'end');
      if (!start || !end || end <= start) throw new ToolError('end must be after start');
      const e = await api('POST', '/events', { title: String(a.title || '').slice(0, 300), start, end, location: a.location || undefined, description: a.description || undefined, ...(Array.isArray(a.guests) && a.guests.length && { guests: a.guests }) });
      return { id: `event:${e.id}`, title: e.title, start: iso(e.start), end: iso(e.end), url: link('/calendar') };
    },
  },
  {
    name: 'list_tasks', title: 'Tasks', readOnly: true,
    description: 'The person’s task lists and the open tasks on them (or one list’s tasks, with done ones if asked).',
    inputSchema: { type: 'object', properties: { list: { type: 'string', description: 'A list’s name or id (default: every list)' }, include_done: { type: 'boolean' } } },
    async run(api, a) {
      const r = await api('GET', '/tasks/lists');
      let lists = Array.isArray(r) ? r : r.lists || [];
      if (a.list) lists = lists.filter((l) => l.id === a.list || l.name.toLowerCase() === String(a.list).toLowerCase());
      if (a.list && !lists.length) throw new ToolError(`No list called “${a.list}”`);
      const out = [];
      for (const l of lists.slice(0, 30)) {
        const tasks = (await api('GET', `/tasks/lists/${l.id}/tasks`)).filter((t) => a.include_done || !t.done).slice(0, 200)
          .map((t) => ({ id: `task:${t.id}`, title: t.title, done: !!t.done, due: t.due || null, assignee: t.assignee_name || null, important: !!t.important }));
        out.push({ id: l.id, name: l.name, owner: l.owner_name, tasks });
      }
      return { lists: out };
    },
  },
  {
    name: 'create_task', title: 'Add a task', readOnly: false,
    description: 'Add a task to one of the person’s lists (by default their first list).',
    inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, list: { type: 'string', description: 'A list’s name or id' }, due: { type: 'string', description: 'A day, YYYY-MM-DD' }, notes: { type: 'string' } } },
    async run(api, a) {
      const r = await api('GET', '/tasks/lists');
      const lists = Array.isArray(r) ? r : r.lists || [];
      const list = a.list ? lists.find((l) => l.id === a.list || l.name.toLowerCase() === String(a.list).toLowerCase()) : lists[0];
      if (!list) throw new ToolError(`No list called “${a.list}”`);
      if (a.due && !/^\d{4}-\d{2}-\d{2}$/.test(a.due)) throw new ToolError('due is a day, like 2026-11-20');
      const t = await api('POST', `/tasks/lists/${list.id}/tasks`, { title: String(a.title || '').slice(0, 500), ...(a.due && { due: a.due }), ...(a.notes && { notes: String(a.notes) }) });
      return { id: `task:${t.id}`, title: t.title, list: list.name, due: t.due || null, url: link(`/tasks/${list.id}?task=${t.id}`) };
    },
  },
  {
    name: 'complete_task', title: 'Tick off a task', readOnly: false,
    description: 'Mark a task done (or not done again).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'task:… from list_tasks or search' }, done: { type: 'boolean', default: true } } },
    async run(api, a) {
      const id = String(a.id || '').replace(/^task:/, '');
      const t = await api('PATCH', `/tasks/tasks/${encodeURIComponent(id)}`, { done: a.done !== false });
      return { id: `task:${t.id || id}`, title: t.title, done: !!t.done };
    },
  },
  {
    name: 'list_mail', title: 'Email', readOnly: true,
    description: 'Emails in a mail folder (default: Inbox), newest first, optionally matching a search (Gmail-style: from:, to:, subject:, has:attachment, is:unread, before:, after:).',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', default: 'INBOX' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } },
    async run(api, a) {
      const folder = String(a.folder || 'INBOX');
      const r = await api('GET', `/mail/messages?folder=${encodeURIComponent(folder)}${a.query ? `&q=${encodeURIComponent(a.query)}` : ''}`);
      const limit = Math.min(50, Math.max(1, Number(a.limit) || 20));
      return {
        messages: (r.messages || []).slice(0, limit).map((m) => ({ id: `mail:${folder}:${m.uid}`, subject: m.subject || '(no subject)', from: m.from?.address ? `${m.from.name ? `${m.from.name} ` : ''}<${m.from.address}>` : null, date: iso(m.date), unread: !m.seen, starred: !!m.flagged })),
      };
    },
  },
  {
    name: 'draft_email', title: 'Write an email draft', readOnly: false,
    description: 'Write an email and leave it in the person’s Drafts folder for them to check and send in Workspace. It is not sent.',
    inputSchema: { type: 'object', required: ['to', 'subject', 'body'], properties: { to: { type: 'string', description: 'Addresses, separated by commas' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'The message, as plain text' } } },
    async run(api, a) {
      const r = await api('POST', '/mail/drafts', { to: String(a.to || ''), cc: String(a.cc || ''), subject: String(a.subject || ''), text: String(a.body || '') });
      return { saved: true, folder: r.folder || 'Drafts', note: 'Saved in Drafts, not sent: open it in Workspace Mail to check and send.', url: link('/mail/Drafts') };
    },
  },
  {
    name: 'create_note', title: 'Add a note', readOnly: false,
    description: 'Add a note to the person’s Notes (a checklist when items are given).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, items: { type: 'array', items: { type: 'string' }, description: 'Checklist items' } } },
    async run(api, a) {
      const items = Array.isArray(a.items) && a.items.length ? a.items.map((t) => ({ text: String(t) })) : undefined;
      const n = await api('POST', '/notes', { title: String(a.title || ''), body: items ? '' : String(a.text || ''), ...(items && { items }) });
      return { id: `note:${n.id}`, title: n.title, url: link('/notes') };
    },
  },
  {
    name: 'create_document', title: 'Make a document', readOnly: false,
    description: 'Make a new Workspace document in the person’s Drive from plain text (lines starting with # become headings).',
    inputSchema: { type: 'object', required: ['name', 'text'], properties: { name: { type: 'string' }, text: { type: 'string' } } },
    async run(api, a) {
      const f = await api('POST', '/files/new', { kind: 'doc', name: String(a.name || 'Untitled document').slice(0, 200), content: docFromText(a.text) });
      return { id: `file:${f.id}`, name: f.name, url: fileUrl({ ...f, kind: 'doc' }) };
    },
  },
];

const listed = () => TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false } }));

/** One JSON-RPC message → its answer (or null for a notification). */
export async function handle(msg, api) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.id === undefined || msg.id === null) return null; // a notification (initialized, cancelled…)
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'workspace', title: 'Workspace', version: '1.0.0' },
        instructions: 'Workspace is the company’s own email, calendar, Drive, chat, tasks, notes and contacts. Use search then fetch to find and read things; draft_email never sends, it leaves a draft for the person to send.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: listed() });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `No tool called ${msg.params?.name}`);
      try {
        const out = await tool.run(api, msg.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export function mcpRoutes(auth) {
  const r = Router();
  // Only with a token: a browser's cookie can't be used here (another site could otherwise post as you).
  const bearerOnly = (req, res, next) => {
    if (!/^Bearer\s+\S/i.test(req.get('authorization') || '')) {
      res.set('WWW-Authenticate', 'Bearer realm="workspace"');
      return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in with an API token: Authorization: Bearer nwt_…' } });
    }
    delete req.headers.cookie;
    next();
  };
  r.post('/', bearerOnly, auth, express.json({ limit: '4mb' }), async (req, res) => {
    const api = apiFor(req);
    const one = async (m) => {
      try { return await handle(m, api); }
      catch (e) { return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: String(e.message || e).slice(0, 300) } }; }
    };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(one))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await one(body);
    if (!out) return res.status(202).end();
    res.json(out);
  });
  // No server-to-client stream, and no sessions to end.
  r.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
  r.delete('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
  return r;
}
