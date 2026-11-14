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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
await step('Drive: select files → Email links; sending offers to share them with Kim', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Brief' })).body;
  const up = await page.request.post(`${B}/api/files/upload?name=plan.txt`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, data: 'plan' });
  const f = await up.json();
  await page.goto(`${B}/drive`);
  await page.getByLabel('Select Brief').check();
  await page.getByLabel('Select plan.txt').check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Email links' }).click();
  await page.waitForURL(/\/mail/);
  const d = page.getByRole('dialog', { name: '2 files' }).or(page.getByRole('dialog', { name: 'New message' }));
  const msg = d.getByRole('textbox', { name: 'Message' });
  const a = msg.getByRole('link', { name: 'Brief' }), b = msg.getByRole('link', { name: 'plan.txt' });
  await a.waitFor(); await b.waitFor();
  if (!(await a.getAttribute('href')).endsWith(`/docs/${doc.id}`) || !(await b.getAttribute('href')).endsWith(`/drive?preview=${f.id}`)) throw new Error('links');
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  const gap = page.getByRole('dialog', { name: "Some recipients can't open a linked file" });
  await gap.getByText('Brief').first().waitFor();
  await gap.getByText('plan.txt').first().waitFor();
  await page.getByRole('button', { name: 'Share (can view) and send' }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
