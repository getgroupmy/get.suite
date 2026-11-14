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
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 30000);
  const start = Date.now() + 36e5;
  await api(page, 'POST', '/events', { title: 'Board meeting', start, end: start + 36e5 });
});
await step('turn the morning summary on and choose the hour', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Morning summary' });
  await card.getByLabel('Email me a summary of my day').check();
  await page.getByText("You'll get a summary each day at 7:00").waitFor();
  await card.getByLabel('Summary time').selectOption('8');
  await page.getByText("You'll get a summary each day at 8:00").waitFor();
  const d = (await api(page, 'GET', '/users/me/digest')).body;
  if (d.hour !== 8 || !d.tz) throw new Error(JSON.stringify(d));
});
await step('"Send me one now" shows it and puts it in the inbox', async () => {
  const card = page.getByRole('region', { name: 'Morning summary' });
  await until(async () => { await card.getByRole('button', { name: 'Send me one now' }).click(); return (await card.getByLabel('Summary preview').count()) > 0; }, 30000);
  await card.getByLabel('Summary preview').getByText(/Board meeting/).waitFor();
  await until(async () => (await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages?.some((m) => /^Your day: /.test(m.subject)), 30000);
});
await step('the summary lists what a colleague changed in Drive', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kimd', domain: 'acme.com', name: 'Kim Dee', password: 'password123' })).body;
  const ctx = await browser.newContext(); const kp = await ctx.newPage();
  await kp.goto(B);
  await kp.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kimd@acme.com', password: 'password123' }) }));
  const f = (await api(kp, 'POST', '/files/new', { kind: 'doc', name: 'Quarterly plan' })).body;
  const me = (await api(page, 'GET', '/auth/me')).body;
  await api(kp, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: me.id ?? me.user?.id, role: 'editor' }] });
  await api(kp, 'PATCH', `/files/${f.id}`, { name: 'Quarterly plan v2' });
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Morning summary' });
  await card.getByRole('button', { name: 'Send me one now' }).click();
  await card.getByLabel('Summary preview').getByText(/Changed in Drive since yesterday/).waitFor();
  await card.getByLabel('Summary preview').getByText(/“Quarterly plan v2”: shared by Kim; renamed by Kim; made by Kim|“Quarterly plan v2”: renamed by Kim; shared by Kim; made by Kim/).waitFor();
  await api(kp, 'POST', `/comments/${f.id}`, { body: 'Please review the totals @olivia@acme.com', anchor: { quote: 'q' } });
  await card.getByRole('button', { name: 'Send me one now' }).click();
  await card.getByLabel('Summary preview').getByText(/Comments for you \(1\):/).waitFor();
  await card.getByLabel('Summary preview').getByText(/“Quarterly plan v2”: Kim Dee: Please review the totals/).waitFor();
  const text = await card.getByLabel('Summary preview').innerText();
  if (!text.includes(`Open Workspace: ${B}/home`)) throw new Error('no link to Workspace');
  const link = text.match(new RegExp(`${B.replace(/[.:/]/g, '\\$&')}/docs/[\\w-]+\\?comment=[\\w-]+`))?.[0];
  if (!link) throw new Error('no link to the comment');
  await page.goto(link);
  await page.locator('.comment-thread.active', { hasText: 'Please review the totals' }).waitFor();
  if (!kim.id) throw new Error('no Kim');
  await ctx.close();
});
await step('untick parts: they leave the summary, kept for next time; at least one stays', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Morning summary' });
  await card.getByLabel("Today's events").uncheck();
  await card.getByLabel('What others changed in Drive').uncheck();
  await until(async () => (await api(page, 'GET', '/users/me/digest')).body.off?.length === 2);
  await card.getByRole('button', { name: 'Send me one now' }).click();
  await card.getByLabel('Summary preview').getByText(/Comments for you/).waitFor();
  const text = await card.getByLabel('Summary preview').innerText();
  if (/Board meeting|Changed in Drive/.test(text)) throw new Error('unticked parts still there');
  await page.screenshot({ path: `${SP}/shots/digest-parts.png` });
  await page.reload();
  if (await card.getByLabel("Today's events").isChecked()) throw new Error('not kept');
  for (const l of ['Tasks due or overdue', 'Contacts’ birthdays and dates', 'Unread chat messages', 'Comments for you']) await card.getByLabel(l).uncheck();
  await page.getByText('Keep at least one part in the summary').waitFor();
  await page.reload();
  if (!(await card.getByLabel('Comments for you').isChecked())) throw new Error('the last one was taken off');
});
await step('weekdays only, kept for next time', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Morning summary' });
  await card.getByLabel('Weekdays only (not on Saturday or Sunday)').check();
  await page.getByText('Monday to Friday only').waitFor();
  await until(async () => (await api(page, 'GET', '/users/me/digest')).body.weekdays === true);
  await page.reload();
  if (!(await card.getByLabel('Weekdays only (not on Saturday or Sunday)').isChecked())) throw new Error('not kept');
  await card.getByText("Not on days you're on approved time off.").waitFor();
  await card.getByLabel("Only when there's something in it").check();
  await page.getByText('Only on days with something in it').waitFor();
  await until(async () => (await api(page, 'GET', '/users/me/digest')).body.skip_empty === true);
  await page.reload();
  if (!(await card.getByLabel("Only when there's something in it").isChecked())) throw new Error('skip_empty not kept');
});
await step('a contact’s birthday today is in it', async () => {
  const today = new Date().toISOString().slice(5, 10);
  await api(page, 'POST', '/contacts', { name: 'Bea Birthday', birthday: `1985-${today}` });
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Morning summary' });
  await card.getByLabel('Contacts’ birthdays and dates').check();
  await until(async () => !(await api(page, 'GET', '/users/me/digest')).body.off.includes('dates'));
  await card.getByRole('button', { name: 'Send me one now' }).click();
  await card.getByLabel('Summary preview').getByText(/🎂 Bea Birthday’s birthday/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
