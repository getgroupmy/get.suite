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
let f;
const anon = await mk('anon');
await step('a form with two questions', async () => {
  f = (await api(page, 'POST', '/forms', { title: 'Safety quiz', questions: [
    { id: 'a', type: 'choice', title: 'Fire exit?', options: ['Left', 'Right'] },
    { id: 'b', type: 'short', title: 'Emergency number' },
  ] })).body;
  await page.goto(`${B}/forms/${f.id}?tab=settings`);
});
await step('make it a quiz and set the answers', async () => {
  await page.getByLabel(/Make this a quiz/).check();
  await page.getByLabel(/Anyone with the link/).check();
  await page.getByRole('tab', { name: 'Questions' }).click();
  await page.getByLabel('Correct answer for question 1').selectOption('Right');
  await page.getByLabel('Correct answer for question 2').fill('999');
  await page.getByLabel('Points for question 2').fill('2');
  await until(async () => { const x = (await api(page, 'GET', `/forms/${f.id}`)).body; return x.quiz && x.questions[0].answer === 'Right' && x.questions[1].answer === '999' && x.questions[1].points === 2; });
});
await step('someone takes it and sees their score; the key is never sent', async () => {
  const seen = await anon.evaluate(async (t) => (await fetch(`/api/public/forms/${t}`)).json(), f.token).catch(async () => { await anon.goto(B); return anon.evaluate(async (t) => (await fetch(`/api/public/forms/${t}`)).json(), f.token); });
  if (JSON.stringify(seen).includes('999')) throw new Error('answer leaked');
  await anon.goto(`${B}/f/${f.token}`);
  await anon.getByRole('group', { name: 'Fire exit?' }).getByLabel('Right').check();
  await anon.getByLabel('Emergency number').fill('112');
  await anon.getByRole('button', { name: 'Submit' }).click();
  await anon.getByText('Your score:').waitFor();
  if ((await anon.locator('.quiz-score strong').innerText()) !== '1 / 3') throw new Error(await anon.locator('.quiz-score strong').innerText());
  await anon.getByText('✗ Emergency number').waitFor();
});
await step('owner sees scores in the summary and on each response', async () => {
  await page.getByRole('tab', { name: 'Responses (1)' }).click();
  const sc = page.getByRole('region', { name: 'Scores' });
  await sc.getByText('Average 1 out of 3').waitFor();
  await page.getByRole('tab', { name: 'Individual' }).click();
  await page.getByText('Score 1 / 3').waitFor();
  await page.getByLabel('wrong').waitFor();
  await page.screenshot({ path: `${SP}/shots/quiz.png` });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
