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
// The server out of reach (restarting for an update, the proxy down) while the network is fine: after a few
// seconds a bar says so, with Try now; once it's back the bar goes and live updates flow again.
let blocked = false, parent; const open = [];
await step('a bar says when Workspace can’t be reached, and goes when it can again (Try now)', async () => {
  await page.routeWebSocket(/\/ws$/, (ws) => { if (blocked) { ws.close({ code: 1006 }); return; } ws.connectToServer(); open.push(ws); });
  parent = (await api(page, 'POST', '/files/folder', { name: 'Team' })).body;
  await page.goto(`${B}/drive/folder/${parent.id}`);
  await page.waitForTimeout(1500);
  if (!open.length) throw new Error('no live connection');
  const bar = page.locator('.offline-bar');
  // A blip shorter than a few seconds says nothing.
  blocked = true;
  for (const ws of open.splice(0)) ws.close({ code: 1006 });
  await page.waitForTimeout(1500);
  if (await bar.count()) throw new Error('bar shown for a short blip');
  await bar.getByText('Can’t reach Workspace right now. Reconnecting…'.replace('’', "'")).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/unreachable.png` });
  // Back: Try now reconnects at once (no waiting for the next retry), and the bar goes.
  blocked = false;
  await bar.getByRole('button', { name: 'Try now' }).click();
  await bar.waitFor({ state: 'detached', timeout: 5000 });
  if (!open.length) throw new Error('did not reconnect');
});
await step('live updates flow again after it (a new folder shows without a reload)', async () => {
  await api(page, 'POST', '/files/folder', { name: 'Made while away', parent_id: parent.id });
  await page.locator('table.files').getByText('Made while away').waitFor({ timeout: 10000 });
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
