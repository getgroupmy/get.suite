import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
  await api(page, 'POST', '/orgs/current/domains', { name: 'acme.co' }).catch(() => {});
  const r = await api(page, 'POST', '/users', { local: 'sam', domain: 'acme.com', name: 'Sam Lee', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await api(page, 'POST', '/users', { local: 'taken', domain: 'acme.com', name: 'Taken', password: 'password123' });
});

await step('a taken address is refused with a message', async () => {
  await page.goto(B + '/admin');
  await page.getByLabel('Actions for Sam Lee').click();
  await page.getByRole('menuitem', { name: 'Change email address' }).click();
  const dlg = page.getByRole('dialog', { name: "Change Sam Lee's email address" });
  await dlg.getByText('Now: sam@acme.com').waitFor();
  if (await dlg.getByRole('button', { name: 'Change address' }).isEnabled()) throw new Error('enabled with no change');
  await dlg.getByLabel('New address before @').fill('taken');
  await dlg.getByRole('button', { name: 'Change address' }).click();
  await dlg.getByRole('alert').getByText('taken@acme.com is already taken').waitFor();
});

await step('rename; the list shows it; they sign in with the new address', async () => {
  const dlg = page.getByRole('dialog', { name: "Change Sam Lee's email address" });
  await dlg.getByLabel('New address before @').fill('Sam.Lee');
  await page.screenshot({ path: `${SP}/shots/rename-dialog.png` });
  await dlg.getByRole('button', { name: 'Change address' }).click();
  await page.getByText('Address changed to sam.lee@acme.com').waitFor();
  await page.getByRole('cell', { name: 'sam.lee@acme.com' }).waitFor();
  const ctx = await browser.newContext(); const s = await ctx.newPage();
  await s.goto(B);
  await s.getByLabel('Email address').fill('sam.lee@acme.com');
  await s.getByLabel('Password').fill('password123');
  await s.getByRole('button', { name: 'Sign in' }).click();
  await s.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await ctx.close();
  const aliases = await page.evaluate(async () => (await fetch('/api/users/directory')).json());
  if (!aliases.some((u) => u.username === 'sam.lee@acme.com')) throw new Error('directory not updated');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
