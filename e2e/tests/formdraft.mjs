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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let form, kim;
const draftOf = async (p) => p.evaluate(async (t) => (await (await fetch(`/api/public/forms/${t}/draft`, { headers: { 'x-requested-with': 'nas-workspace' } })).json()).draft, form.token);
await step('a two-page company form, and Kim signed in', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Staff survey' })).body;
  form = (await api(page, 'PUT', `/forms/${form.id}`, { audience: 'org', questions: [
    { id: 'team', type: 'short', title: 'Your team', required: true },
    { id: 'p2', type: 'section', title: 'Lunch' },
    { id: 'food', type: 'checkbox', title: 'What do you like?', options: ['Pizza', 'Sushi', 'Salad'] },
    { id: 'why', type: 'paragraph', title: 'Anything else?', required: true },
  ] })).body;
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
});
await step('answers are saved as Kim goes; closing the page and coming back brings them back, on the page she was on', async () => {
  await kim.goto(`${B}/f/${form.token}`);
  await kim.getByLabel(/^Your team/).fill('Design');
  await kim.getByRole('button', { name: 'Next' }).click();
  await kim.getByLabel('Sushi').check();
  await kim.getByText('Your answers are saved: come back to finish any time').waitFor();
  await until(async () => (await draftOf(kim))?.answers?.food?.includes('Sushi'));
  await kim.goto(`${B}/drive`);
  await kim.goto(`${B}/f/${form.token}`);
  await kim.getByText(/Your answers from .* are back, as you left them/).waitFor();
  await kim.getByRole('heading', { name: 'Lunch' }).waitFor();
  if (!(await kim.getByLabel('Sushi').isChecked())) throw new Error('Sushi');
  await kim.screenshot({ path: `${SP}/shots/form-draft-back.png` });
  await axe(kim, 'draft back');
  await kim.getByRole('button', { name: 'Back' }).click();
  if ((await kim.getByLabel(/^Your team/).inputValue()) !== 'Design') throw new Error('team');
});
await step('sending it ends the draft', async () => {
  await kim.getByRole('button', { name: 'Next' }).click();
  await kim.getByLabel(/^Anything else/).fill('More salad please');
  await kim.getByRole('button', { name: 'Submit' }).click();
  await kim.getByText(/Your response has been recorded/).waitFor();
  await new Promise((r) => setTimeout(r, 1500)); // nothing saved afterwards
  if (await draftOf(kim)) throw new Error('draft left');
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses;
  if (r.length !== 1 || r[0].answers.team !== 'Design' || r[0].answers.food.join() !== 'Sushi') throw new Error(JSON.stringify(r));
});
await step('Start over clears the form and the draft', async () => {
  await kim.goto(`${B}/f/${form.token}`);
  await kim.getByLabel(/^Your team/).fill('Sales');
  await kim.getByText('Your answers are saved: come back to finish any time').waitFor();
  await kim.reload();
  await kim.getByRole('button', { name: 'Start over' }).click();
  if ((await kim.getByLabel(/^Your team/).inputValue()) !== '') throw new Error('not cleared');
  await kim.getByText('Draft deleted').waitFor();
  if (await draftOf(kim)) throw new Error('draft left');
  await kim.reload();
  await kim.getByLabel(/^Your team/).waitFor();
  if (await kim.getByText(/are back, as you left them/).count()) throw new Error('banner');
});
await step('signed out, on a form for anyone: nothing is kept', async () => {
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public' });
  const ctx = await browser.newContext(); const v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel(/^Your team/).fill('Ops');
  await new Promise((r) => setTimeout(r, 1800));
  if (await v.getByText(/saved|Saving/).count()) throw new Error('saving shown');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
