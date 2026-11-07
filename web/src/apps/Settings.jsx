import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, get, patch, post, del, putBlob } from '../api.js';
import { reloadPhotos, usePhoto } from '../components/photos.js';
import { useAuth } from '../App.jsx';
import { Avatar, useToast } from '../components/ui.jsx';
import { getTheme, setTheme } from '../theme.js';

export default function Settings() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');

  async function saveProfile(e) {
    e.preventDefault();
    try { setUser((await patch('/auth/me', { name })).user); toast('Profile saved'); }
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
        <ProfilePhoto user={user} />
        <label className="field"><span>Email address</span><input value={user.username} disabled /></label>
        <label className="field"><span>Company</span><input value={user.org_name} disabled /></label>
        <label className="field"><span>Full name</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <div className="row end"><button className="btn primary">Save profile</button></div>
      </form>
      <Appearance />
      <form className="card stack" onSubmit={savePassword}>
        <h2>Change password</h2>
        <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></label>
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></label>
        <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button className="btn primary">Change password</button></div>
      </form>
      <TwoStep />
      <MailApps />
      <Devices />
    </div>
  );
}

/**
 * Two-step verification: turn on (password -> scan QR -> confirm a code -> save recovery codes),
 * new recovery codes, turn off (password + a code).
 */
