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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', B1: 'Cost', A2: 'Taxi', B2: '12' } }] } })).body;
});
let side; // another tab, for the assistant's calls (as an assistant elsewhere would)
const mcp = (token, name, args) => side.evaluate(async ([t, n, a]) => {
  const r = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: n, arguments: a } }) });
  return (await r.json()).result;
}, [token, name, args]);
await step('the spreadsheet is open while an assistant adds rows: they appear live under the table, no reload, what was just typed kept', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude', scope: 'write', days: 30 })).body.token;
  if (!token) throw new Error('no token');
  side = await page.context().newPage();
  await side.goto(B);
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A2').getByText('Taxi').waitFor();
  await page.getByText('All changes saved').waitFor({ timeout: 10000 }).catch(() => {});
  // Something typed just now, and a mark that's lost if the page reloads.
  await cell('C2').dblclick(); await page.keyboard.type('paid'); await page.keyboard.press('Enter');
  await page.evaluate(() => { window.__stayed = true; });
  const r = await mcp(token, 'add_sheet_rows', { file: `file:${sheet.id}`, rows: [['Lunch', 18.5], ['Hotel', 240]] });
  if (r.isError || r.structuredContent.range !== 'A3:B4') throw new Error(JSON.stringify(r));
  await cell('A3').getByText('Lunch').waitFor({ timeout: 15000 });
  await cell('B4').getByText('240').waitFor();
  await cell('A2').getByText('Taxi').waitFor();
  if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded');
  await cell('C2').getByText('paid').waitFor();
  await page.screenshot({ path: `${SP}/shots/assistant-rows.png` });
});
await step('a document open while an assistant adds to it: the text appears live at the end, no reload', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Team log', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Monday: started' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  const body = page.locator('.ProseMirror');
  await body.getByText('Monday: started').waitFor();
  await page.evaluate(() => { window.__stayed = true; });
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 2', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'append_to_document', { file: `file:${doc.id}`, text: '## Tuesday\nShipped the beta' });
  if (r.isError) throw new Error(JSON.stringify(r));
  await body.getByRole('heading', { name: 'Tuesday' }).waitFor({ timeout: 15000 });
  await body.getByText('Shipped the beta').waitFor();
  if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded');
  await page.screenshot({ path: `${SP}/shots/assistant-append.png` });
});
await step('Admin → Company settings: untick what assistants may do; the assistant is refused, saying why', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const box = page.locator('fieldset.assistant-tools');
  await box.getByText('What AI assistants may do').waitFor();
  await box.getByRole('checkbox', { name: /Post in Chat/ }).uncheck();
  await page.getByText('Assistants can no longer post in chat').waitFor();
  await page.screenshot({ path: `${SP}/shots/assistant-tools.png` });
  await axe(page, 'assistant tools');
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 3', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'send_chat_message', { to: '#general', text: 'hello' });
  if (!r.isError || !/admins have turned off “Post in Chat”/.test(r.content[0].text)) throw new Error(JSON.stringify(r));
  await page.reload();
  if (await page.locator('fieldset.assistant-tools').getByRole('checkbox', { name: /Post in Chat/ }).isChecked()) throw new Error('not kept');
});
await step('Activity: the assistant’s change is listed as its own', async () => {
  const log = JSON.stringify((await api(page, 'GET', '/audit?action=assistant.action')).body);
  if (!/Claude/.test(log) || !/2 rows to file:/.test(log)) throw new Error(log.slice(0, 300));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
