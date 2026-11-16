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
let ch, dm;
await step('a channel and a direct message with things to find', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kimp', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  ch = (await api(page, 'POST', '/chat/channels', { name: 'warehouse' })).body.id;
  const other = (await api(page, 'POST', '/chat/channels', { name: 'random' })).body.id;
  const kp = await (await browser.newContext()).newPage();
  await kp.goto(B);
  await kp.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kimp@acme.com', password: 'password123' }) }));
  const root = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'The forklift is booked for Monday' })).body;
  await api(kp, 'POST', `/chat/channels/${ch}/messages`, { body: 'Forklift keys are at reception', parent_id: root.id });
  await api(kp, 'POST', `/chat/channels/${other}/messages`, { body: 'Forklift manual: https://example.com/manual' });
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kim.id })).body.id;
  await api(kp, 'POST', `/chat/channels/${dm}/messages`, { body: 'Can I borrow the forklift?' });
  const folder = (await api(page, 'POST', '/chat/files-folder')).body.id;
  const pic = await page.evaluate(async (parent) => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    return (await fetch(`/api/files/upload?name=forklift.png&parent=${parent}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: png })).json();
  }, folder);
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Forklift photo', files: [pic.id] });
  await kp.context().close();
});
const results = () => page.getByRole('list', { name: 'Search results' });
const shown = async () => (await results().locator('.chat-result strong + *').allInnerTexts()).map((t) => t.trim()).sort();
await step('filter buttons narrow the results and change the search box', async () => {
  await page.goto(`${B}/chat/${ch}`);
  await page.getByLabel('Search messages').fill('forklift');
  await page.keyboard.press('Enter');
  await results().getByText('Can I borrow the forklift?').waitFor();
  if ((await results().locator('li').count()) !== 5) throw new Error(`five: ${await shown()}`);
  const narrow = page.getByRole('group', { name: 'Narrow the search' });
  await narrow.getByRole('button', { name: 'In this conversation' }).click();
  await page.getByRole('heading', { name: 'Results for “forklift in:#warehouse”' }).waitFor();
  await until(async () => (await results().locator('li').count()) === 3);
  if (await page.getByLabel('Search messages').inputValue() !== 'forklift in:#warehouse') throw new Error('box not updated');
  await narrow.getByRole('button', { name: 'Has pictures' }).click();
  await until(async () => (await results().locator('li').count()) === 1);
  await results().getByText('📎 forklift.png').waitFor();
  if ((await narrow.getByRole('button', { name: 'Has pictures' }).getAttribute('aria-pressed')) !== 'true') throw new Error('not shown as on');
  await page.screenshot({ path: `${SP}/shots/chat-filters.png` });
  await axe(page, 'chat filters');
  await narrow.getByRole('button', { name: 'Has pictures' }).click();
  await narrow.getByRole('button', { name: 'In this conversation' }).click();
  await page.getByRole('heading', { name: 'Results for “forklift”' }).waitFor();
  await until(async () => (await results().locator('li').count()) === 5);
});
await step('typed filters: from:, in: a person, has:link, is:thread, and a left-out word', async () => {
  const run = async (q, n) => {
    await page.getByLabel('Search messages').fill(q);
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: `Results for “${q}”` }).waitFor();
    await until(async () => (await results().locator('li').count()) === n).catch(async () => { throw new Error(`${q}: ${await shown()}`); });
  };
  await run('forklift from:kim', 3);
  await run('in:kim', 1);
  await results().getByText('Can I borrow the forklift?').waitFor();
  await run('forklift has:link', 1);
  await results().getByText('https://example.com/manual').waitFor();
  await run('forklift is:thread', 1);
  await results().getByText('· in a thread').waitFor();
  await run('forklift -monday', 4);
  // Only the words searched for are marked, not the filters.
  await run('keys from:kim', 1);
  const marked = await results().locator('mark').allInnerTexts();
  if (marked.join() !== 'keys') throw new Error(`marked ${marked}`);
});
await step('a mistake in a filter says what to write', async () => {
  await page.getByLabel('Search messages').fill('forklift has:spaceship');
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'has: can be file, image or link' }).waitFor();
  const today = new Date(); const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await page.getByLabel('Search messages').fill(`forklift on:${d}`);
  await page.keyboard.press('Enter');
  await until(async () => (await results().locator('li').count()) === 5);
});
await step('on a phone, the buttons wrap and nothing slides sideways', async () => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.reload();
  await page.getByLabel('Search messages').fill('forklift');
  await page.keyboard.press('Enter');
  await page.getByRole('group', { name: 'Narrow the search' }).getByRole('button', { name: 'In threads' }).waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (wide) throw new Error('page wider than the phone');
  const over = await page.getByRole('group', { name: 'Narrow the search' }).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (over) throw new Error('buttons overflow');
  await page.screenshot({ path: `${SP}/shots/chat-filters-phone.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
