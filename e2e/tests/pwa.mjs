import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ channel: 'chromium' }); // full Chromium (new headless): it has notifications
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed|ERR_INTERNET_DISCONNECTED|Failed to fetch|WebSocket/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
await step('setup: a colleague', async () => {
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
await step('installable: a manifest, and the service worker takes the page over', async () => {
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const m = await page.evaluate(async (h) => (await fetch(h)).json(), href);
  if (m.name !== 'Workspace' || m.display !== 'standalone') throw new Error(JSON.stringify(m));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 10000);
});
await step('without a connection the app still opens, says it is offline, and asks nothing of a cache', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.context().setOffline(true);
  await page.reload();
  await page.getByText('You\'re offline. Workspace reconnects by itself when the network is back.').waitFor();
  const api = await page.evaluate(async () => { try { await fetch('/api/auth/status'); return 'answered'; } catch { return 'failed'; } });
  if (api !== 'failed') throw new Error('an API answer came from somewhere while offline');
  await page.context().setOffline(false);
  await page.reload();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  if (await page.locator('.offline-bar').count()) throw new Error('still says offline');
});
await step('shared from another app: kept on the device, then saved to the folder you pick', async () => {
  await api(page, 'POST', '/files/folder', { name: 'Receipts' });
  await page.goto(`${B}/drive`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 10000);
  // What the phone's Share menu does: a form POST of the files to the app's share address.
  await page.evaluate(() => {
    const f = document.createElement('form'); f.method = 'POST'; f.action = '/share-target'; f.enctype = 'multipart/form-data';
    const input = document.createElement('input'); input.type = 'file'; input.name = 'files'; f.appendChild(input);
    const dt = new DataTransfer();
    dt.items.add(new File(['Lunch 12.50'], 'receipt-lunch.txt', { type: 'text/plain' }));
    dt.items.add(new File(['Taxi 23.00'], 'receipt-taxi.txt', { type: 'text/plain' }));
    input.files = dt.files;
    document.body.appendChild(f); f.submit();
  });
  const dlg = page.getByRole('dialog', { name: 'Save to Drive' });
  await dlg.getByRole('list', { name: 'Shared files' }).getByText('receipt-taxi.txt').waitFor();
  await dlg.getByLabel('Save in').selectOption({ label: 'Receipts' });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('tbody').getByText('receipt-lunch.txt').waitFor();
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Receipts' }).waitFor();
  // Kept only until saved.
  const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-share', 1); r.onsuccess = () => { const g = r.result.transaction('pending').objectStore('pending').get('last'); g.onsuccess = () => res(g.result || null); }; }));
  if (left) throw new Error('still kept on the device');
});
await step('notifications on this device: offered in the bell’s settings; a pushed message shows as a notification', async () => {
  await page.context().grantPermissions(['notifications'], { origin: B });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /Notifications|bell/i }).first().click().catch(() => {});
  await page.getByRole('button', { name: 'Notification settings' }).click();
  const dlg = page.getByRole('dialog', { name: 'Notification settings' });
  await dlg.getByText('On this device, even with Workspace closed').waitFor();
  await dlg.getByLabel('Direct messages in Chat (on devices with notifications on)').waitFor(); // can be turned off
  await dlg.getByLabel('New email (on devices with notifications on)').waitFor();
  // Headless Chromium reports notifications as blocked whatever is granted; a real browser offers the button.
  await dlg.getByRole('button', { name: 'Turn on notifications on this device' }).or(dlg.getByText('Notifications are blocked for Workspace in this browser')).waitFor();
  // The server takes only real push services, and has a key to sign with.
  const key = (await api(page, 'GET', '/push')).body.publicKey;
  if (!/^[\w-]{80,}$/.test(key)) throw new Error(key);
  if ((await api(page, 'POST', '/push/subscribe', { endpoint: 'https://10.0.0.5/x', keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } })).status !== 400) throw new Error('took a local address');
  // A push message, delivered to the service worker as the push service would: shown as a notification.
  const cdp = await page.context().newCDPSession(page);
  const regs = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { const r = e.registrations.find((x) => x.scopeURL.startsWith(B)); if (r) resolve(r.registrationId); }));
  await cdp.send('ServiceWorker.enable');
  const registrationId = await regs;
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: B, registrationId, data: JSON.stringify({ title: 'Kim mentioned you in “Plan”', body: 'Can you check?', link: '/docs/x', tag: 'mention' }) });
  const shown = await until(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}|${n.body}|${n.data?.link}`)).then((l) => l.length && l), 10000);
  if (shown[0] !== 'Kim mentioned you in “Plan”|Can you check?|/docs/x') throw new Error(JSON.stringify(shown));
});
await step('devices with notifications on are listed; one can be removed (a lost phone)', async () => {
  const keys = { p256dh: 'B' + 'x'.repeat(86), auth: 'y'.repeat(22) };
  for (const n of [1, 2]) if ((await api(page, 'POST', '/push/subscribe', { endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys })).status !== 200) throw new Error('subscribe');
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.getByRole('button', { name: 'Notification settings' }).click();
  const list = page.getByRole('dialog', { name: 'Notification settings' }).getByRole('list', { name: 'Devices with notifications on' });
  await until(async () => (await list.getByRole('listitem').count()) === 2, 10000);
  const first = list.getByRole('listitem').first();
  if (!/Chrome on Linux/.test(await first.innerText())) throw new Error(await first.innerText());
  await first.getByRole('button', { name: /^Stop notifications on/ }).click();
  await until(async () => (await list.getByRole('listitem').count()) === 1, 10000);
  if ((await api(page, 'GET', '/push')).body.devices.length !== 1) throw new Error('not removed on the server');
});
await step('an admin keeps what’s written off lock screens (company settings)', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const box = page.getByLabel(/Keep what’s written off lock screens/);
  await box.check();
  await page.locator('.toast', { hasText: 'Notifications on phones now hide what’s written' }).waitFor();
  if ((await api(page, 'GET', '/orgs/current')).body.push_private !== true) throw new Error('not saved');
  await page.reload();
  if (!(await page.getByLabel(/Keep what’s written off lock screens/).isChecked())) throw new Error('not shown as on');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
