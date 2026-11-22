import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
await step('someone from another company writes; Add to contacts saves them', async () => {
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(B);
  await g.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gina@globex.com', password: 'password123' }) }));
  for (let k = 0; k < 10; k++) { if ((await api(g, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Shipping quote', text: 'Our quote is attached.' })).status === 200) break; await g.waitForTimeout(1500); }
  await ctx.close();
  await page.locator('.mail-list').getByText('Shipping quote', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.mail-list').getByText('Shipping quote', { exact: true }).click();
  const reader = page.locator('.mail-reader');
  await reader.getByRole('button', { name: 'Add to contacts' }).click();
  await page.getByText('Gina Globex added to your contacts').waitFor();
  await reader.getByText('In your contacts').waitFor();
  const list = (await api(page, 'GET', '/contacts')).body;
  if (!list.some((c) => c.name === 'Gina Globex' && c.email === 'gina@globex.com')) throw new Error(JSON.stringify(list));
});
await step('messages from colleagues show no button', async () => {
  for (let k = 0; k < 5; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Note to self', text: 'x' })).status === 200) break; await page.waitForTimeout(1000); }
  await page.locator('.mail-list').getByText('Note to self', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.mail-list').getByText('Note to self', { exact: true }).click();
  await page.locator('.mail-reader').getByText('Note to self').first().waitFor();
  await page.waitForTimeout(800);
  if (await page.locator('.mail-reader').getByRole('button', { name: 'Add to contacts' }).count()) throw new Error('button for a colleague');
});
await step('⋮ → Add everyone to Contacts: the sender’s colleagues on cc added, Gina (already a contact) not twice', async () => {
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(B);
  await g.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gina@globex.com', password: 'password123' }) }));
  for (const [local, name] of [['ben', 'Ben Barge'], ['hal', 'Hal Harbour']]) {
    const u = await api(g, 'POST', '/users', { local, domain: 'globex.com', name, password: 'password123' });
    if (u.status !== 201) throw new Error(JSON.stringify(u.body));
  }
  for (let k = 0; k < 10; k++) { if ((await api(g, 'POST', '/mail/send', { to: 'olivia@acme.com', cc: 'Ben Barge <ben@globex.com>, Hal Harbour <hal@globex.com>', subject: 'Crew list', text: 'The crew for March.' })).status === 200) break; await g.waitForTimeout(1500); }
  await ctx.close();
  await page.locator('.mail-list').getByText('Crew list', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.mail-list').getByText('Crew list', { exact: true }).click();
  await page.locator('.mail-reader').getByText('The crew for March.').waitFor();
  await page.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'Add everyone to Contacts' }).click();
  await page.getByText('Added 2 people to your contacts (1 already there or colleagues)').waitFor();
  const list = (await api(page, 'GET', '/contacts')).body;
  if (!list.some((c) => c.name === 'Ben Barge' && c.email === 'ben@globex.com') || !list.some((c) => c.name === 'Hal Harbour') || list.filter((c) => c.email === 'gina@globex.com').length !== 1) throw new Error(JSON.stringify(list));
  await page.getByRole('button', { name: 'Open Contacts' }).click();
  await page.waitForURL(/\/contacts/);
  await page.getByText('Hal Harbour').first().waitFor();
});
await step('an AI assistant adds everyone on an email to Contacts (add_contacts with from_email)', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const tok = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Contacts helper', scope: 'write', days: 30 })).body.token;
  const call = (name, args) => page.evaluate(async ([t, n, a]) => (await (await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: n, arguments: a } }) })).json()).result, [tok, name, args]);
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(B);
  await g.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gina@globex.com', password: 'password123' }) }));
  const u = await api(g, 'POST', '/users', { local: 'ivy', domain: 'globex.com', name: 'Ivy Inlet', password: 'password123' });
  if (u.status !== 201) throw new Error(JSON.stringify(u.body));
  for (let k = 0; k < 10; k++) { if ((await api(g, 'POST', '/mail/send', { to: 'olivia@acme.com', cc: 'Ivy Inlet <ivy@globex.com>', subject: 'Dock schedule', text: 'See you at the dock.' })).status === 200) break; await g.waitForTimeout(1500); }
  await ctx.close();
  await page.goto(`${B}/mail`);
  await page.locator('.mail-list').getByText('Dock schedule', { exact: true }).waitFor({ timeout: 30000 });
  const msgs = (await call('list_mail', { query: 'Dock schedule' })).structuredContent.messages;
  const r = await call('add_contacts', { from_email: msgs[0].id });
  if (r.isError || r.structuredContent.added !== 1 || r.structuredContent.names[0] !== 'Ivy Inlet' || r.structuredContent.left_out !== 2) throw new Error(JSON.stringify(r));
  await page.goto(new URL(r.structuredContent.url, B).href);
  await page.getByText('Ivy Inlet').first().waitFor();
});
await step('⋮ → Make a contact group…: everyone on the message (not you) in a group named after its subject', async () => {
  await page.goto(`${B}/mail`);
  await page.locator('.mail-list').getByText('Crew list', { exact: true }).click();
  await page.locator('.mail-reader').getByText('The crew for March.').waitFor();
  await page.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'Make a contact group…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Make a contact group' });
  await dlg.getByText('3 people: Gina Globex, Ben Barge, Hal Harbour').waitFor();
  if ((await dlg.getByLabel('Group name').inputValue()) !== 'Crew list') throw new Error('name not from the subject');
  await dlg.getByLabel('Group name').fill('March crew');
  await dlg.getByRole('button', { name: 'Make group' }).click();
  await page.getByText('Made the group “March crew” (3 people)').waitFor();
  const g = (await api(page, 'GET', '/contacts/groups')).body.find((x) => x.name === 'March crew');
  if (!g || g.members.map((x) => x.email).sort().join() !== 'ben@globex.com,gina@globex.com,hal@globex.com') throw new Error(JSON.stringify(g));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
