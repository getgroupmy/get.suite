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
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let token;
await step('Settings → API tokens shows how to use Workspace from an assistant, with this server’s address', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'API tokens' });
  await card.getByRole('button', { name: 'New token' }).click();
  await card.getByLabel('What it\'s for').fill('Claude');
  await card.getByLabel('Access').selectOption('write');
  await card.getByLabel('Your password').fill('password123');
  await card.getByRole('button', { name: 'Make token' }).click();
  token = (await card.getByLabel('New API token').innerText()).trim();
  await card.getByText('Use Workspace from an AI assistant (Claude, ChatGPT…)').click();
  await card.getByText(`${B}/mcp`, { exact: true }).waitFor();
  const cmd = await card.getByLabel('Command for Claude Code').innerText();
  if (!cmd.includes(`claude mcp add --transport http workspace ${B}/mcp`)) throw new Error(cmd);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/mcp-help.png` });
  await axe(page, 'mcp help');
});
await step('that token works at /mcp: the tools are listed, and a note made by the assistant shows in Notes', async () => {
  const rpc = async (method, params) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  if (init.result?.serverInfo?.name !== 'workspace') throw new Error(JSON.stringify(init));
  const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
  if (!tools.includes('search') || !tools.includes('draft_email')) throw new Error(tools.join());
  // The ready-made requests the server offers are the ones Settings names.
  const prompts = (await rpc('prompts/list')).result.prompts.map((p) => p.title);
  const named = await page.locator('.mcp-prompts em').allInnerTexts();
  for (const t of prompts) if (!named.includes(t)) throw new Error(`Settings doesn’t name “${t}”: ${named.join(', ')}`);
  const got = (await rpc('prompts/get', { name: 'plan_my_day', arguments: {} })).result;
  if (!/list_events/.test(got?.messages?.[0]?.content?.text || '')) throw new Error(JSON.stringify(got));
  const made = await rpc('tools/call', { name: 'create_note', arguments: { title: 'From Claude', items: ['Check the numbers'] } });
  if (made.result?.isError) throw new Error(JSON.stringify(made));
  await page.goto(`${B}/notes`);
  await page.getByRole('heading', { name: 'From Claude' }).waitFor();
  await page.goto(`${B}/settings`);
  await page.getByRole('region', { name: 'API tokens' }).getByText(/last used/).first().waitFor();
  // What it changed: listed under the token, and in the company's activity log.
  await page.getByRole('group', { name: /^Recent changes by / }).getByText('Add a note “From Claude”').waitFor();
  await page.goto(`${B}/admin?tab=activity`);
  await page.getByText('From Claude').first().waitFor();
});
await step('an assistant makes a form; it is in Forms, someone fills it in, and the assistant reads what they answered', async () => {
  const rpc = async (method, params) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const made = (await rpc('tools/call', { name: 'create_form', arguments: { title: 'Lunch poll', questions: [{ title: 'Where shall we go?', type: 'choice', options: ['Noodle bar', 'Pizzeria'], required: true }, { title: 'Any requests?', type: 'paragraph' }] } })).result;
  if (made.isError) throw new Error(JSON.stringify(made));
  const { link } = made.structuredContent;
  await page.goto(`${B}/forms`);
  await page.getByText('Lunch poll').first().waitFor();
  await page.goto(link.startsWith('/') ? `${B}${link}` : link); // relative without PUBLIC_URL, as here
  await page.getByRole('heading', { name: 'Lunch poll' }).waitFor();
  await page.getByRole('group', { name: 'Where shall we go? (required)' }).getByLabel('Pizzeria').check();
  await page.getByLabel('Any requests?').fill('Somewhere with a garden');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText(/response has been recorded/i).waitFor();
  const read = (await rpc('tools/call', { name: 'read_form_responses', arguments: { form: 'lunch poll' } })).result.structuredContent;
  if (read.responses !== 1 || read.summary[0].counts.Pizzeria !== 1 || !/Any requests\?: Somewhere with a garden/.test(read.text)) throw new Error(JSON.stringify(read));
  const listed = (await rpc('tools/call', { name: 'list_forms', arguments: {} })).result.structuredContent.forms;
  if (!listed.some((f) => f.title === 'Lunch poll' && f.responses === 1)) throw new Error(JSON.stringify(listed));
  await page.goto(`${B}/settings`);
  await page.getByRole('group', { name: /^Recent changes by / }).getByText('Make a form “Lunch poll”').waitFor();
});
await step('an assistant asks for a day off; it is in Calendar’s Time off', async () => {
  const rpc = async (method, params) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const d = new Date(); d.setDate(d.getDate() + 14); while (d.getDay() !== 3) d.setDate(d.getDate() + 1); // a Wednesday two weeks or more ahead
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = (await rpc('tools/call', { name: 'request_time_off', arguments: { first_day: day, kind: 'personal', note: 'Dentist' } })).result;
  if (r.isError || r.structuredContent.working_days !== 1) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  const mine = dlg.getByRole('region', { name: 'Your time off' });
  const shown = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); // as the list writes it: Wed, Dec 2
  await mine.getByText(new RegExp(`Personal: ${shown}`)).waitFor();
  await mine.getByText('(1 working day)').waitFor();
  const listed = (await rpc('tools/call', { name: 'list_time_off', arguments: {} })).result.structuredContent;
  if (!listed.requests.some((x) => x.first_day === day && x.status === r.structuredContent.status)) throw new Error(JSON.stringify(listed));
});
await step('an assistant thanks a colleague; it is on Home and in #general', async () => {
  const rpc = async (method, params) => (await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  await page.evaluate(async () => fetch('/api/users', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' }) }));
  const r = (await rpc('tools/call', { name: 'thank_colleague', arguments: { to: 'kim@acme.com', message: 'Thanks for the budget review', emoji: '🏆', channel: '#general' } })).result;
  if (r.isError || r.structuredContent.posted_in !== '#general') throw new Error(JSON.stringify(r));
  await page.goto(`${B}/home`);
  const home = page.getByRole('region', { name: 'Thanks' });
  await home.getByText('Thanks for the budget review').waitFor({ timeout: 10000 });
  await page.goto(`${B}/chat`);
  await page.getByRole('button', { name: /general/ }).first().click();
  await page.getByText('🏆 Thanks, Kim Park: Thanks for the budget review').first().waitFor({ timeout: 10000 });
  const recent = (await rpc('tools/call', { name: 'recent_thanks', arguments: { person: 'kim@acme.com' } })).result.structuredContent.thanks;
  if (recent[0]?.message !== 'Thanks for the budget review') throw new Error(JSON.stringify(recent));
});
await step('claude.ai-style sign-in: the consent page offers read only or read and add; the assistant shows in Settings and can be removed', async () => {
  const crypto = await import('node:crypto');
  const reg = await (await fetch(`${B}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let landed = null;
  const catcher = async (route) => { landed = route.request().url(); await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>back at claude</p>' }); };
  await page.route('https://claude.ai/**', catcher);
  await page.goto(`${B}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:read mcp:write' })}`);
  await page.getByRole('heading', { name: 'Connect Claude to Workspace' }).waitFor();
  await page.getByText('(at claude.ai)').waitFor();
  await page.screenshot({ path: `${SP}/shots/mcp-consent.png` });
  await axe(page, 'mcp consent');
  await page.getByRole('radio', { name: 'Read only' }).check();
  await page.getByLabel('Your Workspace password').fill('wrong-password');
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.getByRole('alert').getByText('Your password is not right').waitFor();
  await page.getByLabel('Your Workspace password').fill('password123');
  await page.getByRole('button', { name: 'Allow' }).click();
  await until(() => landed);
  const u = new URL(landed);
  if (u.searchParams.get('state') !== 'xyz' || !u.searchParams.get('code')) throw new Error(landed);
  await page.unroute('https://claude.ai/**', catcher);
  const tok = await (await fetch(`${B}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: reg.client_id, code_verifier: verifier }) })).json();
  if (tok.scope !== 'mcp:read') throw new Error(JSON.stringify(tok));
  await page.goto(`${B}/settings`);
  const apps = page.getByRole('region', { name: 'Apps you sign in to' });
  await apps.getByText(/AI assistant, read only/).waitFor();
  await apps.getByRole('button', { name: 'Remove Claude' }).click();
  await page.getByText('Claude removed').waitFor();
  const after = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  if (after.status !== 401) throw new Error(`still works: ${after.status}`);
});
await step('an assistant signed in with read and add: what it changes is in the activity log under its own name', async () => {
  const crypto = await import('node:crypto');
  const reg = await (await fetch(`${B}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let landed = null;
  const catcher = async (route) => { landed = route.request().url(); await route.fulfill({ status: 200, contentType: 'text/html', body: 'back' }); };
  await page.route('https://chatgpt.com/**', catcher);
  await page.goto(`${B}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:read mcp:write' })}`);
  await page.getByRole('radio', { name: /^Read, and add/ }).check();
  await page.getByLabel('Your Workspace password').fill('password123');
  await page.getByRole('button', { name: 'Allow' }).click();
  await until(() => landed);
  await page.unroute('https://chatgpt.com/**', catcher);
  await page.goto(`${B}/settings`);
  const code = new URL(landed).searchParams.get('code');
  const tok = await (await fetch(`${B}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', client_id: reg.client_id, code_verifier: verifier }) })).json();
  const r = await (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Renew the domain' } } }) })).json();
  if (r.result?.isError) throw new Error(JSON.stringify(r));
  const log = await api(page, 'GET', '/audit?action=assistant.action');
  if (!/"assistant":"ChatGPT"/.test(JSON.stringify(log.body)) || !/Renew the domain/.test(JSON.stringify(log.body))) throw new Error(JSON.stringify(log.body).slice(0, 400));
  await page.goto(`${B}/settings`); // back from the stand-in for chatgpt.com
});
await step('on a phone the command wraps and nothing slides sideways', async () => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.reload();
  const card = page.getByRole('region', { name: 'API tokens' });
  await card.getByText('Use Workspace from an AI assistant (Claude, ChatGPT…)').click();
  await card.getByLabel('Command for Claude Code').waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('wider than the phone');
  if (await card.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) throw new Error('card overflows');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/mcp-help-phone.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
