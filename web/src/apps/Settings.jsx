import { useEffect, useRef, useState } from 'react';
import { loadPause } from '../pause.js';
import QRCode from 'qrcode';
import { api, get, patch, post, put, del, putBlob, postBlob, uploadFile, formatBytes } from '../api.js';
import { reloadPhotos, usePhoto } from '../components/photos.js';
import { useAuth } from '../App.jsx';
import { Avatar, ConfirmModal, useToast } from '../components/ui.jsx';
import DrivePicker from '../components/DrivePicker.jsx';
import Icon from '../components/Icon.jsx';
import { allZones, zoneName, cityOf } from '../components/zones.js';
import { getTheme, setTheme } from '../theme.js';
import { useMailStatus } from '../mailStatus.js';

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
        <PasswordRulesNote />
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></label>
        <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button className="btn primary">Change password</button></div>
      </form>
      <RecoveryEmail />
      <TwoStep />
      <MailApps />
      <MailDelegates />
      <MailPane />
      <MailAdvance />
      <MailTidy />
      <MailNudges />
      <MailAttachCheck />
      <MailTips />
      <CallRing />
      <KeyboardKeys />
      <SearchTips />
      <Devices />
      <SignInApps />
      <WorkLocation />
      <SecondZone />
      <FileFormat />
      <Profile />
      <ViewHistory />
      <ReadReceipts />
      <QuietHours />
      <MorningSummary />
      <ChatEmail />
      <ApiTokens />
      <YourData />
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
      <StartPage />
    </section>
  );
}

