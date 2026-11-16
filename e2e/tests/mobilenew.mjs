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
    await p.evaluate(AXE);
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
await step('set up: shares inside and outside, a note, sign-ins', async () => {
  await api(page, 'POST', '/orgs', { name: 'Globex Corporation International', domain: 'globex.com', admin_name: 'Gil Green', admin_local: 'gil', admin_password: 'password123' });
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const gil = (await api(page, 'GET', '/users/lookup?email=gil@globex.com')).body;
  const up = (n) => page.evaluate(async (a) => (await fetch(`/api/files/upload?name=${encodeURIComponent(a)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json(), n);
  const long = await up('A rather long file name for the quarterly planning review 2026 final final.txt');
  await api(page, 'PUT', `/files/${long.id}/shares`, { shares: [{ user_id: kim.id, role: 'editor' }, { user_id: gil.id, role: 'viewer' }] });
  const n = (await api(page, 'POST', '/notes', { title: 'Shared note', body: 'hello' })).body;
  await api(page, 'PUT', `/notes/${n.id}/shares`, { user_ids: [kim.id] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await signIn(phone, 'olivia@acme.com');
});
await step('Admin → Shared outside, on a phone', async () => {
  await phone.goto(`${B}/admin`);
  await phone.getByRole('tab', { name: 'Shared outside' }).click();
  await phone.getByRole('table', { name: 'Shared outside the company' }).waitFor();
  // A tab far to the right: the page stays in place (its heading and the list on screen).
  const h = await phone.getByRole('heading', { name: 'Admin', level: 1 }).boundingBox();
  if (!h || h.x < 0 || h.x > 390) throw new Error(`heading off screen: ${JSON.stringify(h)}`);
  const t = await phone.getByRole('table', { name: 'Shared outside the company' }).boundingBox();
  if (!t || t.x < -1 || t.x > 390) throw new Error(`list off screen: ${JSON.stringify(t)}`);
  await phone.screenshot({ path: `${SP}/shots/phone-shared-outside.png` });
  await fits(phone, 'Shared outside');
});
await step('Admin → Security checkup and Activity, on a phone', async () => {
  await phone.getByRole('tab', { name: 'Security checkup' }).click();
  await phone.getByRole('list', { name: 'Checkup' }).waitFor();
  await fits(phone, 'Checkup');
  await phone.getByRole('tab', { name: 'Activity' }).click();
  await phone.getByLabel('Kind of activity').waitFor();
  await fits(phone, 'Activity');
});
await step('Settings → Recent security activity, on a phone', async () => {
  await phone.goto(`${B}/settings`);
  await phone.getByRole('region', { name: 'Recent security activity' }).waitFor();
  await phone.getByRole('region', { name: 'Recent security activity' }).scrollIntoViewIfNeeded();
  await phone.screenshot({ path: `${SP}/shots/phone-security-activity.png` });
  await fits(phone, 'Security activity');
});
await step('Drive → Shared by me, and Kim’s Shared with me, on a phone', async () => {
  await phone.goto(`${B}/drive/sharedbyme`);
  await phone.locator('.files tbody tr').first().waitFor();
  await phone.screenshot({ path: `${SP}/shots/phone-shared-by-me.png` });
  await fits(phone, 'Shared by me');
});
await step('Notes → Shared with me (as Kim), on a phone', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const k = await ctx.newPage();
  await signIn(k, 'kim@acme.com');
  await k.goto(`${B}/drive/shared`);
  await k.locator('.files tbody tr').first().waitFor();
  await fits(k, 'Shared with me');
  await k.goto(`${B}/notes`);
  await k.getByText('Shared note').first().waitFor();
  await fits(k, 'Notes');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
