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
const tag = `Old${Date.now()}`;
const mbox = [
  `From friend@example.org Mon Jan  5 10:00:00 2015\nFrom: Old Friend <friend@example.org>\nTo: olivia@acme.com\nSubject: ${tag} photos\nMessage-ID: <${tag}-1@example.org>\nDate: Mon, 05 Jan 2015 10:00:00 +0000\n\nThe holiday photos.\n\n`,
  `From friend@example.org Tue Jan  6 10:00:00 2015\nFrom: Old Friend <friend@example.org>\nTo: olivia@acme.com\nSubject: ${tag} dinner\nMessage-ID: <${tag}-2@example.org>\nDate: Tue, 06 Jan 2015 10:00:00 +0000\n\n>From the menu: soup.\n\n`,
].join('');
(await import('node:fs')).writeFileSync(`${SP}/Old account.mbox`, mbox);
await step('Import mail from an .mbox file: its messages arrive in a folder named after it', async () => {
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 60000);
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Import mail' }).click();
  const dlg = page.getByRole('dialog', { name: 'Import mail' });
  await dlg.getByText('Or from an .mbox file').waitFor();
  await dlg.getByLabel('An .mbox file').setInputFiles(`${SP}/Old account.mbox`);
  await dlg.getByText(/Done: 2 messages copied from Old account\.mbox/).waitFor({ timeout: 60000 });
  await page.screenshot({ path: `${SP}/shots/mbox-import.png` });
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: /^Old account/ }).first().click();
  await page.getByText(`${tag} photos`).waitFor();
  await page.getByText(`${tag} dinner`).click();
  await page.getByText('From the menu: soup.').waitFor();
});
await step('an .mbox written by another program (Python\'s mailbox module): a "From " line and accents in a message come through', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['-I', '-c', `
import sys, mailbox, time
box = mailbox.mbox(sys.argv[1])
for n, body in enumerate(['From here on, prices go up.\\nThanks, Zoë', 'Second one, no last line break']):
    m = mailbox.mboxMessage(('From: Zoë <zoe@example.org>\\nTo: olivia@acme.com\\nSubject: ${tag} python %d\\nMessage-ID: <${tag}-py%d@example.org>\\nDate: Wed, 07 Jan 2015 10:00:00 +0000\\nContent-Type: text/plain; charset=utf-8\\nContent-Transfer-Encoding: 8bit\\n\\n' % (n, n) + body).encode())
    m.set_from('zoe@example.org', time.gmtime(1420624800))
    box.add(m)
box.flush()
`, `${SP}/From Python.mbox`]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  if (!/^>From here on/m.test((await import('node:fs')).readFileSync(`${SP}/From Python.mbox`, 'latin1'))) throw new Error('Python didn\'t escape the From line');
  await page.getByRole('button', { name: 'Import mail' }).click();
  const dlg = page.getByRole('dialog', { name: 'Import mail' });
  await dlg.getByLabel('An .mbox file').setInputFiles(`${SP}/From Python.mbox`);
  await dlg.getByText(/Done: 2 messages copied from From Python\.mbox/).waitFor({ timeout: 60000 });
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: /^From Python/ }).first().click();
  await page.getByText(`${tag} python 1`).waitFor();
  await page.getByText(`${tag} python 0`).click();
  await page.locator('.mail-reader').getByText('From here on, prices go up.').waitFor();
  await page.locator('.mail-reader').getByText('Thanks, Zoë').waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
