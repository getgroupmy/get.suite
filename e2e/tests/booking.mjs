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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let url, visitor;
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
await step('make a booking page in Calendar', async () => {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'New booking page' }).click();
  await dlg.getByLabel('Title').fill('Intro call');
  await dlg.getByLabel('Length').selectOption({ label: '30 minutes' });
  for (const d of ['Sun', 'Sat']) await dlg.getByLabel(d, { exact: true }).check(); // every day, so the test works any day
  await dlg.getByLabel('From', { exact: true }).fill('00:00');
  await dlg.getByLabel('To', { exact: true }).fill('23:30');
  await dlg.getByLabel('At least this much notice').selectOption({ label: 'None' });
  await dlg.getByLabel('Gap before and after').selectOption({ label: '15 minutes' });
  await dlg.getByLabel('Bookings a day').selectOption({ label: 'At most 5' });
  if (!(await dlg.getByLabel('Email visitors a reminder the day before').isChecked())) throw new Error('reminders not on by default');
  await dlg.getByRole('button', { name: '+ Add a question' }).click();
  await dlg.getByLabel('Question 1', { exact: true }).fill('Phone number');
  await dlg.getByLabel('Question 1 is required').check();
  await dlg.getByRole('button', { name: '+ Add a question' }).click(); // left blank: not saved
  await dlg.getByRole('button', { name: 'Create' }).click();
  await dlg.getByText('Intro call').waitFor();
  url = (await api(page, 'GET', '/bookings')).body[0].url;
  const saved = (await api(page, 'GET', '/bookings')).body[0];
  if (saved.buffer_min !== 15 || saved.max_per_day !== 5 || saved.remind !== true || JSON.stringify(saved.questions) !== '[{"label":"Phone number","required":true}]') throw new Error(JSON.stringify(saved));
  if (!/\/b\/[\w-]+$/.test(url)) throw new Error(url);
  await page.keyboard.press('Escape');
});
await step('a visitor without an account sees free times and books one', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  visitor = await ctx.newPage();
  visitor.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByRole('heading', { name: 'Intro call' }).waitFor();
  await visitor.getByText('Book time with Olivia Owner').waitFor();
  const tabs = visitor.getByRole('tab');
  await tabs.nth(1).click();
  await visitor.getByRole('group', { name: /^Times on/ }).getByRole('button').first().click();
  await visitor.getByLabel('Your name').fill('Oscar Out');
  await visitor.getByLabel('Your email').fill('oscar@example.org');
  await visitor.getByLabel('Phone number', { exact: true }).fill('+1 555 0100');
  await visitor.getByLabel('Anything to add (optional)').fill('About the quote');
  await visitor.screenshot({ path: `${SP}/shots/booking-form.png` });
  await visitor.getByRole('button', { name: 'Book' }).click();
  await visitor.getByRole('heading', { name: 'You’re booked' }).waitFor();
  await visitor.getByRole('link', { name: 'Change or cancel this booking' }).waitFor();
});
await step('the owner is told, and it is on their calendar with the visitor as guest', async () => {
  await page.locator('.toast', { hasText: 'Oscar Out booked “Intro call”' }).waitFor();
  const evs = (await api(page, 'GET', `/events?from=${Date.now()}&to=${Date.now() + 3 * 864e5}`)).body;
  const ev = evs.find((e) => e.title === 'Intro call: Oscar Out');
  if (!ev || ev.guests[0]?.email !== 'oscar@example.org') throw new Error(JSON.stringify(evs.map((e) => e.title)));
  if (!ev.description.includes('Phone number: +1 555 0100')) throw new Error(ev.description);
  await page.getByRole('dialog').count();
});
await step('that time is no longer offered', async () => {
  const ev = (await api(page, 'GET', `/events?from=${Date.now()}&to=${Date.now() + 3 * 864e5}`)).body.find((e) => e.title === 'Intro call: Oscar Out');
  await visitor.reload();
  await visitor.getByRole('heading', { name: 'Intro call' }).waitFor();
  const token = url.split('/b/')[1];
  const slots = await visitor.evaluate(async (t) => (await (await fetch(`/api/public/book/${t}`)).json()).days.flatMap((d) => d.slots), token);
  if (slots.includes(ev.start)) throw new Error('still offered');
});
await step('the visitor cancels with their link: off the calendar, and the owner is told', async () => {
  const ev = (await api(page, 'GET', `/events?from=${Date.now()}&to=${Date.now() + 3 * 864e5}`)).body.find((e) => e.title === 'Intro call: Oscar Out');
  const link = ev.description.match(/https?:\/\/\S+\/b\/cancel\/[\w-]+/)[0];
  await visitor.goto(link.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByRole('heading', { name: 'Your booking' }).waitFor();
  await visitor.getByText('Intro call', { exact: true }).waitFor();
  // First they move it to another time; then they cancel after all.
  await visitor.getByRole('button', { name: 'Pick another time' }).click();
  await visitor.getByRole('tab').nth(1).click();
  await visitor.getByRole('group', { name: /^Times on/ }).getByRole('button').nth(2).click();
  await visitor.getByRole('heading', { name: 'Booking moved' }).waitFor();
  const movedEv = await until(async () => (await api(page, 'GET', `/events?from=${Date.now()}&to=${Date.now() + 4 * 864e5}`)).body.find((e) => e.title === 'Intro call: Oscar Out' && e.start !== ev.start));
  if (!movedEv) throw new Error('not moved');
  if (!JSON.stringify((await api(page, 'GET', '/notifications')).body).includes('Oscar Out moved “Intro call”')) throw new Error('owner not told of the move');
  await visitor.getByRole('button', { name: 'Cancel booking' }).click();
  await visitor.getByRole('heading', { name: 'Booking cancelled' }).waitFor();
  await page.locator('.toast', { hasText: 'Oscar Out cancelled “Intro call”' }).waitFor().catch(async () => {
    if (!JSON.stringify((await api(page, 'GET', '/notifications')).body).includes('Oscar Out cancelled “Intro call”')) throw new Error('not told');
  });
  const still = (await api(page, 'GET', `/events?from=${Date.now()}&to=${Date.now() + 3 * 864e5}`)).body.some((e) => e.title === 'Intro call: Oscar Out');
  if (still) throw new Error('still on the calendar');
});
await step('Booking pages → Add people who booked to Contacts: Oscar saved (his booking cancelled or not), not twice', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Add people who booked Intro call to Contacts' }).click();
  await page.getByText('Added Oscar Out to your contacts').waitFor();
  const list = (await api(page, 'GET', '/contacts')).body;
  if (!list.some((c) => c.email === 'oscar@example.org' && c.name === 'Oscar Out')) throw new Error(JSON.stringify(list));
  await dlg.getByRole('button', { name: 'Add people who booked Intro call to Contacts' }).click();
  await page.getByText('Everyone who booked is already in your contacts or a colleague').waitFor();
  await page.keyboard.press('Escape');
});
await step('“Add people who book to my contacts”: ticked and saved, the next visitor is in Contacts', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Change Intro call' }).click();
  await dlg.getByLabel('Add people who book to my contacts').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Booking page saved').waitFor();
  await page.keyboard.press('Escape');
  if ((await api(page, 'GET', '/bookings')).body[0].add_contacts !== true) throw new Error('not saved');
  const tk = url.split('/b/')[1];
  const slots = (await api(visitor, 'GET', `/public/book/${tk}`)).body.days.flatMap((d) => d.slots);
  const r = await api(visitor, 'POST', `/public/book/${tk}`, { start: slots[slots.length - 1], name: 'Quinn Quick', email: 'quinn@example.org', answers: ['+1 555 0111'] });
  if (r.status >= 300) throw new Error(JSON.stringify(r.body));
  const list = (await api(page, 'GET', '/contacts')).body;
  if (!list.some((c) => c.email === 'quinn@example.org' && c.name === 'Quinn Quick')) throw new Error(JSON.stringify(list));
});
await step('Booking pages → Download the bookings: a CSV of who booked, when, and the cancelled one marked', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'The bookings of Intro call' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download (.csv)' }).click()]);
  if (dl.suggestedFilename() !== 'Intro call bookings.csv') throw new Error(dl.suggestedFilename());
  const text = (await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8')).replace(/^\ufeff/, '');
  const lines = text.trim().split('\r\n');
  if (!lines[0].startsWith('Name,Email,Starts,Ends,Time zone,Host,Booked,Status,') || !lines[0].endsWith(',Note')) throw new Error(lines[0]);
  const oscar = lines.find((l) => l.startsWith('Oscar Out,')), quinn = lines.find((l) => l.startsWith('Quinn Quick,'));
  if (!oscar?.includes(',Cancelled ') || !quinn?.includes(',Booked,')) throw new Error(text);
  // The page's question has a column of its own, with Quinn's answer in it.
  if (lines[0] !== 'Name,Email,Starts,Ends,Time zone,Host,Booked,Status,Phone number,Note' || !quinn.endsWith(',Booked,+1 555 0111,')) throw new Error(`${lines[0]} | ${quinn}`);
  await page.keyboard.press('Escape');
});
await step('Booking pages → bookings → Open in Sheets: a spreadsheet in Drive with the same rows', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'The bookings of Intro call' }).click();
  await page.getByRole('menuitem', { name: 'Open in Sheets' }).click();
  const toast = page.locator('.toast', { hasText: 'Made “Intro call bookings” in your Drive' });
  await toast.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="A1"]', { hasText: 'Name' }).waitFor();
  await page.getByText('Quinn Quick', { exact: true }).first().waitFor();
  await page.getByText('Phone number', { exact: true }).first().waitFor();
  await page.getByText('+1 555 0111', { exact: true }).first().waitFor(); // (kept as written, not a sum)
});
await step('Paused until a day: the visitor sees no times before it, and is told when bookings open again', async () => {
  const day = new Date(Date.now() + 3 * 864e5); const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Change Intro call' }).click();
  await dlg.getByLabel('Paused until').fill(ymd);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Booking page saved').waitFor();
  await dlg.getByText(/paused until/).waitFor();
  await page.keyboard.press('Escape');
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByRole('status').filter({ hasText: 'Not taking bookings until' }).waitFor();
  const pub = await api(visitor, 'GET', `/public/book/${url.split('/b/')[1]}`);
  if (pub.body.paused_until !== ymd || pub.body.days.some((d) => d.date < ymd)) throw new Error(JSON.stringify(pub.body));
  await api(page, 'PATCH', `/bookings/${(await api(page, 'GET', '/bookings')).body[0].id}`, { paused_until: null });
});
await step('“No bookings while my vacation reply is on”: ticked and saved', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Change Intro call' }).click();
  await dlg.getByLabel('No bookings while my vacation reply is on').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Booking page saved').waitFor();
  await page.keyboard.press('Escape');
  if ((await api(page, 'GET', '/bookings')).body[0].skip_away !== true) throw new Error('not saved');
});
await step('turned off: the link says so', async () => {
  const p = (await api(page, 'GET', '/bookings')).body[0];
  await api(page, 'PATCH', `/bookings/${p.id}`, { enabled: false });
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByRole('heading', { name: 'Booking not available' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
