import { useState } from 'react';
import { patch } from '../api.js';
import { useAuth } from '../App.jsx';
import { useToast } from '../components/ui.jsx';

export default function Settings() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [profile, setProfile] = useState({ name: user.name, email: user.email || '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');

  async function saveProfile(e) {
    e.preventDefault();
    try { setUser((await patch('/auth/me', profile)).user); toast('Profile saved'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function savePassword(e) {
    e.preventDefault();
    setError('');
    if (pw.newPassword !== pw.confirm) return setError('New passwords do not match');
    try {
      await patch('/auth/me', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      toast('Password changed. Other devices were signed out.');
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <form className="card stack" onSubmit={saveProfile}>
        <h2>Profile</h2>
        <label className="field"><span>Username</span><input value={user.username} disabled /></label>
        <label className="field"><span>Full name</span><input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} required /></label>
        <label className="field"><span>Email</span><input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label>
        <div className="row end"><button className="btn primary">Save profile</button></div>
      </form>
      <form className="card stack" onSubmit={savePassword}>
        <h2>Change password</h2>
        <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></label>
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></label>
        <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button className="btn primary">Change password</button></div>
      </form>
    </div>
  );
}
