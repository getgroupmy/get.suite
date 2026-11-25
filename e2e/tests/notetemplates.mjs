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
  const yesterday = card.getByRole('checkbox', { name: 'Yesterday' });
  await yesterday.waitFor({ timeout: 10000 });
  await card.getByRole('checkbox', { name: 'Today' }).waitFor();
  // Ticked right here: saved in the note.
  await yesterday.check();
  await until(async () => (await api(page, 'GET', `/notes/daily?date=${await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })}`)).body.items.find((i) => i.text === 'Yesterday').done);
  await page.reload();
  if (!(await card.getByRole('checkbox', { name: 'Yesterday' }).isChecked())) throw new Error('not kept');
  await page.screenshot({ path: `${SP}/shots/home-daily.png` });
  await card.getByRole('link', { name: 'Open' }).click();
  await page.waitForURL(/\/notes\?note=/);
  await until(async () => (await page.getByRole('dialog').locator('input').evaluateAll((els) => els.map((e) => e.value)).catch(() => [])).includes('Yesterday'), 10000);
});
await step('carry over: today’s note brings yesterday’s unticked items', async () => {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date(), y = new Date(now); y.setDate(y.getDate() - 1);
  const todays = (await api(page, 'GET', `/notes/daily?date=${ymd(now)}`)).body;
  await api(page, 'DELETE', `/notes/${todays.id}`); // start the day again
  const yest = (await api(page, 'POST', '/notes/daily', { date: ymd(y), title: 'Yesterday’s note' })).body;
  await api(page, 'PATCH', `/notes/${yest.id}`, { items: [{ text: 'Yesterday', done: true }, { text: 'Today' }, { text: 'Call the bank' }, { text: 'Sent the invoice', done: true }] });
  await page.goto(`${B}/notes`);
  await page.getByRole('button', { name: 'Templates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByLabel('Carry over the unticked items from the last daily note').check();
  await until(async () => (await api(page, 'GET', '/notes/templates')).body.find((t) => t.daily)?.carry);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Today’s note' }).click();
  await page.getByText('Today’s note, from “Stand-up”, with 1 unticked item from last time').last().waitFor({ timeout: 10000 });
  await until(async () => { const v = await page.getByRole('dialog').locator('input').evaluateAll((els) => els.map((e) => e.value)).catch(() => []); return v.includes('Call the bank') && !v.includes('Sent the invoice'); }, 10000);
  await page.keyboard.press('Escape');
});
await step('with several templates, the ones you used last are listed first', async () => {
  for (const title of ['Alpha plan', 'Beta plan', 'Zeta plan']) {
    const n = (await api(page, 'POST', '/notes', { title, body: title })).body;
    await api(page, 'POST', '/notes/templates', { note_id: n.id, name: title });
  }
  await page.goto(`${B}/notes`);
  await page.getByRole('button', { name: 'Templates' }).click();
  let dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByRole('list', { name: 'Templates' }).getByRole('listitem').filter({ hasText: 'Zeta plan' }).getByRole('button', { name: 'Use' }).click();
  await page.getByText('New note from “Zeta plan”').last().waitFor();
  await until(async () => (await api(page, 'GET', '/notes/templates')).body.find((t) => t.name === 'Zeta plan')?.used_at);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Templates' }).click();
  dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByRole('list', { name: 'Templates' }).getByRole('listitem').first().waitFor();
  const names = await dlg.getByRole('list', { name: 'Templates' }).getByRole('listitem').evaluateAll((els) => els.map((e) => e.querySelector('strong')?.textContent).filter(Boolean));
  if (names[0] !== 'Zeta plan' || names.indexOf('Alpha plan') > names.indexOf('Beta plan')) throw new Error(names.join('|'));
  await page.keyboard.press('Escape');
});
await step('a template is renamed from Templates (not to a name another has)', async () => {
  const n = (await api(page, 'POST', '/notes', { title: 'Retro', items: [{ text: 'Went well' }] })).body;
  await api(page, 'POST', '/notes/templates', { note_id: n.id, name: 'Retro' });
  await page.goto(`${B}/notes`);
  await page.getByRole('button', { name: 'Templates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByRole('button', { name: 'Rename the template Retro' }).click();
  const r = page.getByRole('dialog', { name: 'Rename template' });
  await r.getByLabel('Template name').fill('stand-up');
  await r.getByRole('button', { name: 'Rename' }).click();
  await r.getByText('You already have a template with that name').waitFor();
  await r.getByLabel('Template name').fill('Sprint retro');
  await r.getByRole('button', { name: 'Rename' }).click();
  await r.waitFor({ state: 'detached' });
  await dlg.getByRole('button', { name: 'Rename the template Sprint retro' }).waitFor();
  const t = (await api(page, 'GET', '/notes/templates')).body.find((x) => x.name === 'Sprint retro');
  if (t?.items?.[0]?.text !== 'Went well') throw new Error(JSON.stringify(t));
  await page.keyboard.press('Escape');
});
await step('Templates → Export gives Note templates.json; Import reads one back (ones here skipped)', async () => {
  await page.goto(`${B}/notes`);
  await page.getByRole('button', { name: 'Templates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Note templates' });
  await dlg.getByRole('button', { name: 'Rename the template Sprint retro' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Export' }).click()]);
  if (dl.suggestedFilename() !== 'Note templates.json') throw new Error(dl.suggestedFilename());
  const file = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
  const retro = file.find((t) => t.name === 'Sprint retro');
  if (!retro || retro.items?.[0]?.text !== 'Went well' || 'id' in retro) throw new Error(JSON.stringify(file));
  const more = [...file, { name: 'Weekly review', title: 'Weekly review', items: [{ text: 'Inbox zero' }] }];
  await dlg.getByLabel('Import note templates').setInputFiles({ name: 'Note templates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(more)) });
  await page.getByText(`Added 1 template (${file.length} already here)`).waitFor();
  await dlg.getByRole('button', { name: 'Rename the template Weekly review' }).waitFor();
  await dlg.getByLabel('Import note templates').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
  await page.getByText('That isn’t a templates file (Note templates.json)').waitFor();
  await page.keyboard.press('Escape');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
