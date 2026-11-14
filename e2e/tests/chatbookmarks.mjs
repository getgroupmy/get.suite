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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let kim;
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
let ch, doc;
const bar = (p) => p.getByRole('navigation', { name: 'Bookmarks' });
await step('a team channel with Kim, and a plan document', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  ch = (await api(page, 'POST', '/chat/channels', { name: 'launch-team', private: true, members: [kimId] })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan' })).body.id;
  await api(page, 'PUT', `/files/${doc}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await kim.goto(`${B}/chat/${ch}`);
  await bar(kim).getByRole('button', { name: '+ Bookmark' }).waitFor();
});
await step('+ Bookmark with a pasted Workspace link: it shows for Kim too, straight away', async () => {
  await page.goto(`${B}/chat/${ch}`);
  await bar(page).getByRole('button', { name: '+ Bookmark' }).click();
  const d = page.getByRole('dialog', { name: 'Add a bookmark' });
  await d.getByLabel('Link').fill(`${B}/docs/${doc}`);
  await d.getByLabel('Name (optional)').fill('Launch plan');
  await d.getByRole('button', { name: 'Add' }).click();
  await page.getByText('Bookmark added for everyone in the conversation').waitFor();
  await bar(kim).getByRole('link', { name: 'Launch plan' }).waitFor({ timeout: 10000 });
  if (await bar(page).getByRole('link', { name: 'Launch plan' }).getAttribute('href') !== `/docs/${doc}`) throw new Error('kept as a Workspace page');
});
await step('a website, named from its address; it opens in a new tab', async () => {
  await bar(page).getByRole('button', { name: '+ Bookmark' }).click();
  const d = page.getByRole('dialog', { name: 'Add a bookmark' });
  await d.getByLabel('Link').fill('https://www.example.com/press-kit');
  await d.getByRole('button', { name: 'Add' }).click();
  const link = bar(page).getByRole('link', { name: 'example.com/press-kit' });
  await link.waitFor();
  if (await link.getAttribute('target') !== '_blank') throw new Error('not a new tab');
  await page.screenshot({ path: `${SP}/shots/chat-bookmarks.png` });
});
await step('Kim opens the plan from the bar, in Workspace', async () => {
  await bar(kim).getByRole('link', { name: 'Launch plan' }).click();
  await kim.waitForURL(`**/docs/${doc}`);
});
await step('removing one takes it away for everyone; a bad link is refused', async () => {
  await bar(page).getByRole('button', { name: 'Remove bookmark example.com/press-kit' }).click();
  await page.getByText('“example.com/press-kit” removed').waitFor();
  await kim.goto(`${B}/chat/${ch}`);
  await bar(kim).getByRole('link', { name: 'Launch plan' }).waitFor();
  if (await bar(kim).getByRole('link', { name: 'example.com/press-kit' }).count()) throw new Error('still there for Kim');
  await bar(page).getByRole('button', { name: '+ Bookmark' }).click();
  const d = page.getByRole('dialog', { name: 'Add a bookmark' });
  await d.getByLabel('Link').fill('javascript:alert(1)');
  await d.getByRole('button', { name: 'Add' }).click();
  await page.getByText('Links start with https:// (or / for a page in Workspace)').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
