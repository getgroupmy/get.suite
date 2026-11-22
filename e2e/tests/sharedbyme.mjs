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
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

await step('Drive → Shared by me: your files others can open, with whom', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const up = (n) => page.evaluate(async (a) => (await fetch(`/api/files/upload?name=${encodeURIComponent(a)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json(), n);
  const brief = await up('Brief.txt');
  const handbook = await up('Handbook.txt');
  await up('Private notes.txt');
  await api(page, 'PUT', `/files/${brief.id}/shares`, { shares: [{ user_id: kim.id, role: 'editor' }] });
  await api(page, 'PUT', `/files/${handbook.id}/company`, { role: 'viewer' });
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Shared by me' }).click();
  await page.waitForURL(/\/drive\/sharedbyme$/);
  const rows = page.locator('.files tbody tr');
  await until(async () => (await rows.count()) === 2);
  await rows.filter({ hasText: 'Brief.txt' }).getByText('· with Kim Park').waitFor();
  await rows.filter({ hasText: 'Handbook.txt' }).getByText('· with Everyone at Acme Trading').waitFor();
  if (await rows.filter({ hasText: 'Private notes.txt' }).count()) throw new Error('an unshared file is listed');
  await page.screenshot({ path: `${SP}/shots/shared-by-me.png` });
  await axe(page, 'shared by me');
  // Stop sharing it: it leaves the list.
  await api(page, 'PUT', `/files/${brief.id}/shares`, { shares: [] });
  await until(async () => (await rows.filter({ hasText: 'Brief.txt' }).count()) === 0);
});

await step('Shared by me → Open in Sheets: a row per file and who it’s shared with', async () => {
  await page.getByRole('button', { name: 'Open in Sheets' }).click();
  await page.getByText(/^Made “Shared by me \d{4}-\d{2}-\d{2}” in your Drive$/).waitFor();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="C1"]', { hasText: 'Shared with' }).waitFor();
  await page.locator('[data-k="A2"]', { hasText: 'Handbook.txt' }).waitFor();
  await page.locator('[data-k="C2"]', { hasText: 'Everyone at Acme Trading' }).waitFor();
  await page.locator('[data-k="F2"]', { hasText: 'Can view' }).waitFor();
});

await step('select and Stop sharing: gone from Shared by me, and Kim can no longer open it', async () => {
  await page.goto(`${B}/drive/sharedbyme`);
  const rows = page.locator('.files tbody tr');
  await until(async () => (await rows.count()) === 1);
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  const bar = page.getByRole('toolbar', { name: 'Selected files' });
  await bar.getByRole('button', { name: 'Stop sharing' }).click();
  const d = page.getByRole('dialog', { name: 'Stop sharing “Handbook.txt”?' });
  await d.getByText(/Links for people without an account stay/).waitFor();
  await axe(page, 'stop sharing');
  await d.getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByText('Stopped sharing 1 item').waitFor();
  await page.getByText("You haven't shared anything yet").waitFor();
  // Undo puts it back as it was (the whole company could see it); then stop it again for the rest.
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Sharing back as it was on 1 item').waitFor();
  await page.locator('.files tbody tr', { hasText: 'Handbook.txt' }).getByText('· with Everyone at Acme Trading').waitFor();
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByRole('dialog', { name: 'Stop sharing “Handbook.txt”?' }).getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByText("You haven't shared anything yet").waitFor();
  // Not offered for something that isn't yours.
  const kim = await mk('kim-x');
  await signIn(kim, 'kim@acme.com');
  const f = await kim.evaluate(async () => (await fetch('/api/files/upload?name=kims.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json());
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  await api(kim, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: me.id, role: 'viewer' }] });
  await page.goto(`${B}/drive/shared`);
  await page.locator('.files tbody tr', { hasText: 'kims.txt' }).getByRole('checkbox').check();
  await page.getByRole('toolbar', { name: 'Selected files' }).waitFor();
  if (await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Stop sharing' }).count()) throw new Error('offered for someone else’s file');
  await api(kim, 'POST', '/files/unshare', { ids: [f.id] }); // Kim has shared nothing again, for the next step
});

await step('nothing shared: says so', async () => {
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive/sharedbyme`);
  await kim.getByText("You haven't shared anything yet").waitFor();
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
