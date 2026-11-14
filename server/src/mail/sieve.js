// Per-user Sieve script: filter rules first, then the vacation auto-reply.
// Runs inside Dovecot at delivery time, so rules also apply to mail read on phones.
import { HttpError } from '../util.js';
import { TO_PRIMARY, TO_UPDATES } from './tabs.js';

/** Sieve string literal: escape backslash and double quote (newlines are allowed). */
export const sieveString = (v) => `"${String(v).replace(/\r\n?/g, '\n').replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const FIELDS = { from: ['from'], to: ['to', 'cc'], subject: ['subject'] };
const OPS = ['contains', 'not_contains', 'is'];
// Not headers: a message's size (over or under, "5 MB", "300 KB") and whether it has attachments.
const SIZE_OPS = ['over', 'under'];
// The message's text (Sieve's body extension) and the mailing list it came through (its List-Id): contains or not.
const TEXT_FIELDS = { body: null, list: 'list-id' };
const TEXT_OPS = ['contains', 'not_contains'];
const ATTACHMENT_OPS = ['has', 'has_not'];

/** "5 MB", "300kb", "1.5M" → { text: "1.5 MB", kb: 1536 } (Sieve's size takes whole K), or null. */
export function parseSize(v) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(k|kb|m|mb)?\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const mb = /^m/i.test(m[2] || 'm'); // a bare number is MB
  const kb = Math.round(n * (mb ? 1024 : 1));
  if (!(kb >= 1) || kb > 100 * 1024) return null;
  return { text: `${n} ${mb ? 'MB' : 'KB'}`, kb };
}
const EMAIL_RE = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;
const bad = (m) => new HttpError(400, m);

/** Validate and normalise the rules a user submits (an ordered array). */
export function normalizeRules(input) {
  if (!Array.isArray(input)) throw bad('rules must be a list');
  if (input.length > 100) throw bad('At most 100 filter rules');
  return input.map((r, i) => {
    const label = `Rule ${i + 1}`;
    const name = String(r.name || '').trim().slice(0, 100) || label;
    const match = r.match === 'any' ? 'any' : 'all';
    const conditions = (Array.isArray(r.conditions) ? r.conditions : []).slice(0, 10).map((c) => {
      if (c.field === 'size') {
        if (!SIZE_OPS.includes(c.op)) throw bad(`${name}: unknown comparison`);
        const size = parseSize(c.value);
        if (!size) throw bad(`${name}: give a size such as 5 MB or 300 KB (up to 100 MB)`);
        return { field: 'size', op: c.op, value: size.text };
      }
      if (c.field === 'attachment') {
        if (!ATTACHMENT_OPS.includes(c.op)) throw bad(`${name}: unknown comparison`);
        return { field: 'attachment', op: c.op, value: '' };
      }
      if (c.field in TEXT_FIELDS) {
        if (!TEXT_OPS.includes(c.op)) throw bad(`${name}: unknown comparison`);
        const value = String(c.value ?? '').trim();
        if (!value) throw bad(`${name}: a condition is empty`);
        if (value.length > 200) throw bad(`${name}: a condition is too long`);
        return { field: c.field, op: c.op, value };
      }
      if (!FIELDS[c.field]) throw bad(`${name}: unknown field`);
      if (!OPS.includes(c.op)) throw bad(`${name}: unknown comparison`);
      const value = String(c.value ?? '').trim();
      if (!value) throw bad(`${name}: a condition is empty`);
      if (value.length > 200) throw bad(`${name}: a condition is too long`);
      return { field: c.field, op: c.op, value };
    });
    if (!conditions.length) throw bad(`${name}: add at least one condition`);
    const a = r.actions || {};
    const actions = {
      moveTo: a.moveTo ? cleanFolder(a.moveTo, name) : null,
      markRead: !!a.markRead,
      star: !!a.star,
      forwardTo: a.forwardTo ? String(a.forwardTo).trim().toLowerCase() : null,
      delete: !!a.delete,
      label: a.label && /^[\w-]{1,40}$/.test(String(a.label)) ? String(a.label) : null, // a label's id (Mail → Labels)
      tab: ['primary', 'updates'].includes(a.tab) ? a.tab : null, // which Inbox tab it shows in
      stop: a.stop !== false,
    };
    if (actions.forwardTo && !EMAIL_RE.test(actions.forwardTo)) throw bad(`${name}: “${actions.forwardTo}” is not a valid email address`);
    if (actions.delete && actions.moveTo) throw bad(`${name}: choose either “move to” or “delete”`);
    if (actions.delete && actions.label) throw bad(`${name}: a deleted message can't be labelled`);
    if (actions.delete && actions.tab) throw bad(`${name}: choose either a tab or “delete”`);
    if (!actions.moveTo && !actions.markRead && !actions.star && !actions.forwardTo && !actions.delete && !actions.label && !actions.tab) throw bad(`${name}: choose at least one action`);
    return { name, enabled: r.enabled !== false, match, conditions, actions };
  });
}

