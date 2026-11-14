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
await step('Attach from Drive → A link to it: a named link to the document goes in the message', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Project brief' })).body;
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  const d = page.getByRole('dialog', { name: 'New message' });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByLabel('Subject').fill('The brief');
  await d.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Here it is: ');
  await d.getByRole('button', { name: 'Attach from Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach from Drive' });
  await pick.getByLabel('Search your files').fill('Project');
  await pick.getByRole('button', { name: /Project brief/ }).click();
  const as = page.getByRole('dialog', { name: 'Attach “Project brief”' });
  await as.getByLabel('A link to it (in the message)').check();
  await as.getByRole('button', { name: 'Insert link' }).click();
  const link = d.getByRole('textbox', { name: 'Message' }).getByRole('link', { name: 'Project brief' });
  await link.waitFor();
  if (await link.getAttribute('href') !== `${B}/docs/${doc.id}`) throw new Error(await link.getAttribute('href'));
  if (await d.getByText('Project brief.docx').count()) throw new Error('attached as a file too');
  await page.screenshot({ path: `${SP}/shots/maillink.png` });
});
await step('sending: Kim can\'t open it yet, so Mail offers to share it; Kim then opens it from the email', async () => {
  const d = page.getByRole('dialog', { name: 'The brief' }).or(page.getByRole('dialog', { name: 'New message' }));
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Share (can view) and send' }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const k = await kctx.newPage();
  await signIn(k, 'kim@acme.com');
  await k.locator('.mail-list').getByText('The brief', { exact: true }).click({ timeout: 40000 });
  const href = await k.locator('.mail-body a, iframe').first().evaluate((el) => (el.tagName === 'IFRAME' ? [...el.contentDocument.querySelectorAll('a')].map((a) => a.href).join(' ') : el.href)).catch(() => '');
  if (href && !href.includes(`/docs/${doc.id}`)) throw new Error(`link in the email: ${href}`);
  if ((await api(k, 'GET', `/files/${doc.id}`)).status !== 200) throw new Error('Kim cannot open the document');
});
await step('an uploaded file’s link (as Drive’s Copy link gives) is checked too: Mail offers to share it', async () => {
  const up = await page.request.post(`${B}/api/files/upload?name=budget.txt`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, data: 'numbers' });
  const f = await up.json();
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  const d = page.getByRole('dialog', { name: 'New message' });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByLabel('Subject').fill('Budget file');
  await d.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(`The budget: ${B}/drive?preview=${f.id} `);
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('dialog', { name: "Some recipients can't open a linked file" }).getByText('budget.txt').waitFor();
  await page.getByRole('button', { name: 'Share (can view) and send' }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  const shares = (await api(page, 'GET', `/files/${f.id}/shares`)).body;
  const list = Array.isArray(shares) ? shares : shares.shares || [];
  if (!JSON.stringify(list).includes('kim@acme.com') && !JSON.stringify(list).includes('Kim Park')) throw new Error(JSON.stringify(shares));
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
