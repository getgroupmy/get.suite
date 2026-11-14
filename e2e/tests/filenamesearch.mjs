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
// Each search lands in the address, and the box is made again from it, before the next is typed
// (typed in between, it would be wiped).
const search = async (q) => {
  await page.getByLabel('Search mail').fill(q);
  await page.getByLabel('Search mail').press('Enter');
  await page.waitForURL((u) => new URL(u).searchParams.get('q') === q);
  await until(async () => (await page.getByLabel('Search mail').inputValue()) === q);
  await page.waitForTimeout(200);
};
const subjects = async () => (await page.locator('.mail-list .msg-subject').allInnerTexts()).map((t) => t.trim()).sort().join('|');

await step('filename: finds mail by the names of its attachments', async () => {
  const f = {};
  for (const [n, t] of [['Q3 report final.pdf', '%PDF-1.4\n'], ['Q3 report draft.pdf', '%PDF-1.4\n'], ['budget.xlsx', 'x'], ['photo.jpg', 'y']]) f[n] = (await upload(n, t)).id;
  for (const [subject, files, text] of [
    ['Final numbers', ['Q3 report final.pdf', 'budget.xlsx'], 'Here.'],
    ['Draft numbers', ['Q3 report draft.pdf'], 'Here.'],
    ['Team photo', ['photo.jpg'], 'Here.'],
    ['About the pdf', [], 'I will send the pdf tomorrow.'], // says "pdf", has no files
  ]) {
    const r = await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text, attachments: files.map((n) => f[n]) });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
  }
  await until(async () => ((await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []).length === 4, 30000);
  await page.reload();
  await page.locator('.mail-list').getByText('Team photo').waitFor();
  await search('filename:pdf');
  await until(async () => (await subjects()) === 'Draft numbers|Final numbers');
  await search('filename:"q3 report" -filename:draft');
  await until(async () => (await subjects()) === 'Final numbers');
  await search('filename:xlsx from:olivia');
  await until(async () => (await subjects()) === 'Final numbers');
  await search('-filename:pdf');
  await until(async () => (await subjects()) === 'About the pdf|Team photo');
  await search('filename:docx');
  await page.getByText('No messages found').waitFor();
});

await step('a saved filename: search counts the unread that fit', async () => {
  const r = await api(page, 'POST', '/mail/searches', { query: 'filename:pdf', folder: 'INBOX', name: 'PDFs' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  const list = (await api(page, 'GET', '/mail/searches')).body;
  const sv = list.find((x) => x.name === 'PDFs');
  if (sv.unseen !== 2) throw new Error(JSON.stringify(sv));
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
