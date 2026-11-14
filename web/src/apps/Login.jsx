import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import BrandMark from '../components/BrandMark.jsx';
import { applyAccent } from '../theme.js';
import { useAuth } from '../App.jsx';
import { requestOptions, credentialJson, passkeysSupported, passkeyError } from '../passkey.js';

export default function Login({ needsSetup, canReset = false }) {
  const { setUser } = useAuth();
  const [form, setForm] = useState({ username: '', password: '', confirm: '', org_name: '', domain: '', name: '', local: '' });
  const [error, setError] = useState(() => { try { const m = sessionStorage.getItem('nw-signed-out'); sessionStorage.removeItem('nw-signed-out'); return m || ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  // The company whose address this is (workspace.acme.com → Acme): its name, logo and colour.
  const [brand, setBrand] = useState(null);
  useEffect(() => { if (!needsSetup) get('/public/brand').then((r) => { setBrand(r.brand); applyAccent(r.brand?.accent); }).catch(() => {}); return () => applyAccent(null); }, [needsSetup]);
  const mark = <div className="brand big"><BrandMark name={brand?.name || 'Workspace'} logo={brand?.logo} /><span className="brand-text">{brand?.name || 'Workspace'}</span></div>;
  // Two-step verification: after the password, a code from the authenticator app (or a recovery code).
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [forgot, setForgot] = useState(null); // null, or { sent: message } once asked

  // A passkey instead of the password (and code): the browser offers the ones it has for this site.
  async function withPasskey() {
    setError(''); setBusy(true);
    try {
      const { ticket: t, options } = await post('/auth/login/passkey/options', {});
      const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
      const r = await post('/auth/login/passkey', { ticket: t, credential: credentialJson(cred) });
      setUser(r.user);
    } catch (err) { setError(err?.name ? passkeyError(err) : err.message); setBusy(false); }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (needsSetup && form.password !== form.confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (ticket) {
        const r = await post('/auth/login/code', { ticket, code });
        return setUser(r.user);
      }
      const r = needsSetup
        ? await post('/auth/setup', { org_name: form.org_name, domain: form.domain, name: form.name, local: form.local, password: form.password })
        : await post('/auth/login', { username: form.username, password: form.password });
      if (r.twoFactor) { setTicket(r.ticket); setBusy(false); return; }
      setUser(r.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      // An expired or used-up sign-in goes back to the password.
      if (ticket && /Sign in again/.test(err.message)) { setTicket(null); setCode(''); }
    }
  }

  if (ticket) {
    return (
      <div className="auth-page">
        <form className="auth-card stack" onSubmit={submit}>
          {mark}
          <h1>Two-step verification</h1>
          <p className="muted">{useRecovery
            ? 'Enter one of the recovery codes you saved when you turned on two-step verification. Each code works once.'
            : 'Enter the 6-digit code from the authenticator app on your phone.'}</p>
          <label className="field"><span>{useRecovery ? 'Recovery code' : 'Code'}</span>
            <input key={useRecovery ? 'r' : 'c'} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required spellCheck={false} autoCapitalize="none"
              {...(useRecovery ? { placeholder: 'xxxx-xxxx', autoComplete: 'off' } : { inputMode: 'numeric', autoComplete: 'one-time-code', placeholder: '123456', maxLength: 7 })} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : 'Verify'}</button>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="link-btn" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>
              {useRecovery ? 'Use a code from the app' : 'Use a recovery code'}</button>
            <button type="button" className="link-btn" onClick={() => { setTicket(null); setCode(''); setError(''); setUseRecovery(false); }}>Back</button>
          </div>
        </form>
      </div>
    );
  }

  const domain = form.domain.trim().toLowerCase() || 'yourcompany.com';

  if (forgot) {
    return (
      <div className="auth-page">
        <form className="auth-card stack" aria-label="Forgot your password?" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try { const r = await post('/auth/forgot', { username: form.username.trim() }); setForgot({ sent: r.message }); }
          catch (err) { setError(err.message); }
          finally { setBusy(false); }
        }}>
          {mark}
          <h1>Forgot your password?</h1>
          {forgot.sent ? <p role="status">{forgot.sent} Check that inbox (and its spam folder). No address? Ask your company's admin to reset your password.</p> : <>
            <p className="muted small" style={{ margin: 0 }}>We'll email a link to choose a new one to the recovery address you added in Settings.</p>
            <label className="field"><span>Email address</span><input type="email" value={form.username} onChange={set('username')} autoComplete="username" required autoFocus /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : 'Send me a link'}</button>
          </>}
          <button type="button" className="link-btn small" onClick={() => { setForgot(null); setError(''); }}>Back to sign in</button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card stack" onSubmit={submit}>
        {mark}
        <h1>{needsSetup ? 'Set up your workspace' : 'Sign in'}</h1>
        {needsSetup ? <>
          <p className="muted">You'll be the platform owner. You can add more companies and their domains later.</p>
          <label className="field"><span>Your company name</span><input value={form.org_name} onChange={set('org_name')} required autoFocus /></label>
          <label className="field"><span>Company domain</span>
            <input value={form.domain} onChange={set('domain')} placeholder="yourcompany.com" autoCapitalize="none" spellCheck={false} required />
          </label>
          <label className="field"><span>Your full name</span><input value={form.name} onChange={set('name')} autoComplete="name" required /></label>
          <label className="field"><span>Your email address</span>
            <span className="address-input">
              <input value={form.local} onChange={set('local')} placeholder="you" autoCapitalize="none" spellCheck={false} required aria-label="Address before @" />
              <span className="muted">@{domain}</span>
            </span>
          </label>
        </> : (
          <label className="field"><span>Email address</span>
            <input type="email" value={form.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" required autoFocus />
          </label>
        )}
        <label className="field"><span>Password</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete={needsSetup ? 'new-password' : 'current-password'} required minLength={needsSetup ? 8 : undefined} />
        </label>
        {needsSetup && (
          <label className="field"><span>Confirm password</span><input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required /></label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : needsSetup ? 'Create workspace' : 'Sign in'}</button>
        {!needsSetup && !ticket && passkeysSupported() && <button type="button" className="btn block" disabled={busy} onClick={withPasskey}>🔑 Use a passkey</button>}
        {!needsSetup && !ticket && canReset && <button type="button" className="link-btn small" onClick={() => setForgot({})}>Forgot password?</button>}
      </form>
    </div>
  );
}

/** /reset/<token>: choose a new password from the link emailed to the recovery address. */
export function ResetPassword({ token }) {
  const [state, setState] = useState({ loading: true }); // { username } | { error } | { done }
  const [pw, setPw] = useState({ password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/auth/reset/${encodeURIComponent(token)}`).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      setState(r.ok ? { username: d.username } : { error: d.error || 'This link has expired or been used.' });
    }).catch(() => setState({ error: 'The server could not be reached.' }));
  }, [token]);
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw.password !== pw.confirm) return setError('Passwords do not match');
    setBusy(true);
    try { await post(`/auth/reset/${encodeURIComponent(token)}`, { password: pw.password }); setState({ done: true, username: state.username }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="auth-page">
      <form className="auth-card stack" onSubmit={submit} aria-label="Choose a new password">
        <div className="brand big"><BrandMark name="Workspace" /><span className="brand-text">Workspace</span></div>
        <h1>Choose a new password</h1>
        {state.loading ? <p className="muted">Checking the link…</p>
          : state.error ? <><p className="error" role="alert">{state.error}</p><a className="btn" href="/">Back to sign in</a></>
          : state.done ? <><p role="status">Your password is changed, and you've been signed out everywhere. Sign in with the new one.</p><a className="btn primary" href="/">Sign in</a></>
          : <>
            <p className="muted small" style={{ margin: 0 }}>For {state.username}. You'll be signed out on every device.</p>
            <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required autoFocus /></label>
            <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : 'Change password'}</button>
          </>}
      </form>
    </div>
  );
}
