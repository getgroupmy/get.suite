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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const put = (url, body) => page.evaluate(async ([u, b]) => (await fetch(u, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: b })).json(), [url, body]);
const OLD = ['port: 80', 'name: shop', ...Array.from({ length: 20 }, (_, i) => `item${i}: ${i}`), 'mode: dev', ''].join('\n');
const NEW = ['port: 80', 'name: store', ...Array.from({ length: 20 }, (_, i) => `item${i}: ${i}`), 'mode: dev', 'cache: on', ''].join('\n');
let f;
await step('Version history → Compare shows an earlier version against now: the changed line removed and added, the new one added, the rest folded', async () => {
  f = await put('/api/files/upload?name=shop.yaml', OLD);
  await put(`/api/files/${f.id}/versions`, NEW);
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for shop.yaml' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  const dlg = page.getByRole('dialog', { name: 'Version history: shop.yaml' });
  await dlg.getByRole('button', { name: /^Compare the version from/ }).click();
  const view = dlg.getByRole('region', { name: 'Differences, line by line' });
  await view.waitFor({ timeout: 15000 });
  await dlg.getByText('2 lines added').waitFor();
  await dlg.getByText('1 removed').waitFor();
  const del = await view.locator('.diff-line.del .diff-text').allTextContents();
  const add = await view.locator('.diff-line.add .diff-text').allTextContents();
  if (del.join('|') !== 'Removed: name: shop' || add.join('|') !== 'Added: name: store|Added: cache: on') throw new Error(JSON.stringify({ del, add }));
  const fold = view.getByRole('button', { name: /^Show \d+ unchanged lines$/ });
  await fold.waitFor();
  const before = await view.locator('.diff-line').count();
  await fold.click();
  if (await view.locator('.diff-line').count() <= before) throw new Error('fold did not open');
  await view.getByText('item10: 10').waitFor();
  await page.screenshot({ path: `${SP}/shots/version-diff.png` });
  await page.evaluate(AXE);
  const v = await page.evaluate(async () => (await window.axe.run(document.querySelector('[role=dialog]'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  if (v.length) throw new Error(v.join(' | '));
  await dlg.getByRole('button', { name: '← All versions' }).click();
  await dlg.getByRole('list', { name: 'Versions' }).waitFor();
});
await step('an AI assistant (MCP compare_file_versions) lists the versions and says what changed since the previous one', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const tok = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Files helper', scope: 'read', days: 30 })).body.token;
  const call = (name, args) => page.evaluate(async ([t, n, a]) => (await (await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: n, arguments: a } }) })).json()).result, [tok, name, args]);
  const list = (await call('compare_file_versions', { file: `file:${f.id}` }))?.structuredContent?.versions || [];
  if (list.length !== 1) throw new Error(JSON.stringify(list));
  const ch = (await call('compare_file_versions', { file: `file:${f.id}`, version: 'previous' }))?.structuredContent;
  if (ch?.added !== 2 || ch?.removed !== 1 || !/- 2: name: shop\n\+ 2: name: store/.test(ch.changes) || !/\+ 24: cache: on/.test(ch.changes)) throw new Error(JSON.stringify(ch));
});
await step('no Compare for a picture, nor for someone who may only view a file with downloading off', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pic = await page.evaluate(async (b) => (await fetch('/api/files/upload?name=logo.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) })).json(), PNG);
  await page.evaluate(async ([id, b]) => fetch(`/api/files/${id}/versions`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) }), [pic.id, PNG]);
  await page.keyboard.press('Escape');
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for logo.png' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  const dlg = page.getByRole('dialog', { name: 'Version history: logo.png' });
  await dlg.getByRole('list', { name: 'Versions' }).getByRole('listitem').nth(1).waitFor();
  if (await dlg.getByRole('button', { name: /^Compare/ }).count()) throw new Error('Compare offered for a picture');
  await page.keyboard.press('Escape');
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kim.id, role: 'viewer' }] });
  await api(page, 'PATCH', `/files/${f.id}`, { no_download: true });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Drive' }).first().waitFor();
  await k.goto(`${B}/drive/shared`);
  await k.getByRole('button', { name: 'Actions for shop.yaml' }).click({ timeout: 15000 });
  await k.getByRole('menuitem', { name: 'Version history' }).click();
  const kd = k.getByRole('dialog', { name: 'Version history: shop.yaml' });
  await kd.getByRole('list', { name: 'Versions' }).getByRole('listitem').nth(1).waitFor();
  if (await kd.getByRole('button', { name: /^Compare/ }).count()) throw new Error('Compare offered to a view-only person');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
