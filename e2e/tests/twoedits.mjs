// Edited in two places at once: something is open for changing here while another device changes a different
// part of it. Saving here keeps the other change (only what was changed here is written).
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
const found = [];
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

await step('a contact: name changed here, phone number changed elsewhere', async () => {
  const c = (await api('POST', '/contacts', { name: 'Ada Lovelace' })).body;
  await page.goto(`${B}/contacts`);
  await page.getByText('Ada Lovelace').first().click();
  const edit = page.getByRole('button', { name: /^Edit/ }).first();
  if (await edit.count()) await edit.click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Name').waitFor();
  const r = await api('PATCH', `/contacts/${c.id}`, { phone: '+44 7700 900123' }).then((x) => x.status >= 400 ? api('PUT', `/contacts/${c.id}`, { ...c, phone: '+44 7700 900123' }) : x);
  console.log('contact elsewhere', r.status);
  await dlg.getByLabel('Name').fill('Ada King');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const now = (await api('GET', '/contacts')).body.find((x) => x.id === c.id);
  console.log('contact now', JSON.stringify(now).slice(0, 300));
  if (!JSON.stringify(now).includes('Ada King')) found.push('contact: the name here wasn’t saved');
  if (!JSON.stringify(now).includes('900123')) found.push('contact: the phone number from elsewhere was lost');
});

await step('an event: title changed here, place changed elsewhere', async () => {
  const d = new Date(); d.setHours(10, 0, 0, 0);
  const ev = (await api('POST', '/events', { title: 'Planning', start: d.getTime(), end: d.getTime() + 3600e3 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByText('Planning').first().click();
  const dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByLabel('Title').count())) await dlg.getByRole('button', { name: /Edit/ }).first().click();
  await dlg.getByLabel('Title').waitFor();
  const r = await api('PATCH', `/events/${ev.id}`, { location: 'Room 4' }).then((x) => x.status >= 400 ? api('PUT', `/events/${ev.id}`, { ...ev, location: 'Room 4' }) : x);
  console.log('event elsewhere', r.status);
  await dlg.getByLabel('Title').fill('Planning (moved)');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const from = Date.now() - 864e5 * 2, to = Date.now() + 864e5 * 2;
  const now = (await api('GET', `/events?from=${from}&to=${to}`)).body.find((e) => e.id === ev.id);
  console.log('event now', JSON.stringify(now).slice(0, 300));
  if (now?.title !== 'Planning (moved)') found.push('event: the title here wasn’t saved');
  if (now?.location !== 'Room 4') found.push(`event: the place from elsewhere was lost (${now?.location})`);
});

await step('a task: title changed here, due date set elsewhere', async () => {
  const list = (await api('POST', '/tasks/lists', { name: 'Two edits' })).body;
  const t = (await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Call the bank' })).body;
  await page.goto(`${B}/tasks/${list.id}?task=${t.id}`);
  const title = page.getByRole('complementary', { name: 'Task details' }).getByLabel('Task', { exact: true });
  await title.waitFor();
  const r = await api('PATCH', `/tasks/tasks/${t.id}`, { due: '2030-01-15' });
  console.log('task elsewhere', r.status);
  await page.waitForTimeout(300);
  await title.fill('Call the bank about the loan');
  await title.press('Enter');
  await page.waitForTimeout(1500);
  const all = (await api('GET', `/tasks/lists/${list.id}/tasks`)).body;
  const now = (all.tasks || all).find((x) => x.id === t.id);
  console.log('task now', JSON.stringify(now).slice(0, 300));
  if (now?.title !== 'Call the bank about the loan') found.push('task: the title here wasn’t saved');
  if (!String(now?.due || '').startsWith('2030-01-15')) found.push(`task: the due date from elsewhere was lost (${now?.due})`);
});

await step('a note: text changed here, title changed elsewhere', async () => {
  const n = (await api('POST', '/notes', { title: 'Shopping', body: 'Milk' })).body;
  await page.goto(`${B}/notes?note=${n.id}`);
  const body = page.getByRole('dialog').getByRole('textbox').nth(1);
  await body.waitFor();
  const r = await api('PATCH', `/notes/${n.id}`, { title: 'Shopping for Saturday' });
  console.log('note elsewhere', r.status);
  await page.waitForTimeout(300);
  await body.fill('Milk, eggs');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  const nl = (await api('GET', '/notes')).body;
  const it = (nl.notes || nl).find((x) => x.id === n.id);
  console.log('note now', JSON.stringify(it).slice(0, 300));
  if (!JSON.stringify(it).includes('Milk, eggs')) found.push('note: the text here wasn’t saved');
  if (!JSON.stringify(it).includes('Shopping for Saturday')) found.push('note: the title from elsewhere was lost');
});

await step('Admin: a job title changed here, the department set elsewhere', async () => {
  const u = (await api('POST', '/users', { local: 'jo', domain: 'acme.com', name: 'Jo Jones', password: 'password123' })).body;
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Jo Jones' }).click();
  await page.getByRole('menuitem', { name: 'Job and manager' }).click();
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Job title').waitFor();
  const r = await api('POST', '/users/bulk', { ids: [u.id], action: 'department', value: 'Finance' });
  console.log('department elsewhere', r.status);
  await dlg.getByLabel('Job title').fill('Accountant');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const now = (await api('GET', '/users')).body.find((x) => x.id === u.id);
  console.log('user now', now?.job_title, now?.department);
  if (now?.job_title !== 'Accountant') found.push('admin: the job title here wasn’t saved');
  if (now?.department !== 'Finance') found.push(`admin: the department set elsewhere was lost (${now?.department})`);
});

await step('a booking page: title changed here, length changed elsewhere', async () => {
  const bp = (await api('POST', '/bookings', { title: 'Intro call', duration: 30 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Change Intro call' }).click();
  await dlg.getByLabel('Title').waitFor();
  const r = await api('PATCH', `/bookings/${bp.id}`, { duration: 60 });
  console.log('booking elsewhere', r.status);
  await dlg.getByLabel('Title').fill('Intro call (video)');
  await dlg.getByRole('button', { name: /^Save/ }).click();
  await page.waitForTimeout(1500);
  const now = (await api('GET', '/bookings')).body.find((x) => x.id === bp.id);
  console.log('booking now', now?.title, now?.duration);
  if (now?.title !== 'Intro call (video)') found.push('booking page: the title here wasn’t saved');
  if (now?.duration !== 60) found.push(`booking page: the length set elsewhere was lost (${now?.duration})`);
});

await step('nothing lost', async () => { if (found.length) throw new Error(found.join(' | ')); });
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
