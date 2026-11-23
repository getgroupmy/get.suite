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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

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

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
let ids, sales;
await step('people and a Sales group', async () => {
  ids = {};
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Chan'], ['max', 'Max Moss']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error('user ' + r.status);
  }
  for (const u of (await api(page, 'GET', '/users/directory')).body) ids[u.name] = u.id;
  sales = (await api(page, 'POST', '/groups', { name: 'Sales' })).body;
  const me = (await api(page, 'GET', '/auth/me')).body;
  // Olivia herself is in it too: she isn't offered to herself.
  const r = await api(page, 'PUT', `/groups/${sales.id}/members`, { user_ids: [ids['Kim Park'], ids['Lee Chan'], me.id || me.user?.id].filter(Boolean) });
  if (r.status !== 200) throw new Error('members ' + r.status + JSON.stringify(r.body));
  await api(page, 'POST', '/groups', { name: 'Empty team' });
});
await step('Tasks → Share: + Sales ticks everyone in the group, and the list is shared with them', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Q4 deals' })).body.id;
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Share “Q4 deals”' });
  const groups = d.getByRole('group', { name: 'Add a group: Colleagues' });
  await groups.getByRole('button', { name: '+ Sales (2)' }).click();
  if (await groups.getByRole('button', { name: /Empty team/ }).count()) throw new Error('an empty group is offered');
  if (!(await d.getByLabel(/Kim Park/).isChecked()) || !(await d.getByLabel(/Lee Chan/).isChecked())) throw new Error('not ticked');
  if (await d.getByLabel(/Max Moss/).isChecked()) throw new Error('Max ticked');
  if (await d.getByLabel(/Olivia Owner/).count()) throw new Error('offered to herself');
  if (!(await groups.getByRole('button', { name: '+ Sales (2)' }).isDisabled())) throw new Error('still offered once all ticked');
  await d.getByLabel('Message to the people you added (optional)').waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Shared with 2' }).waitFor();
  const l = (await api(page, 'GET', '/tasks/lists')).body.lists.find((x) => x.id === list);
  const names = l.members.map((m) => m.name).sort().join(',');
  if (names !== 'Kim Park,Lee Chan') throw new Error(names);
});
await step('Notes → Share note: + Sales does the same, keeping who was already ticked', async () => {
  const note = (await api(page, 'POST', '/notes', { title: 'Pricing ideas', text: 'Bundle the add-ons' })).body;
  await api(page, 'PUT', `/notes/${note.id}/shares`, { user_ids: [ids['Max Moss']] });
  await page.goto(`${B}/notes`);
  await page.locator('.note-card', { hasText: 'Pricing ideas' }).getByRole('button', { name: 'Share note' }).click();
  const d = page.getByRole('dialog', { name: 'Share note' });
  await d.getByRole('group', { name: 'Add a group: Colleagues' }).getByRole('button', { name: '+ Sales (2)' }).click();
  for (const n of ['Kim Park', 'Lee Chan', 'Max Moss']) if (!(await d.getByLabel(new RegExp(n)).isChecked())) throw new Error(n + ' not ticked');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => {
    const n = (await api(page, 'GET', '/notes')).body.find((x) => x.id === note.id);
    return n && n.shared.map((u) => u.name).sort().join(',') === 'Kim Park,Lee Chan,Max Moss';
  });
});

await step('Calendar → Share my calendar: a name typed finds a colleague, and + Sales shares with everyone in it', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Share my calendar' }).click();
  const d = page.getByRole('dialog', { name: 'Share my calendar' });
  await d.getByLabel('Share with a colleague').fill('moss max'); // words in any order
  await d.getByRole('option', { name: /Max Moss/ }).click();
  const list = d.getByRole('list', { name: 'Sees your event details' });
  await list.getByText('Max Moss').waitFor();
  if (await d.getByLabel('Share with a colleague').inputValue()) throw new Error('box not emptied');
  const groups = d.getByRole('group', { name: 'Share with a group' });
  if (await groups.getByRole('button', { name: /Empty team/ }).count()) throw new Error('an empty group is offered');
  await groups.getByRole('button', { name: '+ Sales (2)' }).click();
  await list.getByText('Kim Park').waitFor();
  await list.getByText('Lee Chan').waitFor();
  await groups.waitFor({ state: 'detached' }); // everyone in it sees them now
  const shares = (await api(page, 'GET', '/freebusy/shares')).body;
  const names = shares.with.map((u) => u.name).sort().join(',');
  if (names !== 'Kim Park,Lee Chan,Max Moss') throw new Error(names);
});
await step('Calendar → a calendar\'s Share…: + Sales shares that one calendar with everyone in the group', async () => {
  const cal = (await api(page, 'POST', '/events/calendars', { name: 'Sales visits', color: '#0b8043' })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Options for Sales visits' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const d = page.getByRole('dialog', { name: 'Share “Sales visits”' });
  await d.getByLabel('Message to the next person you add (optional)').fill('Plan the visits here');
  await d.getByRole('group', { name: 'Share with a group' }).getByRole('button', { name: '+ Sales (2)' }).click();
  await d.getByLabel('What Kim Park can do').waitFor();
  await d.getByLabel('What Lee Chan can do').waitFor();
  if (await d.getByLabel('What Max Moss can do').count()) throw new Error('Max added');
  await until(async () => {
    const c = (await api(page, 'GET', '/events/calendars')).body.find((x) => x.id === cal.id);
    return c && c.members.map((m) => m.name).sort().join(',') === 'Kim Park,Lee Chan' && c.members.every((m) => !m.can_edit);
  });
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
