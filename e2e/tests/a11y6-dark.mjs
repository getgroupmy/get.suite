import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
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
const all = [];
const scan = async (name, p = page) => {
  await p.waitForTimeout(600);
  await p.evaluate(AXE);
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, where: v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | '), html: v.nodes[0]?.html.slice(0, 200) })));
  for (const v of res) all.push({ page: name, ...v });
  if (res.length) throw new Error(res.map((v) => `${v.id}(${v.n})`).join(', '));
};
// Screens added lately: list styles in Docs, the poll dialog and its new options, reminders of your own,
// "Also send to" under a thread, and a slide's list box with its List picker.
const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
await step('Docs: in a numbered list, the Numbering style picker; in a bulleted one, Bullet style', async () => {
  const items = (ts) => ts.map((t) => ({ type: 'listItem', content: [P(t)] }));
  const id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Lists', content: { type: 'doc', content: [{ type: 'orderedList', attrs: { listStyle: 'lower-roman' }, content: items(['One', 'Two']) }, { type: 'bulletList', attrs: { bullet: 'check' }, content: items(['Milk']) }] } })).body.id;
  await page.goto(`${B}/docs/${id}`);
  await page.getByText('Two').click();
  await page.getByLabel('Numbering style').waitFor();
  await scan('docs numbering style');
  await page.getByText('Milk').click();
  await page.getByLabel('Bullet style').waitFor();
  await scan('docs bullet style');
});
let ch;
await step('Chat: the poll dialog with Anonymous, Others can add options and Closes', async () => {
  ch = (await api(page, 'POST', '/chat/channels', { name: 'team' })).body.id;
  await page.goto(`${B}/chat/${ch}`);
  await page.getByRole('button', { name: 'Create a poll' }).click();
  await page.getByRole('dialog', { name: 'Create a poll' }).getByLabel('Closes').waitFor();
  await scan('chat poll dialog');
  await page.keyboard.press('Escape');
});
await step('Chat: a poll that is anonymous, closes later and takes others’ options; reminders of your own', async () => {
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { poll: { question: 'Offsite?', options: ['Lisbon', 'Porto'], anonymous: true, add_options: true, closes_at: Date.now() + 36e5 } });
  await api(page, 'POST', `/chat/channels/${ch}/reminders`, { text: 'book the room', at: Date.now() + 36e5, repeat: { rule: { freq: 'weekly', byday: [5] }, tz: 'UTC' } });
  await page.reload();
  await page.getByLabel('Add an option to: Offsite?').waitFor();
  await scan('chat poll anonymous add options');
  await page.locator('aside.subnav').getByRole('button', { name: /Reminders/ }).click();
  await page.getByRole('list', { name: 'Reminders' }).waitFor();
  await scan('chat reminders of your own');
});
await step('Chat: a thread with “Also send to #team”', async () => {
  const m = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Lunch?' })).body;
  await page.goto(`${B}/chat/${ch}?msg=${m.id}&thread=${m.id}`);
  await page.getByLabel('Also send to #team').waitFor();
  await scan('chat thread also send');
});
await step('Slides: a list box chosen, with its List picker', async () => {
  const id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Deck', content: { theme: 'light', slides: [{ id: 's', items: [{ id: 't', type: 'text', role: 'body', text: 'Plan\n\tCosts\nDo', list: 'lower-roman', x: 10, y: 10, w: 80, h: 40, size: 24 }] }] } })).body.id;
  await page.goto(`${B}/slides/${id}`);
  await page.locator('.slide-stage [aria-label^="Text: Plan"]').click();
  await page.getByLabel('List', { exact: true }).waitFor();
  await scan('slides list box');
});
for (const v of all) console.log("V", v.page, "|", v.where, "|", v.html);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
