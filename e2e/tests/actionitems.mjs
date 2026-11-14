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
let doc, kimId, kim;
const t = (text) => ({ type: 'text', text });
const m = (id, name) => ({ type: 'mention', attrs: { id, name, email: '' } });
const item = (checked, ...content) => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content }] });
await step('send a document\'s action items to Tasks', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Sync notes', content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Action items')] },
    { type: 'taskList', content: [item(false, m(kimId, 'Kim Park'), t(' send the figures by Friday')), item(true, m(kimId, 'Kim Park'), t(' old one')), item(false, t('Nobody'))] },
  ] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').first().getByText('send the figures by Friday').first().waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send action items to Tasks' }).click();
  const d = page.getByRole('dialog', { name: 'Send action items to Tasks' });
  const list = d.getByRole('list', { name: 'Action items' });
  await list.getByText(/send the figures/).waitFor();
  if (await list.getByRole('listitem').count() !== 1) throw new Error('only the open item with a mention');
  await d.getByRole('button', { name: 'Send 1' }).click();
  await page.getByText(/Sent 1 task\. Kim Park can't open this document/).waitFor();
});
await step('Kim finds it in Assigned to me, linking to the document', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const assigned = (await api(kim, 'GET', '/tasks/assigned')).body;
  const task = assigned.find((x) => x.title === 'send the figures');
  if (!task || task.link_url !== `/docs/${doc.id}` || !task.due) throw new Error(JSON.stringify(assigned));
  await kim.goto(`${B}/tasks/${task.list_id}?task=${task.id}`);
  await kim.getByRole('link', { name: '📄 Sync notes' }).waitFor();
}, kim);
await step('sending again leaves it alone', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send action items to Tasks' }).click();
  const d = page.getByRole('dialog', { name: 'Send action items to Tasks' });
  await d.getByText('already sent').waitFor();
  if (!(await d.getByRole('checkbox').isDisabled())) throw new Error('can send again');
  await d.getByRole('button', { name: 'Cancel' }).click();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
