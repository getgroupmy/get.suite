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
// …and in an open window, no text squeezed into a sliver beside its buttons (a few words a line).
const roomy = async (p, label) => {
  const tight = await p.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].pop();
    if (!d) return ['no window open'];
    return [...d.querySelectorAll('strong, label, p, span, td, li, button')].filter((e) => {
      const t = (e.innerText || '').trim();
      if (t.length < 20 || e.children.length > 3) return false;
      const b = e.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(e).lineHeight) || 18;
      return b.width > 0 && b.width < 110 && b.height > lh * 3.5; // a long text in a narrow column
    }).slice(0, 3).map((e) => `“${e.innerText.trim().slice(0, 30)}” ${Math.round(e.getBoundingClientRect().width)}px wide`);
  });
  if (tight.length) throw new Error(`${label}: squeezed: ${tight.join('; ')}`);
};
let phone, fileId;
const problems = [];
const look = async (label) => {
  try { await fits(phone, label); await roomy(phone, label); } catch (e) { problems.push(e.message); await phone.screenshot({ path: `${SP}/shots/phone-${label.replace(/\W+/g, '_')}.png` }); }
  await phone.keyboard.press('Escape');
  await phone.waitForTimeout(300);
};
await step('a phone, signed in, with a shared file, a task and an event', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const f = await page.evaluate(async () => (await fetch('/api/files/upload?name=Quarterly%20planning%20review%20notes.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json());
  fileId = f.id;
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kim.id, role: 'editor' }] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await signIn(phone, 'olivia@acme.com');
});
await step('Drive windows on a phone: Share, Details, Labels, Move', async () => {
  await phone.goto(`${B}/drive`);
  const row = phone.locator('.files tbody tr', { hasText: 'Quarterly planning' });
  await row.waitFor();
  for (const item of ['Share', 'Details', 'Labels…', 'Move to…', 'Version history']) {
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await phone.getByRole('menuitem', { name: item, exact: true }).click();
    await phone.getByRole('dialog').first().waitFor();
    await phone.waitForTimeout(500);
    await look(`Drive ${item}`);
  }
  if (problems.length) throw new Error(problems.join(' || '));
});
await step('Calendar, Tasks and Contacts windows on a phone', async () => {
  problems.length = 0;
  await phone.goto(`${B}/calendar`);
  await phone.getByRole('button', { name: /^(Create|New event)/ }).first().click();
  await phone.getByRole('dialog').first().waitFor();
  await look('Calendar new event');
  await phone.goto(`${B}/contacts`);
  await phone.getByRole('button', { name: /^(New contact|Add contact|Create contact)/ }).first().click();
  await phone.getByRole('dialog').first().waitFor();
  await look('Contacts new contact');
  await phone.goto(`${B}/settings`);
  await phone.waitForTimeout(800);
  await fits(phone, 'Settings').catch((e) => problems.push(e.message));
  if (problems.length) throw new Error(problems.join(' || '));
});

await step('no stray “0” for an ordinary file: in its Share window, and in Admin → Storage', async () => {
  await page.goto(`${B}/drive`);
  const row = page.locator('.files tbody tr', { hasText: 'Quarterly planning' });
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
  const d = page.getByRole('dialog', { name: /^Share “Quarterly/ });
  await d.getByLabel('Email address').waitFor();
  if (/^\s*0\s*$/m.test(await d.innerText())) throw new Error(`a stray 0: ${(await d.innerText()).slice(0, 120)}`);
  await page.keyboard.press('Escape');
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Storage' }).click();
  const cell = page.locator('td.name', { hasText: 'Quarterly planning review notes.txt' }).first();
  await cell.waitFor();
  if ((await cell.innerText()).trim() !== 'Quarterly planning review notes.txt') throw new Error(`“${await cell.innerText()}”`);
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
