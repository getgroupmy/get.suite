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
let form;
await step('a poll for anyone with the link, sharing what others answered', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Team offsite' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [
    { id: 'where', type: 'choice', title: 'Where shall we go?', options: ['Lisbon', 'Porto', 'Faro'] },
    { id: 'stars', type: 'rating', title: 'How excited are you?', max: 5 },
    { id: 'wish', type: 'paragraph', title: 'A secret wish' },
  ] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Show people who've answered what others answered/).check();
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.show_results === true);
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  // Two answers already in.
  for (const [where, stars, wish] of [['Lisbon', 5, 'A pony'], ['Porto', 3, 'Karaoke']]) {
    const r = await page.evaluate(async ([t, a]) => (await fetch(`/api/public/forms/${t}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ answers: a }) })).status, [form.token, { where, stars, wish }]);
    if (r !== 201) throw new Error(String(r));
  }
});
let v;
await step('after sending: “See what others answered” shows the counts, never what was typed', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 } }); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/f/${form.token}`);
  if (await v.getByRole('button', { name: /See what others answered/ }).count()) throw new Error('shown before answering');
  await v.getByLabel('Lisbon').check();
  await v.getByLabel('4 of 5').check({ force: true });
  await v.getByLabel(/A secret wish/).fill('Sailing');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  await v.getByRole('button', { name: 'See what others answered' }).click();
  const where = v.getByRole('region', { name: 'Results: Where shall we go?' });
  await where.getByText('2 (67%)').waitFor();
  await v.getByRole('region', { name: 'Results: How excited are you?' }).getByText('average 4').waitFor();
  await v.getByText('3 responses so far. Who answered, and what anyone wrote, stays private.').waitFor();
  const wish = v.getByRole('region', { name: 'Results: A secret wish' });
  await wish.getByText('3 answers').waitFor();
  for (const secret of ['A pony', 'Karaoke']) if (await v.getByText(secret).count()) throw new Error(secret);
  await v.screenshot({ path: `${SP}/shots/form-results.png`, fullPage: true });
  await axe(v, 'results');
});
await step('coming back later from the same browser: the link is there again', async () => {
  await v.goto(`${B}/f/${form.token}`);
  await v.getByText("You've answered this form before.").waitFor();
  await v.getByRole('button', { name: 'See what others answered' }).click();
  await v.getByRole('region', { name: 'Results: Where shall we go?' }).getByText('2 (67%)').waitFor();
  await v.getByRole('button', { name: 'Hide' }).click();
  await v.getByRole('region', { name: 'Results: Where shall we go?' }).waitFor({ state: 'detached' });
});
await step('a company form: someone who sent a response sees it from the closed form too; turned off, it goes', async () => {
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'org', one_per_person: true });
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/f/${form.token}`);
  await kim.getByLabel('Faro').check();
  await kim.getByRole('button', { name: 'Submit' }).click();
  await kim.getByText(/Your response has been recorded/).waitFor();
  await kim.reload();
  await kim.getByText('You have already filled in this form.').waitFor();
  await kim.getByRole('button', { name: 'See what others answered' }).click();
  await kim.getByRole('region', { name: 'Results: Where shall we go?' }).getByText('1 (25%)').first().waitFor();
  await api(page, 'PUT', `/forms/${form.id}`, { show_results: false });
  await kim.reload();
  await kim.getByText('You have already filled in this form.').waitFor();
  if (await kim.getByRole('button', { name: 'See what others answered' }).count()) throw new Error('still offered');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
