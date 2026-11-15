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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
await step('notes of different kinds and colours', async () => {
  await api(page, 'POST', '/notes', { title: 'Groceries', items: [{ text: 'Milk' }], color: '#e2f6d3' });
  await api(page, 'POST', '/notes', { title: 'Soup recipe', body: 'From https://example.com/soup', color: '#fff8b8' });
  const pic = (await api(page, 'POST', '/notes', { title: 'Whiteboard', body: 'photo of it' })).body;
  await page.evaluate(async (id) => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    await fetch(`/api/notes/${id}/pictures`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'image/png' }, body: png });
  }, pic.id);
  const rem = (await api(page, 'POST', '/notes', { title: 'Dentist', body: 'book a check-up' })).body;
  await api(page, 'PATCH', `/notes/${rem.id}`, { remind_at: Date.now() + 864e5 });
  await page.goto(`${B}/notes`);
  await page.getByRole('heading', { name: 'Dentist' }).waitFor();
});
const titles = async () => (await page.locator('.notes-main .note-card h3').allInnerTexts()).sort().join(', ');
const expect = async (want) => until(async () => (await titles()) === want).catch(async () => { throw new Error(`wanted ${want}, saw ${await titles()}`); });
await step('Filter shows kinds and colours; picking narrows the notes', async () => {
  await page.getByRole('button', { name: 'Filter' }).click();
  const kinds = page.getByRole('group', { name: 'Kind of note' });
  await kinds.getByRole('button', { name: '☑ Lists' }).click();
  await expect('Groceries');
  await kinds.getByRole('button', { name: '🔗 Links' }).click();
  await expect('Soup recipe');
  if ((await kinds.getByRole('button', { name: '☑ Lists' }).getAttribute('aria-pressed')) !== 'false') throw new Error('one kind at a time');
  await kinds.getByRole('button', { name: '🖼 Pictures' }).click();
  await expect('Whiteboard');
  await kinds.getByRole('button', { name: '🔔 Reminders' }).click();
  await expect('Dentist');
  await kinds.getByRole('button', { name: '🎙 Voice' }).click();
  await page.getByText('No matching notes').waitFor();
  await kinds.getByRole('button', { name: '🎙 Voice' }).click();
  await expect('Dentist, Groceries, Soup recipe, Whiteboard');
  const colours = page.getByRole('group', { name: 'Colour' });
  await colours.getByRole('button', { name: 'Sand' }).click();
  await expect('Soup recipe');
  await colours.getByRole('button', { name: 'Default' }).click();
  await expect('Dentist, Whiteboard');
  await page.getByLabel('Search notes').fill('check-up');
  await expect('Dentist');
  await page.screenshot({ path: `${SP}/shots/note-filter.png` });
  await axe(page, 'note filters');
  await page.getByLabel('Search notes').fill('');
});
await step('Clear filter shows everything again', async () => {
  await page.getByRole('button', { name: '× Clear filter' }).click();
  await expect('Dentist, Groceries, Soup recipe, Whiteboard');
  if (await page.getByRole('group', { name: 'Colour' }).count()) throw new Error('still open');
});
await step('on a phone the filters wrap', async () => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.reload();
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('group', { name: 'Colour' }).getByRole('button', { name: 'Chalk' }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('wider than the phone');
  if (await page.locator('.notes-main').evaluate((el) => el.scrollLeft > 0 || el.scrollWidth > el.clientWidth + 1)) throw new Error('the notes slide sideways');
  for (const g of ['Kind of note', 'Colour']) if (await page.getByRole('group', { name: g }).evaluate((el) => el.scrollWidth > el.clientWidth + 1)) throw new Error(`${g} overflows`);
  await page.screenshot({ path: `${SP}/shots/note-filter-phone.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