/** A second time zone beside the hours in Calendar. */
/** Whether owners and editors see when you open their files. */
const DIGEST_PARTS = [['events', "Today's events"], ['tasks', 'Tasks due or overdue'], ['dates', 'Contacts’ birthdays and dates'], ['chat', 'Unread chat messages'], ['comments', 'Comments for you'], ['drive', 'What others changed in Drive']];
/** The morning summary email: on at an hour of your choosing, in this browser's time zone, with the parts you tick. */
function MorningSummary() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => { get('/users/me/digest').then(setD).catch(() => {}); }, []);
  if (!d) return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = async (hour) => {
    const before = d.hour;
    setD({ ...d, hour });
    try { await put('/users/me/digest', { hour, tz }); toast(hour === null ? 'No more morning summaries' : `You'll get a summary each day at ${hour}:00`); } catch (e) { setD({ ...d, hour: before }); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="ms-h">
      <h2 id="ms-h">Morning summary</h2>
      {!d.mail ? <p className="muted small" style={{ margin: 0 }}>Needs email on this server.</p> : <>
        <label className="check"><input type="checkbox" checked={d.hour !== null} onChange={(e) => save(e.target.checked ? 7 : null)} /> Email me a summary of my day</label>
        {d.hour !== null && (
          <label className="row small">at <select aria-label="Summary time" value={d.hour} onChange={(e) => save(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select> <span className="muted">({tz})</span></label>
        )}
        {d.hour !== null && (
          <label className="check small"><input type="checkbox" checked={!!d.weekdays} onChange={async (e) => {
            const weekdays = e.target.checked;
            setD({ ...d, weekdays });
            try { await put('/users/me/digest/days', { weekdays }); toast(weekdays ? 'Monday to Friday only' : 'Every day'); } catch (err) { setD({ ...d, weekdays: !weekdays }); toast(err.message, 'error'); }
          }} /> Weekdays only (not on Saturday or Sunday)</label>
        )}
        {d.hour !== null && (
          <label className="check small"><input type="checkbox" checked={!!d.skip_empty} onChange={async (e) => {
            const skip = e.target.checked;
            setD({ ...d, skip_empty: skip });
            try { await put('/users/me/digest/days', { skip_empty: skip }); toast(skip ? 'Only on days with something in it' : 'Every time, even with nothing in it'); } catch (err) { setD({ ...d, skip_empty: !skip }); toast(err.message, 'error'); }
          }} /> Only when there's something in it</label>
        )}
        {d.hour !== null && (
          <fieldset className="digest-parts">
            <legend className="small muted">What's in it</legend>
            {DIGEST_PARTS.map(([key, label]) => (
              <label key={key} className="check small"><input type="checkbox" checked={!d.off?.includes(key)} onChange={async (e) => {
                const before = d.off || [];
                const off = e.target.checked ? before.filter((x) => x !== key) : [...before, key];
                setD({ ...d, off });
                try { await put('/users/me/digest/parts', { off }); } catch (err) { setD({ ...d, off: before }); toast(err.message, 'error'); }
              }} /> {label}</label>
            ))}
          </fieldset>
        )}
        <p className="muted small" style={{ margin: 0 }}>From your own mailbox to your inbox. Not on days you're on approved time off.</p>
      </>}
      <div className="row">
        <button type="button" className="btn small" onClick={async () => { try { const r = await post('/users/me/digest/send', { preview: !d.mail }); setPreview(r.text); if (r.sent) toast('Sent to your inbox'); } catch (e) { toast(e.message, 'error'); } }}>{d.mail ? 'Send me one now' : 'Show what it would say'}</button>
      </div>
      {preview && <pre className="digest-preview" aria-label="Summary preview">{preview}</pre>}
    </section>
  );
}

const waitText = (m) => (m === 30 ? 'half an hour' : m < 60 ? `${m} minutes` : m === 60 ? 'an hour' : `${m / 60} hours`);

/** Chat emails: unread direct messages and mentions come by email after half an hour (or the wait chosen). */
function ChatEmail() {
  const toast = useToast();
  const [c, setC] = useState(null);
  useEffect(() => { get('/chat/me/chat-email').then(setC).catch(() => {}); }, []);
  if (!c) return null;
  return (
    <section className="card stack" aria-labelledby="ce-h">
      <h2 id="ce-h">Chat emails</h2>
      <label className="check"><input type="checkbox" checked={c.on} disabled={!c.mail} onChange={async (e) => {
        const on = e.target.checked;
        setC({ ...c, on });
        try { await put('/chat/me/chat-email', { on }); toast(on ? "You'll get an email about chat messages you haven't read" : 'No more chat emails'); } catch (err) { setC({ ...c }); toast(err.message, 'error'); }
      }} /> Email me about unread direct messages, mentions and keywords</label>
      {c.mail && c.on && <label className="field" style={{ maxWidth: 260 }}><span>After it has waited</span>
        <select value={c.wait} onChange={async (e) => {
          const wait = Number(e.target.value);
          const was = c.wait;
          setC({ ...c, wait });
          try { await put('/chat/me/chat-email', { wait }); toast(`Chat emails after ${waitText(wait)} unread`); } catch (err) { setC({ ...c, wait: was }); toast(err.message, 'error'); }
        }}>{(c.waits || [30]).map((m) => <option key={m} value={m}>{waitText(m)}</option>)}</select>
      </label>}
      <p className="muted small" style={{ margin: 0 }}>{c.mail ? `Sent when one has waited ${waitText(c.wait || 30)} and you still haven't read it, not during quiet hours or while notifications are paused.` : 'Needs email on this server.'}</p>
    </section>
  );
}

/** Quiet hours: notifications pause by themselves outside your working hours. */
function QuietHours() {
  const toast = useToast();
  const [q, setQ] = useState(null);
  useEffect(() => { get('/users/me/quiet-hours').then(setQ).catch(() => {}); }, []);
  if (!q) return null;
  return (
    <section className="card stack" aria-labelledby="qh-h">
      <h2 id="qh-h">Quiet hours</h2>
      <label className="check"><input type="checkbox" checked={q.on} disabled={!q.hours} onChange={async (e) => {
        const on = e.target.checked;
        setQ({ ...q, on });
        try { await put('/users/me/quiet-hours', { on }); await loadPause(); toast(on ? 'Notifications pause outside your working hours' : 'Quiet hours off'); } catch (err) { setQ({ ...q, on: !on }); toast(err.message, 'error'); }
      }} /> Pause notifications outside my working hours</label>
      <p className="muted small" style={{ margin: 0 }}>{q.hours ? `Your working hours: ${q.hours} (${q.tz}). Outside them, pop-up notes and desktop notifications wait, as with Pause notifications, and colleagues see 🔕. Everything still arrives in the bell.` : 'Set your working hours first, in Calendar → Working hours.'}</p>
    </section>
  );
}

/** "Seen" in direct messages: on for both people, or for neither. */
function ReadReceipts() {
  const toast = useToast();
  const [on, setOn] = useState(null);
  useEffect(() => { get('/chat/me/read-receipts').then((r) => setOn(r.on)).catch(() => {}); }, []);
  if (on === null) return null;
  return (
    <section className="card stack" aria-labelledby="rr-h">
      <h2 id="rr-h">Read receipts</h2>
      <label className="check"><input type="checkbox" checked={on} onChange={async (e) => {
        const next = e.target.checked; setOn(next);
        try { await put('/chat/me/read-receipts', { on: next }); toast(next ? 'People you message can see when you’ve read what they sent' : 'Read receipts are off, both ways'); } catch (err) { setOn(!next); toast(err.message, 'error'); }
      }} /> Show “Seen” in direct messages</label>
      <p className="muted small" style={{ margin: 0 }}>When it's off, people you message don't see when you've read what they sent, and you don't see it for them either.</p>
    </section>
  );
}

function ViewHistory() {
  const toast = useToast();
  const [show, setShow] = useState(null);
  useEffect(() => { get('/users/me/view-history').then((r) => setShow(r.show)).catch(() => {}); }, []);
  if (show === null) return null;
  return (
    <section className="card stack" aria-labelledby="vh-h">
      <h2 id="vh-h">Who has seen it</h2>
      <label className="check"><input type="checkbox" checked={show} onChange={async (e) => {
        const next = e.target.checked; setShow(next);
        try { await put('/users/me/view-history', { show: next }); toast(next ? 'Owners and editors can see when you open their files' : 'Your openings are hidden, and the ones kept so far are forgotten'); } catch (err) { setShow(!next); toast(err.message, 'error'); }
      }} /> Show the owners and editors of files when I've opened them</label>
      <p className="muted small" style={{ margin: 0 }}>They see it in Drive → Details → Who has seen it. Turning this off also forgets the openings kept so far.</p>
    </section>
  );
}

/** Your job title, department and work phone, as colleagues see them in the Directory. */
function Profile() {
  const toast = useToast();
  const { user } = useAuth();
  const [p, setP] = useState(null);
  useEffect(() => { get('/users/directory').then((list) => { const me = list.find((u) => u.id === user.id) || {}; setP({ job_title: me.job_title || '', department: me.department || '', work_phone: me.work_phone || '' }); }).catch(() => {}); }, [user.id]);
  if (!p) return null;
  const save = async (e) => {
    e.preventDefault();
    try { await put('/users/me/profile', p); toast('Saved: colleagues see it in the Directory'); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <form className="card stack" aria-labelledby="profile-h" onSubmit={save}>
      <h2 id="profile-h">About you</h2>
      <p className="muted small" style={{ margin: 0 }}>Colleagues see these in Contacts → Directory and the org chart. Who you report to is set by an admin.</p>
      <div className="row wrap">
        <label className="field grow"><span>Job title</span><input value={p.job_title} maxLength={100} onChange={(e) => setP({ ...p, job_title: e.target.value })} placeholder="Sales manager" /></label>
        <label className="field grow"><span>Department</span><input value={p.department} maxLength={100} onChange={(e) => setP({ ...p, department: e.target.value })} placeholder="Sales" /></label>
        <label className="field grow"><span>Work phone</span><input type="tel" value={p.work_phone} maxLength={40} onChange={(e) => setP({ ...p, work_phone: e.target.value })} placeholder="+60 3-1234 5678" /></label>
      </div>
      <div className="row end"><button className="btn primary">Save</button></div>
    </form>
  );
}

/** Mail: what opens after archiving, deleting, moving or snoozing the message you're reading. */
/** Calls from Chat: pop up on screen with Join, or only reach the bell. */
function CallRing() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [on, setOn] = useState(user.ring !== false);
  const set = async (next) => {
    setOn(next);
    try { await put('/users/me/ring', { on: next }); setUser({ ...user, ring: next }); toast(next ? 'Calls pop up on screen' : 'Calls only reach your notifications'); } catch (e) { setOn(!next); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="ring-h">
      <h2 id="ring-h">Calls</h2>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Show calls on screen (📞 … is calling you, with Join and Can’t talk)</label>
      <p className="muted small" style={{ margin: 0 }}>Turned off, a call still reaches your notifications (and your phone, if notifications are on there), so you can join or call back when it suits you.</p>
    </section>
  );
}

/** Notes while writing mail (Include …?, after their working hours, away, full mailbox, many people, outside the company). */
function MailTips() {
  const toast = useToast();
  const mail = useMailStatus();
  const { user, setUser } = useAuth();
  const [on, setOn] = useState(user.mail_tips !== false);
  if (!mail?.enabled) return null;
  const set = async (next) => {
    setOn(next);
    try { await put('/users/me/mail-tips', { on: next }); setUser({ ...user, mail_tips: next }); toast(next ? 'Tips while writing are on' : 'Tips while writing are off'); } catch (e) { setOn(!next); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="mtips-h">
      <h2 id="mtips-h">Tips while writing</h2>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Show tips under the addresses as I write an email</label>
      <p className="muted small" style={{ margin: 0 }}>People you usually include, colleagues outside their working hours, away or with a full mailbox, how many people a big message goes to, and who's outside the company. If your company asks before mail goes outside it, that question still comes.</p>
    </section>
  );
}

/** The search box's "Type to make things" tips (event …, task …): shown in the empty box, or hidden. */
function SearchTips() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [on, setOn] = useState(user.search_tips !== false);
  const set = async (next) => {
    setOn(next);
    try { await put('/users/me/search-tips', { on: next }); setUser({ ...user, search_tips: next }); toast(next ? 'Search tips are on' : 'Search tips are off'); } catch (e) { setOn(!next); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="stips-h">
      <h2 id="stips-h">Search tips</h2>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Show what I can type to make things (<em>event …</em>, <em>task …</em>, <em>note …</em>) when I click into the search box</label>
    </section>
  );
}

/** Single-key shortcuts (C, J/K, G then M, ?): on or off, for people who'd rather not have keys do things (or use speech input). */
function KeyboardKeys() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [on, setOn] = useState(user.keys !== false);
  const set = async (next) => {
    setOn(next);
    try { await put('/users/me/keys', { on: next }); setUser({ ...user, keys: next }); toast(next ? 'Single-key shortcuts are on' : 'Single-key shortcuts are off'); } catch (e) { setOn(!next); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="keys-h">
      <h2 id="keys-h">Keyboard shortcuts</h2>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Single-key shortcuts (<kbd>C</kbd> to write in Mail, <kbd>G</kbd> then <kbd>M</kbd> to go to Mail, <kbd>?</kbd> for the list…)</label>
      <p className="muted small" style={{ margin: 0 }}>Turn them off if keys you press by accident (or speech input) set things off. Shortcuts with Ctrl or ⌘ (such as Ctrl+/ for the list) keep working.</p>
    </section>
  );
}

function MailPane() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [now, setNow] = useState(user.mail_pane || 'right');
  const [list, setList] = useState(user.mail_list || { pictures: false, compact: false });
  const set = async (pane) => {
    const was = now;
    setNow(pane);
    try { await put('/users/me/mail-pane', { pane }); setUser({ ...user, mail_pane: pane }); toast('Saved'); } catch (e) { setNow(was); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="mpane-h">
      <h2 id="mpane-h">Mail list and reading pane</h2>
      <p className="muted small" style={{ margin: 0 }}>Where an email you open shows in Mail (on a computer; phones show one at a time).</p>
      <div className="stack" role="radiogroup" aria-labelledby="mpane-h">
        <label className="check"><input type="radio" name="mail-pane" checked={now === 'right'} onChange={() => set('right')} /> Right of the list</label>
        <label className="check"><input type="radio" name="mail-pane" checked={now === 'below'} onChange={() => set('below')} /> Below the list</label>
        <label className="check"><input type="radio" name="mail-pane" checked={now === 'off'} onChange={() => set('off')} /> No split: the list fills the page, and an email opens in its place (← back to the list)</label>
      </div>
      <div className="stack">
        {[['pictures', 'Show sender pictures in the list (a colleague’s photo, or initials)'], ['compact', 'Compact list: one line per email, more on the screen']].map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={!!list[k]} onChange={async (e) => {
            const on = e.target.checked, was = list;
            setList({ ...list, [k]: on }); // at once; put back if saving fails
            try { const r = await put('/users/me/mail-list', { [k]: on }); setUser({ ...user, mail_list: r }); toast('Saved'); } catch (err) { setList(was); toast(err.message, 'error'); }
          }} /> {label}</label>
        ))}
      </div>
    </section>
  );
}

function MailAdvance() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [now, setNow] = useState(user.mail_advance || 'list');
  const set = async (advance) => {
    const was = now;
    setNow(advance);
    try { await put('/users/me/mail-advance', { advance }); setUser({ ...user, mail_advance: advance }); toast('Saved'); } catch (e) { setNow(was); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="madv-h">
      <h2 id="madv-h">After archiving or deleting an email</h2>
      <p className="muted small" style={{ margin: 0 }}>What Mail opens after you archive, delete, move or snooze the message you're reading.</p>
      <div className="stack" role="radiogroup" aria-labelledby="madv-h">
        <label className="check"><input type="radio" name="mail-advance" checked={now === 'list'} onChange={() => set('list')} /> Go back to the list</label>
        <label className="check"><input type="radio" name="mail-advance" checked={now === 'newer'} onChange={() => set('newer')} /> Open the next newer message</label>
        <label className="check"><input type="radio" name="mail-advance" checked={now === 'older'} onChange={() => set('older')} /> Open the next older message</label>
      </div>
    </section>
  );
}

/** Nudges: "Received 5 days ago. Reply?" in the Inbox, "Sent 4 days ago. Follow up?" in Sent, and Home's Not answered yet. */
function MailNudges() {
  const toast = useToast();
  const mail = useMailStatus();
  const [on, setOn] = useState(undefined);
  useEffect(() => { if (mail?.enabled) get('/mail/nudges/settings').then((r) => setOn(r.on)).catch(() => {}); }, [mail?.enabled]);
  if (!mail?.enabled || on === undefined) return null;
  const set = async (v) => { setOn(v); try { await put('/mail/nudges/settings', { on: v }); toast('Saved'); } catch (e) { setOn(!v); toast(e.message, 'error'); } };
  return (
    <section className="card stack" aria-labelledby="mnudge-h">
      <h2 id="mnudge-h">Nudges</h2>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Suggest emails to reply to and to follow up on</label>
      <p className="muted small" style={{ margin: 0 }}>Mail from people you haven't answered in a few days says <em>Received 5 days ago. Reply?</em> in the Inbox (and shows on Home); mail you sent that nobody has answered says <em>Sent 4 days ago. Follow up?</em> in Sent.</p>
    </section>
  );
}

/** The forgotten-attachment reminder in Compose: on or off, and words of your own that mean a file comes with it. */
function MailAttachCheck() {
  const toast = useToast();
  const mail = useMailStatus();
  const [v, setV] = useState(undefined);
  const [words, setWords] = useState('');
  useEffect(() => { if (mail?.enabled) get('/mail/attach-check').then((r) => { setV(r); setWords(r.words.join(', ')); }).catch(() => {}); }, [mail?.enabled]);
  if (!mail?.enabled || v === undefined) return null;
  const save = async (body, msg) => {
    try { const r = await put('/mail/attach-check', body); setV(r); setWords(r.words.join(', ')); toast(msg); return true; } catch (e) { toast(e.message, 'error'); return false; }
  };
  return (
    <section className="card stack" aria-labelledby="mattach-h">
      <h2 id="mattach-h">Forgotten attachments</h2>
      <label className="check"><input type="checkbox" checked={v.on} onChange={(e) => { const was = v; setV({ ...v, on: e.target.checked }); save({ on: e.target.checked }, 'Saved').then((ok) => { if (!ok) setV(was); }); }} /> Ask before sending when a message says something is attached but nothing is</label>
      <p className="muted small" style={{ margin: 0 }}>It looks for words such as <em>attached</em>, <em>see attachment</em>, <em>enclosed</em> or <em>PFA</em> in what you wrote (not in what you're replying to). Add words of your own below, such as another language's.</p>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); save({ words }, 'Your words are saved'); }}>
        <label className="field grow"><span>Your own words</span>
          <input value={words} onChange={(e) => setWords(e.target.value)} placeholder="Anlage, spec sheet" disabled={!v.on} /></label>
        <button className="btn" disabled={!v.on || words === v.words.join(', ')}>Save words</button>
      </form>
    </section>
  );
}

