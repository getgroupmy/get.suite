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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
const AXE = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);

await step('Mail → Attachments lists the files in the Inbox, newest first, with sender and subject', async () => {
  const a = await upload('budget.csv', 'Item,Cost\nPaint,120\n');
  const b = await upload('Q3 report.pdf', '%PDF-1.4\n% a tiny test file\n');
  const c = await upload('site photo.png', 'not really a picture');
  for (const [subject, files] of [['Q3 numbers', [a.id, b.id]], ['Site visit', [c.id]], ['No files here', []]]) {
    const r = await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: 'See attached.', attachments: files });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
  }
  await until(async () => ((await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []).length === 3, 30000);
  await page.reload();
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Attachments' });
  const list = d.getByRole('list', { name: 'Attachments' });
  await list.locator('li').first().waitFor({ timeout: 20000 });
  const names = await list.locator('li strong').allInnerTexts();
  if (names.join('|') !== 'site photo.png|budget.csv|Q3 report.pdf') throw new Error(names.join('|'));
  await list.locator('li', { hasText: 'budget.csv' }).getByText(/Olivia Owner · .* · Q3 numbers/).waitFor();
  await list.locator('li', { hasText: 'Q3 report.pdf' }).getByRole('link', { name: 'Open Q3 report.pdf' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/attachments.png` });
  await axe(page, 'attachments');
});

await step('narrowed by kind, or by words', async () => {
  const d = page.getByRole('dialog', { name: 'Attachments' });
  const list = d.getByRole('list', { name: 'Attachments' });
  await d.getByLabel('Kind of file').selectOption({ label: 'Spreadsheets' });
  await until(async () => (await list.locator('li strong').allInnerTexts().catch(() => [])).join('|') === 'budget.csv');
  await d.getByLabel('Kind of file').selectOption({ label: 'Presentations' });
  await d.getByText('No attachments match.').waitFor();
  await d.getByLabel('Kind of file').selectOption({ label: 'All files' });
  await d.getByLabel('Search attachments').fill('site visit');
  await until(async () => (await list.locator('li strong').allInnerTexts().catch(() => [])).join('|') === 'site photo.png');
  await d.getByLabel('Search attachments').fill('');
  await until(async () => (await list.locator('li').count().catch(() => 0)) === 3);
});

await step('download one, save one to Drive, and go to its email', async () => {
  const d = page.getByRole('dialog', { name: 'Attachments' });
  const [dl] = await Promise.all([page.waitForEvent('download'), d.getByRole('link', { name: 'Download budget.csv' }).click()]);
  const body = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (dl.suggestedFilename() !== 'budget.csv' || !body.includes('Paint,120')) throw new Error(`${dl.suggestedFilename()}: ${body}`);
  await d.getByRole('button', { name: 'Save Q3 report.pdf to Drive' }).click();
  await page.getByText('Saved Q3 report.pdf to Drive').waitFor();
  const drive = await api(page, 'GET', '/files?q=Q3%20report');
  if (!JSON.stringify(drive.body).includes('Q3 report.pdf')) throw new Error(JSON.stringify(drive.body).slice(0, 300));
  await d.getByRole('button', { name: 'Go to the email with site photo.png' }).click();
  await page.locator('.mail-reader').getByText('Site visit').first().waitFor();
  if (await page.getByRole('dialog', { name: 'Attachments' }).count()) throw new Error('still open');
});

await step('a part that isn’t an attachment, or isn’t a part, is refused', async () => {
  const m = ((await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages).find((x) => x.subject === 'Q3 numbers');
  for (const part of ['1', 'HEADER', '9']) {
    const r = await page.evaluate(async ([u, p]) => (await fetch(`/api/mail/messages/${u}/parts/${p}?folder=INBOX`)).status, [m.uid, part]);
    if (r !== 404) throw new Error(`${part}: ${r}`);
  }
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
