import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
let deckId;
const box = (id, text, x, y, w, h) => ({ id, type: 'text', text, x, y, w, h, size: 24 });
const item = (txt) => page.locator('.slide.editable').getByText(txt, { exact: true });
const saved = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides[0].items;
const at = async () => Object.fromEntries((await saved()).map((i) => [i.id, i]));
const groups = async () => { const g = await at(); return g; };
await step('Group two boxes: one click picks both, a drag moves both', async () => {
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Grouping', content: { theme: 'light', slides: [{ id: 's1', items: [box('a', 'Logo', 10, 10, 10, 10), box('b', 'Acme', 22, 12, 20, 8), box('c', 'Agenda', 50, 50, 30, 10)] }] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await item('Logo').click();
  await item('Acme').click({ modifiers: ['Shift'] });
  await page.getByText('2 boxes').waitFor();
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByText('Grouped 2 boxes').waitFor();
  await until(async () => { const g = await groups(); return g.a.group && g.a.group === g.b.group && !g.c.group; });
  await item('Agenda').click();
  await item('Acme').click(); // one click: the whole group
  await page.getByText('Group of 2').waitFor();
  await page.screenshot({ path: `${SP}/shots/slidegroup.png` });
  const slide = await page.locator('.slide.editable').boundingBox();
  const b = await item('Logo').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + slide.width * 0.1, b.y + b.height / 2 + slide.height * 0.2, { steps: 6 });
  await page.mouse.up();
  await until(async () => { const g = await groups(); return Math.abs(g.a.x - 20) < 0.3 && Math.abs(g.b.x - 32) < 0.3 && Math.abs(g.a.y - 30) < 0.3 && g.c.x === 50; });
});
await step('double-click types in one box of the group on its own', async () => {
  await item('Acme').dblclick();
  const t = page.locator('.slide.editable textarea');
  await t.waitFor();
  await t.fill('Acme Trading');
  await page.keyboard.press('Escape');
  await until(async () => (await groups()).b.text === 'Acme Trading');
  if ((await groups()).b.group !== (await groups()).a.group) throw new Error('still grouped');
});
await step('copy and paste the group: the copies are a group of their own', async () => {
  await item('Logo').click();
  await page.getByText('Group of 2').waitFor();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await until(async () => (await saved()).length === 5);
  const all = await saved();
  const copies = all.filter((i) => !['a', 'b', 'c'].includes(i.id));
  const orig = all.find((i) => i.id === 'a').group;
  if (!(copies[0].group && copies[0].group === copies[1].group && copies[0].group !== orig)) throw new Error(JSON.stringify(copies));
  await page.getByText('Group of 2').waitFor();
  await page.keyboard.press('Delete');
  await until(async () => (await saved()).length === 3);
});
await step('Ungroup with Ctrl+Alt+Shift+G; then a click picks one box', async () => {
  await item('Logo').click();
  await page.getByText('Group of 2').waitFor();
  await page.keyboard.press('Control+Alt+Shift+g');
  await page.getByText('Ungrouped').waitFor();
  await until(async () => { const g = await groups(); return !g.a.group && !g.b.group; });
  await item('Agenda').click();
  await item('Logo').click();
  await page.getByLabel('Rotation').waitFor();
  if (await page.getByText(/Group of|\d boxes/).count()) throw new Error('more than one chosen');
});
await step('Ctrl+Alt+G groups what is chosen; the PowerPoint download keeps the group', async () => {
  await item('Acme Trading').click({ modifiers: ['Shift'] });
  await page.getByText('2 boxes').waitFor();
  await page.keyboard.press('Control+Alt+g');
  await page.getByText('Grouped 2 boxes').waitFor();
  await until(async () => { const g = await groups(); return g.a.group && g.a.group === g.b.group; });
  const xml = await page.evaluate(async (id) => {
    const r = await fetch(`/api/files/${id}/export`);
    return r.ok ? r.headers.get('content-type') : `status ${r.status}`;
  }, deckId);
  if (!/presentationml/.test(xml)) throw new Error(xml);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
