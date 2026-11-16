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
const ids = {};
// The same check with the apps full of things (labels, badges, overdue and done tasks, polls, chat from Forms,
// responses, a time-off request…), in light and dark: colours that only appear with data are checked too.
// Every call has to work, or the pages would be checked empty.
const must = async (p, method, url, body) => { const r = await api(p, method, url, body); if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
await step('fill the apps', async () => {
  await must(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  ids.doc = (await must(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Some text', marks: [{ type: 'bold' }] }] }] } })).body.id;
  ids.sheet = (await must(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Item', B1: 'Status', C1: 'Done', A2: 'Rent', B2: 'Paid', C2: 'TRUE', A3: '=1/0' }, frozen: { rows: 1 }, validations: [{ range: 'B2:B9', type: 'list', options: ['Paid', 'Due'], colors: { Paid: '#e6f4ea', Due: '#fce8e6' } }, { range: 'C2:C9', type: 'checkbox' }] }] } })).body.id;
  const folder = (await must(page, 'POST', '/files/folder', { name: 'Clients' })).body;
  await must(page, 'PATCH', `/files/${folder.id}`, { color: '#188038' });
  await must(page, 'PUT', `/files/${ids.doc}/star`, { starred: true });
  const list = (await must(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await must(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Overdue thing', due: day(-3), important: true });
  await must(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Due today', due: day(0) });
  const done = (await must(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Finished thing' })).body;
  await must(page, 'PATCH', `/tasks/tasks/${done.id}`, { done: true });
  const start = new Date(); start.setHours(10, 0, 0, 0);
  await must(page, 'POST', '/events', { title: 'Budget review', start: start.getTime(), end: start.getTime() + 36e5, guests: ['kim@acme.com'] });
  await must(page, 'POST', '/time-off', { start_date: day(7), end_date: day(9), kind: 'vacation', note: 'Trip' });
  await must(page, 'POST', '/time-off/holidays', { date: day(14), name: 'Founders Day' });
  await must(page, 'POST', '/notes', { title: 'Packing', items: [{ text: 'Badges' }, { text: 'Snacks', done: true }] });
  await must(page, 'POST', '/contacts', { name: 'Pat Lee', email: 'pat@example.com', company: 'Example Ltd' });
  await must(page, 'POST', '/contacts/groups', { name: 'Clients', members: [] });
  const leads = (await must(page, 'POST', '/chat/channels', { name: 'leads', topic: 'New leads' })).body.id;
  await must(page, 'POST', `/chat/channels/${leads}/messages`, { body: 'Planning the **offsite** with @kim@acme.com' });
  await must(page, 'POST', `/chat/channels/${leads}/messages`, { body: 'Where shall we go?', poll: { question: 'Where?', options: ['Lake', 'City'] } });
  ids.leads = leads;
  const form = (await must(page, 'POST', '/forms', { title: 'Lead form', questions: [{ id: 'n', type: 'short', title: 'Name' }, { id: 't', type: 'choice', title: 'Topic', options: ['Sales', 'Support'] }, { id: 'r', type: 'rating', title: 'Rating' }] })).body;
  await must(page, 'PUT', `/forms/${form.id}`, { chat_channel: leads });
  for (const a of [{ n: 'Pat', t: 'Sales', r: 4 }, { n: 'Sam', t: 'Support', r: 2 }]) await must(page, 'POST', `/public/forms/${form.token}`, { answers: a });
  ids.form = form.id;
  // The data is there to see.
  for (const [path, text] of [['/tasks', 'Overdue thing'], [`/chat/${leads}`, 'Where?'], [`/forms/${form.id}?tab=responses`, 'Sales'], ['/drive', 'Clients'], ['/notes', 'Packing']]) {
    await page.goto(B + path);
    await page.getByText(text).first().waitFor();
  }
});
const PAGES = () => ({
  Home: '/', Drive: '/drive', 'Drive starred': '/drive?view=starred', Docs: `/docs/${ids.doc}`, Sheets: `/sheets/${ids.sheet}`, Calendar: '/calendar', 'Calendar week': '/calendar?view=week',
  Contacts: '/contacts', Tasks: '/tasks', Chat: `/chat/${ids.leads}`, Notes: '/notes', Forms: '/forms', 'Form responses': `/forms/${ids.form}?tab=responses`, 'Form settings': `/forms/${ids.form}?tab=settings`,
  Settings: '/settings', Admin: '/admin', 'Admin activity': '/admin?tab=activity',
});
const all = [];
for (const scheme of ['light', 'dark']) {
  for (const [name, path] of Object.entries(PAGES())) {
    await step(`accessibility with things in it (${scheme}): ${name}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(B + path);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1200);
      await page.evaluate(AXE);
      const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ id: v.id, n: v.nodes.length, where: v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | '), html: v.nodes[0]?.html.slice(0, 200) })));
      for (const v of res) all.push({ page: `${name} (${scheme})`, ...v });
      if (res.length) throw new Error(res.map((v) => `${v.id}(${v.n})`).join(', '));
    });
  }
}
for (const v of all) console.log(`DBG ${v.page} ${v.id} x${v.n} :: ${v.where} :: ${v.html}`);
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED', errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
