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

await step('attachments show as chips under their message in the list: open, download, or +N more', async () => {
  const f = [];
  for (const [n, t] of [['budget.csv', 'Item,Cost\nPaint,120\n'], ['Q3 report.pdf', '%PDF-1.4\n%\n'], ['plan.docx', 'not really'], ['extra.txt', 'four']]) f.push((await upload(n, t)).id);
  for (const [subject, files] of [['Everything for Monday', f], ['Just the plan', [f[2]]], ['Plain note', []]]) {
    const r = await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: 'Here.', attachments: files });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
  }
  await until(async () => ((await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []).length === 3, 30000);
  await page.reload();
  const many = page.getByRole('group', { name: 'Attachments: Everything for Monday' });
  await many.waitFor({ timeout: 20000 });
  const chips = await many.locator('.file-chip .ellipsis, .file-chip.more').allInnerTexts();
  if (chips.join('|') !== 'budget.csv|Q3 report.pdf|plan.docx|+1 more') throw new Error(chips.join('|'));
  await page.getByRole('group', { name: 'Attachments: Just the plan' }).getByRole('link', { name: 'Download plan.docx' }).waitFor();
  if (await page.getByRole('group', { name: 'Attachments: Plain note' }).count()) throw new Error('chips on a message without files');
  if (await many.getByRole('link', { name: 'Open Q3 report.pdf' }).getAttribute('target') !== '_blank') throw new Error('PDF not opened in a tab');
  await page.screenshot({ path: `${SP}/shots/mail-chips.png` });
  await axe(page, 'chips');
  const [dl] = await Promise.all([page.waitForEvent('download'), many.getByRole('link', { name: 'Download budget.csv' }).click()]);
  if (!(await import('node:fs')).readFileSync(await dl.path(), 'utf8').includes('Paint,120')) throw new Error('csv content');
  await page.getByText('No message selected').waitFor(); // the chip didn't open the message too
  await many.getByRole('button', { name: '+1 more' }).click();
  await page.locator('.mail-reader').getByText('Everything for Monday').first().waitFor();
});

await step('the compact list leaves them out', async () => {
  const r = await api(page, 'PUT', '/users/me/mail-list', { compact: true });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/mail`);
  await page.locator('.mail-list').getByText('Everything for Monday').waitFor();
  if (await page.getByRole('group', { name: 'Attachments: Everything for Monday' }).count()) throw new Error('chips in the compact list');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
