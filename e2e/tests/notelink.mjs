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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let general, note, arch, lee, kim;
await step('copy a link to a note from its menu, paste it in Chat', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  note = (await api(page, 'POST', '/notes', { title: 'Offsite packing', items: [{ text: 'Projector', done: true }, { text: 'Name badges' }, { text: 'Snacks' }], color: '#fff8b8' })).body;
  await api(page, 'PUT', `/notes/${note.id}/shares`, { user_ids: [kimId] });
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await page.goto(`${B}/notes`);
  const card = page.locator('article.note-card', { hasText: 'Offsite packing' });
  await card.hover();
  await card.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await page.getByText('Link to the note copied').waitFor();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  if (url !== `${B}/notes?note=${note.id}`) throw new Error(`copied ${url}`);
  await page.goto(`${B}/chat/${general}`);
  await page.getByLabel('Message', { exact: true }).fill(`Please check ${url}`);
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const c = page.getByRole('group', { name: 'Note: Offsite packing' });
  await c.waitFor();
  const txt = await c.textContent();
  if (!/Name badges/.test(txt) || !/1\/3 done/.test(txt) || !/Your note/.test(txt)) throw new Error(txt);
  await page.screenshot({ path: `${SP}/shots/notelink-card.png` });
  await c.getByRole('link', { name: 'Offsite packing' }).click();
  await page.getByRole('dialog', { name: 'Offsite packing' }).waitFor();
  if (page.url().includes('note=')) throw new Error('the link stays in the address');
});
await step('the person it’s shared with sees it; an archived note opens too', async () => {
  arch = (await api(page, 'POST', '/notes', { title: 'Old plan', body: 'From last year' })).body;
  await api(page, 'PATCH', `/notes/${arch.id}`, { archived: true });
  await page.goto(`${B}/notes?note=${arch.id}`);
  await page.getByRole('dialog', { name: 'Old plan' }).waitFor();
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${general}`);
  const c = kim.getByRole('group', { name: 'Note: Offsite packing' });
  await c.waitFor();
  if (!/Olivia Owner’s note/.test(await c.textContent())) throw new Error(await c.textContent());
});
await step('someone it isn’t shared with', async () => {
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/chat/${general}`);
  await lee.getByText('A note you can’t see').waitFor();
  if (await lee.getByText('Name badges').count()) throw new Error('Lee must not see it');
  await lee.goto(`${B}/notes?note=${note.id}`);
  await lee.getByText('That note isn’t one of yours or shared with you').waitFor();
});
await step('tick an item on the card in Chat (Kim, whom it’s shared with); it’s ticked in the note', async () => {
  await kim.goto(`${B}/chat/${general}`);
  const c = kim.getByRole('group', { name: 'Note: Offsite packing' });
  const box = c.getByRole('checkbox', { name: 'Name badges' });
  const was = await box.isChecked();
  await box.click();
  await until(async () => (await c.getByRole('checkbox', { name: 'Name badges' }).isChecked()) === !was);
  await c.getByText(was ? '0/3 done' : '2/3 done').waitFor();
  const n = (await api(page, 'GET', '/notes')).body.find((x) => x.id === note.id);
  if (n.items.find((i) => i.text === 'Name badges').done !== !was) throw new Error('not saved');
});
await step('the card keeps up: Kim ticks Snacks, and Olivia’s open card shows it without reloading', async () => {
  await page.goto(`${B}/chat/${general}`);
  const mine = page.getByRole('group', { name: 'Note: Offsite packing' });
  await mine.getByRole('checkbox', { name: 'Snacks' }).waitFor();
  if (await mine.getByRole('checkbox', { name: 'Snacks' }).isChecked()) throw new Error('ticked already');
  await kim.getByRole('group', { name: 'Note: Offsite packing' }).getByRole('checkbox', { name: 'Snacks' }).click();
  await until(async () => mine.getByRole('checkbox', { name: 'Snacks' }).isChecked(), 10000);
});
await step('one note: ⋮ → Send in Chat… puts its link in #general', async () => {
  await page.goto(`${B}/notes`);
  await page.getByRole('article', { name: 'Offsite packing' }).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send in Chat…' }).click();
  const d = page.getByRole('dialog', { name: 'Send the note in Chat' });
  await d.getByLabel('Conversation').selectOption({ label: '# general' });
  await d.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(`**/chat/${general}`);
  await until(async () => (await page.getByLabel('Message', { exact: true }).inputValue()).includes(`/notes?note=${note.id}`));
});
await step('⋮ → Chat with people it’s shared with: the note’s own channel, Kim in it', async () => {
  await page.goto(`${B}/notes`);
  await page.getByRole('article', { name: 'Offsite packing' }).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Chat with people it’s shared with' }).click();
  await page.waitForURL(/\/chat\/[\w-]+$/);
  const chanId = page.url().split('/chat/')[1];
  await page.getByText('A channel for this note, with everyone it’s shared with').waitFor();
  await page.getByText(/For the note Offsite packing/).first().waitFor();
  if (!(await api(kim, 'GET', '/chat/channels')).body.channels.some((c) => c.id === chanId)) throw new Error('Kim not in it');
});
await step('its channel says what it’s about at the top', async () => {
  await page.getByText('· this channel’s note').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
