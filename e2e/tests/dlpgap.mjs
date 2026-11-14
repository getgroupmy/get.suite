import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
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
let doc, gina;
await step('a second company (Globex) that works with Acme, a rule and a doc', async () => {
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  const g = await api(page, 'POST', '/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (g.status !== 201) throw new Error(JSON.stringify(g.body));
  const globexId = g.body.id || g.body.org?.id;
  for (const id of [me.org_id, globexId]) { const r = await api(page, 'PATCH', `/orgs/${id}`, { allow_external: true }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); }
  await api(page, 'POST', '/dlp/rules', { name: 'Falcon', detector: 'words', words: 'Project Falcon', action: 'warn' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Roadmap' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Project Falcon ships in May' }] }] } });
  gina = (await api(page, 'GET', '/users?org=' + globexId)).body;
});
await step('mailing a link to it to Globex: share and send asks first, then shares and sends', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('The roadmap');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(`Here it is: ${B}/docs/${doc.id} `);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const gaps = page.getByRole('dialog', { name: "Some recipients can't open a linked file" });
  await gaps.getByText('Roadmap').waitFor({ timeout: 15000 });
  await gaps.getByRole('button', { name: 'Share (can view) and send' }).click();
  const ask = page.getByRole('dialog', { name: 'Check before sharing' });
  await ask.getByText('It contains words your company protects (Falcon: Project Falcon).').waitFor();
  await page.screenshot({ path: `${SP}/shots/dlp-gap.png` });
  await ask.getByRole('button', { name: 'Share anyway' }).click();
  await page.getByText(/Sent to 1 recipient/).waitFor({ timeout: 20000 });
  const shares = (await api(page, 'GET', `/files/${doc.id}/shares`)).body;
  if (!JSON.stringify(shares).includes('gina@globex.com') && !shares.some((s) => /Gina/.test(s.name || ''))) throw new Error(JSON.stringify(shares));
  const log = JSON.stringify((await api(page, 'GET', '/audit?limit=50')).body);
  if (!log.includes('dlp.sent_anyway')) throw new Error('logged');
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors.filter((e) => !/409/.test(e))));
await browser.close();
