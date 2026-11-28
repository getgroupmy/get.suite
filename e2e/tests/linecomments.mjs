// Comments on a line of a text file in Drive: started by clicking a line (or typing its number), shown as a marker beside
// the line, and following the line when lines are added above it.
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
  p.on('console', (m) => m.type() === 'error' && !/40[0-49]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
const SRC = ['# Sums', 'a = 1', 'b = 2', '', 'def total():', '    return a + b', '', 'print(total())'].join('\n') + '\n';
let f, first, second;
const dlg = () => page.getByRole('dialog', { name: 'report.py' });
await step('“Comment on a line”: click a line, write the comment; a marker shows on that line and the comment says “Line 3”', async () => {
  f = await upload(page, 'report.py', SRC);
  await page.goto(`${B}/drive`);
  await page.getByText('report.py').dblclick();
  const d = dlg();
  await d.getByLabel('Text of report.py').waitFor({ timeout: 15000 });
  if (await d.locator('.code-mark').count()) throw new Error('markers before any comment');
  await d.getByRole('button', { name: 'Comments' }).click();
  await d.getByRole('button', { name: 'Comment on a line' }).click();
  await d.getByRole('button', { name: 'Click a line…' }).waitFor();
  await d.locator('.code-line').nth(2).click();
  await d.getByLabel('New comment').fill('Why 2?');
  await d.getByRole('button', { name: 'Comment', exact: true }).click();
  await d.getByRole('button', { name: 'Comment on line 3', exact: true }).waitFor();
  await d.getByRole('button', { name: 'Line 3', exact: true }).waitFor();
  const list = (await api(page, 'GET', `/comments/${f.id}`)).body;
  first = list.find((c) => c.body === 'Why 2?');
  if (JSON.stringify(first.anchor) !== JSON.stringify({ line: 3, text: 'b = 2' })) throw new Error(JSON.stringify(first.anchor));
  // Picking is over: a click on another line starts nothing.
  await d.locator('.code-line').nth(0).click();
  if (await d.getByLabel('New comment').count()) throw new Error('a click on a line started a comment without being asked');
  await page.screenshot({ path: `${SP}/shots/line-comment.png` });
});
await step('by keyboard: “Comment on a line”, then the line’s number in “Go to line” and Enter', async () => {
  const d = dlg();
  await d.getByRole('button', { name: 'Comment on a line' }).click();
  await d.getByLabel('Go to line').fill('6');
  await d.getByLabel('Go to line').press('Enter');
  await d.getByLabel('New comment').fill('Name this better');
  await d.getByRole('button', { name: 'Comment', exact: true }).click();
  await d.getByRole('button', { name: 'Comment on line 6', exact: true }).waitFor();
  second = (await api(page, 'GET', `/comments/${f.id}`)).body.find((c) => c.body === 'Name this better');
  if (JSON.stringify(second.anchor) !== JSON.stringify({ line: 6, text: '    return a + b' })) throw new Error(JSON.stringify(second.anchor));
  await d.getByRole('button', { name: /Comments \(2\)/ }).waitFor();
});
await step('clicking a marker opens its comment; clicking the comment’s “Line 6” brings that line into view', async () => {
  const d = dlg();
  await d.getByRole('button', { name: 'Comment on line 3', exact: true }).click();
  await d.locator('.comment-thread.active').getByText('Why 2?').waitFor();
  if (!(await d.getByRole('button', { name: 'Comment on line 3', exact: true }).evaluate((el) => el.classList.contains('on')))) throw new Error('the marker of the open comment is not picked out');
  await d.getByRole('button', { name: 'Line 6', exact: true }).click();
  await until(() => d.locator('.code-line.target').evaluate((el) => el.textContent.includes('return a + b')).catch(() => false));
  await page.keyboard.press('Escape');
});
await step('lines added above: the comments follow their lines (5 and 8); a rewritten line keeps its number and says it changed', async () => {
  const v = (await api(page, 'GET', `/files/${f.id}/source-text`)).body.version;
  const r = await api(page, 'PUT', `/files/${f.id}/source-text`, { text: `#!/usr/bin/env python3\n# Written by Olivia\n${SRC}`, version: v });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  await page.goto(`${B}/drive?preview=${f.id}&comment=${second.id}`);
  const d = dlg();
  await d.getByRole('button', { name: 'Comment on line 8', exact: true }).waitFor({ timeout: 15000 });
  await d.getByRole('button', { name: 'Comment on line 5', exact: true }).waitFor();
  if (await d.locator('.code-mark').count() !== 2) throw new Error('not two markers');
  await d.getByRole('button', { name: 'Line 8', exact: true }).waitFor();
  await d.getByRole('button', { name: 'Line 5', exact: true }).waitFor();
  // The link was to the second comment: its marker is picked out and its line is the one gone to.
  await until(() => d.locator('.code-line.target').evaluate((el) => el.textContent.includes('return a + b')).catch(() => false));
  if (!(await d.getByRole('button', { name: 'Comment on line 8', exact: true }).evaluate((el) => el.classList.contains('on')))) throw new Error('linked comment not picked out');
  // What was kept is still the place it was made at: only the viewer follows the line.
  const kept = (await api(page, 'GET', `/comments/${f.id}`)).body.find((c) => c.id === first.id).anchor;
  if (kept.line !== 3) throw new Error(JSON.stringify(kept));
  await page.screenshot({ path: `${SP}/shots/line-comment-moved.png` });
  await page.keyboard.press('Escape');
  const v2 = (await api(page, 'GET', `/files/${f.id}/source-text`)).body.version;
  await api(page, 'PUT', `/files/${f.id}/source-text`, { text: `#!/usr/bin/env python3\n# Written by Olivia\n${SRC.replace('b = 2', 'b = 3')}`, version: v2 });
  await page.goto(`${B}/drive?preview=${f.id}&comment=${first.id}`);
  await dlg().getByRole('button', { name: 'Line 3 (since changed)', exact: true }).waitFor({ timeout: 15000 });
  await dlg().getByRole('button', { name: 'Comment on line 3', exact: true }).waitFor();
  await dlg().getByRole('button', { name: 'Comment on line 8', exact: true }).waitFor();
});
await step('a resolved comment’s marker goes; the view passes an accessibility check', async () => {
  const d = dlg();
  const r = await api(page, 'PATCH', `/comments/${f.id}/${first.id}`, { resolved: true });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  await until(async () => (await d.locator('.code-mark').count()) === 1);
  await page.evaluate(AXE);
  const v = await page.evaluate(async () => (await window.axe.run(document.querySelector('[role=dialog]'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  if (v.length) throw new Error(v.join(' | '));
  await page.keyboard.press('Escape');
});
await step('someone who may only view sees the markers and comments, but has no “Comment on a line”', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kim.id, role: 'viewer' }] });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Drive' }).first().waitFor();
  await k.goto(`${B}/drive?preview=${f.id}`);
  const d = k.getByRole('dialog', { name: 'report.py' });
  await d.getByRole('button', { name: 'Comment on line 8', exact: true }).click({ timeout: 15000 });
  await d.locator('.comment-thread.active').getByText('Name this better').waitFor();
  if (await d.getByRole('button', { name: 'Comment on a line' }).count()) throw new Error('a viewer is offered “Comment on a line”');
  await d.locator('.code-line').nth(0).click();
  if (await d.getByLabel('New comment').count()) throw new Error('a viewer started a comment');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
