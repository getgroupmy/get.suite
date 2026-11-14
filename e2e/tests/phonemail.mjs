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

// Today's new screens on a phone: nothing wider than the screen (no sideways scrolling).
const fits = async (p, label) => {
  await p.waitForTimeout(300);
  const r = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, wide: [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`) }));
  if (r.doc > r.win + 1) throw new Error(`${label}: page is ${r.doc}px on a ${r.win}px screen (${r.wide.join(', ')})`);
  // Nor an area of the page slid sideways (only a row of tabs, a sidebar strip on a phone, or a table's own strip, may scroll).
  const slid = await p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.scrollLeft > 0 && !e.closest('.tabs, .subnav, table, pre, .cm-editor')).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)} by ${e.scrollLeft}px`));
  if (slid.length) throw new Error(`${label}: slid sideways: ${slid.join(', ')}`);
  // …or about to: a page whose content is wider than it (tapping what's off to the right would slide it).
  const over = await p.evaluate(() => [...document.querySelectorAll('.page')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `page ${e.scrollWidth}px in ${e.clientWidth}px: ${[...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > window.innerWidth + 1 && !x.closest('.tabs, table, pre')).slice(0, 2).map((x) => `${x.tagName.toLowerCase()}.${String(x.className).slice(0, 25)}`).join(', ')}`));
  if (over.length) throw new Error(`${label}: ${over.join('; ')}`);
};
await step('Mail on a phone: the list with attachment chips, a message, Attachments, writing', async () => {
  const a = await upload('A long attachment name for the quarterly review.pdf', '%PDF-1.4\n');
  const b = await upload('budget.csv', 'x');
  await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'A rather long subject line about the quarterly review and budget', text: 'See attached.', attachments: [a.id, b.id] });
  await until(async () => ((await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []).length === 1, 30000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await phone.goto(B);
  await phone.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'olivia@acme.com', password: 'password123' }) }));
  await phone.goto(`${B}/mail`);
  await phone.getByRole('group', { name: /^Attachments: / }).waitFor({ timeout: 20000 });
  await phone.screenshot({ path: `${SP}/shots/phone-mail-list.png` });
  await fits(phone, 'Mail list');
  await phone.locator('.mail-list .msg-row').first().click();
  await phone.locator('.mail-reader').getByText('See attached.').waitFor();
  await fits(phone, 'Mail message');
  await phone.goto(`${B}/mail`);
  await phone.getByRole('button', { name: 'Attachments', exact: true }).click(); // in the sidebar strip, scrolled to
  await phone.getByRole('dialog', { name: 'Attachments' }).getByRole('list', { name: 'Attachments' }).waitFor();
  await phone.screenshot({ path: `${SP}/shots/phone-attachments.png` });
  await fits(phone, 'Mail Attachments');
  // Each file's name and details get the width; the buttons go on a line of their own when they must.
  for (const li of await phone.getByRole('dialog', { name: 'Attachments' }).locator('.attach-list li').all()) {
    const w = (await li.locator('.grow').boundingBox()).width;
    if (w < 180) throw new Error(`a file's name and details squeezed to ${Math.round(w)}px`);
  }
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
