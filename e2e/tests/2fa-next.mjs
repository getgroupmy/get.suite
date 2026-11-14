import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
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
const wrap = () => page.locator('.compose-editor .tiptap .img-wrap');
const width = async () => Number((await wrap().getAttribute('data-width')) || 100);
// Shown share of the message width, measured on screen.
const shown = () => page.evaluate(() => {
  const w = document.querySelector('.compose-editor .tiptap .img-wrap');
  const ed = document.querySelector('.compose-editor .tiptap');
  const cs = getComputedStyle(ed);
  return Math.round((w.getBoundingClientRect().width / (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))) * 100);
});
const dragTo = async (pct) => {
  const h = await page.locator('.img-handle').boundingBox();
  const ed = await page.evaluate(() => {
    const e = document.querySelector('.compose-editor .tiptap');
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { left: r.left + parseFloat(cs.paddingLeft), width: e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  });
  const startX = h.x + h.width / 2, y = h.y + h.height / 2;
  const handleOffset = startX - (await wrap().boundingBox()).x - (await wrap().boundingBox()).width;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset - 20, y, { steps: 5 });
  await page.locator('.img-size-label').waitFor(); // live label while dragging
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset, y, { steps: 5 });
  await page.mouse.up();
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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});



const { codeAt, stepAt } = await import(`${ROOT}/server/src/totp.js`);
let key, recovery;
const signOut = async () => {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
};
const signInPassword = async () => {
  await page.getByLabel('Email address').fill('olivia@acme.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
};

await step('turn-on-in-settings', async () => {
  await page.goto(B + '/settings');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Two-step verification' }) });
  await card.getByText('Off.').waitFor();
  await card.getByRole('button', { name: 'Turn on' }).click();
  await card.getByLabel('Your password').fill('wrong-password');
  await card.getByRole('button', { name: 'Continue' }).click();
  await card.getByText('Your password is not right').waitFor();
  await card.getByLabel('Your password').fill('password123');
  await card.getByRole('button', { name: 'Continue' }).click();
  await card.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor();
  key = (await card.getByLabel('Setup key').innerText()).replace(/\s/g, '');
  if (!/^[A-Z2-7]{32}$/.test(key)) throw new Error('key ' + key);
  await card.getByLabel(/Enter the 6-digit code/).fill('000000');
  await card.getByRole('button', { name: 'Turn on' }).click();
  await card.getByText('That code is not right').waitFor();
  await page.screenshot({ path: `${SP}/shots/2fa-scan.png` });
  await card.getByLabel(/Enter the 6-digit code/).fill(codeAt(key, stepAt()));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const list = card.getByRole('list', { name: 'Recovery codes' });
  await list.waitFor();
  recovery = await list.locator('li').allInnerTexts();
  if (recovery.length !== 10) throw new Error('codes ' + recovery.length);
  await page.screenshot({ path: `${SP}/shots/2fa-codes.png` });
  await card.getByRole('button', { name: "I've saved them" }).click();
  await card.getByText('On.').waitFor();
});

await step('sign-in-needs-a-code', async () => {
  await signOut();
  await signInPassword();
  await page.getByRole('heading', { name: 'Two-step verification' }).waitFor();
  await page.getByLabel('Code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByText('That code is not right').waitFor();
  await page.screenshot({ path: `${SP}/shots/2fa-signin.png` });
  await page.getByLabel('Code').fill(codeAt(key, stepAt() + 1)); // the setup code's step is used up
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
});

await step('sign-in-with-a-recovery-code', async () => {
  await signOut();
  await signInPassword();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recovery[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.goto(B + '/settings');
  await page.getByText('9 of 10 recovery codes left').waitFor();
});

await step('admin-sees-2-step', async () => {
  await page.goto(B + '/admin');
  await page.locator('tr', { hasText: 'olivia@acme.com' }).getByText('2-step').waitFor();
  // Your own reset is done in Settings, not here.
  await page.getByRole('button', { name: 'Actions for Olivia Owner' }).click();
  if (await page.getByRole('menuitem', { name: 'Reset two-step verification' }).count()) throw new Error('reset offered for yourself');
  await page.keyboard.press('Escape');
});

await step('turn-off-with-password-and-code', async () => {
  await page.goto(B + '/settings');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Two-step verification' }) });
  await card.getByRole('button', { name: 'Turn off' }).click();
  await card.getByLabel('Your password').fill('password123');
  await card.getByLabel(/Code from your app/).fill(recovery[1]);
  await card.getByRole('button', { name: 'Turn off' }).click();
  await card.getByText('Off.').waitFor();
  await signOut();
  await signInPassword();
  await page.getByRole('link', { name: 'Mail' }).waitFor(); // password only again
});

const { createRequire } = await import('node:module');
const { ImapFlow } = createRequire(`${ROOT}/server/package.json`)('imapflow');
const imapOk = async (user, pass) => {
  const c = new ImapFlow({ host: '127.0.0.1', port: 993, secure: true, tls: { rejectUnauthorized: false }, auth: { user, pass }, logger: false });
  c.on('error', () => {});
  try { await c.connect(); await c.logout(); return true; } catch { return false; }
};
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 500)); } return false; };

await step('mail-app-password', async () => {
  await page.goto(B + '/settings');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Mail, calendar and contacts on your phone' }) });
  await card.getByText('Incoming mail (IMAP)').waitFor();
  if (!/993/.test(await card.innerText()) || !/olivia@acme\.com/.test(await card.innerText())) throw new Error('settings not shown');
  if (!(await imapOk('olivia@acme.com', 'password123'))) throw new Error('account password should work in mail apps at first');
  await card.getByRole('button', { name: 'Create mail-app password' }).click();
  await card.getByLabel('Your account password').fill('password123');
  await card.getByRole('button', { name: 'Create mail-app password' }).click();
  const shown = (await card.getByLabel('Mail-app password').innerText()).trim();
  if (!/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(shown)) throw new Error('password ' + shown);
  await page.screenshot({ path: `${SP}/shots/mail-app-password.png` });
  await card.getByRole('button', { name: 'Done' }).click();
  if (!(await until(() => imapOk('olivia@acme.com', shown)))) throw new Error('mail app could not sign in with the mail-app password');
  if (await imapOk('olivia@acme.com', 'password123')) throw new Error('account password still works in mail apps');
  await card.getByText(/A mail-app password is in use/).waitFor();
  await card.getByRole('button', { name: 'Remove' }).click();
  await card.getByLabel('Your account password').fill('password123');
  await card.getByRole('button', { name: 'Remove it' }).click();
  await card.getByText(/give mail apps their own password/).waitFor();
  if (!(await until(() => imapOk('olivia@acme.com', 'password123')))) throw new Error('account password not restored for mail apps');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
