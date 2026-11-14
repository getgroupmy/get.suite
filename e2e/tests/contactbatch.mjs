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
const mine = async () => (await api(page, 'GET', '/contacts')).body;
let group;
await step('setup: some contacts and a group', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [name, email] of [['Ann Able', 'ann@example.com'], ['Ben Best', 'ben@example.com'], ['Cy NoMail', ''], ['Dee Done', 'dee@example.com']]) await api(page, 'POST', '/contacts', { name, ...(email && { email }) });
  group = (await api(page, 'POST', '/contacts/groups', { name: 'Clients', members: [] })).body;
  await page.goto(`${B}/contacts`);
  await page.getByText('Dee Done').waitFor();
});
await step('Select several: star them, add them to a group', async () => {
  if (await page.getByRole('toolbar', { name: 'Change the selected contacts' }).count()) throw new Error('bar before selecting');
  await page.getByLabel('Select Ann Able').check();
  await page.getByLabel('Select Cy NoMail').check();
  const bar = page.getByRole('toolbar', { name: 'Change the selected contacts' });
  await bar.getByText('2 selected').waitFor();
  await bar.getByRole('button', { name: '★ Star' }).click();
  await page.locator('.toast', { hasText: '2 contacts starred' }).last().waitFor();
  if ((await mine()).filter((c) => c.starred).map((c) => c.name).sort().join() !== 'Ann Able,Cy NoMail') throw new Error('stars');
  await page.getByLabel('Select Ann Able').check();
  await page.getByLabel('Select Ben Best').check();
  await page.getByLabel('Select Cy NoMail').check();
  await bar.getByLabel('Add the selected contacts to a group').selectOption({ label: 'Clients' });
  await page.locator('.toast', { hasText: '2 added to Clients (1 without an email address left out)' }).last().waitFor();
  const g = (await api(page, 'GET', '/contacts/groups')).body.find((x) => x.id === group.id);
  if (g.members.map((m) => m.email).sort().join() !== 'ann@example.com,ben@example.com') throw new Error(JSON.stringify(g.members));
});
await step('Email everyone selected', async () => {
  await page.getByLabel('Select all shown').check();
  await page.getByRole('toolbar', { name: 'Change the selected contacts' }).getByText('4 selected').waitFor();
  // Mail takes ?compose= off the address once it has opened the message, so note every address the page goes to.
  const seen = [];
  const note = (f) => { if (f === page.mainFrame()) seen.push(f.url()); };
  page.on('framenavigated', note);
  await page.getByRole('toolbar', { name: 'Change the selected contacts' }).getByRole('button', { name: 'Email' }).click();
  await page.waitForFunction(() => location.pathname === '/mail');
  page.off('framenavigated', note);
  const hit = [...seen, page.url()].find((u) => /\/mail\?compose=/.test(u));
  if (!hit) throw new Error(`no compose link: ${seen.join(' ')}`);
  const to = decodeURIComponent(new URL(hit).searchParams.get('compose'));
  for (const e of ['ann@example.com', 'ben@example.com', 'dee@example.com']) if (!to.includes(e)) throw new Error(to);
  if (to.includes('NoMail')) throw new Error('someone without an address');
});
await step('Export selected: just the ticked ones, as vCard or CSV', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByLabel('Select Ann Able').check();
  await page.getByLabel('Select Ben Best').check();
  const bar = page.getByRole('toolbar', { name: 'Change the selected contacts' });
  await bar.getByText('2 selected').waitFor();
  const fs = await import('node:fs');
  await bar.getByRole('button', { name: 'Export selected' }).click();
  const [v] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /vCard/ }).click()]);
  const vcf = fs.readFileSync(await v.path(), 'utf8');
  if ((vcf.match(/BEGIN:VCARD/g) || []).length !== 2 || !/Ann Able/.test(vcf) || !/Ben Best/.test(vcf) || /Cy NoMail/.test(vcf)) throw new Error(vcf);
  await bar.getByRole('button', { name: 'Export selected' }).click();
  const [c] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /CSV/ }).click()]);
  const csv = fs.readFileSync(await c.path(), 'utf8');
  if (csv.trim().split(/\r?\n/).length !== 3) throw new Error(csv);
  await bar.getByRole('button', { name: 'Clear' }).click();
});
await step('Print: the ticked contacts as an address list; Export → Print the list for everyone', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByLabel('Select Ann Able').check();
  await page.getByLabel('Select Ben Best').check();
  const bar = page.getByRole('toolbar', { name: 'Change the selected contacts' });
  await bar.getByRole('button', { name: 'Print' }).click();
  const frame = page.locator('iframe.print-frame').last();
  await frame.waitFor({ state: 'attached' });
  const html = await frame.getAttribute('srcdoc');
  if (!/Ann Able/.test(html) || !/Ben Best/.test(html) || /Cy NoMail/.test(html) || !/2 people/.test(html)) throw new Error(html.slice(0, 300));
  await bar.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'Print the list' }).click();
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe.print-frame')].pop(); return f && /Cy NoMail/.test(f.getAttribute('srcdoc')); });
});
await step('Send in Chat…: the ticked contacts as cards in a channel, the message with the first', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'suppliers' })).body.id;
  await page.goto(`${B}/contacts`);
  await page.getByLabel('Select Ann Able').check();
  await page.getByLabel('Select Ben Best').check();
  const bar = page.getByRole('toolbar', { name: 'Change the selected contacts' });
  await bar.getByRole('button', { name: 'Send in Chat…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Send 2 contacts in Chat' });
  await dlg.getByRole('combobox').selectOption({ label: '# suppliers' });
  await dlg.getByLabel('Add a message (optional)').fill('Our two suppliers');
  await dlg.getByRole('button', { name: 'Send' }).click();
  await page.locator('.toast', { hasText: '2 contacts sent to # suppliers' }).waitFor();
  const r = (await api(page, 'GET', `/chat/channels/${ch}/messages`)).body;
  const msgs = (Array.isArray(r) ? r : r.messages || []).filter((m) => m.contact);
  const names = msgs.map((m) => m.contact.name).sort().join();
  if (names !== 'Ann Able,Ben Best' || !msgs.some((m) => m.body === 'Our two suppliers')) throw new Error(JSON.stringify(msgs.map((m) => [m.contact?.name, m.body])));
  await bar.getByRole('button', { name: 'Clear' }).click();
});
await step('Delete several, asked first', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByText('Dee Done').waitFor();
  await page.getByLabel('Select Ben Best').check();
  await page.getByLabel('Select Dee Done').check();
  await page.screenshot({ path: `${SP}/shots/contactbatch.png` });
  await page.getByRole('toolbar', { name: 'Change the selected contacts' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete 2 contacts?' }).getByRole('button', { name: 'Delete' }).click();
  await page.locator('.toast', { hasText: '2 contacts moved to Trash' }).last().waitFor();
  if ((await mine()).map((c) => c.name).sort().join() !== 'Ann Able,Cy NoMail') throw new Error('delete');
  await page.getByRole('tab', { name: 'Directory' }).click();
  if (await page.getByLabel('Select all shown').count()) throw new Error('selecting colleagues');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
