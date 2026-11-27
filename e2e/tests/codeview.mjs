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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const upload = (p, name, text) => p.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
let json;
await step('a JSON file in Drive shows as its text, laid out, with line numbers; “Show as written” gives it as it is', async () => {
  json = await upload(page, 'prices.json', '{"chair":40,"desk":{"oak":120,"pine":80}}');
  await page.goto(`${B}/drive`);
  await page.getByText('prices.json').dblclick();
  const pre = page.getByRole('dialog', { name: 'prices.json' }).getByLabel('Text of prices.json');
  await pre.waitFor({ timeout: 15000 });
  const t = await pre.innerText();
  if (!t.includes('"oak": 120') || !/^\s*1\s*\{/.test(t)) throw new Error(t);
  await page.getByText('7 lines').waitFor();
  await page.screenshot({ path: `${SP}/shots/code-json.png` });
  await page.getByRole('button', { name: 'Show as written' }).click();
  await page.getByText('1 line', { exact: true }).waitFor();
  if (!(await pre.innerText()).includes('{"chair":40,"desk":{"oak":120,"pine":80}}')) throw new Error('not as written');
  await page.getByRole('button', { name: 'Lay out' }).waitFor();
});
await step('the text view passes an accessibility check (it can be scrolled with the keyboard)', async () => {
  await page.evaluate(AXE);
  const v = await page.evaluate(async () => (await window.axe.run(document.querySelector('[role=dialog]'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  if (v.length) throw new Error(v.join(' | '));
  await page.keyboard.press('Escape');
});
await step('a Python file someone may only view (downloading off) still shows as text', async () => {
  const py = await upload(page, 'report.py', 'def total(xs):\n    return sum(xs)\n');
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await api(page, 'PUT', `/files/${py.id}/shares`, { shares: [{ user_id: kim.id, role: 'viewer' }] });
  await api(page, 'PATCH', `/files/${py.id}`, { no_download: true });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Drive' }).first().waitFor();
  await k.goto(`${B}/drive?preview=${py.id}`);
  const pre = k.getByLabel('Text of report.py');
  await pre.waitFor({ timeout: 15000 });
  if (!(await pre.innerText()).includes('return sum(xs)')) throw new Error(await pre.innerText());
  // Kim sends Olivia a SQL file in Chat: it opens in the viewer as text too.
  const dm = (await api(k, 'POST', '/chat/dm', { user_id: (await api(page, 'GET', '/auth/me')).body.user.id })).body.id;
  const sql = await upload(k, 'monthly.sql', 'SELECT name, SUM(total)\nFROM orders\nGROUP BY name;\n');
  await api(k, 'POST', `/chat/channels/${dm}/messages`, { body: 'The query', files: [sql.id] });
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('link', { name: /monthly\.sql/ }).click({ timeout: 15000 });
  const t = page.getByRole('dialog', { name: 'monthly.sql' }).getByLabel('Text of monthly.sql');
  await t.waitFor({ timeout: 15000 });
  if (!(await t.innerText()).includes('GROUP BY name;')) throw new Error(await t.innerText());
  await page.getByText('3 lines').waitFor();
});
await step('it fits a phone screen without the page scrolling sideways', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 392) throw new Error(`page is ${w}px wide`);
  await page.setViewportSize({ width: 1280, height: 900 });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