const TIDY = [[null, 'Never'], [7, 'After a week'], [14, 'After 2 weeks'], [30, 'After 30 days'], [60, 'After 60 days'], [90, 'After 90 days']];
/** Tidy the inbox: mail in Updates older than so many days goes to Archive by itself (starred mail stays). */
function MailTidy() {
  const toast = useToast();
  const mail = useMailStatus();
  const [days, setDays] = useState(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (mail?.enabled) get('/mail/tidy').then((r) => setDays(r.days)).catch(() => {}); }, [mail?.enabled]);
  if (!mail?.enabled || days === undefined) return null;
  const set = async (v) => {
    const was = days;
    setDays(v);
    try { await put('/mail/tidy', { days: v }); toast(v ? 'Saved: old updates go to Archive each day' : 'Saved: updates stay in your inbox'); } catch (e) { setDays(was); toast(e.message, 'error'); }
  };
  const now = async () => {
    setBusy(true);
    try { const r = await post('/mail/tidy/now'); toast(r.moved ? `${r.moved} message${r.moved === 1 ? '' : 's'} moved to Archive` : 'Nothing to tidy'); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <section className="card stack" aria-labelledby="mtidy-h">
      <h2 id="mtidy-h">Tidy the inbox</h2>
      <p className="muted small" style={{ margin: 0 }}>Newsletters, notifications and receipts in the <strong>Updates</strong> tab move to <strong>Archive</strong> by themselves once they're this old, every day. Starred ones stay, and nothing is deleted.</p>
      <div className="row wrap">
        <label className="field"><span>Archive updates</span>
          <select value={days ?? ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : null)}>
            {TIDY.map(([v, l]) => <option key={l} value={v ?? ''}>{l}</option>)}
          </select></label>
        {days && <button type="button" className="btn" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={now}>{busy ? 'Tidying…' : 'Tidy now'}</button>}
      </div>
    </section>
  );
}

