import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
await step('Create event on an email opens a new event with its subject, people and text', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@globex.example.com>', to: 'olivia@acme.com', cc: 'kim@globex.example.com', subject: 'Re: Quarterly review', text: 'Shall we meet next week to go through the numbers?', envelope: { from: 'olivia@acme.com', to: 'olivia@acme.com' } });
  await refreshUntil(page, inboxRow('Re: Quarterly review'));
  await inboxRow('Re: Quarterly review').click();
  await page.locator('.reader-actions').getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/calendar/);
  const d = page.getByRole('dialog', { name: 'New event' });
  if ((await d.getByLabel('Title').inputValue()) !== 'Quarterly review') throw new Error('title');
  await d.getByText('raj@globex.example.com').waitFor();
  await d.getByText('kim@globex.example.com').waitFor();
  if (await d.getByText('olivia@acme.com', { exact: true }).count()) throw new Error('you are a guest');
  if (!(await d.getByLabel('Description').inputValue()).includes('go through the numbers')) throw new Error('description');
  await page.screenshot({ path: `${SP}/shots/mailevent.png` });
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByText('Quarterly review').first().waitFor();
  const evs = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 7 * 864e5}`)).body;
  const ev = (evs.events || evs).find((e) => e.title === 'Quarterly review');
  if (!ev || ev.guests.length !== 2) throw new Error('saved ' + JSON.stringify(ev));
});
await step('reloading the calendar does not open it again', async () => {
  await page.reload();
  await page.getByRole('button', { name: /Today/ }).first().waitFor();
  await page.waitForTimeout(500);
  if (await page.getByRole('dialog', { name: 'New event' }).count()) throw new Error('opened again');
});
await step('an email from a colleague: the new event starts at the first hour you’re both free', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kimf', domain: 'acme.com', name: 'Kim Free', password: 'password123' })).body.id;
  const busy = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); });
  await api(page, 'POST', '/events', { title: 'Olivia busy', start: busy, end: busy + 3600e3 });
  await smtp.sendMail({ from: 'Kim Free <kimf@acme.com>', to: 'olivia@acme.com', cc: 'raj@globex.example.com', subject: 'Plan the launch', text: 'When can we meet?', envelope: { from: 'kimf@acme.com', to: 'olivia@acme.com' } });
  await page.goto(`${B}/mail`);
  await refreshUntil(page, inboxRow('Plan the launch'));
  await inboxRow('Plan the launch').click();
  await page.locator('.reader-actions').getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/calendar/);
  const expected = await page.evaluate(async (id) => (await (await fetch(`/api/freebusy/suggest?users=${id}&duration=60&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`)).json()).slots[0], kimId);
  if (expected.start < busy + 3600e3 && expected.end > busy) throw new Error('suggested while busy');
  const when = await page.evaluate((t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), expected.start);
  await page.getByText(`The first hour you’re all free: ${when}`).waitFor();
  const d = page.getByRole('dialog', { name: 'New event' });
  const want = await page.evaluate((t) => { const x = new Date(t); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; }, expected.start);
  if ((await d.locator('input[type="time"]').first().inputValue()) !== want) throw new Error('start time');
  await d.getByText('raj@globex.example.com').waitFor();
});
await step('a Contacts group with a colleague and someone outside: both invited, at the colleague’s first free hour; it saves', async () => {
  const g = await api(page, 'POST', '/contacts/groups', { name: 'Mixed group', members: [{ name: 'Kim Free', email: 'kimf@acme.com' }, { name: 'Raj Kumar', email: 'raj@globex.example.com' }] });
  if (g.status !== 201) throw new Error(JSON.stringify(g.body));
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByRole('button', { name: 'Schedule a meeting with Mixed group' }).click();
  await page.waitForURL(/\/calendar/);
  await page.getByText(/^The first hour you’re all free: /).waitFor();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.getByText('Kim Free').first().waitFor();
  await d.getByText(/raj@globex\.example\.com|Raj Kumar/).first().waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  const evs = (await api(page, 'GET', `/events?from=${Date.now()}&to=${Date.now() + 14 * 864e5}`)).body.filter((e) => e.title === 'Mixed group');
  if (evs.length !== 1 || !evs[0].guests.some((x) => x.email === 'raj@globex.example.com' && x.external)) throw new Error(JSON.stringify(evs.map((e) => e.guests)));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
