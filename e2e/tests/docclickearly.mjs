// Clicking into a document before it has finished loading: the caret stays where you clicked. A document
// opened before shows at once from the copy kept on the device; if you click into it and type before the
// server's copy arrives, your words land where you clicked, not at the top (the editor used to put the
// caret at the start when loading finished, whatever you'd done meanwhile).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let doc;
const lines = () => page.locator('.ProseMirror').evaluate((el) => [...el.querySelectorAll('p')].map((p) => p.textContent));

await step('setup: a document opened once on this device', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  doc = (await api('POST', '/files/new', { kind: 'doc', name: 'Early click', content: { type: 'doc', content: Array.from({ length: 5 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Row ${i}:` }] })) } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror p').nth(4).waitFor();
  await page.getByText('Saved').first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500); // kept on the device
  await page.goto(`${B}/drive`);
});

await step('click and type before the server’s copy arrives: the words land where you clicked', async () => {
  // The server's side of the live connection answers two seconds late.
  await page.routeWebSocket(/\/ws\/collab/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => setTimeout(() => { try { ws.send(m); } catch { /* closed */ } }, 2000));
  });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror p').nth(3).waitFor({ timeout: 5000 }); // from the device, at once
  await page.locator('.ProseMirror p').nth(3).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' early');
  await page.waitForTimeout(3500); // the server's copy has arrived
  await page.keyboard.type(' late');
  let t;
  for (let k = 0; k < 20; k++) { t = await lines(); if (t[3] === 'Row 3: early late') break; await page.waitForTimeout(250); }
  if (t[3] !== 'Row 3: early late') throw new Error(`the words went elsewhere: ${JSON.stringify(t)}`);
  // And on the server too.
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  let server;
  for (let k = 0; k < 20; k++) { server = (await api('GET', `/files/${doc.id}/text`)).body?.text || ''; if (server.includes('Row 3: early late')) break; await page.waitForTimeout(500); }
  if (!server.includes('Row 3: early late')) throw new Error(`saved as ${JSON.stringify(server)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
