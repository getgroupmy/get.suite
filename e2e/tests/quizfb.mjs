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
let f, anon;
await step('answer feedback: set in the editor under the answer key', async () => {
  f = (await api(page, 'POST', '/forms', { title: 'Safety quiz', questions: [
    { id: 'a', type: 'choice', title: 'Fire exit?', options: ['Left', 'Right'] },
    { id: 'b', type: 'short', title: 'Emergency number' },
  ] })).body;
  await page.goto(`${B}/forms/${f.id}?tab=settings`);
  await page.getByLabel(/Make this a quiz/).check();
  await page.getByLabel(/Anyone with the link/).check();
  await page.getByRole('tab', { name: 'Questions' }).click();
  await page.getByLabel('Correct answer for question 1').selectOption('Right');
  await page.getByLabel('Correct answer for question 2').fill('999');
  const key2 = page.getByRole('group', { name: 'Answer key for question 2' });
  await key2.getByText('Answer feedback').click();
  await page.getByLabel('Feedback for a right answer to question 2').fill('Correct: 999 reaches everything.');
  await page.getByLabel('Feedback for a wrong answer to question 2').fill('It’s 999 in the UK. Check the poster by the lift.');
  await page.getByRole('group', { name: 'Answer key for question 1' }).getByText('Answer feedback').click();
  await page.getByLabel('Feedback for a right answer to question 1').fill('Yes, the right-hand stairs.');
  await page.screenshot({ path: `${SP}/shots/quiz-feedback-edit.png` });
  await until(async () => { const x = (await api(page, 'GET', `/forms/${f.id}`)).body; return x.questions[1].feedback?.wrong?.startsWith('It’s 999') && x.questions[0].feedback?.right; });
});
await step('after submitting: each question’s feedback for the answer given', async () => {
  anon = await mk('anon');
  await anon.goto(`${B}/f/${f.token}`);
  const seen = await anon.evaluate(async (t) => (await fetch(`/api/public/forms/${t}`)).text(), f.token);
  if (seen.includes('poster by the lift')) throw new Error('feedback leaked before answering');
  await anon.getByRole('group', { name: 'Fire exit?' }).getByLabel('Right').check();
  await anon.getByLabel('Emergency number').fill('112');
  await anon.getByRole('button', { name: 'Submit' }).click();
  await anon.getByText('Your score:').waitFor();
  await anon.getByText('Yes, the right-hand stairs.').waitFor();
  await anon.getByText('It’s 999 in the UK. Check the poster by the lift.').waitFor();
  if (await anon.getByText('Correct: 999 reaches everything.').count()) throw new Error('right-answer feedback for a wrong answer');
  await anon.screenshot({ path: `${SP}/shots/quiz-feedback.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
