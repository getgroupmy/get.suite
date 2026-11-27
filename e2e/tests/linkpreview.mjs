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
const upload = (name, text, parent) => page.evaluate(async ([n, t, p]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}${p ? `&parent=${p}` : ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text, parent]);
const visitor = await (async () => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`visitor: ${e.message}`)); return p; })();
let yamlLink, yaml;
await step('someone opening a link to a YAML file (no account) reads it as text with line numbers', async () => {
  yaml = await upload('shop.yaml', 'port: 8080\nname: shop\nitems:\n  - chair\n  - desk\n');
  yamlLink = (await api(page, 'POST', '/links', { file_id: yaml.id })).body;
  await visitor.goto(`${B}/s/${yamlLink.token}`);
  const pre = visitor.getByLabel('Text of shop.yaml');
  await pre.waitFor({ timeout: 15000 });
  if (!(await pre.innerText()).includes('- desk')) throw new Error(await pre.innerText());
  await visitor.getByText('5 lines').waitFor();
  await visitor.getByRole('link', { name: 'Download' }).waitFor();
  await visitor.screenshot({ path: `${SP}/shots/link-yaml.png` });
  await visitor.evaluate(AXE);
  const v = await visitor.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  if (v.length) throw new Error(v.join(' | '));
});
await step('with downloading turned off it is still shown, and Download isn’t offered (it used to be, and then failed)', async () => {
  const pr = await api(page, 'PATCH', `/files/${yaml.id}`, { no_download: true }); if (pr.status !== 200) throw new Error(JSON.stringify(pr));
  const info = await visitor.evaluate(async (t) => (await fetch(`/api/public/links/${t}`, { headers: { 'x-requested-with': 'nas-workspace' } })).json(), yamlLink.token); if (!info.no_download) throw new Error(JSON.stringify(info));
  await visitor.reload();
  await visitor.getByLabel('Text of shop.yaml').waitFor({ timeout: 15000 });
  await visitor.getByText('View only: downloading is turned off').waitFor();
  if (await visitor.getByRole('link', { name: 'Download' }).count()) throw new Error('Download offered');
}, visitor);
await step('a calendar file behind a password: after the password, its events (nothing to add them to without an account)', async () => {
  const ics = await upload('Open days.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:od-1@x', 'DTSTART:20261205T100000Z', 'DTEND:20261205T120000Z', 'SUMMARY:Open day', 'LOCATION:Main hall', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
  const l = (await api(page, 'POST', '/links', { file_id: ics.id, password: 'pass-1234' })).body;
  await visitor.goto(`${B}/s/${l.token}`);
  await visitor.getByLabel('Password').fill('pass-1234');
  await visitor.getByRole('button', { name: 'Open' }).click();
  const list = visitor.getByRole('region', { name: 'Events in this calendar file' });
  await list.getByText('Open day').waitFor({ timeout: 15000 });
  await list.getByText(/Main hall/).waitFor();
  await list.getByText('Download it to add these events to your calendar.').waitFor();
  if (await visitor.getByRole('button', { name: 'Add to Calendar' }).count()) throw new Error('Add offered without an account');
});
await step('inside a linked folder, a JavaScript file opens as text too', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Shop code' })).body;
  await upload('app.js', 'console.log("open");\n', folder.id);
  const l = (await api(page, 'POST', '/links', { file_id: folder.id })).body;
  await visitor.goto(`${B}/s/${l.token}`);
  await visitor.getByText('app.js').click({ timeout: 15000 });
  const pre = visitor.getByLabel('Text of app.js');
  await pre.waitFor({ timeout: 15000 });
  if (!(await pre.innerText()).includes('console.log("open");')) throw new Error(await pre.innerText());
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
