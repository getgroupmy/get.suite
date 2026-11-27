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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const upload = (p, name, text) => p.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
const MD = '# Shop setup\n\nSteps for the **morning**:\n\n- Count the float\n- Switch on the till\n\n| Item | Price |\n| --- | --- |\n| Lamp | 25 |\n';
await step('a Markdown file in Drive shows formatted: a heading, bold, a list and a table, not its # and ** marks', async () => {
  await upload(page, 'README.md', MD);
  await page.goto(`${B}/drive`);
  await page.locator('.files tbody tr').filter({ hasText: 'README.md' }).getByText('README.md').dblclick();
  const v = page.getByRole('dialog', { name: 'README.md' });
  await v.getByRole('heading', { name: 'Shop setup' }).waitFor({ timeout: 15000 });
  await v.locator('strong', { hasText: 'morning' }).waitFor();
  await v.getByRole('listitem').filter({ hasText: 'Count the float' }).waitFor();
  await v.getByRole('cell', { name: 'Lamp' }).waitFor();
  if (await v.getByText('# Shop setup').count()) throw new Error('raw Markdown shown');
  await v.getByRole('button', { name: /Open as document/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/md-drive.png` });
  await page.keyboard.press('Escape');
});
await step('a plain .txt file still shows as it is', async () => {
  await upload(page, 'notes.txt', 'Plain notes, # not a heading');
  await page.goto(`${B}/drive`);
  await page.locator('.files tbody tr').filter({ hasText: 'notes.txt' }).getByText('notes.txt').dblclick();
  await page.getByLabel('Text of notes.txt').getByText('Plain notes, # not a heading').waitFor({ timeout: 15000 }); // as written, in the text viewer
  await page.keyboard.press('Escape');
});
await step('a Markdown file sent in Chat opens formatted in the viewer too', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kim.id })).body.id;
  const f = await upload(page, 'Agenda.md', '## Agenda\n\n1. Budget\n2. Hiring\n');
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'Agenda', files: [f.id] });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Chat' }).first().waitFor();
  await k.goto(`${B}/chat/${dm}`);
  await k.getByRole('link', { name: /Agenda\.md/ }).click({ timeout: 15000 });
  const v = k.getByRole('dialog', { name: 'Agenda.md' });
  await v.getByRole('heading', { name: 'Agenda' }).waitFor({ timeout: 15000 });
  await v.getByRole('listitem').filter({ hasText: 'Hiring' }).waitFor();
}, page);
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
