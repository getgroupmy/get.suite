// Deleted by mistake, small things too: a booking page (its link) and a contact group come back with Undo.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const p of [owner]) p.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await owner.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let bp;
await step('setup', async () => {
  await owner.goto(B);
  await owner.getByLabel('Your company name').fill('Acme Trading');
  await owner.getByLabel('Company domain').fill('acme.com');
  await owner.getByLabel('Your full name').fill('Olivia Owner');
  await owner.getByLabel('Address before @').fill('olivia');
  await owner.getByLabel('Password', { exact: true }).fill('password123');
  await owner.getByLabel('Confirm password').fill('password123');
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await owner.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  bp = (await api(owner, 'POST', '/bookings', { title: 'Intro call', duration: 30 })).body;
  await api(owner, 'POST', '/contacts/groups', { name: 'Suppliers', members: [{ name: 'Ann', email: 'ann@x.example' }] });
});

await step('a booking page deleted, then Undo: its link works again', async () => {
  await owner.goto(`${B}/calendar`);
  await owner.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = owner.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Delete Intro call' }).click();
  await owner.getByRole('button', { name: 'Undo' }).click();
  await dlg.getByText('Intro call').first().waitFor({ timeout: 8000 });
  const token = bp.token || (bp.url || '').split('/').pop();
  const r = await owner.request.get(`${B}/api/public/book/${token}`);
  if (r.status() !== 200) throw new Error(`the link: ${r.status()}`);
});

await step('a contact group deleted, then Undo: back with its people', async () => {
  await owner.goto(`${B}/contacts`);
  await owner.getByRole('tab', { name: 'Groups' }).click();
  await owner.getByRole('button', { name: 'Delete Suppliers' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: /Delete/ }).click();
  await owner.locator('.toast', { hasText: 'Group “Suppliers” deleted' }).getByRole('button', { name: 'Undo' }).click();
  let g = null;
  for (let k = 0; k < 20 && !g; k++) { await owner.waitForTimeout(300); g = (await api(owner, 'GET', '/contacts/groups')).body.find((x) => x.name === 'Suppliers'); }
  await owner.getByRole('button', { name: 'Delete Suppliers' }).waitFor({ timeout: 8000 }); // listed again
  if (!JSON.stringify(g?.members || []).includes('ann@x.example')) throw new Error('its people are missing');
});
await step('a booking page deleted: Recently deleted in Booking pages puts it back later, link and all', async () => {
  const p = (await api(owner, 'POST', '/bookings', { title: 'Demo slot', duration: 30 })).body;
  await api(owner, 'DELETE', `/bookings/${p.id}`);
  await owner.goto(`${B}/calendar`);
  await owner.getByRole('button', { name: 'Booking pages' }).click();
  await owner.getByRole('dialog', { name: 'Booking pages' }).getByRole('button', { name: 'Recently deleted' }).click();
  const bin = owner.getByRole('dialog', { name: 'Recently deleted booking pages' });
  await bin.getByRole('button', { name: 'Restore Demo slot' }).click();
  await owner.getByText('“Demo slot” is back').waitFor();
  await owner.getByRole('dialog', { name: 'Booking pages' }).getByText('Demo slot').first().waitFor();
  const token = p.token || (p.url || '').split('/').pop();
  const r = await owner.request.get(`${B}/api/public/book/${token}`);
  if (r.status() !== 200) throw new Error(`the link: ${r.status()}`);
});
await step('Make a copy of a booking page: opened to change, with a link of its own', async () => {
  const p = (await api(owner, 'POST', '/bookings', { title: 'Coffee chat', duration: 30 })).body;
  await owner.goto(`${B}/calendar`);
  await owner.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = owner.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Make a copy of Coffee chat' }).click();
  await owner.getByText('“Copy of Coffee chat” made').waitFor();
  const pages = (await api(owner, 'GET', '/bookings')).body;
  const c = pages.find((x) => x.title === 'Copy of Coffee chat');
  if (!c || c.url === p.url || c.duration !== 30) throw new Error(JSON.stringify(c));
  await dlg.getByRole('textbox', { name: /Title/ }).first().waitFor(); // opened for changing
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
