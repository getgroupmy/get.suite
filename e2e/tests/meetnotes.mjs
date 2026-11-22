import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let ev, notes, kim;
await step('take meeting notes from an event: a document opens with the details', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const start = Math.ceil(Date.now() / 36e5) * 36e5 + 36e5;
  ev = (await api(page, 'POST', '/events', { title: 'Budget review', start, end: start + 36e5, location: 'Room 4', description: 'Q3 figures\nHiring plan', guests: ['kim@acme.com'] })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Budget review', { exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  const [tab] = await Promise.all([page.waitForEvent('popup'), dlg.getByRole('button', { name: /Take meeting notes/ }).click()]);
  await tab.waitForURL(/\/docs\//);
  notes = tab.url().split('/docs/')[1];
  const ed = tab.locator('.ProseMirror');
  await ed.getByRole('heading', { name: 'Budget review' }).waitFor();
  await ed.getByText('Room 4').waitFor();
  await ed.getByText('@Kim Park').waitFor();
  await ed.getByText('Hiring plan').waitFor();
  await ed.getByRole('heading', { name: 'Action items' }).waitFor();
  await dlg.getByRole('list', { name: 'Attachments' }).getByRole('link', { name: /^Notes – Budget review/ }).waitFor();
  await dlg.getByRole('button', { name: /Open meeting notes/ }).waitFor();
  await tab.close();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const evs = (await api(page, 'GET', `/events?from=${start - 864e5}&to=${start + 864e5}`)).body;
  const saved = evs.find((e) => e.id === ev.id);
  if (!saved.attachments.some((a) => a.id === notes) || saved.notes_id !== notes) throw new Error(JSON.stringify(saved.attachments));
});
await step('the guest finds the notes on the invitation and can write in them', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Schedule' }).click();
  await kim.getByText('Budget review', { exact: true }).first().click();
  const link = kim.getByRole('dialog', { name: 'Budget review' }).getByRole('list', { name: 'Attachments' }).getByRole('link', { name: /^Notes – Budget review/ });
  if ((await link.getAttribute('href')) !== `/docs/${notes}`) throw new Error('href');
  await kim.goto(`${B}/docs/${notes}`);
  const ed = kim.locator('.ProseMirror');
  await ed.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
  if ((await ed.getAttribute('contenteditable')) !== 'true') throw new Error('read only for the guest');
  await ed.getByRole('heading', { name: 'Notes', exact: true }).click();
  await kim.keyboard.press('End');
  await kim.keyboard.press('Enter');
  await kim.keyboard.type('Kim agreed to send the figures');
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${notes}/content`)).body.content).includes('Kim agreed'), 10000);
}, kim);
await step('asking again opens the same notes', async () => {
  const r = await api(page, 'POST', `/events/${ev.id}/notes`, {});
  if (r.status !== 200 || r.body.id !== notes) throw new Error(JSON.stringify(r));
});
await step('Guest list in Sheets: who’s invited and how they answered, in a spreadsheet that opens in a new tab', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Budget review', { exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  const [tab] = await Promise.all([page.waitForEvent('popup'), dlg.getByRole('button', { name: /Guest list in Sheets/ }).click()]);
  await tab.waitForURL(/\/sheets\//);
  await tab.locator('[data-k="A1"]', { hasText: 'Name' }).waitFor();
  await tab.locator('[data-k="C2"]', { hasText: 'Organizer' }).waitFor();
  await tab.locator('[data-k="A3"]', { hasText: 'Kim Park' }).waitFor();
  await tab.locator('[data-k="C3"]', { hasText: /Going|Not answered|Maybe|Not going/ }).waitFor();
  await tab.close();
});
await step('event → Make a contact group…: its guests in a group named after the event', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(15, 0, 0, 0);
  const r = await api(page, 'POST', '/events', { title: 'Launch crew', start: t.getTime(), end: t.getTime() + 36e5, guests: ['kim@acme.com', 'max@acme.com'] });
  if (r.status >= 300) throw new Error(JSON.stringify(r.body));
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Launch crew', { exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByRole('button', { name: 'Make a contact group…' }).click();
  const ask = page.getByRole('dialog', { name: 'Make a contact group' });
  await ask.getByText('2 people: Kim Park, Max Meet').waitFor();
  if ((await ask.getByLabel('Group name').inputValue()) !== 'Launch crew') throw new Error('not named after the event');
  await ask.getByRole('button', { name: 'Make group' }).click();
  await page.getByText('Made the group “Launch crew” (2 people)').waitFor();
  await dlg.getByLabel('Title').waitFor(); // the event editor is still open (making the group didn't save and close it)
  const g = (await api(page, 'GET', '/contacts/groups')).body.find((x) => x.name === 'Launch crew');
  if (!g || g.members.map((m) => m.email).sort().join() !== 'kim@acme.com,max@acme.com') throw new Error(JSON.stringify(g));
});
await step('event → Add to Tasks: a task due on its day that links back to the event', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Launch crew', { exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText(/^Added to /).waitFor();
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const inbox = lists.find((l) => l.inbox);
  const t = (await api(page, 'GET', `/tasks/lists/${inbox.id}/tasks`)).body.find((x) => x.title === 'Launch crew');
  const d = new Date(); d.setDate(d.getDate() + 1);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (!t || t.due !== day || t.due_time !== '15:00' || !/^\/calendar\?event=/.test(t.link_url) || t.link_label !== 'Event: Launch crew') throw new Error(JSON.stringify(t));
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/tasks\/.+\?task=/);
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Event: Launch crew/ }).click();
  await page.waitForURL(/\/calendar/);
  await page.getByRole('dialog', { name: 'Edit event' }).waitFor();
  // The event shows its open task beside Add to Tasks, and opens it.
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: '1 task to do about this event' }).click();
  await page.getByRole('menuitem', { name: /^Launch crew · due / }).click();
  await page.waitForURL(/\/tasks\/.+\?task=/);
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Event: Launch crew/ }).waitFor();
});
await step('event → Copy to Notes: a note with when, who and a link back that opens the event', async () => {
  await page.keyboard.press('Escape');
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Launch crew', { exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Copy to Notes' }).click();
  await page.getByText('Saved to Notes: Launch crew').waitFor();
  const n = (await api(page, 'GET', '/notes')).body.find((x) => x.title === 'Launch crew');
  if (!n || !/^When: .+\nWith: .*Kim/.test(n.body) || !/\n\nOpen the event: https?:\/\/[^/\s]+\/calendar\?event=[\w-]+/.test(n.body)) throw new Error(JSON.stringify(n && n.body));
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/notes/);
  await page.getByRole('dialog', { name: 'Launch crew' }).waitFor();
});
await step('the address an AI assistant is given for an event opens that event', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const tok = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Event reader', scope: 'read', days: 30 })).body.token;
  const r = await page.evaluate(async (t) => (await (await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'Launch crew' } } }) })).json()).result, tok);
  const hit = (r.structuredContent?.results || []).find((x) => /^event:/.test(x.id) && /Launch crew/.test(x.title));
  if (!hit || !/\/calendar\?event=[\w-]+/.test(hit.url)) throw new Error(JSON.stringify(r.structuredContent || r));
  await page.goto(new URL(hit.url, B).href);
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.waitFor();
  if ((await dlg.getByLabel('Title').inputValue()) !== 'Launch crew') throw new Error(await dlg.getByLabel('Title').inputValue());
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
