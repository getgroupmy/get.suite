// A person's mail as .mbox files (one per folder), for "Download your data": the format Thunderbird,
// Apple Mail and most mail programs import, and that Gmail's own export uses. mboxrd: each message
// starts with a "From " line, and lines in it that already start with "From " (after any ">") get one
// more ">" so they can't be mistaken for the start of the next message.
import fs from 'node:fs';
import path from 'node:path';
import { ownConnection } from './imap.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
/** The "From " line's date, in the asctime form mbox readers expect (UTC). */
export function asctime(d) {
  const t = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date(0);
  return `${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${String(t.getUTCDate()).padStart(2, ' ')} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} ${t.getUTCFullYear()}`;
}

/** One message (its raw source) as an mboxrd entry, ending with a blank line. */
export function mboxEntry(source, { from = 'MAILER-DAEMON', date } = {}) {
  const text = Buffer.isBuffer(source) ? source.toString('latin1') : String(source); // bytes kept as they are
  const body = text.replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
  const sender = /^[^\s@]+@[^\s@]+$/.test(from) ? from : 'MAILER-DAEMON';
  return Buffer.from(`From ${sender} ${asctime(date)}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`, 'latin1');
}

/** A folder's file name in the download: "INBOX" is Inbox; subfolders become folders ("Projects/Acme"). */
export function mboxName(folder) {
  const parts = (folder.path === 'INBOX' ? ['Inbox'] : folder.path.split(folder.delimiter || '/'))
    .map((p) => p.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'Folder');
  return `${parts.join('/')}.mbox`;
}

/**
 * Write every folder of someone's mailbox as an .mbox file in `dir`. Returns [{ name, file, messages,
 * bytes }]. Stops with an error once more than `maxBytes` has been written.
 */
export async function writeMailbox(user, dir, { maxBytes = Infinity } = {}) {
  const client = await ownConnection(user);
  const out = [];
  let total = 0;
  try {
    const folders = (await client.list()).filter((f) => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent'));
    for (const folder of folders) {
      const name = mboxName(folder);
      const file = path.join(dir, `${out.length}.mbox`);
      const fd = fs.openSync(file, 'w');
      let messages = 0, bytes = 0;
      try {
        const lock = await client.getMailboxLock(folder.path, { readOnly: true });
        try {
          if (client.mailbox.exists) {
            for await (const m of client.fetch('1:*', { uid: true, source: true, envelope: true, internalDate: true })) {
              if (!m.source) continue;
              const entry = mboxEntry(m.source, { from: m.envelope?.from?.[0]?.address, date: m.internalDate || m.envelope?.date });
              fs.writeSync(fd, entry);
              messages++; bytes += entry.length; total += entry.length;
              if (total > maxBytes) throw Object.assign(new Error('Your mail is too large to download this way'), { tooLarge: true });
            }
          }
        } finally { lock.release(); }
      } finally { fs.closeSync(fd); }
      out.push({ name, file, messages, bytes });
    }
  } finally { await client.logout().catch(() => {}); }
  return out;
}

/** How many messages are in each of someone's folders, without downloading them (for the summary). */
export async function mailboxCounts(user) {
  const client = await ownConnection(user);
  try {
    let messages = 0;
    for (const f of await client.list({ statusQuery: { messages: true } })) messages += f.status?.messages || 0;
    return { messages };
  } finally { await client.logout().catch(() => {}); }
}
