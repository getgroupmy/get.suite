import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-extshares-'));
const { createApp } = await import('../src/app.js');
const { q } = await import('../src/db.js');

let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
function client() {
  let cookie = '';
  return async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', ...(!raw && { 'content-type': 'application/json' }), ...(cookie && { cookie }) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text, type: r.headers.get('content-type') };
  };
}
const ana = client(), kim = client(), gil = client(), ivy = client();
const id = (u) => q('SELECT id FROM users WHERE username = ?').get(u).id;

test('Admin → Shared outside: what the company shares with other companies, and stopping it', async () => {
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const globex = (await ana('POST', '/api/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gil', admin_local: 'gil', admin_password: 'password123' })).body;
  const initech = (await ana('POST', '/api/orgs', { name: 'Initech', domain: 'initech.com', admin_name: 'Ivy', admin_local: 'ivy', admin_password: 'password123' })).body;
  for (const [c, u] of [[kim, 'kim@acme.com'], [gil, 'gil@globex.com'], [ivy, 'ivy@initech.com']]) await c('POST', '/api/auth/login', { username: u, password: 'password123' });
  const folder = (await kim('POST', '/api/files/folder', { name: 'Joint project' })).body;
  const plan = (await kim('POST', '/api/files/upload?name=plan.txt', 'the plan', true)).body;
  const memo = (await kim('POST', '/api/files/upload?name=memo.txt', 'internal', true)).body;
  assert.equal((await kim('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'editor' }] })).status, 200);
  assert.equal((await kim('PUT', `/api/files/${plan.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer' }, { user_id: id('ivy@initech.com'), role: 'viewer' }] })).status, 200);
  assert.equal((await kim('PUT', `/api/files/${memo.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor' }] })).status, 200);

  assert.equal((await kim('GET', '/api/external-shares')).status, 403, 'admins only');
  const r = (await ana('GET', '/api/external-shares')).body;
  assert.deepEqual(r.items.map((x) => [x.with_company, x.file_name, x.with_email, x.role, x.owner_name]), [
    ['Globex', 'Joint project', 'gil@globex.com', 'editor', 'Kim Park'],
    ['Globex', 'plan.txt', 'gil@globex.com', 'viewer', 'Kim Park'],
    ['Initech', 'plan.txt', 'ivy@initech.com', 'viewer', 'Kim Park'],
  ], 'not the memo shared inside the company');
  assert.deepEqual(r.companies.map((c) => [c.name, c.items, c.people]), [['Globex', 2, 1], ['Initech', 1, 1]]);
  // Globex's admin sees nothing of Acme's (it's what *their* company shares out).
  assert.deepEqual((await gil('GET', '/api/external-shares')).body.items, []);

  // The security checkup points here.
  const { checkup } = await import('../src/checkup.js');
  const orgId = q("SELECT org_id FROM users WHERE username = 'ana@acme.com'").get().org_id;
  const item = (await checkup(orgId, Date.now(), { mail: false })).find((x) => x.id === 'outside');
  assert.equal(item.title, '2 files and folders shared with people at 2 other companies');
  assert.match(item.detail, /^Globex, Initech; 1 of them they can edit\./);
  assert.equal(item.tab, 'outside');
  assert.deepEqual(item.fix, { label: 'Limit outside shares to 90 days', settings: { external_share_days: 90 } }, 'no limit yet: offered');
  q('UPDATE orgs SET external_share_days = 30 WHERE id = ?').run(orgId);
  assert.equal((await checkup(orgId, Date.now(), { mail: false })).find((x) => x.id === 'outside').fix, undefined, 'with a limit: not');
  q('UPDATE orgs SET external_share_days = NULL WHERE id = ?').run(orgId);
  // A spreadsheet of it, for an audit; admins only.
  const csv = await ana('GET', '/api/external-shares/export.csv');
  assert.match(csv.type, /text\/csv/);
  const lines = csv.text.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines[0], 'File or folder,Kind,Shared by,Their email,With,Email,Company,Access,Until (UTC),In the trash');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], 'Joint project,folder,Kim Park,kim@acme.com,Gil,gil@globex.com,Globex,Can edit,,no');
  assert.equal((await kim('GET', '/api/external-shares/export.csv')).status, 403);
  // The same rows in a new spreadsheet of the admin's.
  assert.equal((await kim('POST', '/api/external-shares/sheet', {})).status, 403);
  const sheet = await ana('POST', '/api/external-shares/sheet', {});
  assert.equal(sheet.status, 201, JSON.stringify(sheet.body));
  assert.match(sheet.body.name, /^Shared outside \d{4}-\d{2}-\d{2}/);
  assert.equal(sheet.body.shares, 3);
  const cells = (await ana('GET', `/api/files/${sheet.body.id}/content`)).body.content.sheets[0].cells;
  assert.deepEqual(['A1', 'G1', 'H1'].map((k) => cells[k]), ['File or folder', 'Company', 'Access']);
  assert.deepEqual(['A2', 'C2', 'F2', 'G2', 'H2'].map((k) => cells[k]), ['Joint project', 'Kim Park', 'gil@globex.com', 'Globex', 'Can edit']);
  // Stop one: Ivy can't open the plan any more; Kim is told.
  assert.equal((await ivy('GET', `/api/files/${plan.id}/raw`)).status, 200);
  assert.equal((await ana('DELETE', `/api/external-shares/${plan.id}/${id('ivy@initech.com')}`)).status, 200);
  assert.equal((await ivy('GET', `/api/files/${plan.id}/raw`)).status, 404);
  assert.equal((await ana('DELETE', `/api/external-shares/${plan.id}/${id('ivy@initech.com')}`)).status, 404, 'gone already');
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'An admin stopped sharing “plan.txt” outside the company'").get(id('kim@acme.com')));
  // An inside share can't be stopped this way.
  assert.equal((await ana('DELETE', `/api/external-shares/${memo.id}/${id('ana@acme.com')}`)).status, 404);

  // Stop everything with Globex.
  assert.equal((await ana('POST', '/api/external-shares/stop-company', { org_id: globex.id })).body.stopped, 2);
  assert.equal((await gil('GET', `/api/files/${folder.id}`)).status, 404);
  assert.deepEqual((await ana('GET', '/api/external-shares')).body.items, []);
  assert.equal((await ana('POST', '/api/external-shares/stop-company', { org_id: initech.id })).status, 404);
  assert.equal((await ana('GET', `/api/files/${memo.id}`)).status, 200, 'inside shares untouched');
  // In the activity log, in words.
  const log = (await ana('GET', '/api/audit?action=file')).body.entries;
  assert.ok(log.some((e) => e.label === 'Changed sharing' && e.details?.by_admin && e.details?.company));
});

test('Drive → Shared by me: your files others can open, and with whom, in words', async () => {
  const mine = async () => (await kim('GET', '/api/files?view=sharedbyme')).body.map((f) => [f.name, f.shared_with]);
  // After the admin stopped the outside shares above, only the memo (shared with Ana) is left.
  assert.deepEqual(await mine(), [['memo.txt', ['Ana Admin']]]);
  const deck = (await kim('POST', '/api/files/upload?name=deck.txt', 'deck', true)).body;
  const group = (await ana('POST', '/api/groups', { name: 'Design' })).body;
  assert.equal((await kim('PUT', `/api/files/${deck.id}/groups`, { groups: [{ group_id: group.id, role: 'viewer' }] })).status, 200);
  assert.equal((await kim('PUT', `/api/files/${deck.id}/company`, { role: 'viewer' })).status, 200);
  assert.equal((await kim('PUT', `/api/files/${deck.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer' }] })).status, 200);
  assert.deepEqual(await mine(), [['deck.txt', ['Everyone at Acme', 'Design (group)', 'Gil (outside)']], ['memo.txt', ['Ana Admin']]]);
  // A share that has ended doesn't count; nor does what isn't yours.
  q('UPDATE shares SET expires_at = ? WHERE file_id = ?').run(Date.now() - 1000, (await kim('GET', '/api/files?view=sharedbyme')).body.find((f) => f.name === 'memo.txt').id);
  assert.deepEqual((await mine()).map((x) => x[0]), ['deck.txt']);
  assert.deepEqual((await ana('GET', '/api/files?view=sharedbyme')).body, []);
});

test('Home → Shared with you: what people shared with you directly lately, who and when', async () => {
  const recent = async (c) => (await c('GET', '/api/files/shared-recently')).body.map((f) => [f.name, f.by_name, f.role]);
  const report = (await kim('POST', '/api/files/upload?name=report.txt', 'r', true)).body;
  const sheet = (await kim('POST', '/api/files/upload?name=numbers.csv', 'n', true)).body;
  await kim('PUT', `/api/files/${report.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor' }] });
  await kim('PUT', `/api/files/${sheet.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer' }] });
  assert.deepEqual((await recent(ana)).slice(0, 2), [['numbers.csv', 'Kim Park', 'viewer'], ['report.txt', 'Kim Park', 'editor']]);
  // Saving the sharing again (a role changed) keeps when it was first shared.
  const first = q('SELECT shared_at FROM shares WHERE file_id = ? AND user_id = ?').get(report.id, id('ana@acme.com')).shared_at;
  await new Promise((r) => setTimeout(r, 5));
  await kim('PUT', `/api/files/${report.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer' }] });
  assert.equal(q('SELECT shared_at FROM shares WHERE file_id = ? AND user_id = ?').get(report.id, id('ana@acme.com')).shared_at, first);
  // Older than two weeks, in the trash, or no longer shared: not listed. The owner sees none of it.
  q('UPDATE shares SET shared_at = ? WHERE file_id = ?').run(Date.now() - 15 * 864e5, sheet.id);
  await kim('PUT', `/api/files/${report.id}/shares`, { shares: [] });
  assert.deepEqual((await recent(ana)).filter(([n]) => ['numbers.csv', 'report.txt'].includes(n)), []);
  assert.deepEqual(await recent(kim), []);
  // It's a Home card (in the layout list).
  const { HOME_CARDS } = await import('../src/auth.js');
  assert.ok(HOME_CARDS.includes('sharedwithyou'));
});

test('Drive → Shared with me: newest shared first, with who shared it and when', async () => {
  const a = (await kim('POST', '/api/files/upload?name=alpha.txt', 'a', true)).body;
  const z = (await kim('POST', '/api/files/upload?name=zulu.txt', 'z', true)).body;
  await kim('PUT', `/api/files/${a.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer' }] });
  await new Promise((r) => setTimeout(r, 5));
  await kim('PUT', `/api/files/${z.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer' }] });
  const list = (await ana('GET', '/api/files?view=shared')).body;
  assert.deepEqual(list.slice(0, 2).map((f) => [f.name, f.shared_by_name]), [['zulu.txt', 'Kim Park'], ['alpha.txt', 'Kim Park']], 'zulu shared last: first, though z comes after a');
  assert.ok(list[0].shared_at >= list[1].shared_at);
  // Older shares (no time known) come after, by name.
  q('UPDATE shares SET shared_at = NULL WHERE file_id = ?').run(z.id);
  const again = (await ana('GET', '/api/files?view=shared')).body.map((f) => f.name);
  assert.ok(again.indexOf('alpha.txt') < again.indexOf('zulu.txt'));
});

test('Remove from Shared with me: off a direct share; a group or company share stays', async () => {
  const doc = (await kim('POST', '/api/files/upload?name=minutes.txt', 'm', true)).body;
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor' }, { user_id: id('gil@globex.com'), role: 'viewer' }] });
  const shared = async () => (await ana('GET', '/api/files?view=shared')).body.find((f) => f.name === 'minutes.txt');
  assert.equal((await shared()).direct, 1);
  const r = await ana('DELETE', `/api/files/${doc.id}/my-access`);
  assert.deepEqual(r.body, { removed: true, still: null });
  assert.equal(await shared(), undefined);
  assert.equal((await ana('GET', `/api/files/${doc.id}`)).status, 404, 'no access');
  assert.equal((await gil('GET', `/api/files/${doc.id}`)).status, 200, 'others keep theirs');
  assert.equal((await ana('DELETE', `/api/files/${doc.id}/my-access`)).status, 404, 'not shared any more');
  assert.equal((await kim('DELETE', `/api/files/${doc.id}/my-access`)).status, 404, 'the owner has no share to leave');
  // Also shared with the whole company: it's still there for her, and she's told.
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor' }] });
  await kim('PUT', `/api/files/${doc.id}/company`, { role: 'viewer' });
  assert.equal((await ana('DELETE', `/api/files/${doc.id}/my-access`)).body.still, 'viewer');
  assert.ok((await shared()), 'still listed, through the company');
  assert.equal(!!(await shared()).direct, false);
});

test('Stop sharing several at once: people, groups and the whole company; only your own', async () => {
  const a = (await kim('POST', '/api/files/upload?name=u1.txt', 'a', true)).body;
  const b = (await kim('POST', '/api/files/upload?name=u2.txt', 'b', true)).body;
  const c = (await kim('POST', '/api/files/upload?name=u3.txt', 'c', true)).body; // never shared
  await kim('PUT', `/api/files/${a.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor' }] });
  const group = (await ana('GET', '/api/groups')).body.find((g) => g.name === 'Design');
  await kim('PUT', `/api/files/${b.id}/groups`, { groups: [{ group_id: group.id, role: 'viewer' }] });
  await kim('PUT', `/api/files/${b.id}/company`, { role: 'viewer' });
  const link = (await kim('POST', '/api/links', { file_id: a.id })).body;
  assert.equal((await ana('POST', '/api/files/unshare', { ids: [a.id] })).status, 404, 'not hers');
  const r = await kim('POST', '/api/files/unshare', { ids: [a.id, b.id, c.id] });
  assert.deepEqual([r.body.files, r.body.people, typeof r.body.undo], [2, 1, 'string']);
  assert.equal((await ana('GET', `/api/files/${a.id}`)).status, 404);
  assert.equal((await ana('GET', `/api/files/${b.id}`)).status, 404, 'company and group access gone too');
  assert.equal(q('SELECT COUNT(*) AS n FROM group_shares WHERE file_id = ?').get(b.id).n, 0);
  assert.equal(q('SELECT org_role FROM files WHERE id = ?').get(b.id).org_role, null);
  assert.ok(q('SELECT 1 FROM share_links WHERE id = ?').get(link.id), 'links stay');
  assert.deepEqual((await kim('GET', '/api/files?view=sharedbyme')).body.filter((f) => ['u1.txt', 'u2.txt'].includes(f.name)), []);
  assert.equal((await kim('POST', '/api/files/unshare', { ids: [] })).status, 400);
});

test('a company limit on shares with other companies: they end within its days', async () => {
  const doc = (await kim('POST', '/api/files/upload?name=limited.txt', 'l', true)).body;
  assert.equal((await ana('PATCH', '/api/orgs/current', { external_share_days: 400 })).status, 400);
  assert.equal((await ana('PATCH', '/api/orgs/current', { external_share_days: 30 })).body.external_share_days, 30);
  assert.equal((await kim('PATCH', '/api/orgs/current', { external_share_days: null })).status, 403, 'admins only');
  const now = Date.now();
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer' }, { user_id: id('ana@acme.com'), role: 'editor' }] });
  const end = (u) => q('SELECT expires_at FROM shares WHERE file_id = ? AND user_id = ?').get(doc.id, id(u))?.expires_at;
  const gilEnd = end('gil@globex.com');
  assert.ok(gilEnd >= now + 30 * 864e5 - 5000 && gilEnd <= Date.now() + 30 * 864e5, 'outside: ends in 30 days');
  assert.equal(end('ana@acme.com'), null, 'inside the company: no limit');
  // A sooner end that's asked for stays; a later one is cut to the limit.
  const soon = Date.now() + 5 * 864e5;
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer', expires_at: soon }] });
  assert.equal(end('gil@globex.com'), soon);
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer', expires_at: Date.now() + 200 * 864e5 }] });
  assert.ok(end('gil@globex.com') <= Date.now() + 30 * 864e5);
  // Saving again without a date (a role change) keeps the end it has; it isn't pushed later each time.
  const was = end('gil@globex.com');
  await new Promise((r) => setTimeout(r, 5));
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'editor' }] });
  assert.equal(end('gil@globex.com'), was);
  await ana('PATCH', '/api/orgs/current', { external_share_days: null });
});

test('apply the limit to existing outside shares: they end within it; owners told; needs a limit', async () => {
  const old = (await kim('POST', '/api/files/upload?name=old-share.txt', 'o', true)).body;
  await kim('PUT', `/api/files/${old.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer' }, { user_id: id('ana@acme.com'), role: 'viewer' }] });
  const end = (u) => q('SELECT expires_at FROM shares WHERE file_id = ? AND user_id = ?').get(old.id, id(u))?.expires_at;
  assert.equal(end('gil@globex.com'), null, 'made while there was no limit');
  assert.equal((await ana('POST', '/api/external-shares/enforce')).status, 400, 'no limit set');
  await ana('PATCH', '/api/orgs/current', { external_share_days: 7 });
  assert.equal((await kim('POST', '/api/external-shares/enforce')).status, 403);
  const r = (await ana('POST', '/api/external-shares/enforce')).body;
  assert.ok(r.changed >= 1);
  assert.ok(Math.abs(end('gil@globex.com') - (Date.now() + 7 * 864e5)) < 10000);
  assert.equal(end('ana@acme.com'), null, 'colleagues untouched');
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Your files shared outside the company now end in 7 days'").get(id('kim@acme.com')));
  assert.equal((await ana('POST', '/api/external-shares/enforce')).body.changed, 0, 'nothing left to change');
  await ana('PATCH', '/api/orgs/current', { external_share_days: null });
});

test('a few days before someone’s access ends: they and the owner are told, once per end date', async () => {
  const { warnEndingShares, WARN_DAYS } = await import('../src/shareexpiry.js');
  const doc = (await kim('POST', '/api/files/upload?name=ending.txt', 'e', true)).body;
  const now = Date.now();
  const soon = now + 2 * 864e5, later = now + 10 * 864e5;
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer', expires_at: soon }, { user_id: id('gil@globex.com'), role: 'viewer', expires_at: later }] });
  const told = (u, like) => q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE ?').get(id(u), like).n;
  assert.equal(WARN_DAYS, 3);
  warnEndingShares(now); // (earlier tests' shares may be warned about too)
  assert.equal(told('ana@acme.com', 'Your access to “ending.txt” ends %'), 1);
  assert.equal(told('kim@acme.com', "Ana Admin's access to “ending.txt” ends %"), 1);
  assert.equal(told('gil@globex.com', 'Your access to “ending.txt” ends %'), 0, 'not yet');
  warnEndingShares(now + 60e3);
  assert.equal(told('ana@acme.com', 'Your access to “ending.txt” ends %'), 1, 'once');
  // Given longer, then nearly up again: warned again for the new end.
  const newEnd = now + 5 * 864e5;
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer', expires_at: newEnd }, { user_id: id('gil@globex.com'), role: 'viewer', expires_at: later }] });
  warnEndingShares(now);
  assert.equal(told('ana@acme.com', 'Your access to “ending.txt” ends %'), 1, 'more than 3 days away now');
  warnEndingShares(newEnd - 864e5);
  assert.equal(told('ana@acme.com', 'Your access to “ending.txt” ends %'), 2);
  // Gil's turn comes too.
  warnEndingShares(later - 2 * 864e5);
  assert.equal(told('gil@globex.com', 'Your access to “ending.txt” ends %'), 1);
});

test('ask for longer: the owner says yes (30 more days, or within the outside limit) or no', async () => {
  const doc = (await kim('POST', '/api/files/upload?name=keep.txt', 'k', true)).body;
  const soon = Date.now() + 2 * 864e5;
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor', expires_at: soon }, { user_id: id('gil@globex.com'), role: 'viewer', expires_at: soon }] });
  const end = (u) => q('SELECT expires_at FROM shares WHERE file_id = ? AND user_id = ?').get(doc.id, id(u))?.expires_at;
  // Only with a share that ends by date.
  const other = (await kim('POST', '/api/files/upload?name=forever.txt', 'f', true)).body;
  await kim('PUT', `/api/files/${other.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'viewer' }] });
  assert.equal((await ana('POST', `/api/files/${other.id}/ask-longer`, {})).status, 404);
  assert.equal((await ana('POST', `/api/files/${doc.id}/ask-longer`, { message: 'Still editing it' })).status, 200);
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Ana Admin asks to keep “keep.txt” after %'").get(id('kim@acme.com')));
  const reqs = (await kim('GET', '/api/files/access-requests')).body.filter((r) => r.file_name === 'keep.txt');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].longer, 1);
  assert.equal(reqs[0].ends_at, soon);
  assert.equal((await kim('POST', `/api/files/access-requests/${reqs[0].id}`, { approve: true })).status, 200);
  assert.ok(Math.abs(end('ana@acme.com') - (Date.now() + 30 * 864e5)) < 10000, '30 more days');
  assert.equal(q("SELECT role FROM shares WHERE file_id = ? AND user_id = ?").get(doc.id, id('ana@acme.com')).role, 'editor', 'same access');
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'You can keep “keep.txt” until %'").get(id('ana@acme.com')));
  // Someone outside, with a 7-day company limit: 30 asked, 7 given.
  await ana('PATCH', '/api/orgs/current', { external_share_days: 7 });
  await gil('POST', `/api/files/${doc.id}/ask-longer`, {});
  const g = (await kim('GET', '/api/files/access-requests')).body.find((r) => r.file_name === 'keep.txt');
  await kim('POST', `/api/files/access-requests/${g.id}`, { approve: true, days: 30 });
  assert.ok(Math.abs(end('gil@globex.com') - (Date.now() + 7 * 864e5)) < 10000, 'within the limit');
  await ana('PATCH', '/api/orgs/current', { external_share_days: null });
  // No: the end stays.
  await ana('POST', `/api/files/${doc.id}/ask-longer`, {});
  const before = end('ana@acme.com');
  const n = (await kim('GET', '/api/files/access-requests')).body.find((r) => r.file_name === 'keep.txt');
  await kim('POST', `/api/files/access-requests/${n.id}`, { approve: false });
  assert.equal(end('ana@acme.com'), before);
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Kim Park didn’t give you longer with “keep.txt”'").get(id('ana@acme.com')));
});

test('Undo Stop sharing: people (with their access and end), groups and the company come back; once, by you', async () => {
  const a = (await kim('POST', '/api/files/upload?name=undo-a.txt', 'a', true)).body;
  const end = Date.now() + 20 * 864e5;
  await kim('PUT', `/api/files/${a.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor', expires_at: end }] });
  const group = (await ana('GET', '/api/groups')).body.find((g) => g.name === 'Design');
  await kim('PUT', `/api/files/${a.id}/groups`, { groups: [{ group_id: group.id, role: 'viewer' }] });
  await kim('PUT', `/api/files/${a.id}/company`, { role: 'viewer' });
  const r = (await kim('POST', '/api/files/unshare', { ids: [a.id] })).body;
  assert.ok(r.undo);
  assert.equal((await ana('GET', `/api/files/${a.id}`)).status, 404);
  assert.equal((await ana('POST', '/api/files/unshare/undo', { undo: r.undo })).status, 404, 'not hers to undo');
  assert.deepEqual((await kim('POST', '/api/files/unshare/undo', { undo: r.undo })).body, { files: 1 });
  const s = q('SELECT direct_role, expires_at FROM shares WHERE file_id = ? AND user_id = ?').get(a.id, id('ana@acme.com'));
  assert.deepEqual([s.direct_role, s.expires_at], ['editor', end]);
  assert.equal(q('SELECT role FROM group_shares WHERE file_id = ?').get(a.id).role, 'viewer');
  assert.equal(q('SELECT org_role FROM files WHERE id = ?').get(a.id).org_role, 'viewer');
  assert.equal((await ana('GET', `/api/files/${a.id}`)).status, 200);
  assert.equal((await kim('POST', '/api/files/unshare/undo', { undo: r.undo })).status, 404, 'once');
  // Nothing was shared: nothing to undo.
  const b = (await kim('POST', '/api/files/upload?name=undo-b.txt', 'b', true)).body;
  assert.equal((await kim('POST', '/api/files/unshare', { ids: [b.id] })).body.undo, null);
});

test('Admin → Shared outside: Undo a Stop puts the shares back; once, by that admin; owners told', async () => {
  const doc = (await kim('POST', '/api/files/upload?name=undo-outside.txt', 'u', true)).body;
  const until = Date.now() + 9 * 864e5;
  await kim('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'editor', expires_at: until }] });
  const orgId = q('SELECT org_id FROM users WHERE id = ?').get(id('gil@globex.com')).org_id;
  const r = (await ana('POST', '/api/external-shares/stop-company', { org_id: orgId })).body;
  assert.ok(r.stopped >= 1 && r.undo);
  assert.equal((await gil('GET', `/api/files/${doc.id}`)).status, 404);
  assert.equal((await kim('POST', '/api/external-shares/undo', { undo: r.undo })).status, 403, 'admins only');
  const back = (await ana('POST', '/api/external-shares/undo', { undo: r.undo })).body;
  assert.equal(back.restored, r.stopped);
  const s = q('SELECT direct_role, expires_at FROM shares WHERE file_id = ? AND user_id = ?').get(doc.id, id('gil@globex.com'));
  assert.deepEqual([s.direct_role, s.expires_at], ['editor', until]);
  assert.equal((await gil('GET', `/api/files/${doc.id}`)).status, 200);
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'An admin put back sharing of %'").get(id('kim@acme.com')));
  assert.equal((await ana('POST', '/api/external-shares/undo', { undo: r.undo })).status, 404, 'once');
  // One share: the same.
  const one = (await ana('DELETE', `/api/external-shares/${doc.id}/${id('gil@globex.com')}`)).body;
  assert.equal((await ana('POST', '/api/external-shares/undo', { undo: one.undo })).body.restored, 1);
});