function cleanFolder(v, name) {
  const f = String(v).trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!f || f.length > 100 || /[\x00-\x1f*%]/.test(f)) throw bad(`${name}: invalid folder name`);
  if (f.toUpperCase() === 'INBOX') return 'INBOX';
  return f;
}

function conditionSieve(c) {
  if (c.field === 'size') return `size ${c.op === 'under' ? ':under' : ':over'} ${parseSize(c.value)?.kb || 1}K`;
  // With attachments: a "mixed" multipart message (pictures shown in the text alone don't count).
  if (c.field === 'attachment') { const t = 'header :contains "Content-Type" "multipart/mixed"'; return c.op === 'has_not' ? `not ${t}` : t; }
  if (c.field in TEXT_FIELDS) {
    const t = c.field === 'body' ? `body :text :contains ${sieveString(c.value)}` : `header :contains "list-id" ${sieveString(c.value)}`;
    return c.op === 'not_contains' ? `not ${t}` : t;
  }
  const headers = FIELDS[c.field];
  const h = headers.length === 1 ? sieveString(headers[0]) : `[${headers.map(sieveString).join(', ')}]`;
  // "is exactly" on From/To compares the address itself ("Pest <pest@acme.com>" is pest@acme.com).
  const test = c.op === 'is' && c.field !== 'subject'
    ? `address :all :is ${h} ${sieveString(c.value)}`
    : `header ${c.op === 'is' ? ':is' : ':contains'} ${h} ${sieveString(c.value)}`;
  return c.op === 'not_contains' ? `not ${test}` : test;
}

function rulesSieve(rules, labels = new Map()) {
  const out = [];
  for (const r of rules.filter((x) => x.enabled)) {
    const conds = r.conditions.map(conditionSieve);
    const combined = conds.length === 1 ? conds[0] : `${r.match === 'any' ? 'anyof' : 'allof'}(${conds.join(', ')})`;
    const body = [];
    if (r.actions.markRead) body.push('addflag "\\\\Seen";');
    if (r.actions.star) body.push('addflag "\\\\Flagged";');
    // A label is an IMAP keyword on the message (one deleted since is left out).
    if (r.actions.label && labels.get(r.actions.label)) body.push(`addflag ${sieveString(labels.get(r.actions.label))};`);
    if (r.actions.tab) body.push(`addflag ${sieveString(r.actions.tab === 'primary' ? TO_PRIMARY : TO_UPDATES)};`);
    if (r.actions.forwardTo) body.push(`redirect :copy ${sieveString(r.actions.forwardTo)};`);
    if (r.actions.delete) body.push('discard;', 'set "deleted" "1";');
    else if (r.actions.moveTo) body.push(r.actions.moveTo === 'INBOX' ? 'keep;' : `fileinto :create ${sieveString(r.actions.moveTo)};`);
    if (!body.length) continue; // only a label that's gone: nothing to do
    if (r.actions.stop || r.actions.delete) body.push('set "done" "1";');
    out.push(`# ${r.name.replace(/[\r\n]/g, ' ')}\nif allof(string :is "\${done}" "", ${combined}) {\n  ${body.join('\n  ')}\n}`);
  }
  return out.join('\n');
}

function vacationSieveBlock({ subject, body, start_date, end_date, name, username, addresses }) {
  const conds = ['string :is "${deleted}" ""'];
  if (start_date) conds.push(`currentdate :value "ge" "date" ${sieveString(start_date)}`);
  if (end_date) conds.push(`currentdate :value "le" "date" ${sieveString(end_date)}`);
  const action = `vacation :days 1 :subject ${sieveString(subject || 'Out of office')} :from ${sieveString(`${name} <${username}>`)}`
    + ` :addresses [${addresses.map(sieveString).join(', ')}] ${sieveString(body)};`;
  return `# Vacation auto-reply (not sent for mail a rule deleted)\nif allof(${conds.join(', ')}) {\n  ${action}\n}`;
}

