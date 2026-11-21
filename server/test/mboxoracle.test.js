// .mbox files against another program: Python's own mailbox module (the standard library's). Random
// messages (bodies with "From " lines, ">From" lines, blank lines, accents and 8-bit bytes, with and without a
// last line break) go both ways: Workspace's "Download your data" read by Python, and an .mbox written by
// Python imported the way Mail imports one. The same messages, in order, with the same headers, text and dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { mboxEntry, readMbox, countMbox } from '../src/mail/mbox.js';

const python = spawnSync('python3', ['-c', 'import mailbox'], { encoding: 'utf8' }).status === 0;
let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const LINES = ['From here on, prices go up.', 'From', 'From:', 'From  two spaces', '', '', 'Hello Zoë,', 'ça va ?', '  indented', 'Thanks', 'From the archive', 'trailing space ', '-- ', 'Subject: not a header', 'x'.repeat(200)];
const QUOTED = ['>From the archive', '>>From deeper', '> From quoted reply', '>'];

/** A random message (latin1 string, CRLF line endings, as a mail server keeps it). */
function message(i, { quoted }) {
  const body = Array.from({ length: Math.floor(rnd() * 12) }, () => pick(rnd() < 0.2 && quoted ? QUOTED : LINES));
  const head = [`From: Person ${i} <p${i}@example.org>`, 'To: olivia@acme.com', `Subject: Message ${i} ${pick(['', 'From Kim', 'résumé'])}`.trim(), `Message-ID: <m${i}.${Math.floor(rnd() * 1e9)}@example.org>`,
    `Date: ${new Date(Date.UTC(2020 + Math.floor(rnd() * 7), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60))).toUTCString()}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'];
  const text = Buffer.from([...head, '', ...body].join('\r\n') + (rnd() < 0.8 ? '\r\n' : ''), 'utf8').toString('latin1');
  return { text, date: new Date(Date.UTC(2020 + Math.floor(rnd() * 7), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 60))), sender: `p${i}@example.org` };
}
/** How a message is compared: LF line endings, without the last line break (an .mbox has no way to keep it). */
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '');

test('Workspace\'s .mbox download, read by Python: every message, in order, the same', { skip: !python && 'no python3' }, () => {
  for (let round = 0; round < 6; round++) {
    const msgs = Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, i) => message(i, { quoted: true }));
    const file = Buffer.concat(msgs.map((m) => mboxEntry(Buffer.from(m.text, 'latin1'), { from: m.sender, date: m.date })));
    const r = spawnSync('python3', ['-I', '-c', `
import sys, json, mailbox, tempfile, os
f = tempfile.NamedTemporaryFile(delete=False); f.write(sys.stdin.buffer.read()); f.close()
out = []
for m in mailbox.mbox(f.name):
    raw = m.as_bytes(unixfrom=False)
    out.append({'from_line': m.get_from(), 'raw': raw.decode('latin-1'), 'id': m['Message-ID']})
os.unlink(f.name)
print(json.dumps(out))
`], { input: file, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, String(r.stderr));
    const got = JSON.parse(r.stdout);
    assert.equal(got.length, msgs.length, 'as many messages');
    for (const [i, m] of msgs.entries()) {
      const g = got[i];
      assert.equal(g.id, /^Message-ID: (.*)$/m.exec(m.text)[1].replace(/\r$/, ''), `message ${i}`);
      assert.equal(g.from_line, `${m.sender} ${new Date(m.date).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, (x, d, n, mo, y, t) => `${d} ${mo} ${n.replace(/^0/, ' ')} ${t} ${y}`)}`, `message ${i}'s From line`);
      // Python reads mboxo, which doesn't take the ">" back off: undo the one mboxrd added, as an mboxrd reader does.
      assert.equal(norm(g.raw.replace(/^>(>*From )/gm, '$1')), norm(m.text), `message ${i}`);
    }
  }
});

test('an .mbox written by Python, imported the way Mail imports one: every message, in order, the same', { skip: !python && 'no python3' }, async () => {
  for (let round = 0; round < 6; round++) {
    // (no ">From" lines: in mboxo, which Python writes, they can't be told from an escaped "From ")
    const msgs = Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, i) => message(i, { quoted: false }));
    const r = spawnSync('python3', ['-I', '-c', `
import sys, json, mailbox, tempfile, os, time, calendar
d = tempfile.mkdtemp(); path = os.path.join(d, 'x.mbox')
box = mailbox.mbox(path)
for c in json.load(sys.stdin):
    m = mailbox.mboxMessage(c['text'].encode('latin-1'))
    m.set_from(c['sender'], time.gmtime(c['date'] / 1000))
    box.add(m)
box.flush(); box.close()
sys.stdout.buffer.write(open(path, 'rb').read())
`], { input: JSON.stringify(msgs.map((m) => ({ ...m, date: m.date.getTime() }))), maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, String(r.stderr));
    const file = r.stdout;
    assert.equal(await countMbox(Readable.from([file])), msgs.length, 'counted (for the progress bar)');
    // read in uneven pieces, as a file arrives
    const pieces = [];
    for (let at = 0; at < file.length;) { const n = 1 + Math.floor(rnd() * 300); pieces.push(file.subarray(at, at + n)); at += n; }
    const got = [];
    for await (const m of readMbox(Readable.from(pieces))) got.push(m);
    assert.equal(got.length, msgs.length, 'as many messages');
    for (const [i, m] of msgs.entries()) {
      assert.equal(got[i].date?.getTime(), Math.floor(m.date.getTime() / 1000) * 1000, `message ${i}'s date`);
      assert.equal(norm(got[i].source.toString('latin1')), norm(m.text), `message ${i}`);
    }
  }
});