/** What documents, spreadsheets and presentations download as when there's no menu to choose from: a .zip from Drive, your data. */
function FileFormat() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [now, setNow] = useState(user.file_format === 'odf' ? 'odf' : 'office'); // shown chosen straight away
  const set = async (format) => {
    const was = now;
    setNow(format);
    try { await put('/users/me/file-format', { format }); setUser({ ...user, file_format: format }); toast(format === 'odf' ? 'Files will download as OpenDocument' : 'Files will download as Word, Excel and PowerPoint'); } catch (e) { setNow(was); toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="ff-h">
      <h2 id="ff-h">File format for downloads</h2>
      <p className="muted small" style={{ margin: 0 }}>What documents, spreadsheets and presentations become in a .zip from Drive, in <strong>Download your data</strong>, and first in the list when you attach one to an email. Each editor's ⋮ menu still offers every kind.</p>
      <div className="stack" role="radiogroup" aria-labelledby="ff-h">
        <label className="check"><input type="radio" name="file-format" checked={now === 'office'} onChange={() => set('office')} /> Microsoft Office: Word (.docx), Excel (.xlsx), PowerPoint (.pptx)</label>
        <label className="check"><input type="radio" name="file-format" checked={now === 'odf'} onChange={() => set('odf')} /> OpenDocument: .odt, .ods, .odp (LibreOffice and others)</label>
      </div>
      <ConvertUploads />
    </section>
  );
}

