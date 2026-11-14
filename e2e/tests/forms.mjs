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
let formUrl, formId;
const rex = await mk('rex');
const anon = await mk('anon');
await step('make a colleague', async () => {
  const r = await api(page, 'POST', '/users', { local: 'rex', domain: 'acme.com', name: 'Rex Responder', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
});
await step('build a form', async () => {
  await page.getByRole('link', { name: 'Forms', exact: true }).first().click();
  await page.getByText('No forms yet').waitFor();
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByLabel('Form title').fill('Team lunch');
  await page.getByLabel('Description').fill('Friday at 1');
  await page.getByLabel('Question 1 title').fill('Food');
  await page.getByLabel('Question 1, option 1', { exact: true }).fill('Pizza');
  await page.getByRole('button', { name: 'Add option' }).click();
  await page.getByLabel('Question 1, option 2', { exact: true }).fill('Sushi');
  await page.getByRole('region', { name: 'Question 1' }).getByLabel('Required').check();
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 2 title').fill('How hungry?');
  await page.getByLabel('Type of question 2').selectOption('scale');
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 3 title').fill('Allergies');
  await page.getByLabel('Type of question 3').selectOption('paragraph');
  await page.getByText('Saved', { exact: true }).waitFor();
  formId = page.url().split('/forms/')[1];
  const f = (await api(page, 'GET', `/forms/${formId}`)).body;
  if (f.title !== 'Team lunch' || f.questions.length !== 3 || f.questions[0].options.join() !== 'Pizza,Sushi' || !f.questions[0].required || f.questions[1].type !== 'scale') throw new Error(JSON.stringify(f));
  formUrl = `${B}/f/${f.token}`;
  await page.screenshot({ path: `${SP}/shots/forms-editor.png` });
});
await step('reorder and delete questions', async () => {
  await page.getByRole('button', { name: 'Move question 3 up' }).click();
  await page.getByRole('button', { name: 'Duplicate question 1' }).click();
  await page.getByRole('button', { name: 'Delete question 2' }).click();
  await until(async () => (await api(page, 'GET', `/forms/${formId}`)).body.questions.map((q) => q.title).join() === 'Food,Allergies,How hungry?');
});
await step('settings: one per person, message', async () => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('One response per person').check();
  await page.getByLabel('Message after submitting').fill('Thanks, see you Friday!');
  await page.getByLabel('Notify me of each new response').click(); // blur saves the message
  await page.getByLabel('Notify me of each new response').check();
  await until(async () => { const f = (await api(page, 'GET', `/forms/${formId}`)).body; return f.one_per_person && f.confirmation === 'Thanks, see you Friday!' && f.notify; });
});
await step('signed-out visitor is asked to sign in, then fills it in', async () => {
  await rex.goto(formUrl);
  await rex.getByRole('heading', { name: 'Sign in to fill in this form' }).waitFor();
  await rex.getByRole('button', { name: 'Sign in' }).click();
  await rex.getByLabel('Email').fill('rex@acme.com');
  await rex.getByLabel('Password').fill('password123');
  await rex.getByRole('button', { name: /^Sign in/ }).click();
  await rex.getByRole('heading', { name: 'Team lunch' }).waitFor();
  await rex.getByText('Signed in as Rex Responder').waitFor();
  await rex.getByRole('button', { name: 'Submit' }).click();
  await rex.getByText('This question needs an answer').waitFor();
  await rex.getByRole('group', { name: 'Food (required)' }).getByLabel('Sushi').check();
  await rex.getByRole('group', { name: 'How hungry?' }).getByLabel('4').check();
  await rex.getByLabel('Allergies').fill('None');
  await rex.screenshot({ path: `${SP}/shots/forms-fill.png`, fullPage: true });
  await rex.getByRole('button', { name: 'Submit' }).click();
  await rex.getByText('Thanks, see you Friday!').waitFor();
  if (await rex.getByText('Submit another response').count()) throw new Error('one each');
  await rex.reload();
  await rex.getByText('You have already filled in this form.').waitFor();
});
await step('owner sees it live: count, bell, summary, individual', async () => {
  await page.getByRole('tab', { name: 'Responses (1)' }).click();
  const sum = page.getByRole('region', { name: 'Summary: Food' });
  await sum.getByText('1 (100%)').waitFor();
  await page.getByRole('region', { name: 'Summary: How hungry?' }).getByText('average 4').waitFor();
  await page.getByRole('region', { name: 'Summary: Allergies' }).getByText('None').waitFor();
  await page.getByRole('button', { name: /Notifications, 1 new/ }).waitFor();
  await page.getByRole('tab', { name: 'Individual' }).click();
  await page.getByText('Rex Responder (rex@acme.com)').waitFor();
});
await step('anyone with the link: anonymous response arrives live', async () => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Anyone with the link/).check();
  await until(async () => (await api(page, 'GET', `/forms/${formId}`)).body.audience === 'public');
  await page.getByRole('tab', { name: /Responses/ }).click();
  await anon.goto(formUrl);
  await anon.getByRole('heading', { name: 'Team lunch' }).waitFor();
  if (await anon.getByText(/Signed in as/).count()) throw new Error('should be anonymous');
  await anon.getByRole('group', { name: 'Food (required)' }).getByLabel('Pizza').check();
  await anon.getByRole('button', { name: 'Submit' }).click();
  await anon.getByText('Thanks, see you Friday!').waitFor();
  await anon.getByRole('button', { name: 'Submit another response' }).click();
  await anon.getByRole('group', { name: 'Food (required)' }).getByLabel('Pizza').check();
  await anon.getByRole('button', { name: 'Submit' }).click();
  await anon.getByText('Thanks, see you Friday!').waitFor();
  await page.getByRole('tab', { name: 'Responses (3)' }).waitFor();
  await page.getByRole('tab', { name: 'Summary' }).click();
  await page.getByRole('region', { name: 'Summary: Food' }).getByText('2 (67%)').waitFor();
  await page.screenshot({ path: `${SP}/shots/forms-summary.png` });
});
await step('close the form', async () => {
  await page.getByLabel('Accepting responses').uncheck();
  await page.getByText('This form is closed').waitFor();
  await anon.reload();
  await anon.getByText('This form is no longer accepting responses.').waitFor();
});
await step('open responses in Sheets', async () => {
  await page.getByRole('button', { name: 'Open in Sheets' }).click();
  await page.waitForURL(/\/sheets\//);
  await until(() => page.locator('input').evaluateAll((els) => els.some((e) => e.value === 'Team lunch (responses)')));
  await page.getByText('Sushi', { exact: true }).first().waitFor();
  await page.getByText('rex@acme.com', { exact: true }).first().waitFor(); // people kept after going public
});
await step('list shows the form; delete it', async () => {
  await page.goto(`${B}/forms`);
  const row = page.getByRole('list', { name: 'Your forms' }).getByRole('button', { name: /Team lunch/ });
  await row.getByText('3 responses').waitFor();
  await row.getByText('Closed').waitFor();
  await row.click();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete form' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('No forms yet').waitFor();
  await anon.reload();
  await anon.getByRole('heading', { name: 'Form not available' }).waitFor();
});
await step('phone width', async () => {
  await anon.setViewportSize({ width: 390, height: 800 });
  const w = await anon.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) throw new Error(`scrolls sideways: ${w}`);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