export function TwoStep({ onEnabled }) {
  const toast = useToast();
  const [st, setSt] = useState(null); // { enabled, recoveryLeft }
  const [step, setStep] = useState(null); // null | 'on' | 'scan' | 'codes' | 'newcodes' | 'off'
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null); // { secret, qr }
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/auth/2fa').then(setSt).catch(() => {}); }, []);
  const reset = () => { setStep(null); setPassword(''); setCode(''); setError(''); setSetup(null); };
  const run = (fn) => async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const begin = run(async () => {
    const r = await post('/auth/2fa/setup', { password });
    setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauth, { margin: 1, width: 360 }) });
    setPassword(''); setStep('scan');
  });
  const confirm = run(async () => {
    const r = await post('/auth/2fa/confirm', { code });
    setSt(r); setCodes(r.recoveryCodes); setStep('codes'); setCode('');
    toast('Two-step verification is on. Other devices were signed out.');
  });
  const regenerate = run(async () => {
    const r = await post('/auth/2fa/recovery-codes', { password });
    setSt(r); setCodes(r.recoveryCodes); setPassword(''); setStep('codes');
  });
  const turnOff = run(async () => {
    setSt(await post('/auth/2fa/disable', { password, code }));
    reset(); toast('Two-step verification is off');
  });
  const download = () => {
    const blob = new Blob([`Workspace recovery codes\nEach code can be used once to sign in without your phone.\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'workspace-recovery-codes.txt' });
    a.click(); URL.revokeObjectURL(a.href);
  };

  if (!st) return null;
  const pwField = <label className="field"><span>Your password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></label>;
  return (
    <section className="card stack" aria-labelledby="twostep-h">
      <h2 id="twostep-h">Two-step verification</h2>
      {step === 'codes' ? <>
        <p><strong>Save these recovery codes.</strong> If you lose your phone, each one signs you in once instead of a code from the app. They won't be shown again.</p>
        <ul className="recovery-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <div className="row end">
          <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied'))}>Copy</button>
          <button type="button" className="btn" onClick={download}>Download</button>
          <button type="button" className="btn primary" onClick={() => { setCodes(null); reset(); onEnabled?.(); }}>I've saved them</button>
        </div>
      </> : step === 'scan' ? (
        <form className="stack" onSubmit={confirm}>
          <p>1. In an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …), add an account by scanning this code:</p>
          <img className="qr" src={setup.qr} alt="QR code for your authenticator app" />
          <p className="muted small">Can't scan? Enter this key in the app instead (time-based):</p>
          <div className="secret-key" aria-label="Setup key">{setup.secret.match(/.{1,4}/g).join(' ')}</div>
          <label className="field"><span>2. Enter the 6-digit code the app shows</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required placeholder="123456" /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row end"><button type="button" className="btn" onClick={reset}>Cancel</button><button className="btn primary" disabled={busy}>Turn on</button></div>
        </form>
      ) : step === 'on' || step === 'newcodes' ? (
        <form className="stack" onSubmit={step === 'on' ? begin : regenerate}>
          <p>{step === 'on' ? 'Confirm your password to start.' : 'New codes replace all your old recovery codes.'}</p>
          {pwField}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row end"><button type="button" className="btn" onClick={reset}>Cancel</button><button className="btn primary" disabled={busy}>Continue</button></div>
        </form>
      ) : step === 'off' ? (
        <form className="stack" onSubmit={turnOff}>
          <p>Your account will be protected by your password only.</p>
          {pwField}
          <label className="field"><span>Code from your app (or a recovery code)</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row end"><button type="button" className="btn" onClick={reset}>Cancel</button><button className="btn danger" disabled={busy}>Turn off</button></div>
        </form>
      ) : st.enabled ? <>
        <p><strong>On.</strong> Signing in on the web asks for a code from your phone after your password. {st.recoveryLeft} of 10 recovery codes left.</p>
        {st.recoveryLeft <= 3 && <div className="banner warn">You're running out of recovery codes. Make new ones so you can still get in if you lose your phone.</div>}
        <p className="muted small">Mail apps on phones and Outlook (IMAP/SMTP) still use just your password; sign-in protection blocks anyone guessing it.</p>
        <div className="row end">
          <button type="button" className="btn" onClick={() => setStep('newcodes')}>New recovery codes</button>
          <button type="button" className="btn danger" onClick={() => setStep('off')}>Turn off</button>
        </div>
      </> : <>
        <p><strong>Off.</strong> Add a second step to signing in: after your password, a code from an app on your phone. Someone who learns your password still can't get in.</p>
        <div className="row end"><button type="button" className="btn primary" onClick={() => setStep('on')}>Turn on</button></div>
      </>}
    </section>
  );
}

/**
 * Mail apps (phones, Outlook): the settings to enter, and an optional mail-app password that
 * replaces the account password for them.
 */
function Appearance() {
  const [theme, set] = useState(getTheme);
  const pick = (t) => { setTheme(t); set(t); };
  return (
    <section className="card stack" aria-labelledby="appearance-h">
      <h2 id="appearance-h">Appearance</h2>
      <div className="theme-pick" role="radiogroup" aria-label="Theme">
        {[['system', 'System', 'Follows your computer or phone'], ['light', 'Light', 'Always light'], ['dark', 'Dark', 'Always dark']].map(([k, label, hint]) => (
          <button key={k} type="button" role="radio" aria-checked={theme === k} className={`theme-opt ${k} ${theme === k ? 'on' : ''}`} onClick={() => pick(k)}>
            <span className="theme-sample" aria-hidden="true"><span /><span /></span>
            <strong>{label}</strong><span className="muted small">{hint}</span>
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>Kept on this device, so a phone and a computer can differ.</p>
    </section>
  );
}

function MailApps() {
  const toast = useToast();
  const { user } = useAuth();
  const [st, setSt] = useState(null);
  const [step, setStep] = useState(null); // null | 'create' | 'remove' | 'show'
  const [password, setPassword] = useState('');
  const [made, setMade] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { get('/auth/mail-app').then(setSt).catch(() => {}); }, []);
  if (!st) return null;
  const reset = () => { setStep(null); setPassword(''); setError(''); };
  const run = (fn) => async (e) => { e.preventDefault(); setError(''); try { await fn(); } catch (err) { setError(err.message); } };
  const create = run(async () => { const r = await post('/auth/mail-app', { password }); setSt(r); setMade(r.password); setPassword(''); setStep('show'); });
  const remove = run(async () => { setSt(await api('DELETE', '/auth/mail-app', { password })); reset(); toast('Mail apps use your account password again'); });
  const host = st.hostname || window.location.hostname;
  return (
    <section className="card stack" aria-labelledby="mailapps-h">
      <h2 id="mailapps-h">{st.enabled ? 'Mail, calendar and contacts on your phone' : 'Calendar and contacts on your phone'}</h2>
      <dl className="settings-list">
        {st.enabled && <><dt>Incoming mail (IMAP)</dt><dd><code>{host}</code>, port <code>993</code>, SSL/TLS</dd>
        <dt>Outgoing mail (SMTP)</dt><dd><code>{host}</code>, port <code>465</code> SSL/TLS (or <code>587</code> STARTTLS)</dd></>}
        <dt>Calendar (CalDAV) and contacts (CardDAV)</dt><dd>Server <code>{window.location.host}</code> (if an app asks for a full address: <code>{`${window.location.origin}/dav/`}</code>)</dd>
        <dt>Drive as a network drive (WebDAV)</dt><dd><code>{`${window.location.origin}/dav/files/`}</code></dd>
        <dt>User name</dt><dd><code>{user.username}</code></dd>
        <dt>Password</dt><dd>{st.appPassword ? 'your mail-app password (your account password no longer works in apps)'
          : st.twoFactor ? 'create a mail-app password below: with two-step verification on, your account password doesn\'t work in apps' : 'your account password'}</dd>
      </dl>
      <p className="muted small">iPhone and iPad: Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account (and Contacts → Add CardDAV Account). Android: the free DAVx⁵ app, "Login with URL and user name".</p>
      <p className="muted small">Drive on a computer: on a Mac, Finder → Go → Connect to Server, and enter the Drive address. On Windows, File Explorer → This PC → Map network drive → "Connect to a website…", and enter the Drive address. Files you save there are in Drive straight away; saving over one keeps the old version.</p>
      {step === 'show' ? <>
        <p><strong>Your mail-app password:</strong> enter it in your mail apps instead of your account password. It's shown only once.</p>
        <div className="secret-key" aria-label="Mail-app password">{made}</div>
        <p className="muted small">Type it exactly as shown, dashes included (or use Copy). Mail apps signed in with your account password will ask for this one within a few seconds.</p>
        <div className="row end">
          <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(made).then(() => toast('Copied'))}>Copy</button>
          <button type="button" className="btn primary" onClick={() => { setMade(''); reset(); }}>Done</button>
        </div>
      </> : step ? (
        <form className="stack" onSubmit={step === 'create' ? create : remove}>
          <p>{step === 'create'
            ? (st.appPassword ? 'A new mail-app password replaces the current one; mail apps using the old one will ask for the new one.' : 'Mail apps will then need the mail-app password; your account password stops working in them.')
            : 'Mail apps will use your account password again.'}</p>
          <label className="field"><span>Your account password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row end"><button type="button" className="btn" onClick={reset}>Cancel</button>
            <button className={`btn ${step === 'remove' ? 'danger' : 'primary'}`}>{step === 'create' ? 'Create mail-app password' : 'Remove it'}</button></div>
        </form>
      ) : <>
        <p className="muted small">{st.appPassword
          ? `A mail-app password is in use (created ${new Date(st.appPassword.created).toLocaleDateString()}). If a phone is lost, make a new one or remove it.`
          : 'For extra safety, give mail apps their own password: then someone who learns your account password can\'t read your mail from a mail app, and a lost phone never had your account password.'}</p>
        <div className="row end">
          {st.appPassword && <button type="button" className="btn" onClick={() => setStep('remove')}>Remove</button>}
          <button type="button" className="btn primary" onClick={() => setStep('create')}>{st.appPassword ? 'New mail-app password' : 'Create mail-app password'}</button>
        </div>
      </>}
    </section>
  );
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 5) return 'Active now';
  if (m < 60) return `${m} minutes ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} hours ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Where you're signed in on the web, with sign-out per device. */
function Devices() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => get('/auth/sessions').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!list) return null;
  const others = list.filter((d) => !d.current);
  const signOut = async (d) => {
    try { await api('DELETE', `/auth/sessions/${d.id}`); toast(`Signed out ${d.device}`); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const signOutOthers = async () => {
    try { const r = await post('/auth/sessions/sign-out-others'); toast(`Signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}`); load(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="devices-h">
      <h2 id="devices-h">Signed-in devices</h2>
      <p className="muted small">Browsers where you're signed in to Workspace. Don't recognise one? Sign it out and change your password. (Mail apps aren't listed; see Mail apps above.)</p>
      <ul className="device-list" aria-label="Signed-in devices">
        {[...list].sort((a, b) => b.current - a.current).map((d) => (
          <li key={d.id}>
            <span className="grow">
              <span className="device-name"><strong>{d.device}</strong>{d.current && <span className="pill ok">This device</span>}</span>
              <span className="muted small">{d.current ? 'Active now' : ago(d.last_seen || d.created_at)}{d.ip ? ` · ${d.ip}` : ''}{d.created_at ? ` · signed in ${new Date(d.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}</span>
            </span>
            {!d.current && <button type="button" className="btn small" onClick={() => signOut(d)} aria-label={`Sign out ${d.device}`}>Sign out</button>}
          </li>
        ))}
      </ul>
      {others.length > 0 && <div className="row end"><button type="button" className="btn" onClick={signOutOthers}>Sign out all other devices</button></div>}
    </section>
  );
}

/** A square picture (cropped from the middle, 256 pixels) as a JPEG, made in the browser. */
async function squarePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That file isn’t a picture')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  } finally { URL.revokeObjectURL(url); }
}

/** Your photo: shown to colleagues instead of your initials. */
function ProfilePhoto({ user }) {
  const toast = useToast();
  const input = useRef();
  const has = !!usePhoto(user.id);
  const [busy, setBusy] = useState(false);
  const choose = async (file) => {
    if (!file) return;
    setBusy(true);
    try { await putBlob('/users/me/photo', await squarePhoto(file)); await reloadPhotos(); toast('Photo saved'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => { try { await del('/users/me/photo'); await reloadPhotos(); toast('Photo removed'); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="row profile-photo">
      <Avatar name={user.name} userId={user.id} size={64} />
      <div className="stack" style={{ gap: 4 }}>
        <div className="row">
          <button type="button" className="btn small" disabled={busy} onClick={() => input.current.click()}>{has ? 'Change photo' : 'Add a photo'}</button>
          {has && <button type="button" className="btn small" onClick={remove}>Remove photo</button>}
        </div>
        <span className="muted small">Colleagues see it next to your name in Chat, Drive, Mail and elsewhere.</span>
      </div>
      <input ref={input} type="file" accept="image/*" hidden aria-label="Photo file" onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}
