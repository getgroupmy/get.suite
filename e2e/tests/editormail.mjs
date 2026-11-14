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
await step('a document: ⋮ → Email link: a new email with its link', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Q3 report' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Email link' }).click();
  await page.waitForURL(/\/mail/);
  const d = page.getByRole('dialog', { name: 'Q3 report' }).or(page.getByRole('dialog', { name: 'New message' }));
  await d.waitFor();
  if (await d.getByLabel('Subject').inputValue() !== 'Q3 report') throw new Error('subject');
  const link = d.getByRole('textbox', { name: 'Message' }).getByRole('link', { name: 'Q3 report' });
  await link.waitFor();
  if (await link.getAttribute('href') !== `${B}/docs/${doc.id}`) throw new Error(await link.getAttribute('href'));
  await d.getByRole('button', { name: /Discard|Delete draft/ }).first().click().catch(() => {});
});
await step('⋮ → Email as attachment…: Mail asks how to attach it, then attaches a Word file', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Email as attachment…' }).click();
  await page.waitForURL(/\/mail/);
  const as = page.getByRole('dialog', { name: 'Attach “Q3 report”' });
  await as.waitFor();
  await as.getByRole('button', { name: 'Attach' }).click();
  await page.getByText('Q3 report.docx').first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SP}/shots/editor-mail.png` });
});
await step('a viewer of a document that can’t be downloaded: Email link, but no Email as attachment', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kimv', domain: 'acme.com', name: 'Kim Viewer', password: 'password123' })).body.id;
  if ((await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] })).status !== 200) throw new Error('share');
  if ((await api(page, 'PATCH', `/files/${doc.id}`, { no_download: true })).status !== 200) throw new Error('no_download');
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const k = await kctx.newPage();
  await signIn(k, 'kimv@acme.com');
  await k.goto(`${B}/docs/${doc.id}`);
  await k.getByRole('button', { name: 'More' }).click();
  await k.getByRole('menuitem', { name: 'Email link' }).waitFor();
  if (await k.getByRole('menuitem', { name: 'Email as attachment…' }).count()) throw new Error('offered to a viewer who can’t download');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
