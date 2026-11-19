// Removing a meeting room in Admin: it says how many meetings to come have it booked, and Undo puts it back
// with those bookings.
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
let room, ev, t;
await step('setup: a room booked for a meeting tomorrow', async () => {
  await owner.goto(B);
  await owner.getByLabel('Your company name').fill('Acme Trading');
  await owner.getByLabel('Company domain').fill('acme.com');
  await owner.getByLabel('Your full name').fill('Olivia Owner');
  await owner.getByLabel('Address before @').fill('olivia');
  await owner.getByLabel('Password', { exact: true }).fill('password123');
  await owner.getByLabel('Confirm password').fill('password123');
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await owner.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  room = (await api(owner, 'POST', '/rooms', { name: 'Boardroom', capacity: 12 })).body;
  t = Date.now() + 864e5;
  ev = (await api(owner, 'POST', '/events', { title: 'Quarterly review', start: t, end: t + 3600e3, rooms: [room.id] })).body;
});

await step('remove it: told 1 meeting loses it; Undo: back, booked again', async () => {
  await owner.goto(`${B}/admin`);
  await owner.getByRole('tab', { name: 'Company settings' }).click().catch(() => owner.getByRole('button', { name: 'Company settings' }).click());
  await owner.getByRole('button', { name: 'Remove Boardroom' }).click();
  const dlg = owner.getByRole('dialog', { name: 'Remove Boardroom?' });
  await dlg.getByText('1 meeting to come has it booked, and will lose it.').waitFor();
  await dlg.getByRole('button', { name: 'Remove room' }).click();
  await owner.locator('.toast', { hasText: 'Boardroom removed' }).getByRole('button', { name: 'Undo' }).click();
  await owner.getByText('Boardroom is back, with its bookings').waitFor({ timeout: 8000 });
  await owner.getByRole('button', { name: 'Remove Boardroom' }).waitFor();
  const e = (await api(owner, 'GET', `/events?from=${t - 1}&to=${t + 7200e3}`)).body.find((x) => x.id === ev.id);
  if (!(e?.rooms || []).length) throw new Error('the meeting lost its room');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
