import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
// Made in another tab (or on another device), shown at once in an open app: for each app, without a reload.
let other;
const fresh = async (path) => { await page.goto(`${B}${path}`); await page.waitForTimeout(1500); await page.evaluate(() => { window.__stayed = true; }); };
const stayed = async () => { if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded'); };
await step('a second tab', async () => { other = await page.context().newPage(); await other.goto(B); });
const CASES = [
  ['Notes', '/notes', () => api(other, 'POST', '/notes', { title: 'Note from the phone', body: 'x' }), 'Note from the phone'],
  ['Contacts', '/contacts', () => api(other, 'POST', '/contacts', { name: 'Zed From-Phone', email: 'zed@example.com' }), 'Zed From-Phone'],
  ['Tasks: a list', '/tasks', () => api(other, 'POST', '/tasks/lists', { name: 'List from the phone' }), 'List from the phone'],
  ['Tasks: a task', '/tasks', async () => { const ls = (await api(other, 'GET', '/tasks/lists')).body; const l = (Array.isArray(ls) ? ls : ls.lists)[0]; return api(other, 'POST', `/tasks/lists/${l.id}/tasks`, { title: 'Task from the phone' }); }, 'Task from the phone'],
  ['Calendar', '/calendar', () => { const t = new Date(); t.setHours(10, 0, 0, 0); return api(other, 'POST', '/events', { title: 'Event from the phone', start: t.getTime(), end: t.getTime() + 36e5 }); }, 'Event from the phone'],
  ['Forms', '/forms', () => api(other, 'POST', '/forms', { title: 'Form from the phone' }), 'Form from the phone'],
  ['Chat: a channel', '/chat', () => api(other, 'POST', '/chat/channels', { name: 'from-the-phone' }), 'from-the-phone'],
];
for (const [label, path, make, text] of process.env.ONLY ? CASES.filter((c) => c[0] === process.env.ONLY) : CASES) {
  await step(`${label}: made in another tab, shown here at once`, async () => {
    await fresh(path);
    const r = await make();
    if (r.status >= 300) throw new Error(`could not make it: ${JSON.stringify(r.body).slice(0, 200)}`);
    await page.getByText(text, { exact: true }).first().waitFor({ timeout: 8000 });
    await stayed();
  });
}
// Changed or deleted in the other tab: renamed things show their new name, deleted ones go.
const gone = async (text) => { const end = Date.now() + 8000; while (await page.getByText(text, { exact: true }).count()) { if (Date.now() > end) throw new Error(`“${text}” still shown`); await page.waitForTimeout(200); } };
const find = async (url, pick) => { const b = (await api(other, 'GET', url)).body; return (Array.isArray(b) ? b : b.files || b.lists || b.channels || b.items || []).find(pick); };
const CHANGES = [
  ['Notes: renamed', '/notes', async () => { const n = await find('/notes', (x) => x.title === 'Note from the phone'); return api(other, 'PATCH', `/notes/${n.id}`, { title: 'Note renamed' }); }, 'Note renamed', 'Note from the phone'],
  ['Notes: deleted', '/notes', async () => { const n = await find('/notes', (x) => x.title === 'Note renamed'); return api(other, 'DELETE', `/notes/${n.id}`); }, null, 'Note renamed'],
  ['Contacts: renamed', '/contacts', async () => { const c = await find('/contacts', (x) => x.name === 'Zed From-Phone'); return api(other, 'PATCH', `/contacts/${c.id}`, { name: 'Zed Renamed' }); }, 'Zed Renamed', 'Zed From-Phone'],
  ['Contacts: deleted', '/contacts', async () => { const c = await find('/contacts', (x) => x.name === 'Zed Renamed'); return api(other, 'DELETE', `/contacts/${c.id}`); }, null, 'Zed Renamed'],
  ['Tasks: renamed', '/tasks', async () => { const ls = (await api(other, 'GET', '/tasks/lists')).body; const l = (Array.isArray(ls) ? ls : ls.lists)[0]; const ts = (await api(other, 'GET', `/tasks/lists/${l.id}/tasks`)).body; const t = (Array.isArray(ts) ? ts : ts.tasks).find((x) => x.title === 'Task from the phone'); return api(other, 'PATCH', `/tasks/tasks/${t.id}`, { title: 'Task renamed' }); }, 'Task renamed', 'Task from the phone'],
  ['Calendar: deleted', '/calendar', async () => { const t = new Date(); t.setHours(0, 0, 0, 0); const evs = (await api(other, 'GET', `/events?from=${t.getTime()}&to=${t.getTime() + 864e5}`)).body; const e = evs.find((x) => x.title === 'Event from the phone'); return api(other, 'DELETE', `/events/${e.id}`); }, null, 'Event from the phone'],
  ['Drive: renamed at the top', '/drive', async () => { const f = (await api(other, 'POST', '/files/folder', { name: 'Top folder' })).body; await page.locator('table.files').getByText('Top folder', { exact: true }).waitFor({ timeout: 8000 }); return api(other, 'PATCH', `/files/${f.id}`, { name: 'Top renamed' }); }, 'Top renamed', 'Top folder'],
  ['Drive: deleted at the top', '/drive', async () => { const f = (await api(other, 'GET', '/files')).body.find((x) => x.name === 'Top renamed'); return api(other, 'PATCH', `/files/${f.id}`, { trashed: true }); }, null, 'Top renamed'],
  ['Forms: deleted', '/forms', async () => { const f = (await api(other, 'GET', '/forms')).body.find((x) => x.title === 'Form from the phone'); return api(other, 'DELETE', `/forms/${f.id}`); }, null, 'Form from the phone'],
  ['Chat: channel renamed', '/chat', async () => { const c = (await api(other, 'GET', '/chat/channels')).body.channels.find((x) => x.name === 'from-the-phone'); return api(other, 'PATCH', `/chat/channels/${c.id}`, { name: 'renamed-on-phone' }); }, 'renamed-on-phone', 'from-the-phone'],
];
for (const [label, path, change, now, before] of process.env.ONLY ? CHANGES.filter((c) => c[0] === process.env.ONLY) : CHANGES) {
  await step(`${label} in another tab, shown here at once`, async () => {
    await fresh(path);
    if (before && path !== '/drive') await page.getByText(before, { exact: true }).first().waitFor({ timeout: 8000 });
    const r = await change();
    if (r.status >= 300) throw new Error(`could not change it: ${JSON.stringify(r.body).slice(0, 200)}`);
    if (now) await page.getByText(now, { exact: true }).first().waitFor({ timeout: 8000 });
    await gone(before);
    await stayed();
  });
}
// Home's cards (today's events, tasks for today, unread chat) keep up too.
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const HOME = [
  ['Home: an event today', async () => { const t = new Date(); t.setHours(23, 0, 0, 0); return api(other, 'POST', '/events', { title: 'Late call today', start: t.getTime(), end: t.getTime() + 30 * 6e4 }); }, 'Late call today'],
  ['Home: a task due today', async () => { const ls = (await api(other, 'GET', '/tasks/lists')).body; const l = (Array.isArray(ls) ? ls : ls.lists)[0]; return api(other, 'POST', `/tasks/lists/${l.id}/tasks`, { title: 'Due today task', due: today() }); }, 'Due today task'],
  ['Home: a chat message for me', async () => {
    const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
    const k = await page.context().browser().newContext().then((c) => c.newPage());
    await k.goto(B); await k.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
    const me = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'olivia@acme.com');
    const dm = (await api(k, 'POST', '/chat/dm', { user_id: me.id })).body.id;
    return api(k, 'POST', `/chat/channels/${dm}/messages`, { body: 'Ping from Kim' });
  }, 'UNREAD:Kim Park'],
];
for (const [label, make, text] of process.env.ONLY ? HOME.filter((c) => c[0] === process.env.ONLY) : HOME) {
  await step(`${label}: shows on an open Home at once`, async () => {
    await fresh('/home');
    const r = await make();
    if (r.status >= 300) throw new Error(`could not make it: ${JSON.stringify(r.body).slice(0, 200)}`);
    if (text.startsWith('UNREAD:')) await page.getByRole('region', { name: 'Unread' }).getByRole('link', { name: text.slice(7) }).waitFor({ timeout: 8000 }); // the card lists conversations
    else await page.getByText(text).first().waitFor({ timeout: 8000 });
    await stayed();
  });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
