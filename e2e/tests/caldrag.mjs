import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const now = new Date();
const D0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const at = (days, h, m = 0) => new Date(D0.getFullYear(), D0.getMonth(), D0.getDate() + days, h, m).getTime();
const side = D0.getDay() < 6 ? 1 : -1; // a neighbouring day in the same week
const events = async () => (await api(page, 'GET', `/events?from=${at(-40, 0)}&to=${at(40, 0)}`)).body;
const find = async (title) => (await events()).filter((e) => e.title === title);
const box = (title) => page.locator('.tg-event', { hasText: title }).first();
const drag = async (loc, dx, dy, { from = 'center', release = true } = {}) => {
  const b = await loc.boundingBox();
  const x = b.x + b.width / 2, y = from === 'bottom' ? b.y + b.height - 3 : b.y + Math.min(12, b.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  if (release) await page.mouse.up();
};
const colWidth = async () => (await page.locator('.tg-col').first().boundingBox()).width;
const toWeek = async () => {
  await page.goto(B + '/calendar');
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.locator('.tg-scroll').evaluate((s) => { s.scrollTop = 7 * 48; });
};
const moved = async () => { await page.getByText(/^Moved to /).last().waitFor(); await page.waitForTimeout(300); };
const hm = (t) => { const d = new Date(t); return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

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
  const mk = (b) => api(page, 'POST', '/events', { color: '#1a73e8', location: '', description: '', all_day: false, ...b });
  await mk({ title: 'Design review', start: at(0, 10), end: at(0, 11) });
  await mk({ title: 'Weekly sync', start: at(0, 14), end: at(0, 15), rrule: { freq: 'weekly' } });
  await mk({ title: 'Daily check', start: at(-3, 8), end: at(-3, 8, 30), rrule: { freq: 'daily' } });
  await mk({ title: 'Offsite', start: at(0, 0), end: at(1, 0) - 1, all_day: true });
  // A colleague invites Olivia: she can't move their event.
  await api(page, 'POST', '/users', { local: 'carl', domain: 'acme.com', name: 'Carl Colleague', password: 'password123' });
  const ctx = await browser.newContext(); const carl = await ctx.newPage();
  await carl.goto(B);
  await carl.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'carl@acme.com', password: 'password123' }) }));
  const r = await api(carl, 'POST', '/events', { title: 'Client call', start: at(0, 16), end: at(0, 17), guests: ['olivia@acme.com'], color: '#0b8043' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await ctx.close();
});

await step('move an event to another day and time', async () => {
  await toWeek();
  await box('Design review').waitFor();
  await drag(box('Design review'), side * (await colWidth()), 48 + 24); // +1 day, +1.5 hours
  await moved();
  const [e] = await find('Design review');
  if (hm(e.start) !== hm(at(side, 11, 30)) || e.end - e.start !== 36e5) throw new Error(`${hm(e.start)} – ${hm(e.end)}`);
  if (await page.getByRole('dialog').count()) throw new Error('a dialog opened after the drop');
});

await step('drag the bottom edge to change the end', async () => {
  await drag(box('Design review'), 0, 48, { from: 'bottom' });
  await page.getByText(/^Now ends at 1:30\sPM$/).waitFor();
  const [e] = await find('Design review');
  if (hm(e.end) !== hm(at(side, 13, 30))) throw new Error(hm(e.end));
  await page.screenshot({ path: `${SP}/shots/caldrag-week.png` });
});

await step('Escape cancels a drag; a plain click still opens the event', async () => {
  await drag(box('Design review'), 0, 96, { release: false });
  if (!(await page.locator('.tg-event.dragging').count())) throw new Error('no preview while dragging');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  const [e] = await find('Design review');
  if (hm(e.start) !== hm(at(side, 11, 30))) throw new Error('moved anyway: ' + hm(e.start));
  await box('Design review').click();
  await page.getByRole('dialog', { name: 'Edit event' }).waitFor();
  await page.keyboard.press('Escape');
});

await step('repeating event: move only this one', async () => {
  await drag(box('Weekly sync'), 0, -48);
  const dlg = page.getByRole('dialog', { name: 'Move repeating event' });
  await dlg.waitFor();
  await dlg.getByLabel('This event').check();
  await dlg.getByRole('button', { name: 'Move' }).click();
  await moved();
  const list = await find('Weekly sync');
  const series = list.find((e) => e.rrule), single = list.find((e) => !e.rrule);
  if (!series || !single || hm(single.start) !== hm(at(0, 13)) || !series.exdates.includes(at(0, 14))) throw new Error(JSON.stringify(list));
});

await step('repeating event: move all, cancel leaves it', async () => {
  await drag(box('Daily check'), 0, 24);
  const dlg = page.getByRole('dialog', { name: 'Move repeating event' });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  if ((await find('Daily check'))[0].start !== at(-3, 8)) throw new Error('changed on cancel');
  await drag(box('Daily check'), 0, 24);
  await dlg.getByLabel('All events').check();
  await dlg.getByRole('button', { name: 'Move' }).click();
  await moved();
  const [e] = await find('Daily check');
  if (hm(e.start) !== hm(at(-3, 8, 30)) || e.end - e.start !== 18e5) throw new Error(hm(e.start));
});

await step('invitations from others cannot be dragged', async () => {
  await drag(box('Client call'), 0, 96);
  await page.waitForTimeout(400);
  const [e] = await find('Client call');
  if (e.start !== at(0, 16)) throw new Error('moved');
  await box('Client call').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).waitFor();
  await page.keyboard.press('Escape');
});

await step('all-day row: drag to another day', async () => {
  const chip = page.locator('.tg-allday .chip', { hasText: 'Offsite' });
  await drag(chip, side * (await colWidth()), 0);
  await moved();
  const [e] = await find('Offsite');
  if (e.start !== at(side, 0) || new Date(e.end).getDate() !== new Date(at(side, 0)).getDate()) throw new Error(`${hm(e.start)} ${hm(e.end)}`);
});

await step('month view: drag a chip to another day, keeping its time', async () => {
  await page.getByRole('radio', { name: 'Month' }).click();
  const chip = page.locator('.month .chip', { hasText: 'Design review' });
  const target = page.locator(`.month .day[data-day="${at(side + 7 <= 0 ? side - 7 : side + 7, 0)}"]`);
  const off = D0.getDate() + side + 7 > new Date(D0.getFullYear(), D0.getMonth() + 1, 0).getDate() ? side - 7 : side + 7;
  const t = page.locator(`.month .day[data-day="${at(off, 0)}"]`);
  const a = await chip.boundingBox(), b = await t.boundingBox();
  await drag(chip, b.x + b.width / 2 - (a.x + a.width / 2), b.y + b.height - 10 - (a.y + Math.min(12, a.height / 2)));
  await moved();
  const [e] = await find('Design review');
  if (hm(e.start) !== hm(at(off, 11, 30)) || hm(e.end) !== hm(at(off, 13, 30))) throw new Error(`${hm(e.start)} ${hm(e.end)}`);
  if (await page.getByRole('dialog').count()) throw new Error('a dialog opened after the drop');
  await page.screenshot({ path: `${SP}/shots/caldrag-month.png` });
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
