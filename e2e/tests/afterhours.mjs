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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const send = async (subject) => { for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200) break; await page.waitForTimeout(1500); } };
const reader = () => page.locator('.mail-reader');
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
await step('after hours: writing to a colleague whose day is over says their local time; Send when their day starts schedules it', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(`user ${r.status}`);
  const kim = await browser.newPage();
  await kim.goto(B);
  await kim.getByLabel('Email address').fill('kim@acme.com');
  await kim.getByLabel('Password').fill('password123');
  await kim.getByRole('button', { name: 'Sign in' }).click();
  await kim.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const today = new Date().getUTCDay();
  const h = await api(kim, 'PUT', '/users/me/work-hours', { hours: { days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today), start: 0, end: 1440, tz: 'UTC' } });
  if (h.status !== 200) throw new Error(`hours ${h.status}`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await page.getByLabel('Subject').fill('Plan for tomorrow');
  const note = page.locator('.compose-late');
  await note.getByText(/It's \d\d:\d\d for/).waitFor({ timeout: 10000 });
  await note.getByText('Kim Park').waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-afterhours.png` });
  await note.getByRole('button', { name: /Send when their day starts/ }).click();
  await page.getByText(/Will be sent/).waitFor({ timeout: 15000 });
  const tomorrow = new Date(); tomorrow.setUTCHours(24, 0, 0, 0);
  const sched = await api(page, 'GET', '/mail/scheduled');
  const list = Array.isArray(sched.body) ? sched.body : sched.body?.scheduled || sched.body?.items || [];
  const it = list.find((x) => /Plan for tomorrow/.test(x.subject || ''));
  if (!it) throw new Error(`not scheduled: ${JSON.stringify(sched.body).slice(0, 200)}`);
  if (it.send_at !== tomorrow.getTime()) throw new Error(`at ${new Date(it.send_at).toISOString()}`);
  await kim.close();
});
await step('away: writing to a colleague whose vacation reply is on says so, with until when and its subject', async () => {
  const r = await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chen', password: 'password123' });
  if (r.status !== 201) throw new Error(`user ${r.status}`);
  const lee = await browser.newPage();
  await lee.goto(B);
  await lee.getByLabel('Email address').fill('lee@acme.com');
  await lee.getByLabel('Password').fill('password123');
  await lee.getByRole('button', { name: 'Sign in' }).click();
  await lee.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const end = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const v = await api(lee, 'PUT', '/mail/vacation', { enabled: true, subject: 'At the trade fair', body: 'Back soon.', end_date: end });
  if (v.status !== 200) throw new Error(`vacation ${v.status}`);
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('lee@acme.com');
  await page.getByLabel('Subject').click();
  const note = page.locator('.compose-away');
  await note.getByText('Lee Chen').waitFor({ timeout: 10000 });
  await note.getByText(/is away until/).waitFor();
  await note.getByText('“At the trade fair”').waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-away.png` });
  await api(lee, 'PUT', '/mail/vacation', { enabled: false, body: 'x' });
  await page.getByLabel('To', { exact: true }).fill('lee@acme.com ');
  await page.getByLabel('Subject').click();
  await note.waitFor({ state: 'detached', timeout: 10000 });
  await lee.close();
});
await step('a message to 25 people or more says how many it goes to', async () => {
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  const many = Array.from({ length: 24 }, (_, i) => `person${i}@partner.example`).join(', ');
  await page.getByLabel('To', { exact: true }).fill(many);
  await page.getByLabel('Subject').click();
  if (await page.getByText(/This goes to/).count()) throw new Error('shown for 24');
  await page.getByLabel('To', { exact: true }).fill(`${many}, person24@partner.example`);
  await page.getByLabel('Subject').click();
  await page.getByText('25 people').waitFor();
});
await step('Settings: tips while writing off hides the notes; back on, they show again', async () => {
  await page.goto(`${B}/settings`);
  await page.getByRole('checkbox', { name: 'Show tips under the addresses as I write an email' }).uncheck();
  await page.getByText('Tips while writing are off').waitFor();
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  const many = Array.from({ length: 25 }, (_, i) => `person${i}@partner.example`).join(', ');
  await page.getByLabel('To', { exact: true }).fill(many);
  await page.getByLabel('Subject').click();
  await page.waitForTimeout(1200);
  if (await page.getByText(/This goes to/).count()) throw new Error('many-people note shown');
  if (await page.locator('.compose-outside').count()) throw new Error('outside note shown');
  await page.goto(`${B}/settings`);
  await page.getByRole('checkbox', { name: 'Show tips under the addresses as I write an email' }).check();
  await page.getByText('Tips while writing are on').waitFor();
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill(many);
  await page.getByLabel('Subject').click();
  await page.getByText('25 people').waitFor();
  await page.locator('.compose-outside').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
