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
let doc;
await step('Attach from Drive offers documents; choosing OpenDocument attaches a copy as .odt', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Offer letter' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Offer' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Dear Kim, we are pleased to offer you the role.' }] }] } });
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  const d = page.getByRole('dialog', { name: 'New message' });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByLabel('Subject').fill('Your offer');
  await d.getByRole('button', { name: 'Attach from Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach from Drive' });
  await pick.getByLabel('Search your files').fill('Offer');
  await pick.getByRole('button', { name: /Offer letter/ }).click();
  const as = page.getByRole('dialog', { name: 'Attach “Offer letter”' });
  await as.getByLabel('Word (.docx)').waitFor();
  await as.getByLabel('OpenDocument (.odt)').check();
  await page.screenshot({ path: `${SP}/shots/attachas.png` });
  await as.getByRole('button', { name: 'Attach' }).click();
  await as.waitFor({ state: 'detached' });
  await d.getByText('Offer letter.odt').first().waitFor();
});
await step('sent: Kim gets Offer letter.odt and can look at it in Mail', async () => {
  const d = page.getByRole('dialog', { name: 'New message' }).or(page.getByRole('dialog', { name: 'Your offer' }));
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const k = await kctx.newPage();
  k.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(k, 'kim@acme.com');
  await k.locator('.mail-list').getByText('Your offer', { exact: true }).click({ timeout: 40000 });
  await k.getByText('Offer letter.odt').first().click();
  await k.getByText('we are pleased to offer you the role').first().waitFor({ timeout: 20000 });
  await k.screenshot({ path: `${SP}/shots/attachas-received.png` });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
