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
let doc, kim;
await step('the author edits a comment; it shows “edited”; someone newly @mentioned is told; others see it live', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const lenId = (await api(page, 'POST', '/users', { local: 'len', domain: 'acme.com', name: 'Len Lee', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Edit plan' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'commenter' }, { user_id: lenId, role: 'editor' }] });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Ship on Fridya?', anchor: { quote: 'ship' }, id: 'thread-edit-1' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('button', { name: 'Comments' }).first().click();
  const kp = kim.getByRole('complementary', { name: 'Comments' });
  await kp.getByText('Ship on Fridya?').waitFor();
  if (await kp.getByRole('button', { name: /^Edit comment/ }).count()) throw new Error('Kim may edit Olivia’s comment');
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Comments' }).first().click();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.getByRole('button', { name: 'Edit comment by Olivia Owner' }).click();
  const box = panel.getByRole('textbox', { name: 'Edit comment' });
  await box.fill('Ship on Friday? @len@acme.com');
  await page.screenshot({ path: `${SP}/shots/comment-edit.png` });
  await panel.getByRole('button', { name: 'Save' }).click();
  await page.getByText('len@acme.com was told by chat').waitFor();
  await panel.getByText('· edited').waitFor();
  await kp.getByText('Ship on Friday?').waitFor();
  await kp.getByText('· edited').waitFor();
  const bell = (await (async () => { const l = await mk('len'); await signIn(l, 'len@acme.com'); return api(l, 'GET', '/notifications'); })()).body.items;
  if (!bell.some((n) => /mentioned you in a comment on “Edit plan”/.test(n.title))) throw new Error('Len not told');
});
await step('cancel leaves it as it was; Save is off until it changes', async () => {
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.getByRole('button', { name: 'Edit comment by Olivia Owner' }).click();
  if (await panel.getByRole('button', { name: 'Save' }).isEnabled()) throw new Error('Save on with no change');
  await panel.getByRole('textbox', { name: 'Edit comment' }).fill('Something else');
  await panel.getByRole('button', { name: 'Cancel' }).last().click();
  await panel.getByText('Ship on Friday?').waitFor();
  if (await panel.getByRole('textbox', { name: 'Edit comment' }).count()) throw new Error('still editing');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
