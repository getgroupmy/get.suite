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
let form;
const qs = async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions;
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
const visitor = async (who) => { const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } }); const v = await ctx.newPage(); v.on('pageerror', (e) => errors.push(`${who}: ${e.message}`)); return v; };
await step('a required signature question, made in the editor', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Photo consent' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', allow_edit: true, questions: [{ id: 'name', type: 'short', title: 'Your name', required: true }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 2 title').fill('Sign here');
  await page.getByLabel('Type of question 2').selectOption('signature');
  await page.getByText('They sign in a box with a mouse, pen or finger (or type their name)').waitFor();
  await page.getByLabel('Required').nth(1).check();
  await until(async () => { const q = await qs(); return q[1]?.type === 'signature' && q[1].required; }, 10000);
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
});
let editLink;
await step('drawn: not signing is stopped; a drawing is sent as a picture', async () => {
  const v = await visitor('kim');
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel(/^Your name/).fill('Kim Park');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.locator('#q-' + form.questions[1].id).getByText('This question needs an answer').waitFor();
  const pad = v.getByRole('img', { name: 'Draw your signature' }).or(v.locator('canvas[aria-label="Draw your signature"]')).first();
  await axe(v, 'fill');
  const b = await pad.boundingBox();
  await v.mouse.move(b.x + 20, b.y + 90); await v.mouse.down();
  for (let i = 1; i <= 12; i++) await v.mouse.move(b.x + 20 + i * 18, b.y + 90 - Math.sin(i / 2) * 40, { steps: 2 });
  await v.mouse.up();
  await v.getByRole('button', { name: 'Clear', exact: true }).waitFor();
  await v.screenshot({ path: `${SP}/shots/form-sign-draw.png` });
  // Clear form starts again, the drawing too; then sign once more.
  await v.getByRole('button', { name: 'Clear form' }).click();
  await until(async () => (await v.getByRole('button', { name: 'Clear', exact: true }).count()) === 0 && (await v.getByLabel(/^Your name/).inputValue()) === '');
  if (await pad.evaluate((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((x, i) => i % 4 === 3 && x > 0))) throw new Error('the drawing stayed');
  await v.getByLabel(/^Your name/).fill('Kim Park');
  const b2 = await pad.boundingBox();
  await v.mouse.move(b2.x + 30, b2.y + 60); await v.mouse.down(); await v.mouse.move(b2.x + 200, b2.y + 80, { steps: 8 }); await v.mouse.up();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  if (!/^data:image\/png;base64,/.test(r[form.questions[1].id] || '')) throw new Error(JSON.stringify(r).slice(0, 200));
  editLink = await v.getByRole('link', { name: /change|edit/i }).first().getAttribute('href').catch(() => null);
});
await step('typed instead (by keyboard): the name becomes the signature', async () => {
  const v = await visitor('pat');
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel(/^Your name/).fill('Pat Lee');
  await v.getByRole('radio', { name: 'Type it instead' }).check();
  await v.getByLabel('Your name, as your signature').fill('Pat Lee');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const all = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses;
  if (all.length !== 2 || !all.every((x) => /^data:image\/png;base64,/.test(x.answers[form.questions[1].id]))) throw new Error('two signed');
});
await step('the server takes only a PNG picture', async () => {
  const v = await visitor('mallory');
  await v.goto(`${B}/f/${form.token}`);
  const r = await v.evaluate(async ([t, qid]) => (await fetch(`/api/public/forms/${t}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ answers: { name: 'M', [qid]: 'data:image/svg+xml;base64,PHN2Zz4=' } }) })).json(), [form.token, form.questions[1].id]);
  if (!/draw your signature again/.test(r.error || '')) throw new Error(JSON.stringify(r));
});
await step('responses: the signatures in the summary and each response; "Signed" in the CSV', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: /Responses/ }).click();
  const sum = page.getByRole('list', { name: 'Signatures for Sign here' });
  await until(async () => (await sum.getByRole('img').count()) === 2);
  if (!(await sum.getByRole('img').first().evaluate((i) => i.complete && i.naturalWidth > 20))) throw new Error('not a picture');
  await page.screenshot({ path: `${SP}/shots/form-sign-summary.png` });
  await axe(page, 'summary');
  await page.getByRole('tab', { name: 'Individual' }).click();
  await page.getByRole('img', { name: 'Signature for Sign here' }).waitFor();
  const csv = await page.evaluate(async (id) => (await fetch(`/api/forms/${id}/responses.csv`)).text(), form.id);
  if (!/Sign here/.test(csv) || (csv.match(/,Signed/g) || []).length !== 2 || /base64/.test(csv)) throw new Error(csv.slice(0, 300));
});
console.log(editLink ? `edit link: yes` : 'edit link: none shown');
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
