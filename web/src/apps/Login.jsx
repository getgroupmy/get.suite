import { useState } from 'react';
import { post } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Login({ needsSetup }) {
  const { setUser } = useAuth();
  const [form, setForm] = useState({ username: '', password: '', confirm: '', org_name: '', domain: '', name: '', local: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (needsSetup && form.password !== form.confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      const { user } = needsSetup
        ? await post('/auth/setup', { org_name: form.org_name, domain: form.domain, name: form.name, local: form.local, password: form.password })
        : await post('/auth/login', { username: form.username, password: form.password });
      setUser(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const domain = form.domain.trim().toLowerCase() || 'yourcompany.com';

  return (
    <div className="auth-page">
      <form className="auth-card stack" onSubmit={submit}>
        <div className="brand big"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div>
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
      </form>
    </div>
  );
}
