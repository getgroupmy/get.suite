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

let kimPage;
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
  await k.locator('.mail-reader').getByText('Offer letter.odt').first().click(); // not its chip in the list
  await k.getByText('we are pleased to offer you the role').first().waitFor({ timeout: 20000 });
  await k.screenshot({ path: `${SP}/shots/attachas-received.png` });
  kimPage = k;
});
await step('Kim saves that email to Drive as a PDF: it is in Saved emails, with the subject and words in it', async () => {
  const k = kimPage;
  await k.keyboard.press('Escape').catch(() => {});
  await k.getByRole('button', { name: 'More for this message' }).click();
  await k.getByRole('menuitem', { name: 'Save to Drive as PDF' }).click();
  await k.getByText(/Saved to Drive: Saved emails \/ Your offer/).waitFor();
  const top = (await api(k, 'GET', '/files')).body;
  const folder = (Array.isArray(top) ? top : top.files || []).find((f) => f.name === 'Saved emails');
  const inside = (await api(k, 'GET', `/files?parent=${folder.id}`)).body;
  const pdf = (Array.isArray(inside) ? inside : inside.files || []).find((f) => /^Your offer \(\d{4}-\d{2}-\d{2}\)\.pdf$/.test(f.name));
  if (!pdf || pdf.mime !== 'application/pdf') throw new Error(JSON.stringify(inside));
  const b64 = await k.evaluate(async (id) => btoa(Array.from(new Uint8Array(await (await fetch(`/api/files/${id}/raw`)).arrayBuffer()), (c) => String.fromCharCode(c)).join('')), pdf.id);
  const buf = Buffer.from(b64, 'base64');
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  let text = null;
  try { text = (await import('node:child_process')).execFileSync('pdftotext', ['-', '-'], { input: buf }).toString(); } catch { /* not installed */ }
  if (text !== null && (!/Your offer/.test(text) || !/From: Olivia Owner <olivia@acme\.com>/.test(text) || !/Offer letter\.odt/.test(text))) throw new Error(text);
});
await step('a document can be attached as a PDF too', async () => {
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  const d = page.getByRole('dialog', { name: 'New message' });
  await d.getByRole('button', { name: 'Attach from Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach from Drive' });
  await pick.getByLabel('Search your files').fill('Offer');
  await pick.getByRole('button', { name: /Offer letter/ }).filter({ hasNotText: '.odt' }).first().click(); // (not the .odt copy attached before)
  const as = page.getByRole('dialog', { name: 'Attach “Offer letter”' });
  if (!(await as.getByLabel('Word (.docx)').isChecked())) throw new Error('Word stays the usual choice');
  await as.getByLabel('PDF (.pdf)').check();
  await as.getByRole('button', { name: 'Attach' }).click();
  await as.waitFor({ state: 'detached' });
  await d.getByText('Offer letter.pdf').first().waitFor();
  const folder = (await api(page, 'GET', '/files')).body;
  const list = Array.isArray(folder) ? folder : folder.files || [];
  const att = list.find((f) => f.name === 'Email attachments');
  const inside = (await api(page, 'GET', `/files?parent=${att.id}`)).body;
  const pdf = (Array.isArray(inside) ? inside : inside.files || []).find((f) => f.name === 'Offer letter.pdf');
  if (!pdf || pdf.mime !== 'application/pdf') throw new Error(JSON.stringify(pdf));
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
