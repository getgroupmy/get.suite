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
  if (!(await until(() => imapOk('olivia@acme.com', shown)))) throw new Error('mail app could not sign in with the mail-app password as shown');
  if (await imapOk('olivia@acme.com', 'password123')) throw new Error('account password still works in mail apps');
  await card.getByText(/A mail-app password is in use/).waitFor();
  await card.getByRole('button', { name: 'Remove' }).click();
  await card.getByLabel('Your account password').fill('password123');
  await card.getByRole('button', { name: 'Remove it' }).click();
  await card.getByText(/give mail apps their own password/).waitFor();
  if (!(await until(() => imapOk('olivia@acme.com', 'password123')))) throw new Error('account password not restored for mail apps');
});

await step('signed-in-devices', async () => {
  // A second device (an iPhone) signs in as the same person.
  const ctx2 = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const phone = await ctx2.newPage();
  await phone.goto(B);
  await phone.getByLabel('Email address').fill('olivia@acme.com');
  await phone.getByLabel('Password').fill('password123');
  await phone.getByRole('button', { name: 'Sign in' }).click();
  await phone.getByRole('button', { name: 'Account' }).waitFor();
  await page.goto(B + '/settings');
  const list = page.getByRole('list', { name: 'Signed-in devices' });
  const iphone = list.locator('li', { hasText: 'Safari on iPhone' });
  await iphone.waitFor();
  if (!(await list.locator('li', { hasText: 'This device' }).count())) throw new Error('current device not marked');
  await page.locator('section', { has: page.getByRole('heading', { name: 'Signed-in devices' }) }).screenshot({ path: `${SP}/shots/devices.png` });
  await iphone.getByRole('button', { name: 'Sign out Safari on iPhone' }).click();
  await page.getByText('Signed out Safari on iPhone').waitFor();
  await iphone.waitFor({ state: 'detached' });
  // The phone is signed out at its next request.
  await phone.reload();
  await phone.getByRole('heading', { name: 'Sign in' }).waitFor();
  await ctx2.close();
});

await step('company-requires-two-step', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const box = page.getByLabel('Require two-step verification for everyone in this company');
  await box.check();
  await page.locator('.toast', { hasText: 'Turn on two-step verification for your own account first' }).waitFor(); // refused: Olivia doesn't have it yet
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]:checked'), null, { timeout: 3000 }).catch(() => {});
  if (await box.isChecked()) throw new Error('should have been refused');
  // Olivia sets it up for herself, then requires it.
  const r = await api(page, 'POST', '/auth/2fa/setup', { password: 'password123' });
  const done = await api(page, 'POST', '/auth/2fa/confirm', { code: codeAt(r.body.secret, stepAt()) });
  if (done.status !== 200) throw new Error(JSON.stringify(done));
  const sam = await api(page, 'POST', '/users', { local: 'sam', domain: 'acme.com', name: 'Sam New', password: 'password123' });
  if (sam.status !== 201) throw new Error(JSON.stringify(sam));
  await page.reload();
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  await page.getByLabel('Require two-step verification for everyone in this company').check();
  await page.getByText(/1 person still has to set it up/).waitFor();
  await page.locator('.card', { hasText: 'Sign-in security' }).screenshot({ path: `${SP}/shots/require-2fa.png` });

  // Sam signs in: only the setup page until it's done.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx.newPage();
  await p2.goto(B);
  await p2.getByLabel('Email address').fill('sam@acme.com');
  await p2.getByLabel('Password').fill('password123');
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await p2.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
  if (await p2.getByRole('link', { name: 'Mail' }).count()) throw new Error('apps reachable before setup');
  await p2.screenshot({ path: `${SP}/shots/required-setup.png` });
  await p2.getByRole('button', { name: 'Turn on' }).click();
  await p2.getByLabel('Your password').fill('password123');
  await p2.getByRole('button', { name: 'Continue' }).click();
  const key2 = (await p2.getByLabel('Setup key').innerText()).replace(/\s/g, '');
  await p2.getByLabel(/Enter the 6-digit code/).fill(codeAt(key2, stepAt()));
  await p2.getByRole('button', { name: 'Turn on' }).click();
  await p2.getByRole('button', { name: "I've saved them" }).click();
  await p2.getByRole('link', { name: 'Mail' }).waitFor(); // in
  await ctx.close();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
