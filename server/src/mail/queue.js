// The mail server's outgoing queue, for Admin → System: mail waiting to go out (most often because
// the other side refuses it or can't be reached), and asking the mail server to retry or delete it.
//
// The mail container writes MAIL_STATUS_DIR/queue.jsonl every few seconds: a first line
// { at, done } (when it was read, and the last request carried out), then Postfix's `postqueue -j`
// output, one message a line. Requests go the other way in MAIL_CONFIG_DIR/queue/actions, lines of
// "<seq> flush | retry <id> | delete <id>", each carried out once (see mail/entrypoint.sh).
import fs from 'node:fs';
import path from 'node:path';
import { MAIL_CONFIG_DIR } from './config.js';

export const MAIL_STATUS_DIR = process.env.MAIL_STATUS_DIR || null;
const ID = /^[0-9A-Za-z]{5,20}$/;

/** { at, done, messages: [{ id, queue, arrived, size, sender, recipients: [{ address, reason }] }] }, or null. */
export function readQueue(dir = MAIL_STATUS_DIR) {
  if (!dir) return null;
  let text;
  try { text = fs.readFileSync(path.join(dir, 'queue.jsonl'), 'utf8'); } catch { return null; }
  const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const head = lines[0] && 'at' in lines[0] ? lines.shift() : { at: 0, done: 0 };
  const messages = lines.filter((m) => m.queue_id).map((m) => ({
    id: String(m.queue_id), queue: m.queue_name || 'deferred',
    arrived: (Number(m.arrival_time) || 0) * 1000, size: Number(m.message_size) || 0,
    sender: m.sender || '', recipients: (m.recipients || []).map((r) => ({ address: r.address, reason: r.delay_reason || null })),
  })).sort((a, b) => a.arrived - b.arrived);
  return { at: (Number(head.at) || 0) * 1000, done: Number(head.done) || 0, messages };
}

/** Ask the mail server to flush the queue, or retry or delete one message. Returns the request's number. */
export function requestQueueAction(op, id = null, { configDir = MAIL_CONFIG_DIR, statusDir = MAIL_STATUS_DIR } = {}) {
  if (!['flush', 'retry', 'delete'].includes(op)) throw new Error('Unknown action');
  if (op !== 'flush' && !ID.test(String(id))) throw new Error('Not a queued message');
  const file = path.join(configDir, 'queue', 'actions');
  const done = readQueue(statusDir)?.done || 0;
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* the first */ }
  const seqOf = (l) => Number(l.split(' ')[0]) || 0;
  const seq = Math.max(done, ...lines.map(seqOf)) + 1;
  lines = [...lines.filter((l) => seqOf(l) > done), `${seq} ${op}${op === 'flush' ? '' : ` ${id}`}`];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
  return seq;
}

/** The health check's view: how long the oldest waiting message has waited, and whether the report is fresh. */
export function queueCheck(qd, now = Date.now()) {
  if (!qd) return null;
  if (now - qd.at > 5 * 60e3) return { status: 'warn', detail: 'The mail server hasn’t reported its queue for over 5 minutes' };
  const waiting = qd.messages.filter((m) => m.queue !== 'active');
  if (!waiting.length) return { status: 'ok', detail: 'Nothing waiting to go out' };
  const hours = (now - waiting[0].arrived) / 3600e3;
  const reason = waiting[0].recipients.find((r) => r.reason)?.reason;
  return {
    status: hours > 24 ? 'bad' : hours > 1 ? 'warn' : 'ok',
    detail: `${waiting.length} message${waiting.length === 1 ? '' : 's'} waiting; the oldest for ${hours < 1 ? 'less than an hour' : `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`}${reason ? ` (${reason.slice(0, 160)})` : ''}`,
  };
}
