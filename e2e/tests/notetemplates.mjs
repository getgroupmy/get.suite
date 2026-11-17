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
await step('a note saved as a template (⋮ → Save as template…)', async () => {
  await api(page, 'POST', '/notes', { title: 'Packing list', items: [{ text: 'Passport', done: true }, { text: 'Charger' }], color: '#d4e4ed', labels: ['travel'] });
  await page.goto(`${B}/notes`);
  const card = page.locator('article').filter({ hasText: 'Packing list' }).first();
  await card.waitFor({ timeout: 10000 });
  await card.hover();
  await card.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Save as template…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Save as template' });
  if (await dlg.getByLabel('Template name').inputValue() !== 'Packing list') throw new Error('not named after the note');
  await dlg.getByLabel('Template name').fill('Trip packing');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved as the template “Trip packing”').last().waitFor();
});
await step('Templates → Use: a new note with the list unticked, its colour and label, opened', async () => {
  await page.getByRole('button', { name: 'Templates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Note templates' });
  const row = dlg.getByRole('list', { name: 'Templates' }).getByRole('listitem').filter({ hasText: 'Trip packing' });
  await row.getByText('☑ 2 items').waitFor();
  await page.screenshot({ path: `${SP}/shots/note-templates.png` });
  await row.getByRole('button', { name: 'Use' }).click();
  await page.getByText('New note from “Trip packing”').last().waitFor();
  const notes = (await api(page, 'GET', '/notes')).body;
  const made = notes.filter((n) => n.title === 'Packing list');
  if (made.length !== 2) throw new Error(`${made.length} notes`);
  const fresh = made.find((n) => n.items.every((i) => !i.done));
  if (!fresh || fresh.color !== '#d4e4ed' || !fresh.labels.includes('travel')) throw new Error(JSON.stringify(made));
});
await step('a template is deleted', async () => {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Templates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByRole('button', { name: 'Delete the template Trip packing' }).click();
  await dlg.getByText(/No templates yet/).waitFor();
  if ((await api(page, 'GET', '/notes/templates')).body.length) throw new Error('still there');
});
await step('Today’s note: from the template chosen for it, and the same note when opened again that day', async () => {
  const n = (await api(page, 'POST', '/notes', { title: 'Stand-up', items: [{ text: 'Yesterday' }, { text: 'Today' }] })).body;
  await api(page, 'POST', '/notes/templates', { note_id: n.id, name: 'Stand-up' });
  await page.goto(`${B}/notes`);
  await page.getByRole('button', { name: 'Templates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByRole('button', { name: 'For Today’s note' }).click();
  await page.getByText('Today’s note starts from “Stand-up”').last().waitFor();
  await dlg.getByRole('button', { name: '✓ For Today’s note' }).waitFor();
  await page.keyboard.press('Escape');
  const title = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  await page.getByRole('button', { name: 'Today’s note' }).click();
  await page.getByText('Today’s note, from “Stand-up”').last().waitFor();
  const opened = async () => until(async () => { const v = await page.getByRole('dialog').locator('input').evaluateAll((els) => els.map((e) => e.value)).catch(() => []); return v.includes('Yesterday') && v.includes('Today'); }, 10000);
  await opened(); // opened, with the template's list
  await page.screenshot({ path: `${SP}/shots/todays-note.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Today’s note' }).click();
  await opened();
  await page.keyboard.press('Escape');
  const mine = (await api(page, 'GET', '/notes')).body.filter((x) => x.title === title);
  if (mine.length !== 1) throw new Error(`${mine.length} notes titled ${title}`);
  // Filter → 📅 Daily notes: only Today's notes.
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('button', { name: '📅 Daily notes' }).click();
  await page.locator('article').filter({ hasText: title }).first().waitFor({ timeout: 10000 });
  await until(async () => (await page.locator('article').count()) === 1);
});
await step('Home: the Today’s note card shows the day’s list, and Open opens it', async () => {
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Today’s note' });
  await card.getByText('☐ Yesterday').waitFor({ timeout: 10000 });
  await card.getByText('☐ Today').waitFor();
  await page.screenshot({ path: `${SP}/shots/home-daily.png` });
  await card.getByRole('link', { name: 'Open' }).click();
  await page.waitForURL(/\/notes\?note=/);
  await until(async () => (await page.getByRole('dialog').locator('input').evaluateAll((els) => els.map((e) => e.value)).catch(() => [])).includes('Yesterday'), 10000);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
