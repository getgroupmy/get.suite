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
const banner = (p) => p.getByRole('region', { name: 'Approval' });
await step('a shared document', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Supplier contract' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
});
await step('ask for approval from the document', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Request approval…' }).click();
  const d = page.getByRole('dialog', { name: /Request approval/ });
  await d.getByRole('list', { name: 'Reviewers' }).getByLabel(/Kim Park/).check();
  await d.getByLabel('Message (optional)').fill('Please check clause 4');
  await d.getByRole('button', { name: 'Send request' }).click();
  await banner(page).getByText('Waiting for approval').waitFor();
  await banner(page).getByText('0 of 1 approved').waitFor();
});
await step('the reviewer is notified and approves from the banner', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.getByRole('link', { name: /Approvals/ }).getByLabel('1 waiting for you').waitFor();
  await kim.goto(`${B}/home`);
  await kim.getByRole('region', { name: 'Waiting for your approval' }).getByText('Supplier contract').waitFor();
  await kim.getByRole('button', { name: /Notifications, \d+ new/ }).click();
  await kim.getByText('Olivia Owner asked you to approve “Supplier contract”').click();
  await kim.waitForURL(/\/docs\//);
  await banner(kim).getByText('Olivia Owner asked you to approve this').waitFor();
  await banner(kim).getByText('“Please check clause 4”').waitFor();
  await banner(kim).getByLabel('Comment (optional)').fill('Looks good');
  await banner(kim).getByRole('button', { name: '✓ Approve' }).click();
  await banner(kim).getByText('✓ Approved').waitFor();
});
await step('the owner sees it approved, live', async () => {
  await banner(page).getByText('✓ Approved').waitFor();
  await banner(page).getByRole('button', { name: 'Details' }).click();
  await banner(page).getByText('“Looks good”').waitFor();
});
await step('Drive → Approvals lists it', async () => {
  await page.goto(`${B}/drive/approvals`);
  const row = page.getByRole('listitem', { name: 'Approval: Supplier contract' });
  await row.getByText('Approved', { exact: true }).first().waitFor();
});
await step('an edit afterwards is flagged', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Clause 5 added.');
  await page.getByText('All changes saved').waitFor();
  await until(async () => (await api(page, 'GET', `/approvals/file/${doc.id}`)).body.current.changed_since, 15000);
  await page.reload();
  await banner(page).getByText(/changed since it was approved/).waitFor();
});
await step('a rejection from Drive → Approvals', async () => {
  await api(page, 'POST', '/approvals', { file_id: doc.id, reviewers: [(await api(kim, 'GET', '/auth/me')).body.user.id] });
  await kim.goto(`${B}/drive/approvals`);
  const row = kim.getByRole('listitem', { name: 'Approval: Supplier contract' });
  await row.getByLabel('Comment (optional)').fill('Clause 5 is wrong');
  await row.getByRole('button', { name: '✕ Reject' }).click();
  await kim.getByText('Nothing to approve.').waitFor();
  await page.goto(`${B}/docs/${doc.id}`);
  await banner(page).getByText('✕ Rejected').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
