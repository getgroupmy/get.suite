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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label) => {
  await page.waitForTimeout(300);
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label) => { await scan(`${label} light`); await page.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`); await page.emulateMedia({ colorScheme: 'light' }); };
let general, sheetId, docId;
await step('people, a sheet with a dropdown, a document', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['tom', 'Tom Reed']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'Tasks', cells: { A1: 'Job', B1: 'Status' }, validations: [{ id: 'v1', range: 'B2:B5', type: 'list', values: ['Open', 'Doing', 'Done'] }] }] } })).body.id;
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Release plan' })).body.id;
});
await step('Chat: @mention suggestions and Jump to', async () => {
  await page.goto(`${B}/chat/${general}`);
  const box = page.getByLabel('Message', { exact: true });
  await box.click();
  await page.keyboard.type('Hi @ki');
  await page.getByRole('listbox', { name: 'People to mention' }).waitFor();
  await both('mentions');
  await box.fill('');
  await page.getByRole('button', { name: /Jump to/ }).click();
  await page.getByRole('dialog', { name: 'Jump to' }).waitFor();
  await page.keyboard.type('k');
  await page.waitForTimeout(300);
  await both('jump to');
  await page.keyboard.press('Escape');
});
await step('Sheets: function suggestions and a dropdown cell\'s choices', async () => {
  await page.goto(`${B}/sheets/${sheetId}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  await cell('C1').click();
  await page.keyboard.type('=coun');
  await page.getByRole('listbox', { name: 'Function suggestions' }).waitFor();
  await both('function suggestions');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await cell('B2').click();
  await cell('B2').getByRole('button', { name: 'Choices for B2' }).click();
  await page.getByRole('listbox', { name: 'Choices' }).waitFor();
  await both('dropdown choices');
  await page.keyboard.press('Escape');
});
await step('Docs: the @ menu (people, dates, files)', async () => {
  await page.goto(`${B}/docs/${docId}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Owner: @');
  await page.getByRole('listbox', { name: 'People, dates and files' }).waitFor();
  await both('docs @ menu');
  await page.keyboard.press('Escape');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
