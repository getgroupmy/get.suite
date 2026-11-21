// Emails against another mail program: Python's own email package (the standard library's, strict about
// the standards). Random people (names with commas, quotes, brackets, colons, accents and emoji), subjects
// and attachment names go both ways: put on an address line the way Mail does it, sent the way Workspace
// sends, and read by Python; and written by Python and read the way Workspace reads an email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { formatAddress, parseAddresses } from '../../web/src/components/addresses.js';

const python = spawnSync('python3', ['-c', 'import email'], { encoding: 'utf8' }).status === 0;

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const PIECES = ['Ann', 'Lee', 'Doe,', 'Jo', '(Sales)', 'Acme:', 'Billing', '"the"', 'Boss', 'O\'Brien', 'Zoë', 'Łukasz', '山田', '太郎', '🙂', 'Dr.', 'J.', 'a\\b', '[HQ]', 'x@home', '<team>', ';', 'Ünïcødé', 'Müller-Lüdenscheidt', '—', '&'];
const name = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(PIECES)).join(' ');
const people = (n) => Array.from({ length: n }, (_, i) => ({ name: rnd() < 0.15 ? '' : name(), email: `p${i}.${Math.floor(rnd() * 1e6)}@example.org` }));
const subject = () => Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => pick([...PIECES, 'Quarterly', 'figures', 'Re:', 'résumé', 'ça va', 'naïve', 'a'.repeat(40)])).join(' ');
const filename = () => `${Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(['report', 'Zoë', 'Q3 figures', '山田', 'a, b', 'it\'s', '(final)', '🙂', 'x;y', 'long'.repeat(15)])).join(' ')}.${pick(['pdf', 'txt', 'xlsx'])}`;
/** How a name is compared: as anyone reads it (spaces run together, ends trimmed). */
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Python reading messages: each one's from/to/cc (name, address), subject, attachment names and text. */
function pythonReads(raws) {
  const r = spawnSync('python3', ['-I', '-c', `
import sys, json, email
from email import policy
out = []
for raw in json.load(sys.stdin):
    m = email.message_from_bytes(raw.encode('latin-1'), policy=policy.default)
    who = lambda h: [{'name': a.display_name, 'address': a.addr_spec} for a in (m[h].addresses if m[h] else [])]
    body = m.get_body(('plain',))
    out.append({'from': who('from'), 'to': who('to'), 'cc': who('cc'), 'subject': str(m['subject'] or ''),
      'files': [p.get_filename() for p in m.iter_attachments()], 'text': body.get_content() if body else '',
      'defects': [type(d).__name__ for p in m.walk() for d in p.defects] + [type(d).__name__ for h in ('from', 'to', 'cc', 'subject') if m[h] for d in m[h].defects]})
print(json.dumps(out))
`], { input: JSON.stringify(raws), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('people on an address line as Mail puts them: each comes back whole, name and address', () => {
  for (let round = 0; round < 400; round++) {
    const list = people(1 + Math.floor(rnd() * 5));
    const line = list.map(formatAddress).join(', ');
    // the browser reading the line back (tips while writing, contact groups)
    const back = parseAddresses(line);
    assert.deepEqual(back.bad, [], line);
    assert.deepEqual(back.list.map((p) => [norm(p.name), p.email]), list.map((p) => [norm(p.name), p.email]), line);
    // the server reading it (what's sent)
    const sent = addressparser(line, { flatten: true });
    assert.deepEqual(sent.map((p) => [norm(p.name), p.address]), list.map((p) => [norm(p.name), p.email]), line);
  }
});

test('emails Workspace sends, read by Python: the same people, subject, attachment names and text', { skip: !python && 'no python3' }, async () => {
  const cases = [];
  for (let i = 0; i < 150; i++) {
    const from = people(1)[0];
    const to = people(1 + Math.floor(rnd() * 4)), cc = rnd() < 0.5 ? people(1 + Math.floor(rnd() * 3)) : [];
    const files = Array.from({ length: Math.floor(rnd() * 3) }, filename);
    const text = `${subject()}\n${'Zoë 山田 🙂 '.repeat(Math.floor(rnd() * 30))}\nend`;
    const asSent = (l) => addressparser(l.map(formatAddress).join(', '), { flatten: true }).map((a) => ({ name: a.name || '', address: a.address.toLowerCase() }));
    const mail = { from: { name: from.name, address: from.email }, to: asSent(to), cc: asSent(cc), subject: subject(), text,
      attachments: files.map((f, n) => ({ filename: f, content: `file ${n}`, contentType: 'application/octet-stream' })) };
    const raw = await new MailComposer(mail).compile().build();
    cases.push({ from, to, cc, files, text, subject: mail.subject, raw: raw.toString('latin1') });
  }
  const read = pythonReads(cases.map((c) => c.raw));
  for (const [i, c] of cases.entries()) {
    const r = read[i];
    const at = `message ${i}: ${c.raw.split('\r\n\r\n')[0]}`;
    assert.deepEqual(r.defects, [], at);
    assert.deepEqual(r.from.map((p) => [norm(p.name), p.address]), [[norm(c.from.name), c.from.email]], at);
    assert.deepEqual(r.to.map((p) => [norm(p.name), p.address]), c.to.map((p) => [norm(p.name), p.email]), at);
    assert.deepEqual(r.cc.map((p) => [norm(p.name), p.address]), c.cc.map((p) => [norm(p.name), p.email]), at);
    assert.equal(norm(r.subject), norm(c.subject), at);
    assert.deepEqual(r.files, c.files, at);
    assert.equal(r.text.replace(/\r?\n$/, '').replace(/\r\n/g, '\n'), c.text, at);
  }
});

test('emails Python writes, read the way Workspace reads one: the same people, subject, attachment names and text', { skip: !python && 'no python3' }, async () => {
  const cases = Array.from({ length: 150 }, () => ({ from: people(1)[0], to: people(1 + Math.floor(rnd() * 4)), subject: subject(),
    files: Array.from({ length: Math.floor(rnd() * 3) }, filename), text: `${subject()}\n${'ça va 🙂 '.repeat(Math.floor(rnd() * 30))}\nend` }));
  const r = spawnSync('python3', ['-I', '-c', `
import sys, json
from email.message import EmailMessage
from email.headerregistry import Address
from email import policy
out = []
for c in json.load(sys.stdin):
    m = EmailMessage(policy=policy.SMTP)
    addr = lambda p: Address(display_name=p['name'], addr_spec=p['email'])
    m['From'] = addr(c['from'])
    m['To'] = [addr(p) for p in c['to']]
    m['Subject'] = c['subject']
    m.set_content(c['text'])
    for n, f in enumerate(c['files']):
        m.add_attachment(('file %d' % n).encode(), maintype='application', subtype='octet-stream', filename=f)
    out.append(m.as_bytes().decode('latin-1'))
print(json.dumps(out))
`], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const raws = JSON.parse(r.stdout);
  for (const [i, c] of cases.entries()) {
    const p = await simpleParser(Buffer.from(raws[i], 'latin1'));
    const at = `message ${i}: ${raws[i].split('\r\n\r\n')[0]}`;
    const list = (f) => (f?.value || []).flatMap((a) => (a.group ? a.group : [a])).map((a) => [norm(a.name), a.address]);
    assert.deepEqual(list(p.from), [[norm(c.from.name), c.from.email]], at);
    assert.deepEqual(list(p.to), c.to.map((x) => [norm(x.name), x.email]), at);
    assert.equal(norm(p.subject), norm(c.subject), at);
    assert.deepEqual(p.attachments.map((a) => a.filename), c.files, at);
    assert.equal(p.text.replace(/\n$/, ''), c.text, at);
  }
});
