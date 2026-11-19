// A company with a lot in it: the endpoints behind each app's main screen still answer quickly, and the
// screens show it. 1,500 files, 1,000 tasks on one list, 300 notes, 300 events this month and 150
// notifications; each list endpoint is timed (the slowest of three tries) and must answer within a second.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
// Many requests at once from the page (in batches, so the server isn't swamped).
const many = (reqs) => page.evaluate(async (list) => {
  for (let i = 0; i < list.length; i += 25) {
    const res = await Promise.all(list.slice(i, i + 25).map(([m, u, b]) => fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify(b) })));
    const bad = res.find((r) => !r.ok);
    if (bad) throw new Error(`${bad.status} from ${bad.url}: ${await bad.text()}`);
  }
}, reqs);
let list;

await step('setup: a company with a lot in it', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  // Sent from a plain page on the site (not the app, which reacts to each change as it happens).
  await page.goto(`${B}/manifest.webmanifest`).catch(() => {});
  const t0 = Date.now();
  await many(Array.from({ length: 1500 }, (_, i) => ['POST', '/files/new', { kind: ['doc', 'sheet', 'slides'][i % 3], name: `Report ${String(i).padStart(4, '0')}` }]));
  list = (await api('POST', '/tasks/lists', { name: 'Big list' })).body;
  await many(Array.from({ length: 1000 }, (_, i) => ['POST', `/tasks/lists/${list.id}/tasks`, { title: `Task ${i}`, ...(i % 4 === 0 && { due: new Date(Date.now() + (i % 30) * 864e5).toISOString().slice(0, 10) }) }]));
  await many(Array.from({ length: 300 }, (_, i) => ['POST', '/notes', { title: `Note ${i}`, body: `Body of note ${i}` }]));
  const month = new Date(); month.setDate(1); month.setHours(9, 0, 0, 0);
  await many(Array.from({ length: 300 }, (_, i) => ['POST', '/events', { title: `Meeting ${i}`, start: month.getTime() + (i % 28) * 864e5 + (i % 8) * 3600e3, end: month.getTime() + (i % 28) * 864e5 + (i % 8) * 3600e3 + 1800e3 }]));
  // Notifications: a colleague shares files with Olivia.
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await (await browser.newContext()).newPage();
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await kim.evaluate(async () => {
    const h = { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' };
    const olivia = (await (await fetch('/api/users/directory', { headers: h })).json()).find((u) => u.name === 'Olivia Owner').id;
    for (let i = 0; i < 150; i++) {
      const f = await (await fetch('/api/files/new', { method: 'POST', headers: h, body: JSON.stringify({ kind: 'doc', name: `From Kim ${i}` }) })).json();
      await fetch(`/api/files/${f.id}/shares`, { method: 'PUT', headers: h, body: JSON.stringify({ shares: [{ user_id: olivia, role: 'viewer' }], message: `Number ${i}` }) });
    }
  });
  await kim.context().close();
  console.log(`seeded in ${Math.round((Date.now() - t0) / 1000)}s`);
  // It's all there.
  const files = (await api('GET', '/files?view=mine')).body, tasks = (await api('GET', `/tasks/lists/${list.id}/tasks`)).body, notes = (await api('GET', '/notes')).body;
  const counts = { files: (files.files || files).length, tasks: (tasks.tasks || tasks).length, notes: (notes.notes || notes).length, bell: (await api('GET', '/notifications')).body.items.length };
  console.log(`counts: ${JSON.stringify(counts)}`);
  if (counts.files < 1500 || counts.tasks < 1000 || counts.notes < 300) throw new Error(`not all made: ${JSON.stringify(counts)}`);
});

const timings = [];
await step('each app’s list answers within a second', async () => {
  const from = new Date(); from.setDate(1); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setMonth(to.getMonth() + 1);
  const ENDPOINTS = [['Drive', '/files?view=mine'], ['Drive recent', '/files?view=recent'], ['Drive shared with me', '/files?view=shared'], ['Drive search', '/files?view=search&q=Report%2012'],
    ['Tasks', `/tasks/lists/${list.id}/tasks`], ['Tasks lists', '/tasks/lists'], ['Notes', '/notes'], ['Calendar month', `/events?from=${from.getTime()}&to=${to.getTime()}`],
    ['the bell', '/notifications'], ['Chat', '/chat/channels'], ['Home summary', '/files/suggested']];
  const slow = [];
  for (const [name, url] of ENDPOINTS) {
    let worst = 0, status = 0;
    for (let i = 0; i < 3; i++) {
      const r = await page.evaluate(async (u) => { const t = performance.now(); const res = await fetch('/api' + u, { headers: { 'x-requested-with': 'nas-workspace' } }); await res.text(); return [performance.now() - t, res.status]; }, url);
      worst = Math.max(worst, r[0]); status = r[1];
    }
    timings.push(`${name} ${Math.round(worst)}ms${status !== 200 ? ` (${status})` : ''}`);
    if (status === 200 && worst > 1000) slow.push(`${name}: ${Math.round(worst)}ms`);
  }
  console.log(`timings: ${timings.join(', ')}`);
  if (slow.length) throw new Error(slow.join('; '));
});

await step('the screens show it: Drive, the list, Notes, the month, the bell', async () => {
  const shown = [];
  for (const [name, path, ready] of [['Drive', '/drive', () => page.getByText('Report 0000').first()], ['Tasks', `/tasks/${list.id}`, () => page.getByText('Task 0', { exact: true }).first()],
    ['Notes', '/notes', () => page.getByText('Note 299', { exact: true }).first()], ['Calendar', '/calendar', () => page.getByText(/Meeting \d+/).first()], ['Home', '/home', () => page.getByRole('heading', { level: 1 })]]) {
    const t = Date.now();
    await page.goto(`${B}${path}`);
    await ready().waitFor({ timeout: 15000 });
    shown.push(`${name} ${Date.now() - t}ms`);
  }
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.getByRole('dialog', { name: 'Notifications' }).getByText(/Kim Park shared/).first().waitFor();
  console.log(`shown: ${shown.join(', ')}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
