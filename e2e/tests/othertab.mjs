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
// Made in another tab (or on another device), shown at once in an open app: for each app, without a reload.
let other;
const fresh = async (path) => { await page.goto(`${B}${path}`); await page.waitForTimeout(1500); await page.evaluate(() => { window.__stayed = true; }); };
const stayed = async () => { if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded'); };
await step('a second tab', async () => { other = await page.context().newPage(); await other.goto(B); });
const CASES = [
  ['Notes', '/notes', () => api(other, 'POST', '/notes', { title: 'Note from the phone', body: 'x' }), 'Note from the phone'],
  ['Contacts', '/contacts', () => api(other, 'POST', '/contacts', { name: 'Zed From-Phone', email: 'zed@example.com' }), 'Zed From-Phone'],
  ['Tasks: a list', '/tasks', () => api(other, 'POST', '/tasks/lists', { name: 'List from the phone' }), 'List from the phone'],
  ['Tasks: a task', '/tasks', async () => { const ls = (await api(other, 'GET', '/tasks/lists')).body; const l = (Array.isArray(ls) ? ls : ls.lists)[0]; return api(other, 'POST', `/tasks/lists/${l.id}/tasks`, { title: 'Task from the phone' }); }, 'Task from the phone'],
  ['Calendar', '/calendar', () => { const t = new Date(); t.setHours(10, 0, 0, 0); return api(other, 'POST', '/events', { title: 'Event from the phone', start: t.getTime(), end: t.getTime() + 36e5 }); }, 'Event from the phone'],
  ['Forms', '/forms', () => api(other, 'POST', '/forms', { title: 'Form from the phone' }), 'Form from the phone'],
  ['Chat: a channel', '/chat', () => api(other, 'POST', '/chat/channels', { name: 'from-the-phone' }), 'from-the-phone'],
];
for (const [label, path, make, text] of process.env.ONLY ? CASES.filter((c) => c[0] === process.env.ONLY) : CASES) {
  await step(`${label}: made in another tab, shown here at once`, async () => {
    await fresh(path);
    const r = await make();
    if (r.status >= 300) throw new Error(`could not make it: ${JSON.stringify(r.body).slice(0, 200)}`);
    await page.getByText(text, { exact: true }).first().waitFor({ timeout: 8000 });
    await stayed();
  });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
