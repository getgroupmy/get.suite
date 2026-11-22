// Chat polls: anonymous (counts only: nobody sees who chose what) and closing by themselves at a set time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-chatpolls-'));
process.env.DATA_DIR = dir;
let server, base;
before(async () => {
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const login = async (who, email) => assert.equal((await who('POST', '/api/auth/login', { username: email, password: 'password123' })).status, 200);
let ann, ben, ch;
test('set up', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Bell', password: 'password123' })).status, 201);
  ben = client(); await login(ben, 'ben@acme.com');
  ch = (await ann('POST', '/api/chat/channels', { name: 'team' })).body.id;
});

test('anonymous: everyone sees how many chose each option, nobody who; you see your own choice', async () => {
  const poll = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Is the workload OK?', options: ['Yes', 'Too much'], anonymous: true } })).body;
  assert.equal(poll.poll.anonymous, true);
  const v = (await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] })).body;
  assert.deepEqual(v.poll.mine, ['o2'], 'the voter’s own choice, in the answer to their vote');
  await ann('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o1'] });
  const seenBy = async (who) => (await who('GET', `/api/chat/channels/${ch}/messages`)).body.find((m) => m.id === poll.id).poll;
  for (const [who, mine] of [[ann, ['o1']], [ben, ['o2']]]) {
    const p = await seenBy(who);
    assert.deepEqual(p.options.map((o) => [o.count, o.votes.length]), [[1, 0], [1, 0]], 'counts, no names');
    assert.deepEqual(p.mine, mine);
    assert.equal(p.voters, 2);
  }
  assert.ok(!JSON.stringify(await seenBy(ann)).includes('Ben Bell'), 'not even the asker');
  // The conversation's download: counts.
  const txt = await fetch(`${base}/api/chat/channels/${ch}/export?format=txt`, { headers: { cookie: (await (async () => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ann@acme.com', password: 'password123' }) }); return r.headers.get('set-cookie').split(';')[0]; })()) } }).then((r) => r.text());
  assert.match(txt, /Is the workload OK\? — Yes 1, Too much 1/);
  // An ordinary poll still says who.
  const open = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Lunch?', options: ['Pizza', 'Sushi'] } })).body;
  await ben('POST', `/api/chat/messages/${open.id}/vote`, { options: ['o1'] });
  assert.deepEqual((await seenBy(ann).then(() => ann('GET', `/api/chat/channels/${ch}/messages`))).body.find((m) => m.id === open.id).poll.options[0].votes.map((x) => x.name), ['Ben Bell']);
});

test('closing by itself: votes until then, closed after; reopening clears a passed closing time', async () => {
  assert.equal((await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'x', options: ['a', 'b'], closes_at: Date.now() + 1000 } })).status, 400, 'too soon');
  const closesAt = Date.now() + 61e3;
  const poll = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Friday drinks?', options: ['Yes', 'No'], closes_at: closesAt } })).body;
  assert.equal(poll.poll.closes_at, closesAt);
  assert.equal(poll.poll.closed_at, undefined);
  assert.equal((await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o1'] })).status, 200);
  // Its time passes (made so here: the stored closing time moved into the past).
  const { q } = await import('../src/db.js');
  const stored = JSON.parse(q('SELECT poll FROM messages WHERE id = ?').get(poll.id).poll);
  q('UPDATE messages SET poll = ? WHERE id = ?').run(JSON.stringify({ ...stored, closes_at: Date.now() - 1000 }), poll.id);
  const p = (await ben('GET', `/api/chat/channels/${ch}/messages`)).body.find((m) => m.id === poll.id).poll;
  assert.ok(p.closed_at, 'shown closed');
  const late = await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] });
  assert.equal(late.status, 400); assert.match(late.body.error, /closed/);
  // Reopened by whoever asked: open for good (its passed closing time gone).
  assert.equal((await ann('POST', `/api/chat/messages/${poll.id}/poll/close`, { closed: false })).status, 200);
  assert.equal((await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] })).status, 200);
});

