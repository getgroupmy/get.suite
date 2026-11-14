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
let form, v;
await step('build a form with two sections and a branch, in the editor', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Event sign-up' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'come', type: 'choice', title: 'Are you coming?', options: ['Yes', 'No'], required: true }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: 'Add section' }).click();
  await page.getByLabel('Section 2 title').fill('Your visit');
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 3 title').fill('Dietary needs');
  await page.getByLabel('Type of question 3').selectOption('short');
  await page.getByRole('button', { name: 'Add section' }).click();
  await page.getByLabel('Section 4 title').fill('Sorry to miss you');
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 5 title').fill('Why not?');
  await page.getByLabel('Type of question 5').selectOption('short');
  await page.getByRole('region', { name: 'Question 1' }).getByText('Go to a section depending on the answer').click();
  await page.getByLabel('After “No”, go to').selectOption({ label: 'Go to: Sorry to miss you' });
  await page.getByLabel('After “Yes”, go to').selectOption({ label: 'Go to: Your visit' });
  await until(async () => {
    const f = (await api(page, 'GET', `/forms/${form.id}`)).body;
    return f.questions.length === 5 && f.questions[0].goto?.No === f.questions[3].id;
  }, 10000);
});
await step('“Yes” goes through “Your visit” and then on; “No” jumps straight to “Sorry to miss you”', async () => {
  // A branch for Yes also leads past "Sorry…"? No: Yes goes to Your visit, then continues to the next section.
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  await v.goto(`${B}/f/${form.token}`);
  await v.getByRole('button', { name: 'Next' }).click();
  await v.getByText('This question needs an answer').waitFor();
  await v.getByLabel('No').check();
  await v.getByRole('button', { name: 'Next' }).click();
  await v.getByRole('heading', { name: 'Sorry to miss you' }).waitFor();
  if (await v.getByLabel('Dietary needs').count()) throw new Error('skipped page shown');
  await v.getByRole('button', { name: 'Back' }).click();
  await v.getByLabel('Yes').check();
  await v.getByRole('button', { name: 'Next' }).click();
  await v.getByRole('heading', { name: 'Your visit' }).waitFor();
  await v.getByLabel('Dietary needs').fill('Vegetarian');
  await v.getByRole('button', { name: 'Next' }).click();
  await v.getByRole('heading', { name: 'Sorry to miss you' }).waitFor();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  if (r.come !== 'Yes' || r[form.questions[2].id] !== 'Vegetarian') throw new Error(JSON.stringify(r));
});
await step('“After this section: Submit the form” ends it after “Your visit”', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByLabel('After section 2').selectOption('submit');
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions[1].after === 'submit', 10000);
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel('Yes').check();
  await v.getByRole('button', { name: 'Next' }).click();
  await v.getByRole('heading', { name: 'Your visit' }).waitFor();
  await v.getByRole('button', { name: 'Submit' }).waitFor();
  if (await v.getByRole('button', { name: 'Next' }).count()) throw new Error('should end here');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
