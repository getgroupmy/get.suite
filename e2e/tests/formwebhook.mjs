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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
let form;
await step('the owner sets a web address: unsafe ones refused, a test delivery says why it failed, the secret shown and renewed', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_links: true });
  await api(page, 'POST', '/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' });
  form = (await api(page, 'POST', '/forms', { title: 'Leads', questions: [{ type: 'short', title: 'Your name' }] })).body;
  await api(page, 'POST', `/forms/${form.id}/editors`, { email: 'mia@acme.com' });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const box = page.getByRole('group', { name: 'Send responses to a web address' });
  await box.getByText(/each new or changed response is sent there/).waitFor();
  await box.getByRole('button', { name: 'Set up…' }).click();
  const addr = box.getByLabel('Web address (https)');
  await addr.fill('http://hooks.example.com/forms');
  await box.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Use a secure address (https://…)').waitFor();
  await addr.fill('https://192.168.1.20/forms');
  await box.getByRole('button', { name: 'Save' }).click();
  await page.getByText('That address is on a private network').waitFor();
  await addr.fill('https://hooks.example.invalid/forms');
  await box.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Each new response will be sent to that address').waitFor();
  await box.getByRole('button', { name: 'Send a test' }).click();
  await page.getByText(/The test didn’t arrive: /).waitFor({ timeout: 20000 });
  await box.getByRole('status').getByText(/Last try .*:/).waitFor();
  await box.getByRole('button', { name: 'Show' }).click();
  const secret = await box.locator('.webhook-secret').innerText();
  if (!/^whsec_[\w-]{32}$/.test(secret)) throw new Error(secret);
  await box.getByRole('button', { name: 'Make a new one' }).click();
  await until(async () => (await box.locator('.webhook-secret').innerText()) !== secret);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/form-webhook.png` });
  await page.evaluate(AXE);
  const v = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 100)}`));
  if (v.length) throw new Error(v.join(' | '));
  // After reloading, it's still set.
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  if (await box.getByLabel('Web address (https)').inputValue() !== 'https://hooks.example.invalid/forms') throw new Error('not kept');
});
await step('an editor doesn’t see it (the answers would leave Workspace): only the owner sets it', async () => {
  const mia = await mk('mia');
  await mia.goto(B);
  await mia.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mia@acme.com', password: 'password123' }) }));
  await mia.goto(`${B}/forms/${form.id}`);
  await mia.getByRole('tab', { name: 'Settings' }).click();
  await mia.getByText('Who can fill it in').waitFor();
  if (await mia.getByRole('group', { name: 'Send responses to a web address' }).count()) throw new Error('shown to an editor');
});
await step('Post each response in a Chat channel: the answers arrive in #leads, from Forms', async () => {
  await api(page, 'POST', '/chat/channels', { name: 'leads' });
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  const pick = page.getByLabel('Post each response in a Chat channel');
  await pick.locator('option', { hasText: '#leads' }).waitFor({ state: 'attached' });
  await pick.selectOption({ label: '#leads' });
  await until(async () => !!(await api(page, 'GET', `/forms/${form.id}`)).body.chat_channel);
  await page.goto(`${B}/f/${form.token}`);
  await page.getByLabel('Your name').fill('Pat Lee');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText(/response has been recorded/i).waitFor();
  await page.goto(`${B}/chat`);
  await page.getByRole('link', { name: /leads/ }).or(page.getByRole('button', { name: /leads/ })).first().click();
  await page.getByText(/New response to “Leads” from Olivia Owner/).waitFor();
  await page.getByText('Your name: Pat Lee').waitFor();
  await page.getByText('Forms', { exact: true }).first().waitFor();
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
});
await step('Add each response as a task: it lands on the IT list, titled by the answer', async () => {
  await api(page, 'POST', '/tasks/lists', { name: 'IT requests' });
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  const pick = page.getByLabel('Add each response as a task');
  await pick.locator('option', { hasText: 'IT requests' }).waitFor({ state: 'attached' });
  await pick.selectOption({ label: 'IT requests' });
  await page.getByLabel('Task title from').selectOption({ label: 'The answer to “Your name”' });
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.task_title);
  await page.goto(`${B}/f/${form.token}`);
  await page.getByLabel('Your name').fill('Robin Hood');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText(/response has been recorded/i).waitFor();
  await page.goto(`${B}/tasks`);
  await page.getByText('IT requests').first().click();
  await page.getByText('Robin Hood', { exact: true }).first().waitFor();
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
});
await step('turning it off', async () => {
  const box = page.getByRole('group', { name: 'Send responses to a web address' });
  await box.getByRole('button', { name: 'Turn off' }).click();
  await page.getByText('Responses are no longer sent anywhere').waitFor();
  await box.getByRole('button', { name: 'Set up…' }).waitFor();
  if ((await api(page, 'GET', `/forms/${form.id}/webhook`)).body !== null) throw new Error('still set');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