/** Uploads in Drive: Word, Excel, PowerPoint, OpenDocument and Markdown files become documents, spreadsheets and presentations. */
function ConvertUploads() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [on, setOn] = useState(!!user.convert_uploads);
  const set = async (v) => {
    setOn(v);
    try { await put('/users/me/convert-uploads', { on: v }); setUser({ ...user, convert_uploads: v }); toast(v ? 'Office files you upload will become documents, spreadsheets and presentations' : 'Office files you upload will stay as they are'); } catch (e) { setOn(!v); toast(e.message, 'error'); }
  };
  return (
    <label className="check"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Convert uploads: Word, Excel, PowerPoint, OpenDocument and Markdown files I upload in Drive become documents, spreadsheets and presentations (the uploaded file goes to the trash)</label>
  );
}

function SecondZone() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const zones = allZones();
  const set = async (tz) => {
    try { await put('/users/me/second-tz', { tz: tz || null }); setUser({ ...user, second_tz: tz || null }); toast(tz ? `Calendar also shows the time in ${cityOf(tz)}` : 'Second time zone removed'); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="tz2-h">
      <h2 id="tz2-h">Second time zone</h2>
      <p className="muted small" style={{ margin: 0 }}>Show another place's time beside the hours in Calendar's week and day views, for working with colleagues or clients elsewhere.</p>
      <label className="field" style={{ maxWidth: 360 }}><span>Also show the time in</span>
        <select value={user.second_tz || ''} onChange={(e) => set(e.target.value)}>
          <option value="">None</option>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')} ({zoneName(z)})</option>)}
        </select></label>
    </section>
  );
}

/** Where you usually work each weekday (change single days in Calendar). */
function WorkLocation() {
  const toast = useToast();
  const [week, setWeek] = useState(null);
  useEffect(() => { const d = new Date(); const iso = d.toISOString().slice(0, 10); get(`/location?from=${iso}&to=${iso}`).then((r) => setWeek(r.week)).catch(() => setWeek({})); }, []);
  const set = async (day, place) => {
    const next = { ...week, [day]: place || null };
    setWeek(next);
    try { setWeek((await put('/location/week', { week: next })).week); toast('Working location saved'); } catch (e) { toast(e.message, 'error'); }
  };
  if (!week) return null;
  const DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
  return (
    <section className="card stack" aria-labelledby="workloc-h">
      <h2 id="workloc-h">Working location</h2>
      <p className="muted small" style={{ margin: 0 }}>Where you usually work. Colleagues see it in the Directory, and it shows above each day in Calendar, where you can change a single day.</p>
      <div className="workloc-week">
        {DAYS.map(([d, name]) => (
          <label key={d} className="field"><span>{name}</span>
            <select value={week[d] || ''} onChange={(e) => set(d, e.target.value)}>
              <option value="">Not set</option><option value="office">🏢 Office</option><option value="home">🏠 Home</option><option value="other">📍 Elsewhere</option>
            </select></label>
        ))}
      </div>
    </section>
  );
}

