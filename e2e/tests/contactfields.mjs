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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const thisMonth = (d) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`;
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
await step('a contact with an anniversary and a field of your own', async () => {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click();
  await page.getByRole('button', { name: /New contact/ }).click();
  const m = page.getByRole('dialog');
  await m.getByLabel('Name').fill('Ann Lee');
  await m.getByRole('button', { name: '+ Add a date' }).click();
  await m.getByLabel('Date 1 label').fill('Anniversary');
  await m.getByLabel('Date 1', { exact: true }).fill(`2015-${pad(now.getMonth() + 1)}-14`);
  await m.getByRole('button', { name: '+ Add a field' }).click();
  await m.getByLabel('Field 1 label').fill('Customer no.');
  await m.getByLabel('Field 1 value').fill('4711');
  await m.getByRole('button', { name: '+ Add a field' }).click();
  await m.getByLabel('Field 2 label').fill('Parking');
  await m.getByLabel('Field 2 value').fill('B12');
  await m.getByRole('button', { name: 'Remove field 2' }).click();
  await page.screenshot({ path: `${SP}/shots/contact-fields.png` });
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  await page.locator('tbody tr', { hasText: 'Ann Lee' }).getByText('Customer no.: 4711').waitFor();
  const c = (await api(page, 'GET', '/contacts')).body.find((x) => x.name === 'Ann Lee');
  if (JSON.stringify(c.custom_fields) !== '[{"label":"Customer no.","value":"4711"}]' || c.dates[0]?.label !== 'Anniversary') throw new Error(JSON.stringify(c));
});
await step('the anniversary shows on the calendar with the years', async () => {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.locator('.birthday-chip', { hasText: `🗓 Anniversary: Ann Lee (${now.getFullYear() - 2015})` }).waitFor();
});
await step('editing keeps them; they go into the vCard and CSV downloads', async () => {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Ann Lee' }).click();
  const m = page.getByRole('dialog');
  if ((await m.getByLabel('Field 1 value').inputValue()) !== '4711') throw new Error('kept');
  await m.getByLabel('Field 1 value').fill('4712');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  const vcf = await page.evaluate(async () => (await fetch('/api/contacts/export?format=vcf')).text());
  if (!/X-WORKSPACE-FIELD;LABEL="Customer no\.":4712/.test(vcf) || !/X-ABDATE:2015-/.test(vcf)) throw new Error(vcf.slice(0, 400));
  const csv = await page.evaluate(async () => (await fetch('/api/contacts/export?format=csv')).text());
  if (!/Custom Field 1 - Value/.test(csv) || !/4712/.test(csv)) throw new Error(csv.slice(0, 300));
});
await step('related people: added in the form, shown in the list, kept on edit, in the vCard and CSV', async () => {
  await page.getByRole('button', { name: 'Edit Ann Lee' }).click();
  const m = page.getByRole('dialog');
  await m.getByRole('button', { name: '+ Add a person' }).click();
  if ((await m.getByLabel('Related person 1: who they are').inputValue()) !== 'Spouse') throw new Error('Spouse first');
  await m.getByLabel('Related person 1: name').fill('Ben Lee');
  await m.getByRole('button', { name: '+ Add a person' }).click();
  await m.getByLabel('Related person 2: who they are').fill('Manager');
  await m.getByLabel('Related person 2: name').fill('Max Ode');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  await page.locator('tbody tr', { hasText: 'Ann Lee' }).getByText(/Spouse: Ben Lee · Manager: Max Ode/).waitFor();
  await page.getByRole('button', { name: 'Edit Ann Lee' }).click();
  if ((await m.getByLabel('Related person 2: name').inputValue()) !== 'Max Ode') throw new Error('not kept');
  await m.getByRole('button', { name: 'Remove related person 2' }).click();
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  const vcf = await page.evaluate(async () => (await fetch('/api/contacts/export?format=vcf')).text());
  if (!/X-ABRELATEDNAMES:Ben Lee\r\nitem\d+\.X-ABLabel:_\$!<Spouse>!\$_/.test(vcf) || /Max Ode/.test(vcf)) throw new Error(vcf.slice(0, 600));
  const csv = await page.evaluate(async () => (await fetch('/api/contacts/export?format=csv')).text());
  if (!/Relation 1 - Type,Relation 1 - Value/.test(csv) || !/Spouse,Ben Lee/.test(csv)) throw new Error(csv.slice(0, 400));
});
await step('Merge duplicates: the related people, dates and fields of both are kept', async () => {
  await api(page, 'POST', '/contacts', { name: 'Ann Lee', related: [{ label: 'Manager', name: 'Zoe Boss' }], custom_fields: [{ label: 'Locker', value: '7' }] });
  await page.goto(`${B}/contacts`);
  await page.locator('tbody tr', { hasText: 'Ann Lee' }).first().waitFor();
  await page.getByRole('button', { name: 'Merge duplicates' }).click();
  const dlg = page.getByRole('dialog', { name: 'Merge duplicates' });
  await dlg.getByRole('group', { name: 'Duplicates of Ann Lee' }).getByRole('button', { name: 'Merge 2' }).click();
  await dlg.getByText(/No duplicates/).waitFor();
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  const anns = (await api(page, 'GET', '/contacts')).body.filter((x) => x.name === 'Ann Lee');
  if (anns.length !== 1) throw new Error(`${anns.length} Ann Lees`);
  const [ann] = anns;
  const rel = ann.related.map((r) => `${r.label}: ${r.name}`).sort().join(' | ');
  if (rel !== 'Manager: Zoe Boss | Spouse: Ben Lee') throw new Error(rel);
  if (!ann.custom_fields.some((f) => f.label === 'Locker') || !ann.custom_fields.some((f) => f.label === 'Customer no.') || !ann.dates.length) throw new Error(JSON.stringify(ann));
  await page.locator('tbody tr', { hasText: 'Ann Lee' }).getByText(/Zoe Boss/).waitFor();
  // A related person's name finds them among your contacts.
  await api(page, 'POST', '/contacts', { name: 'Zoe Boss', email: 'zoe@boss.example' });
  await page.reload();
  await page.locator('tbody tr', { hasText: 'Ann Lee' }).getByRole('button', { name: 'Zoe Boss' }).click();
  await until(async () => (await page.locator('tbody tr').count()) === 1 && (await page.locator('tbody tr', { hasText: 'zoe@boss.example' }).count()) === 1);
});
await step('Filter finds a contact by a field of your own or another email address', async () => {
  await api(page, 'POST', '/contacts', { name: 'Ola Nord', email: 'ola@work.example', more_emails: [{ type: 'home', value: 'ola.home@mail.example' }] });
  await page.goto(`${B}/contacts`);
  await page.locator('tbody tr', { hasText: 'Ola Nord' }).waitFor();
  const box = page.getByLabel('Filter contacts');
  await box.fill('4712');
  await until(async () => (await page.locator('tbody tr').count()) === 1 && (await page.locator('tbody tr', { hasText: 'Ann Lee' }).count()) === 1);
  await box.fill('ola.home@');
  await until(async () => (await page.locator('tbody tr').count()) === 1 && (await page.locator('tbody tr', { hasText: 'Ola Nord' }).count()) === 1);
  await box.fill('');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
