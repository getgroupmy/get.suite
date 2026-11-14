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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const list = () => page.locator('.mail-list');
const inFolder = async (f) => ((await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(f)}`)).body.messages || []);
const picker = (name) => page.getByRole('dialog', { name });
await step('V on an open message: type to find the folder, Enter moves it there', async () => {
  for (const s of ['Acme order 77', 'Acme order 78', 'Board pack']) if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: s, text: 'x' })).status !== 200) throw new Error('send');
  for (const n of ['Clients/Acme', 'Clients/Globex', 'Board']) if ((await api(page, 'POST', '/mail/folders', { name: n })).status >= 300) throw new Error('folder');
  if ((await api(page, 'POST', '/mail/labels', { name: 'Urgent', color: '#d93025' })).status >= 300) throw new Error('label');
  await until(async () => (await inFolder('INBOX')).length >= 3, 40000);
  await page.reload();
  await list().getByText('Acme order 77', { exact: true }).click({ timeout: 30000 });
  await page.locator('.reader-actions').waitFor();
  await page.keyboard.press('v');
  const d = picker('Move to');
  await d.getByLabel('Find').fill('acm');
  await d.getByRole('option', { selected: true }).getByText('Clients / Acme', { exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/movepicker.png` });
  // The picker passes the accessibility checks (options are the rows themselves, no buttons inside), and with nothing found.
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  const axe = async () => { await page.addScriptTag({ content: AXE }); const r = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)); if (r.length) throw new Error(r.join(' | ')); };
  await axe();
  await d.getByLabel('Find').fill('zzz');
  await d.getByText('Nothing matches “zzz”').waitFor();
  await axe();
  await d.getByLabel('Find').fill('acm');
  await d.getByRole('option', { selected: true }).getByText('Clients / Acme', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await page.getByText('Moved to Clients / Acme').waitFor();
  await until(async () => (await inFolder('Clients/Acme')).some((m) => m.subject === 'Acme order 77'));
  if (/\/mail\/INBOX\/\d+/.test(page.url())) throw new Error('still showing the moved message');
});
await step('V with ticked messages; arrow keys choose', async () => {
  await page.getByRole('checkbox', { name: 'Select Acme order 78' }).check();
  await page.getByRole('checkbox', { name: 'Select Board pack' }).check();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('v');
  const d = picker('Move 2 messages to');
  await d.getByLabel('Find').fill('b');
  await d.getByRole('option', { selected: true }).getByText('Board', { exact: true }).waitFor(); // starts with "b" comes first
  await page.keyboard.press('ArrowDown');
  await d.getByRole('option', { selected: true }).getByText('Clients / Globex', { exact: true }).waitFor();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.getByText('Moved 2 messages to Board').waitFor();
  await until(async () => (await inFolder('Board')).length === 2);
});
await step('L puts a label on; Escape closes the picker without doing anything', async () => {
  await page.goto(`${B}/mail/Board`);
  await list().getByText('Board pack', { exact: true }).click({ timeout: 20000 });
  await page.locator('.reader-actions').waitFor();
  await page.keyboard.press('l');
  await picker('Label as').getByLabel('Find').fill('urg');
  await picker('Label as').getByRole('option', { name: /Urgent/ }).click(); // a click on the row picks it
  await page.getByText('Labelled Urgent').waitFor();
  await until(async () => (await inFolder('Board')).find((m) => m.subject === 'Board pack')?.labels?.length === 1);
  await page.keyboard.press('v');
  await picker('Move to').waitFor();
  await page.keyboard.press('Escape');
  await picker('Move to').waitFor({ state: 'detached' });
  if ((await inFolder('Board')).length !== 2) throw new Error('moved anyway');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
