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

// A lone "0" printed beside other things (React prints 0 from `count && …` / `flag && …` when the
// value is the number 0): find any on a page.
const zeros = (p) => p.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.textContent !== '0') continue;
    const el = n.parentElement;
    if (!el || el.closest('script, style, svg, input, textarea, select, option, .tiptap, .sheet-grid, .cm-editor, [contenteditable="true"]')) continue;
    if (![...el.childNodes].some((c) => c !== n && (c.nodeType === 1 || (c.nodeType === 3 && c.textContent.trim())))) continue; // "0" alone in its element is a count
    const words = (x) => x && x.nodeType === 3 && x.textContent.trim(); // part of a phrase ("· 0 files"): a real count
    if (words(n.previousSibling) || words(n.nextSibling) || (n.nextSibling?.nodeType === 3 && words(n.nextSibling.nextSibling))) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const side = (x) => (x ? (x.nodeType === 1 ? `<${x.tagName.toLowerCase()} ${[...x.attributes].slice(0, 2).map((a) => `${a.name}="${a.value.slice(0, 25)}"`).join(' ')}>` : JSON.stringify(x.textContent.slice(0, 20))) : '—');
    out.push(`in <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 30)}"> between ${side(n.previousSibling)} and ${side(n.nextSibling)}`);
  }
  return out;
});
const found = [];
const check = async (p, label) => { await p.waitForTimeout(900); for (const z of await zeros(p)) found.push(`${label}: ${z}`); };

await step('seed: files, a shared drive, notes, tasks, events, contacts, chat, a form', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const up = (n) => page.evaluate(async (a) => (await fetch(`/api/files/upload?name=${encodeURIComponent(a)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json(), n);
  const f = await up('Report.txt');
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kim.id, role: 'viewer' }] });
  await api(page, 'POST', '/files/folder', { name: 'Projects' });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] } });
  await api(page, 'POST', '/notes', { title: 'A note', body: 'text' });
  await api(page, 'POST', '/contacts', { name: 'Raj Kumar', emails: ['raj@example.com'] }).catch(() => {});
  const lists = (await api(page, 'GET', '/tasks/lists')).body;
  const list = Array.isArray(lists) ? lists[0] : lists?.lists?.[0];
  if (list) await api(page, 'POST', `/tasks/lists/${list.id}/tasks`, { title: 'Send the report' });
  const now = Date.now();
  await api(page, 'POST', '/events', { title: 'Planning', start: now + 3600e3, end: now + 7200e3 });
});
await step('no stray 0 on the main screens', async () => {
  for (const [path, label] of [['/home', 'Home'], ['/drive', 'Drive'], ['/drive/shared', 'Shared with me'], ['/drive/sharedbyme', 'Shared by me'], ['/drive/recent', 'Recent'], ['/drive/starred', 'Starred'], ['/drive/trash', 'Trash'], ['/drive/activity', 'Drive activity'], ['/drive/links', 'Shared by link'], ['/drive/drives', 'Shared drives'],
    ['/calendar', 'Calendar'], ['/contacts', 'Contacts'], ['/tasks', 'Tasks'], ['/chat', 'Chat'], ['/notes', 'Notes'], ['/meet', 'Meet'], ['/forms', 'Forms'], ['/settings', 'Settings']]) {
    await page.goto(`${B}${path}`);
    await check(page, label);
  }
  if (found.length) throw new Error(found.join(' || '));
});
await step('no stray 0 in any Admin tab', async () => {
  found.length = 0;
  await page.goto(`${B}/admin`);
  for (const name of await page.getByRole('tab').allInnerTexts()) {
    await page.getByRole('tab', { name, exact: true }).click();
    await check(page, `Admin ${name}`);
  }
  if (found.length) throw new Error(found.join(' || '));
});
await step('no stray 0 in a file’s windows', async () => {
  found.length = 0;
  await page.goto(`${B}/drive`);
  const row = page.locator('.files tbody tr', { hasText: 'Report.txt' });
  for (const item of ['Share', 'Details', 'Labels…', 'Move to…', 'Version history', 'Transfer ownership…', 'Copy to…', 'Request approval…']) {
    await row.getByRole('button', { name: /^Actions for/ }).click();
    const mi = page.getByRole('menuitem', { name: item, exact: true });
    if (!(await mi.count())) { await page.keyboard.press('Escape'); continue; }
    await mi.click();
    await page.getByRole('dialog').first().waitFor();
    await check(page, `Drive ${item}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  if (found.length) throw new Error(found.join(' || '));
});

await step('no stray 0 deeper in: a form and its responses, a private channel and a DM, a task, an event, a note', async () => {
  found.length = 0;
  const form = (await api(page, 'POST', '/forms', { title: 'Team lunch', questions: [{ id: 'q1', type: 'choice', title: 'Food?', options: ['Pizza', 'Sushi'], required: false }, { id: 'q2', type: 'short', title: 'Anything else?' }] })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'company' });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Questions' }).waitFor();
  const formTabs = await page.getByRole('tab').allInnerTexts();
  if (formTabs.length < 2) throw new Error(`form tabs: ${formTabs.join('|')}`);
  for (const t of formTabs) {
    await page.getByRole('tab', { name: t, exact: true }).first().click();
    await check(page, `Form ${t}`);
  }
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'secret-plans', private: true })).body;
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const kimId = (Array.isArray(dir) ? dir : dir.users || []).find((u) => u.username === 'kim@acme.com')?.id;
  if (!kimId) throw new Error('no Kim in the directory');
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  for (const [id, name] of [[ch.id, 'secret-plans'], [dm, 'Kim Park']]) {
    await page.goto(`${B}/chat/${id}`);
    await page.locator('.chat-head').getByText(name).first().waitFor();
    await check(page, `Chat ${name}`);
  }
  await page.goto(`${B}/tasks`);
  await page.getByText('Send the report').first().click();
  await check(page, 'Task details');
  await page.goto(`${B}/calendar`);
  await page.getByText('Planning').first().click().catch(() => {});
  await check(page, 'Event window');
  await page.keyboard.press('Escape');
  await page.goto(`${B}/notes`);
  await page.getByText('A note').first().click();
  await check(page, 'Open note');
  if (found.length) throw new Error(found.join(' || '));
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
