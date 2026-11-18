import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
const editor = (p) => p.getByRole('textbox', { name: 'Message' });

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
});
await step('out of office with the email auto-reply turned on, from Calendar', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Out of office…/ }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Description').or(d.getByRole('textbox', { name: /Description|Message/ })).first().fill('Back on Monday. For urgent things, write to sam@acme.com.');
  await d.getByLabel(/Also turn on my email auto-reply/).check();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/Email auto-reply on from/).waitFor();
  await until(async () => (await api(page, 'GET', '/mail/vacation')).body.enabled);
  const v = (await api(page, 'GET', '/mail/vacation')).body;
  if (v.body !== 'Back on Monday. For urgent things, write to sam@acme.com.' || !v.start_date || !v.end_date) throw new Error(JSON.stringify(v));
  await page.goto(`${B}/mail`);
  await page.getByText(/Vacation reply is on|auto-reply/i).first().waitFor();
});
await step('an AI assistant turns the auto-reply off and on again (MCP); Mail shows it', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude', scope: 'write', days: 30 })).body.token;
  const mcp = async (name, args) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const off = await mcp('set_out_of_office', { on: false });
  if (off.isError || off.structuredContent.on) throw new Error(JSON.stringify(off));
  await page.goto(`${B}/mail`);
  await page.getByText('Vacation reply', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  if (await page.getByText(/Your vacation reply is on/).count()) throw new Error('still shown as on');
  const on = await mcp('set_out_of_office', { on: true, message: 'Away at the trade fair this week.' });
  if (on.isError || !on.structuredContent.replying_now) throw new Error(JSON.stringify(on));
  await page.reload();
  await page.getByText(/Your vacation reply is on/).waitFor();
  if ((await api(page, 'GET', '/mail/vacation')).body.body !== 'Away at the trade fair this week.') throw new Error('wording not saved');
});
await step('an assistant drafts an email with a document attached as PDF and a file as it is; the draft opens with both', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude mail', scope: 'write', days: 30 })).body.token;
  const mcp = async (name, args) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Q3 report', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sales grew.' }] }] } })).body;
  const up = await page.evaluate(async () => (await fetch('/api/files/upload?name=notes.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'Some notes' })).json());
  const folder = (await api(page, 'POST', '/files/folder', { name: 'A folder' })).body;
  const bad = await mcp('draft_email', { to: 'kim@acme.com', subject: 'x', body: 'x', attach: [`file:${folder.id}`] });
  if (!bad.isError || !/is a folder/.test(bad.content[0].text)) throw new Error(JSON.stringify(bad));
  const r = await mcp('draft_email', { to: 'kim@acme.com', subject: 'Q3 report', body: 'Here it is.', attach: [`file:${doc.id}`, { file: `file:${up.id}` }, { file: `file:${doc.id}`, as: 'docx' }] });
  if (r.isError || r.structuredContent.attached.join('|') !== 'Q3 report.pdf|notes.txt|Q3 report.docx') throw new Error(JSON.stringify(r));
  await page.goto(`${B}/mail/Drafts`);
  await page.locator('.mail-list').getByText('Q3 report', { exact: true }).first().click();
  const d = page.getByRole('dialog').filter({ hasText: 'Here it is.' }).first();
  for (const name of ['Q3 report.pdf', 'notes.txt', 'Q3 report.docx']) await d.getByText(name).first().waitFor({ timeout: 15000 });
});
await step('an assistant drafts an email to everyone a document is shared with; the draft has them all', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude people', scope: 'write', days: 30 })).body.token;
  const mcp = async (name, args) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const ids = [];
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Lane']]) ids.push((await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id);
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Offsite plan' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: ids.map((user_id) => ({ user_id, role: 'commenter' })) });
  const r = await mcp('draft_email', { to_people_with_access: `file:${doc.id}`, to: 'kim@acme.com', subject: 'Offsite plan comments', body: 'Please add your comments by Friday.' });
  if (r.isError || r.structuredContent.to !== 'kim@acme.com, Lee Lane <lee@acme.com>') throw new Error(JSON.stringify(r)); // (Kim already there: not twice)
  await page.goto(`${B}/mail/Drafts`);
  await page.locator('.mail-list').getByText('Offsite plan comments', { exact: true }).first().click();
  const d = page.getByRole('dialog').filter({ hasText: 'Please add your comments by Friday.' }).first();
  await d.waitFor();
  const to = await d.getByLabel('To', { exact: true }).inputValue();
  if (!/kim@acme\.com/.test(to) || !/lee@acme\.com/.test(to)) throw new Error(to);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