/** A Message-ID as Sieve can match it: "<…@…>", no spaces or quotes. */
export const cleanMessageId = (v) => { const s = String(v || '').trim(); return /^<[^<>\s"\\]{1,250}>$/.test(s) ? s : null; };
/** Muted conversations: replies (that name one of their messages) go to Archive, already read, before any rule. */
/**
 * Senders the company blocked for everyone (Admin → Phishing): addresses (a@b.com) and whole domains
 * (b.com, and its subdomains). Their mail goes to Junk, marked read, before anything else: no forwarding
 * copy, no filter, no vacation reply.
 */
function blockedSieve(list) {
  const addresses = list.filter((x) => x.includes('@'));
  const domains = list.filter((x) => !x.includes('@'));
  if (!addresses.length && !domains.length) return '';
  const tests = [
    addresses.length && `address :is :all "from" [${addresses.map(sieveString).join(', ')}]`,
    domains.length && `address :is :domain "from" [${domains.map(sieveString).join(', ')}]`,
    domains.length && `address :matches :domain "from" [${domains.map((d) => sieveString(`*.${d}`)).join(', ')}]`,
  ].filter(Boolean);
  return `# Blocked for everyone at the company (Admin → Phishing)\nif anyof(${tests.join(', ')}) {\n  addflag "\\\\Seen";\n  fileinto :create "Junk";\n  stop;\n}`;
}

function mutedSieve(ids) {
  if (!ids.length) return '';
  return `# Muted conversations\nif allof(string :is "\${done}" "", header :contains ["references", "in-reply-to"] [${ids.map(sieveString).join(', ')}]) {\n  addflag "\\\\Seen";\n  fileinto :create "Archive";\n  set "done" "1";\n}`;
}

/**
 * Plus addresses into folders: mail to you+receipts@… goes into the folder "receipts", when you have one
 * (only folders that already exist, so senders can't make new ones). Otherwise it stays in the Inbox.
 */
const PLUS_SIEVE = `# Plus addresses into folders of the same name
if allof(string :is "\${done}" "", envelope :detail :matches "to" "?*") {
  set "as_is" "\${0}";
  set :lower "low" "\${0}";
  set :upperfirst :lower "cap" "\${0}";
  if mailboxexists "\${as_is}" { fileinto "\${as_is}"; set "done" "1"; }
  elsif mailboxexists "\${low}" { fileinto "\${low}"; set "done" "1"; }
  elsif mailboxexists "\${cap}" { fileinto "\${cap}"; set "done" "1"; }
}`;

/**
 * Forwarding all mail: a copy goes to the address (keeping the original sender), and your own copy
 * stays in the Inbox, is marked read, archived or put in the Trash. Spam never gets here (spam.sieve stops first).
 */
function forwardSieve({ address, keep }) {
  const body = [`redirect :copy ${sieveString(address)};`];
  if (keep === 'read') body.push('addflag "\\\\Seen";');
  if (keep === 'archive') body.push('fileinto :create "Archive";', 'set "done" "1";');
  if (keep === 'trash') body.push('addflag "\\\\Seen";', 'fileinto :create "Trash";', 'set "done" "1";');
  return `# Forwarding all mail to ${address.replace(/[\r\n]/g, '')}\n${body.join('\n')}`;
}

/** The whole script for one user, or null when there is nothing to run. */
export function userSieve({ username, rules = [], vacation = null, muted = [], plusFolders = false, forward = null, labels = new Map(), blocked = [] }) {
  const active = rules.filter((r) => r.enabled);
  if (!active.length && !vacation && !muted.length && !plusFolders && !forward && !blocked.length) return null;
  const req = ['variables', 'fileinto', 'mailbox', 'imap4flags', 'copy'];
  if (plusFolders) req.push('envelope', 'subaddress');
  if (active.some((r) => r.conditions.some((c) => c.field === 'body'))) req.push('body');
  if (vacation) req.push('vacation', 'date', 'relational');
  return [
    `# Generated by Workspace for ${username}. Edit filters and vacation replies in Mail.`,
    `require [${req.map(sieveString).join(', ')}];`,
    blockedSieve(blocked),
    forward ? forwardSieve(forward) : '',
    mutedSieve(muted),
    plusFolders ? PLUS_SIEVE : '',
    rulesSieve(active, labels),
    vacation ? vacationSieveBlock({ ...vacation, username }) : '',
  ].filter(Boolean).join('\n') + '\n';
}