test('when its time comes: closed for everyone, and whoever asked gets the result in the bell (not after closing it by hand)', async () => {
  const { sendDueChat } = await import('../src/routes/chat.js');
  const bell = async (who) => { const b = (await who('GET', '/api/notifications')).body; return b.items || b.notifications || b; };
  const closesAt = Date.now() + 61e3;
  const poll = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Team lunch day?', options: ['Tue', 'Thu'], closes_at: closesAt, anonymous: true } })).body;
  await ben('POST', `/api/chat/messages/${poll.id}/vote`, { options: ['o2'] });
  sendDueChat(closesAt - 5000);
  assert.ok(!(await bell(ann)).some((n) => /Team lunch day/.test(n.title)), 'not yet');
  sendDueChat(closesAt + 1000);
  const n = (await bell(ann)).find((x) => x.title === 'Poll closed: Team lunch day?');
  assert.ok(n);
  assert.equal(n.body, 'Tue 0, Thu 1 · 1 person voted');
  assert.equal(n.link, `/chat/${ch}?msg=${poll.id}`);
  const { q } = await import('../src/db.js');
  assert.equal(JSON.parse(q('SELECT poll FROM messages WHERE id = ?').get(poll.id).poll).closed_at, closesAt, 'stored closed');
  sendDueChat(closesAt + 60e3);
  assert.equal((await bell(ann)).filter((x) => x.title === 'Poll closed: Team lunch day?').length, 1, 'told once');
  // Closed by hand first: nothing more when its time comes.
  const at2 = Date.now() + 61e3;
  const p2 = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Snacks?', options: ['Fruit', 'Crisps'], closes_at: at2 } })).body;
  await ann('POST', `/api/chat/messages/${p2.id}/poll/close`, {});
  sendDueChat(at2 + 1000);
  assert.ok(!(await bell(ann)).some((x) => /Snacks/.test(x.title)));
});

test('others can add options (when the poll lets them): while it’s open, no repeats, up to ten', async () => {
  const p = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Where for the offsite?', options: ['Lisbon', 'Porto'], add_options: true } })).body;
  assert.equal(p.poll.add_options, true);
  const r = await ben('POST', `/api/chat/messages/${p.id}/poll/options`, { text: 'Madrid' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.poll.options.map((o) => [o.id, o.text]), [['o1', 'Lisbon'], ['o2', 'Porto'], ['o3', 'Madrid']]);
  assert.equal((await ben('POST', `/api/chat/messages/${p.id}/vote`, { options: ['o3'] })).status, 200, 'and voted for');
  assert.equal((await ann('POST', `/api/chat/messages/${p.id}/poll/options`, { text: ' madrid ' })).status, 400, 'already there');
  for (const t of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) await ann('POST', `/api/chat/messages/${p.id}/poll/options`, { text: t });
  assert.match((await ben('POST', `/api/chat/messages/${p.id}/poll/options`, { text: 'H' })).body.error, /At most 10/);
  await ann('POST', `/api/chat/messages/${p.id}/poll/close`, {});
  // A poll that doesn't let others: only whoever asked; a closed one: nobody.
  const fixed = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Fixed?', options: ['a', 'b'] } })).body;
  assert.equal((await ben('POST', `/api/chat/messages/${fixed.id}/poll/options`, { text: 'c' })).status, 403);
  assert.equal((await ann('POST', `/api/chat/messages/${p.id}/poll/options`, { text: 'Late' })).status, 400);
});

test('results in Sheets: a row per option with votes, share and who; an anonymous poll without who', async () => {
  const p = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Where to?', options: ['Lisbon', 'Porto', 'Faro'] } })).body;
  await ann('POST', `/api/chat/messages/${p.id}/vote`, { options: ['o1'] });
  await ben('POST', `/api/chat/messages/${p.id}/vote`, { options: ['o1'] });
  const r = await ben('POST', `/api/chat/messages/${p.id}/poll/sheet`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Where to? (poll)');
  const sh = (await ben('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  const row = (n) => ['A', 'B', 'C', 'D'].map((c) => sh.cells[`${c}${n}`] || '');
  assert.deepEqual(row(1), ['Option', 'Votes', 'Share', 'Who']);
  assert.deepEqual(row(2), ['Lisbon', '2', '1', 'Ann Owner, Ben Bell']);
  assert.deepEqual(row(3), ['Porto', '0', '0', '']);
  assert.equal(row(5)[0], '2 people voted');
  assert.deepEqual(sh.formats.C2, { num: 'percent', dp: 0 });
  // Anonymous: no Who column.
  const anon = (await ann('POST', `/api/chat/channels/${ch}/messages`, { poll: { question: 'Happy?', options: ['Yes', 'No'], anonymous: true } })).body;
  await ben('POST', `/api/chat/messages/${anon.id}/vote`, { options: ['o2'] });
  const a = (await ann('GET', `/api/files/${(await ann('POST', `/api/chat/messages/${anon.id}/poll/sheet`, {})).body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([a.cells.D1, a.cells.B3, JSON.stringify(a.cells).includes('Ben')], [undefined, '1', false]);
  // Not a poll; not your conversation.
  const plain = (await ann('POST', `/api/chat/channels/${ch}/messages`, { body: 'hi' })).body;
  assert.equal((await ann('POST', `/api/chat/messages/${plain.id}/poll/sheet`, {})).status, 404);
  const secret = (await ann('POST', '/api/chat/channels', { name: 'ann-only-polls', private: true })).body.id;
  const hidden = (await ann('POST', `/api/chat/channels/${secret}/messages`, { poll: { question: 'Secret?', options: ['a', 'b'] } })).body;
  assert.equal((await ben('POST', `/api/chat/messages/${hidden.id}/poll/sheet`, {})).status, 404);
});
