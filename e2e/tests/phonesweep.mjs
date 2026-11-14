import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

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
let phone;
await step('a phone, signed in', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await signIn(phone, 'olivia@acme.com');
});
const problems = [];
const check = async (label) => { try { await fits(phone, label); } catch (e) { problems.push(e.message); await phone.screenshot({ path: `${SP}/shots/phone-${label.replace(/\W+/g, '_')}.png` }); } };
await step('every Admin tab fits a phone', async () => {
  await phone.goto(`${B}/admin`);
  const tabs = await phone.getByRole('tab').allInnerTexts();
  for (const name of tabs) {
    await phone.getByRole('tab', { name, exact: true }).click();
    await phone.waitForTimeout(700);
    await check(`Admin ${name.replace(/\n/g, ' ')}`);
  }
  if (problems.length) throw new Error(problems.join(' || '));
});
await step('the apps fit a phone', async () => {
  problems.length = 0;
  for (const [path, label] of [['/home', 'Home'], ['/drive', 'Drive'], ['/calendar', 'Calendar'], ['/contacts', 'Contacts'], ['/tasks', 'Tasks'], ['/chat', 'Chat'], ['/notes', 'Notes'], ['/meet', 'Meet'], ['/forms', 'Forms'], ['/settings', 'Settings']]) {
    await phone.goto(`${B}${path}`);
    await phone.waitForTimeout(1200);
    await check(label);
  }
  if (problems.length) throw new Error(problems.join(' || '));
});

await step('documents, spreadsheets, presentations and deeper screens fit a phone', async () => {
  problems.length = 0;
  const ids = {};
  ids.doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] } })).body.id;
  ids.sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Item', B1: '3' } }] } })).body.id;
  ids.slides = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Deck', content: { theme: 'light', slides: [{ id: 's1', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Hello' }] }] } })).body.id;
  for (const [path, label] of [[`/docs/${ids.doc}`, 'Docs'], [`/sheets/${ids.sheet}`, 'Sheets'], [`/slides/${ids.slides}`, 'Slides'],
    ['/drive/shared', 'Drive shared'], ['/drive/sharedbyme', 'Drive shared by me'], ['/drive/activity', 'Drive activity'], ['/drive/links', 'Drive links'],
    ['/calendar?view=month', 'Calendar month'], ['/tasks', 'Tasks'], ['/notes?reminders=1', 'Notes reminders']]) {
    await phone.goto(`${B}${path}`);
    await phone.waitForTimeout(1500);
    await check(label);
  }
  if (problems.length) throw new Error(problems.join(' || '));
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
