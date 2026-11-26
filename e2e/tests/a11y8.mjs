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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label, p = page) => {
  await p.waitForTimeout(300);
  await p.evaluate(AXE);
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label, p = page) => { await p.emulateMedia({ colorScheme: 'light' }); await scan(`${label} light`, p); await p.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`, p); await p.emulateMedia({ colorScheme: 'light' }); };
// Booking pages: the owner's form (pausing, a limit in all, questions with choices), a visitor's form with a choice,
// a full page's waiting list, and the owner's Waiting list window.
let url;
await step('booking page form with the newer settings', async () => {
  const pg = (await api(page, 'POST', '/bookings', { title: 'Consult', duration: 30, days: [0, 1, 2, 3, 4, 5, 6], from_min: 0, to_min: 1440, notice_hours: 0, days_ahead: 5,
    questions: [{ label: 'Phone number', required: true }, { label: 'Topic', choices: 'Pricing, Support' }] })).body;
  url = pg.url;
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Change Consult' }).click();
  await dlg.getByLabel('Question 2 choices').waitFor();
  await both('Booking page form');
  await page.keyboard.press('Escape');
});
const visitor = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
visitor.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
await step('a visitor’s booking form with a choice to pick', async () => {
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByRole('heading', { name: 'Consult' }).waitFor();
  await visitor.getByRole('group', { name: /^Times on/ }).getByRole('button').first().click();
  await visitor.getByLabel('Topic (optional)').waitFor();
  await both('Visitor booking form', visitor);
}, visitor);
await step('a full page: its waiting list form', async () => {
  const pg = (await api(page, 'GET', '/bookings')).body[0];
  const tk = url.split('/b/')[1];
  const slots = (await api(visitor, 'GET', `/public/book/${tk}`)).body.days.flatMap((d) => d.slots);
  await api(visitor, 'POST', `/public/book/${tk}`, { start: slots[0], name: 'Ann First', email: 'ann@example.org', answers: ['555', ''] });
  await api(page, 'PATCH', `/bookings/${pg.id}`, { max_total: 1 });
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByRole('button', { name: 'Join the waiting list' }).waitFor();
  await both('Waiting list form', visitor);
  await visitor.getByLabel('Your name').fill('Wes Waiting');
  await visitor.getByLabel('Your email').fill('wes@example.org');
  await visitor.getByRole('button', { name: 'Join the waiting list' }).click();
  await visitor.getByText('You’re on the waiting list').waitFor();
  await both('On the waiting list', visitor);
}, visitor);
await step('the owner’s Waiting list window', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  await page.getByRole('button', { name: 'The bookings of Consult' }).click();
  await page.getByRole('menuitem', { name: 'Waiting list (1)…' }).click();
  await page.getByRole('dialog', { name: 'Waiting list: Consult' }).getByText('wes@example.org').waitFor();
  await both('Waiting list window');
  await page.keyboard.press('Escape');
});
await step('the owner’s Answers window', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  await page.getByRole('button', { name: 'The bookings of Consult' }).click();
  await page.getByRole('menuitem', { name: 'Answers…' }).click();
  await page.getByRole('dialog', { name: 'Answers: Consult' }).getByRole('region', { name: 'Topic' }).waitFor();
  await both('Answers window');
  await page.keyboard.press('Escape');
});
await step('a contact’s window with dates, related people and fields; Merge duplicates', async () => {
  await api(page, 'POST', '/contacts', { name: 'Ann Lee', email: 'ann@lee.example', related: [{ label: 'Spouse', name: 'Ben Lee' }], dates: [{ label: 'Anniversary', date: '2015-06-20' }], custom_fields: [{ label: 'Locker', value: '7' }] });
  await api(page, 'POST', '/contacts', { name: 'Ann Lee', phone: '+44 7700 900123', related: [{ label: 'Manager', name: 'Zoe Boss' }] });
  await page.goto(`${B}/contacts`);
  await page.locator('tbody tr', { hasText: 'Spouse: Ben Lee' }).waitFor();
  await both('Contacts with related people');
  await page.locator('tbody tr', { hasText: 'Spouse: Ben Lee' }).getByRole('button', { name: /^Edit Ann Lee/ }).click();
  const m = page.getByRole('dialog');
  await m.getByLabel('Related person 1: name').waitFor();
  await both('Contact window with related people');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Merge duplicates' }).click();
  await page.getByRole('dialog', { name: 'Merge duplicates' }).getByRole('group', { name: 'Duplicates of Ann Lee' }).waitFor();
  await both('Merge duplicates window');
  await page.keyboard.press('Escape');
});
await step('a note’s and a task’s comments with a reaction, a link, a mention and the Share-with-them note', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  const n = (await api(page, 'POST', '/notes', { title: 'Offsite', body: 'Where?' })).body;
  await api(page, 'PUT', `/notes/${n.id}/shares`, { user_ids: [kim.id] });
  const c = (await api(page, 'POST', `/notes/${n.id}/comments`, { text: '@kim@acme.com prices at https://example.com/prices' })).body[0];
  await api(page, 'POST', `/notes/${n.id}/comments/${c.id}/reactions`, { emoji: '👍' });
  await page.goto(`${B}/notes?note=${n.id}`);
  const box = page.getByRole('dialog', { name: 'Offsite' }).getByRole('region', { name: 'Comments' });
  await box.getByRole('button', { name: '👍 1: Olivia Owner' }).waitFor();
  await box.getByLabel('Write a comment').fill('@lee@acme.com have a look');
  await box.getByRole('button', { name: 'Share the note with them' }).waitFor();
  await both('Note comments with a reaction, a link and Share the note with them');
  await box.getByLabel('Write a comment').fill('');
  await page.keyboard.press('Escape');
  const l = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body;
  await api(page, 'PUT', `/tasks/lists/${l.id}/members`, { user_ids: [kim.id] });
  const t = (await api(page, 'POST', `/tasks/lists/${l.id}/tasks`, { title: 'Book venue' })).body;
  const tc = (await api(page, 'POST', `/tasks/tasks/${t.id}/comments`, { body: '@kim@acme.com see https://example.com/venues' })).body;
  await api(page, 'POST', `/tasks/tasks/${t.id}/comments/${tc.id}/reactions`, { emoji: '🎉' });
  await page.goto(`${B}/tasks/${l.id}?task=${t.id}`);
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByRole('button', { name: '🎉 1: Olivia Owner' }).waitFor();
  await d.getByLabel('Add a comment').fill('@lee@acme.com can you help?');
  await d.getByRole('button', { name: 'Share the list with them' }).waitFor();
  await both('Task comments with a reaction, a link and Share the list with them');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
