import { useState } from 'react';
import { post } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Login({ needsSetup }) {
  const { setUser } = useAuth();
  const [form, setForm] = useState({ username: '', name: '', password: '', confirm: '' });
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
        ? await post('/auth/setup', { username: form.username, name: form.name, password: form.password })
        : await post('/auth/login', { username: form.username, password: form.password });
      setUser(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card stack" onSubmit={submit}>
        <div className="brand big"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div>
        <h1>{needsSetup ? 'Create the admin account' : 'Sign in'}</h1>
        {needsSetup && <p className="muted">This is the first start. The account you create now manages users and settings.</p>}
        {needsSetup && (
          <label className="field"><span>Full name</span><input value={form.name} onChange={set('name')} autoComplete="name" required /></label>
        )}
        <label className="field"><span>Username</span>
          <input value={form.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" required autoFocus />
        </label>
        <label className="field"><span>Password</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete={needsSetup ? 'new-password' : 'current-password'} required minLength={needsSetup ? 8 : undefined} />
        </label>
        {needsSetup && (
          <label className="field"><span>Confirm password</span><input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required /></label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : needsSetup ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  );
}
