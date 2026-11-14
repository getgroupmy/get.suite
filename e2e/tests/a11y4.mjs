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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const all = [];
const scan = async (name, p = page) => {
  await p.waitForTimeout(600);
  await p.addScriptTag({ content: AXE });
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, where: v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | '), html: v.nodes[0]?.html.slice(0, 200) })));
  for (const v of res) all.push({ page: name, ...v });
  if (res.length) throw new Error(res.map((v) => `${v.id}(${v.n})`).join(', '));
};
let kim, kimId, general;
await step('things to look at', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  const file = (await page.evaluate(async () => (await fetch('/api/files/upload?name=brochure.pdf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: '%PDF' })).json()));
  await api(page, 'POST', '/links', { file_id: file.id, password: 'secret-12', expires_at: Date.now() + 7 * 864e5, notify_open: true });
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Receipts' })).body;
  await api(page, 'POST', '/links', { file_id: folder.id, mode: 'upload' });
  const note = (await api(page, 'POST', '/notes', { title: 'Packing', items: [{ text: 'Badges' }, { text: 'Lanyards', indent: 1 }, { text: 'Snacks', done: true }] })).body;
  await api(page, 'PUT', `/notes/${note.id}/shares`, { user_ids: [kimId] });
  await api(page, 'PATCH', `/notes/${note.id}`, { remind_at: Date.now() + 864e5, remind_repeat: 'weekly', remind_tz: 'UTC' });
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const task = (await api(page, 'POST', `/tasks/lists/${lists[0].id}/tasks`, { title: 'Book the venue' })).body;
  const t = new Date(); t.setDate(t.getDate() + 2); t.setHours(10, 0, 0, 0);
  const ev = (await api(page, 'POST', '/events', { title: 'Launch review', start: t.getTime(), end: t.getTime() + 3600e3, guests: ['kim@acme.com'] })).body;
  const m = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `Packing ${B}/notes?note=${note.id} venue ${B}/tasks/${lists[0].id}?task=${task.id} review ${B}/calendar?event=${ev.id}` })).body;
  await api(page, 'PUT', `/chat/messages/${m.id}/saved`, { saved: true });
  await api(page, 'POST', `/chat/messages/${m.id}/remind`, { at: Date.now() + 3600e3 });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('a11y: Admin → Share links', async () => {
  await page.goto(`${B}/admin?tab=links`);
  await page.getByRole('table', { name: 'Share links' }).waitFor();
  await scan('Admin share links');
});
await step('a11y: Drive → Shared by link, and the Share window’s link row', async () => {
  await page.goto(`${B}/drive/links`);
  await page.getByRole('table', { name: 'Your share links' }).waitFor();
  await scan('Drive shared by link');
  await page.getByRole('button', { name: 'Share settings for brochure.pdf' }).click();
  await page.getByRole('region', { name: 'Link sharing' }).getByLabel('Share link').waitFor();
  await scan('Share window link row');
});
await step('a11y: Home with Saved in Chat, Chat reminders, Note reminders', async () => {
  await page.goto(`${B}/home`);
  for (const r of ['Saved in Chat', 'Chat reminders', 'Note reminders']) await page.getByRole('region', { name: r }).waitFor();
  await scan('Home chat and note cards');
});
await step('a11y: Chat Reminders list, and cards with tick boxes and buttons (Kim)', async () => {
  await page.goto(`${B}/chat?reminders=1`);
  await page.getByRole('list', { name: 'Reminders' }).waitFor();
  await scan('Chat reminders');
  await kim.goto(`${B}/chat/${general}`);
  await kim.getByRole('group', { name: 'Note: Packing' }).getByRole('checkbox', { name: 'Badges' }).waitFor();
  await kim.getByRole('group', { name: 'Answer: Launch review' }).waitFor();
  await kim.getByRole('button', { name: 'Mark done: Book the venue' }).waitFor().catch(() => {});
  await scan('Chat cards', kim);
});
await step('a11y: Notes → Pick a day and time with Repeat', async () => {
  await page.goto(`${B}/notes`);
  await page.getByRole('article', { name: 'Packing' }).getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: 'Pick a day and time…' }).click();
  await page.getByRole('dialog', { name: 'Remind me' }).getByLabel('Untick the list each time').waitFor();
  await scan('Notes pick time');
});
for (const v of all) console.log(`DBG ${v.page} ${v.impact} ${v.id} x${v.n}: ${v.help} :: ${v.where} :: ${v.html}`);
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