/** Download your data: one .zip with everything you own, in formats other programs open. */
function YourData() {
  const toast = useToast();
  const restoreRef = useRef(null);
  const [restoring, setRestoring] = useState(false);
  const [pickingZip, setPickingZip] = useState(false);
  const [progress, setProgress] = useState(null);
  const [step, setStep] = useState(null); // a background restore's progress: { step, done, total }
  const STEPS = { starting: 'Starting', calendar: 'Calendar', contacts: 'Contacts', tasks: 'Tasks', settings: 'Settings', drive: 'Drive', notes: 'Notes' };
  // One already running (started before this page was opened): show it until it's done.
  useEffect(() => {
    let stop = false;
    get('/takeout/restore/status').then(async (st) => {
      if (st.status !== 'running') return;
      setRestoring(true);
      while (!stop) {
        setStep(st);
        if (st.status !== 'running') { setRestoring(false); setStep(null); if (st.status === 'done') toast('Your data has been brought in'); break; }
        await new Promise((ok) => setTimeout(ok, 1500));
        st = await get('/takeout/restore/status').catch(() => st);
      }
    }).catch(() => {});
    return () => { stop = true; };
  }, [toast]);
  // A .zip from this computer (a big one goes to Drive first, then in from there), or one already in Drive (fileId).
  const restore = async (file, fileId = null) => {
    setRestoring(true);
    try {
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
      let r;
      if (!fileId && file.size > 190 * 1024 * 1024) {
        const up = await uploadFile(file, null, (p) => setProgress(p));
        setProgress(null);
        fileId = up.id;
      }
      if (fileId) {
        // From Drive: in the background, its progress on the button until it's done.
        await post(`/takeout/restore?file_id=${encodeURIComponent(fileId)}&tz=${tz}&background=1`, {});
        for (;;) {
          await new Promise((ok) => setTimeout(ok, 1000));
          const st = await get('/takeout/restore/status');
          setStep(st);
          if (st.status === 'failed') throw new Error(st.error || 'Bringing your data in didn’t finish');
          if (st.status === 'done') { r = st.result; break; }
        }
      } else r = await postBlob(`/takeout/restore?tz=${tz}`, file, 'application/zip');
      const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
      const parts = [r.drive?.files > 0 && `${n(r.drive.files, 'file', 'files')} into “${r.drive.folder}” in Drive`, r.mail?.started && `${n(r.mail.folders, 'mail folder', 'mail folders')} (Mail shows the import’s progress)`,
        r.calendar && n(r.calendar.added, 'event', 'events'), r.contacts && n(r.contacts.added, 'contact', 'contacts'),
        r.tasks && `${n(r.tasks.lists, 'task list', 'task lists')} (${n(r.tasks.tasks, 'task', 'tasks')})`, r.notes && n(r.notes.added, 'note', 'notes'),
        r.filters && n(r.filters.added, 'mail filter', 'mail filters'), r.templates && n(r.templates.added, 'email template', 'email templates'),
        r.event_templates && n(r.event_templates.added, 'event template', 'event templates'), r.signatures?.added && n(r.signatures.added, 'signature', 'signatures')].filter(Boolean);
      toast(`Brought in ${parts.join(', ') || 'nothing new'}`);
      for (const x of [r.mail, r.filters, r.templates, r.event_templates, r.signatures]) if (x?.error) toast(x.error, 'error');
      get('/takeout/summary').then(setSum).catch(() => {});
    } catch (err) { toast(err.message, 'error'); } finally { setRestoring(false); setProgress(null); setStep(null); }
  };
  const [sum, setSum] = useState(null);
  useEffect(() => { get('/takeout/summary').then(setSum).catch(() => {}); }, []);
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  return (
    <section className="card stack" aria-labelledby="yourdata-h">
      <h2 id="yourdata-h">Download your data</h2>
      <p className="muted small" style={{ margin: 0 }}>One .zip with everything you own: your Drive with its folders (documents as Word, spreadsheets as Excel, presentations as PowerPoint), your calendar (.ics), contacts (.vcf), tasks (a spreadsheet), notes, comments (a spreadsheet), your chat conversations (as text), your forms with their responses, and your email (an .mbox file for each folder, which Thunderbird, Apple Mail and most mail programs open) with your filters, signatures and vacation reply.</p>
      {sum && <p className="small" style={{ margin: 0 }}>{n(sum.files, 'file', 'files')} ({formatBytes(sum.bytes)} of uploads) · {n(sum.events, 'event', 'events')} · {n(sum.contacts, 'contact', 'contacts')} · {n(sum.tasks, 'task', 'tasks')} · {n(sum.notes, 'note', 'notes')}{sum.comments != null && <> · {n(sum.comments, 'comment', 'comments')}</>}{sum.conversations != null && <> · {n(sum.conversations, 'conversation', 'conversations')}</>}{sum.forms != null && <> · {n(sum.forms, 'form', 'forms')}</>}{sum.mail != null && <> · {n(sum.mail, 'email', 'emails')}</>}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <a className="btn" href="/api/takeout" download><Icon name="download" size={18} /> Download your data (.zip)</a>
        <button type="button" className="btn" disabled={restoring} title="A .zip from Download your data (here or on another Workspace server): its calendar, contacts, task lists and notes are added to yours" onClick={() => restoreRef.current?.click()}>
          <Icon name="upload" size={18} /> {restoring ? (progress != null ? `Uploading… ${Math.round(progress * 100)}%` : step?.step ? `Bringing it in: ${STEPS[step.step] || step.step}${step.total ? ` (${step.done} of ${step.total})` : ''}…` : 'Bringing it in…') : 'Bring in your data…'}</button>
        <button type="button" className="btn" disabled={restoring} title="A Download your data .zip you've put in Drive (for one too big to send from here)" onClick={() => setPickingZip(true)}>Bring in from Drive…</button>
        <input ref={restoreRef} type="file" accept=".zip,application/zip" hidden aria-label="Your data to bring in" onChange={(e) => {
          const f = e.target.files[0]; e.target.value = '';
          if (f) restore(f);
        }} />
      </div>
      {pickingZip && <DrivePicker title="Bring in a Download your data .zip" accept={(x) => x.kind === 'file' && /\.zip$/i.test(x.name)} empty="No .zip files found. Upload one to Drive first." onClose={() => setPickingZip(false)} onPick={(x) => { setPickingZip(false); restore(null, x.id); }} />}
      <p className="muted small" style={{ margin: 0 }}><strong>Bring in your data…</strong> takes such a .zip back (from here or another Workspace server): its Drive, calendar, contacts, task lists and notes, and your mail filters, email templates, signature and event templates, are added to yours; events, contacts and settings you already have are skipped. Its Drive comes in as one new folder (“From your data” and the date) with its folders and files as they were. Its email goes back into your mailbox (in the background; Mail shows how it's going), each folder where it was, and the .mbox files are kept in that Drive folder too.</p>
    </section>
  );
}

/** Where Workspace opens: Drive or Home (kept with your account). */
function StartPage() {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const set = async (page) => {
    try { await put('/users/me/start-page', { page }); setUser({ ...user, start_page: page }); toast(`Workspace now opens on ${page === 'home' ? 'Home' : 'Drive'}`); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <label className="field" style={{ maxWidth: 320 }}><span>Open Workspace on</span>
      <select value={user.start_page || 'drive'} onChange={(e) => set(e.target.value)}>
        <option value="drive">Drive</option><option value="home">Home (the day at a glance)</option>
      </select></label>
  );
}

/** Who can read and answer your mail (an assistant, a stand-in), and whose mail you can. */
function MailDelegates() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [email, setEmail] = useState('');
  const [people, setPeople] = useState([]);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    get('/mail/status').then((s) => { if (!s.enabled) return; setOk(true); get('/mail/delegates').then(setD).catch(() => {}); get('/users/directory').then(setPeople).catch(() => {}); }).catch(() => {});
  }, []);
  if (!ok || !d) return null;
  const add = async (e) => {
    e.preventDefault();
    try { const mine = await post('/mail/delegates', { email }); setD({ ...d, mine }); setEmail(''); toast('They can now read and answer your mail'); } catch (err) { toast(err.message, 'error'); }
  };
  const remove = async (p) => { try { const mine = await del(`/mail/delegates/${p.id}`); setD({ ...d, mine }); toast(`${p.name} no longer has your mail`); } catch (err) { toast(err.message, 'error'); } };
  return (
    <section className="card stack" aria-labelledby="deleg-h">
      <h2 id="deleg-h">Mail delegation</h2>
      <p className="muted small" style={{ margin: 0 }}>Let a colleague (an assistant, or someone standing in for you) read and answer your mail. They pick it under <strong>Mailbox</strong> in Mail; what they send comes from you and says they sent it. Your filters, signatures and settings stay yours. Each change is in the activity log.</p>
      {d.mine.length > 0 && (
        <ul className="plain-list" aria-label="People who have your mail">
          {d.mine.map((p) => <li key={p.id} className="row small"><span className="grow"><strong>{p.name}</strong> <span className="muted">{p.username}</span></span>
            <button type="button" className="btn small" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>Remove</button></li>)}
        </ul>
      )}
      <form className="row" onSubmit={add} style={{ gap: 8 }}>
        <input className="grow" type="email" aria-label="Colleague's email address" list="deleg-people" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <datalist id="deleg-people">{people.map((p) => <option key={p.id} value={p.username}>{p.name}</option>)}</datalist>
        <button className="btn">Give access</button>
      </form>
      {d.toMe.length > 0 && <p className="muted small" style={{ margin: 0 }}>You can read and answer the mail of {d.toMe.map((p) => p.name).join(', ')} (Mail → Mailbox).</p>}
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
      <p className="muted small">iPhone and iPad: Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account (and Contacts → Add CardDAV Account). Android: the free DAVx⁵ app, "Login with URL and user name". Your own calendars (Calendar → My calendars) show as separate calendars there, in their colours; events you add to one on the phone go in it, and renaming or recolouring one there is kept. Calendars colleagues share with you are there too: read-only, or changeable if they let you make changes.</p>
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
/** Other apps (registered by an admin) you've let sign you in with Workspace; taking one back signs you out of it. */
function SignInApps() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => get('/oauth/grants').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list?.length) return null;
  return (
    <section className="card stack" aria-labelledby="signin-apps-h">
      <h2 id="signin-apps-h">Apps you sign in to</h2>
      <p className="muted small">Your company's other apps that you've let sign you in with Workspace. Removing one signs you out of it; it asks again next time.</p>
      <ul className="device-list" aria-label="Apps you sign in to">
        {list.map((g) => (
          <li key={g.client_id}>
            <span className="grow"><strong>{g.name}</strong><span className="muted small"> · allowed {new Date(g.granted_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span></span>
            <button type="button" className="btn small" aria-label={`Remove ${g.name}`} onClick={async () => { try { await api('DELETE', `/oauth/grants/${g.client_id}`); toast(`${g.name} removed`); load(); } catch (e) { toast(e.message, 'error'); } }}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

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

/** The company's password rules, in a line, where a new password is chosen. */
function PasswordRulesNote() {
  const [text, setText] = useState('');
  useEffect(() => { get('/auth/password-rules').then((r) => setText(r.text)).catch(() => {}); }, []);
  return text ? <p className="muted small" role="note" style={{ margin: 0 }}>{text}</p> : null;
}

/** A personal address for "Forgot password?" on the sign-in page (the link is emailed there). */
const when = (ms) => (ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/** Personal API tokens for scripts: made here, shown once, revoked here (or by an admin). */
function ApiTokens() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // { name, scope, days } while making one
  const [made, setMade] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const load = () => get('/tokens').then(setData).catch(() => setData({ allowed: false, tokens: [] }));
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const create = async (e) => {
    e.preventDefault();
    try { const t = await post('/tokens', { ...form, days: Number(form.days) }); setMade(t); setForm(null); load(); } catch (err) { toast(err.message, 'error'); }
  };
  const revoke = async (t) => {
    try { await del(`/tokens/${t.id}`); toast(`“${t.name}” revoked`); load(); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <section className="card stack" aria-labelledby="tokens-h">
      <h2 id="tokens-h">API tokens</h2>
      <p className="muted small" style={{ margin: 0 }}>For your own scripts and tools (a backup job, uploads from a scanner, a report): they use Workspace's API as you, with <code>Authorization: Bearer …</code>. A token can't sign in, change your account or make more tokens. Keep it secret like a password.</p>
      {!data.allowed && !data.tokens.length ? <p className="muted">Your company hasn't turned on API tokens. An admin can, in Admin → Company settings.</p> : <>
        {made && (
          <div className="stack-tight" role="status">
            <p style={{ margin: 0 }}><strong>Your new token “{made.name}”.</strong> Copy it now: it's shown only once.</p>
            <div className="row"><code className="secret-key grow" aria-label="New API token">{made.token}</code>
              <button type="button" className="btn small" onClick={() => { navigator.clipboard?.writeText(made.token).then(() => toast('Copied'), () => {}); }}>Copy</button></div>
            <p className="muted small" style={{ margin: 0 }}>Try it: <code>{`curl -H "Authorization: Bearer ${made.token.slice(0, 8)}…" ${window.location.origin}/api/files`}</code></p>
            <button type="button" className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setMade(null)}>Done, I've copied it</button>
          </div>
        )}
        {data.tokens.length > 0 && (
          <ul className="plain-list" aria-label="Your API tokens">
            {data.tokens.map((t) => (
              <li key={t.id} className="row small">
                <span className="grow"><strong>{t.name}</strong> <span className="muted">…{t.hint} · {t.scope === 'write' ? 'read and write' : 'read only'} · made {when(t.created_at)} · {t.expired ? 'expired' : t.expires_at ? `expires ${when(t.expires_at)}` : 'never expires'} · {t.last_used_at ? `last used ${when(t.last_used_at)}${t.last_ip ? ` from ${t.last_ip}` : ''}` : 'never used'}</span></span>
                <button type="button" className="btn small" aria-label={`Revoke ${t.name}`} onClick={() => setRevoking(t)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
        {data.allowed && (form ? (
          <form className="stack-tight" onSubmit={create} aria-label="Make an API token">
            <label className="field"><span>What it's for</span><input autoFocus required maxLength={80} value={form.name} placeholder="e.g. Nightly backup" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <div className="row wrap" style={{ gap: 12 }}>
              <label className="field"><span>Access</span><select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}><option value="read">Read only</option><option value="write">Read and write</option></select></label>
              <label className="field"><span>Expires</span><select value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="0">Never</option></select></label>
            </div>
            <div className="row"><button className="btn primary">Make token</button><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button></div>
          </form>
        ) : <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => { setMade(null); setForm({ name: '', scope: 'read', days: '90' }); }}>New token</button>)}
        {!data.allowed && <p className="muted small">Your company has turned API tokens off, so these don't work now.</p>}
      </>}
      {revoking && <ConfirmModal title={`Revoke “${revoking.name}”?`} message="Scripts using it stop working at once." confirm="Revoke"
        onClose={() => setRevoking(null)} onConfirm={async () => { const t = revoking; setRevoking(null); await revoke(t); }} />}
    </section>
  );
}

function RecoveryEmail() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState(user.recovery_email || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const save = async (value) => {
    setError('');
    try {
      const r = await put('/auth/recovery-email', { email: value || null, password });
      setUser({ ...user, recovery_email: r.recovery_email });
      setPassword('');
      toast(r.recovery_email ? `Recovery address saved: ${r.recovery_email}` : 'Recovery address removed');
    } catch (e) { setError(e.message); }
  };
  return (
    <form className="card stack" aria-labelledby="rec-h" onSubmit={(e) => { e.preventDefault(); save(email.trim()); }}>
      <h2 id="rec-h">Recovery email</h2>
      <p className="muted small" style={{ margin: 0 }}>A personal address (not this account's) where <strong>Forgot password?</strong> on the sign-in page can send you a link to choose a new password.
        {user.recovery_email ? <> Now: <strong>{user.recovery_email}</strong>.</> : ' None yet.'}</p>
      <label className="field"><span>Recovery address</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" /></label>
      <label className="field"><span>Your password (to confirm it's you)</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        {user.recovery_email && <button type="button" className="btn" onClick={() => { if (password) { setEmail(''); save(''); } else setError('Type your password to remove it'); }}>Remove</button>}
        <button className="btn primary" disabled={!email.trim()}>Save</button>
      </div>
    </form>
  );
}
