import { unreachable, tryLater, forgetAll } from './apps/offlinedocs.js';
import TimerChip from './components/TimerChip.jsx';
import NextMeeting from './components/NextMeeting.jsx';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import OAuthConsent from './apps/oauth/Consent.jsx';
import OAuthSignOut from './apps/oauth/SignOut.jsx';
import { setBadgePart } from './appbadge.js';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate, useParams } from 'react-router';
import { api, get, post, patch, startLive, stopLive, onLive, idleMs } from './api.js';
import { useMailStatus } from './mailStatus.js';
import { useMailNotifications } from './mailNotify.js';
import { useEventReminders } from './eventReminders.js';
import { syncVoiceLang } from './apps/docs/keptpref.js';
import { useTaskReminders } from './taskReminders.js';
import Icon from './components/Icon.jsx';
import Bell from './components/Bell.jsx';
import GlobalSearch from './components/GlobalSearch.jsx';
import Announcements from './components/Announcements.jsx';
import BrandMark from './components/BrandMark.jsx';
import { applyAccent } from './theme.js';
import { Avatar, Menu, ToastProvider, useToast, DataCheckHost } from './components/ui.jsx';
import Login, { ResetPassword } from './apps/Login.jsx';
const PublishedPage = lazy(() => import('./apps/PublishedPage.jsx'));
const PublicLink = lazy(() => import('./apps/PublicLink.jsx'));
import InviteAnswer from './apps/calendar/InviteAnswer.jsx';
const SignPage = lazy(() => import('./apps/docs/Signatures.jsx').then((m) => ({ default: m.SignPage })));
const SignRoute = () => <Suspense fallback={<Loading />}><SignPage token={useParams().token} /></Suspense>;
import BookingPage, { CancelBooking } from './apps/calendar/BookingPage.jsx';
import Unsubscribe from './apps/Unsubscribe.jsx';
import ConfidentialPage from './apps/mail/ConfidentialPage.jsx';
import { TwoStep } from './apps/Settings.jsx';
const Drive = lazy(() => import('./apps/drive/Drive.jsx'));
const DocEditor = lazy(() => import('./apps/docs/DocEditor.jsx'));
import RequestAccess from './apps/RequestAccess.jsx';
const SheetEditor = lazy(() => import('./apps/sheets/SheetEditor.jsx'));
const SlidesEditor = lazy(() => import('./apps/slides/SlidesEditor.jsx'));
const PresenterView = lazy(() => import('./apps/slides/PresenterView.jsx'));
import { QaPage } from './apps/slides/SlideQa.jsx';
import { ShortcutsHelp } from './components/Shortcuts.jsx';
import { StatusDialog, useMyStatus } from './components/StatusDialog.jsx';
import { statusLine } from './components/status.js';
import { usePause, pauseUntil, pauseChoices, isQuietHours } from './pause.js';
import { whenText } from './components/schedule.jsx';
const Calendar = lazy(() => import('./apps/calendar/Calendar.jsx'));
const Contacts = lazy(() => import('./apps/contacts/Contacts.jsx'));
const Tasks = lazy(() => import('./apps/tasks/Tasks.jsx'));
const Forms = lazy(() => import('./apps/forms/Forms.jsx'));
const Notes = lazy(() => import('./apps/notes/Notes.jsx'));
const Home = lazy(() => import('./apps/home/Home.jsx'));
const Meet = lazy(() => import('./apps/meet/Meet.jsx'));
const MeetRoom = lazy(() => import('./apps/meet/MeetRoom.jsx'));
import FormRespond from './apps/forms/FormRespond.jsx';
const Chat = lazy(() => import('./apps/chat/Chat.jsx'));
const Admin = lazy(() => import('./apps/admin/Admin.jsx'));
const Mail = lazy(() => import('./apps/mail/Mail.jsx'));
const Settings = lazy(() => import('./apps/Settings.jsx'));

const AuthCtx = createContext(null);
const LAST_USER = 'nw-last-user';
/** Who's signed in here now: remembered for opening offline; someone else than last time gets nothing of the last person's. */
function rememberUser(user) {
  try {
    const was = JSON.parse(localStorage.getItem(LAST_USER) || 'null');
    if (was && was.id !== user.id) forgetAll();
    localStorage.setItem(LAST_USER, JSON.stringify(user));
  } catch { /* private mode */ }
}
export const useAuth = () => useContext(AuthCtx);

export default function App() {
  // Share links work without an account, signed in or not.
  const link = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (link) return <Suspense fallback={<Loading />}><PublicLink token={link[1]} /></Suspense>;
  // Answering a calendar invitation from outside (no account).
  const invite = window.location.pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/?$/);
  // Booking time from a booking link (no account needed).
  const booking = window.location.pathname.match(/^\/b\/([A-Za-z0-9_-]+)\/?$/);
  if (booking) return <BookingPage token={booking[1]} />;
  const cancelling = window.location.pathname.match(/^\/b\/cancel\/([A-Za-z0-9_-]+)\/?$/);
  if (cancelling) return <CancelBooking token={cancelling[1]} />;
  // Unsubscribing from someone's mail merge emails (no account).
  const unsub = window.location.pathname.match(/^\/u\/([A-Za-z0-9_-]+)\/?$/);
  if (unsub) return <Unsubscribe token={unsub[1]} />;
  // A confidential message (Mail → 🔒): its recipients read it here.
  const confidential = window.location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/);
  if (confidential) return <ConfidentialGate token={confidential[1]} />;
  // Filling in a form (company forms ask you to sign in first).
  const form = window.location.pathname.match(/^\/f\/([A-Za-z0-9_-]+)\/?$/);
  if (form) return <FormGate token={form[1]} />;
  // Signing a document from a private link (no account needed).
  // A published document, spreadsheet or presentation (no account needed).
  const pub = window.location.pathname.match(/^\/pub\/([A-Za-z0-9_-]+)\/?$/);
  if (pub) return <Suspense fallback={<Loading />}><PublishedPage token={pub[1]} /></Suspense>;
  // Choosing a new password from a "Forgot password?" email (no account session needed).
  const reset = window.location.pathname.match(/^\/reset\/([A-Za-z0-9_-]+)\/?$/);
  if (reset) return <ToastProvider><ResetPassword token={reset[1]} /></ToastProvider>;
  const sign = window.location.pathname.match(/^\/sign\/([A-Za-z0-9_-]+)\/?$/);
  if (sign) return <Suspense fallback={<Loading />}><SignPage token={sign[1]} /></Suspense>;
  return invite ? <InviteAnswer token={invite[1]} /> : <Workspace />;
}

/** A confidential message, or signing in to read it (colleagues), coming back to it after. */
function ConfidentialGate({ token }) {
  const [signIn, setSignIn] = useState(false);
  if (!signIn) return <ConfidentialPage token={token} onSignIn={() => setSignIn(true)} />;
  return (
    <AuthCtx.Provider value={{ user: null, setUser: () => window.location.reload() }}>
      <ToastProvider><Login /></ToastProvider>
    </AuthCtx.Provider>
  );
}

function FormGate({ token }) {
  const [signIn, setSignIn] = useState(false);
  if (!signIn) return <FormRespond token={token} onSignIn={() => setSignIn(true)} />;
  return (
    <AuthCtx.Provider value={{ user: null, setUser: () => window.location.reload() }}>
      <ToastProvider><Login /></ToastProvider>
    </AuthCtx.Provider>
  );
}

function Workspace() {
  const [state, setState] = useState({ loading: true, user: null, needsSetup: false });
  // A meeting link opened without being signed in: join as a guest (or sign in instead).
  const [guestSignIn, setGuestSignIn] = useState(false);
  const guestMeet = /^\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(window.location.pathname) && !guestSignIn;

  useEffect(() => {
    // Who was signed in here last is remembered (just their name and settings, not the session), so that without a
    // connection the app still opens for them, with the documents kept on this device.
    get('/auth/status').then((s) => {
      // (Not signed in: who was here last is still remembered, so that someone else signing in gets nothing of theirs.)
      if (s.user) rememberUser(s.user);
      setState({ loading: false, ...s });
    }).catch((e) => {
      let last = null;
      if (unreachable(e)) { try { last = JSON.parse(localStorage.getItem(LAST_USER) || 'null'); } catch { /* none */ } }
      setState({ loading: false, user: last });
    });
    const onOut = () => setState((s) => {
      // Signed out by the company's limit on time away: say so on the sign-in page.
      if (s.user?.session_idle_min && idleMs() > s.user.session_idle_min * 60e3) { try { sessionStorage.setItem('nw-signed-out', `You were signed out after ${s.user.session_idle_min} minutes without activity.`); } catch { /* private mode */ } }
      // (Still remembered: the next person signing in here, if it's someone else, gets nothing of theirs.)
      return { ...s, user: null };
    });
    window.addEventListener('nw:signed-out', onOut);
    return () => window.removeEventListener('nw:signed-out', onOut);
  }, []);

  useEffect(() => {
    if (state.user) startLive(); else stopLive();
  }, [state.user]);
  // Away longer than the company allows: check now and then (the next request is turned away).
  const idleLimit = state.user?.session_idle_min;
  useEffect(() => {
    if (!idleLimit) return undefined;
    const t = setInterval(() => { if (idleMs() > idleLimit * 60e3) get('/auth/me').catch((e) => { if (e.status === 401) window.dispatchEvent(new Event('nw:signed-out')); }); }, 15000);
    return () => clearInterval(t);
  }, [idleLimit]);

  if (state.loading) return <div className="splash">Loading…</div>;

  const auth = {
    user: state.user,
    setUser: (user) => { if (user) rememberUser(user); setState((s) => ({ ...s, user, needsSetup: false })); },
    logout: async () => { await post('/auth/logout').catch(() => {}); try { localStorage.removeItem(LAST_USER); } catch { /* private mode */ } await forgetAll(); setState((s) => ({ ...s, user: null })); },
  };

  return (
    <AuthCtx.Provider value={auth}>
      <ToastProvider>
        {!state.user ? (guestMeet && !state.needsSetup
          ? <BrowserRouter><Suspense fallback={<Loading />}><Routes><Route path="/meet/:code" element={<MeetRoom guest onSignIn={() => setGuestSignIn(true)} />} /></Routes></Suspense></BrowserRouter>
          : <Login needsSetup={state.needsSetup} canReset={!!state.can_reset} />) : state.user.needs_two_factor ? <RequiredTwoStep /> : state.user.must_change_password ? <RequiredPassword /> : (
          <BrowserRouter>
            <ShortcutsHelp />
            <DataCheckHost />
            <SendUnsent />
            <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/docs/:id" element={<DocEditor />} />
              <Route path="/access/:id" element={<RequestAccess />} />
              <Route path="/sheets/:id" element={<SheetEditor />} />
              <Route path="/slides/:id/presenter" element={<PresenterView />} />
              <Route path="/slides/:id" element={<SlidesEditor />} />
              <Route path="/qa/:code" element={<QaPage />} />
              <Route path="/meet/:code" element={<MeetRoom />} />
              <Route path="/oauth/consent" element={<OAuthConsent />} />
              <Route path="/oauth/signout" element={<OAuthSignOut />} />
              <Route path="*" element={<Shell />} />
            </Routes>
            </Suspense>
          </BrowserRouter>
        )}
      </ToastProvider>
    </AuthCtx.Provider>
  );
}

const lastUserId = () => { try { return JSON.parse(localStorage.getItem(LAST_USER) || 'null')?.id || null; } catch { return null; } };
/** Changes made offline to files not open now, and email sent offline: sent once there's a connection (at start, and when the network is back). */
function SendUnsent() {
  const toast = useToast();
  useEffect(() => {
    const run = async () => {
      if (!navigator.onLine) return;
      const [{ sendUnsent }, { WebsocketProvider }] = await Promise.all([import('./apps/KeptCopy.jsx'), import('y-websocket')]);
      // Email sent while offline goes first (it's waited longest), then what was changed in files.
      const { outboxList, outboxRemove, outboxNote } = await import('./apps/offlinedocs.js');
      let mails = 0;
      for (const m of await outboxList(lastUserId())) {
        if (m.error) continue; // refused before: left for the person to see (and delete)
        try { await post('/mail/send', m.body, { mailbox: m.mailbox || null }); await outboxRemove(m.id); mails++; }
        catch (e) { if (tryLater(e)) break; await outboxNote(m.id, m, e.message); window.dispatchEvent(new Event('nw:outbox')); toast(`“${m.subject || '(no subject)'}” couldn’t be sent: ${e.message}`, 'error'); }
      }
      if (mails) toast(`Sent ${mails} email${mails === 1 ? '' : 's'} written while offline`);
      // Changes made offline (Tasks, Notes, Chat messages), in the order they were made (one deleted meanwhile: that change is dropped).
      const { changeList, changeRemove } = await import('./apps/offlinedocs.js');
      let changed = 0;
      for (const c of await changeList(lastUserId())) {
        try { await api(c.method, c.url, c.body, c.url.startsWith('/mail/') ? { mailbox: c.mailbox || null } : {}); await changeRemove(c.id); changed++; } // mail: in the mailbox it was made in
        catch (e) {
          if (tryLater(e)) break; // kept for the next try (signed out, or the server restarting)
          if (c.method === 'DELETE' && e.status === 404) { await changeRemove(c.id); changed++; continue; } // already gone: deleted all the same
          await changeRemove(c.id); toast(`A change made offline to “${c.label || 'something'}” couldn’t be made: ${e.message}`, 'error'); }
      }
      if (changed) { toast(`Sent ${changed} change${changed === 1 ? '' : 's'} made offline`); window.dispatchEvent(new Event('nw:changes-sent')); }
      const r = await sendUnsent(WebsocketProvider);
      if (r.sent) toast(`Sent what you changed offline in ${r.sent} file${r.sent === 1 ? '' : 's'}`);
      import('./apps/KeptCopy.jsx').then((m) => m.refreshPinned()).catch(() => {}); // files made available offline: kept recent
      for (const f of r.copies) toast(`A file was changed elsewhere while you were offline: your changes are in “${f.name}”`, 'info', { duration: 10000 });
    };
    // One run at a time (the network and the live connection can come back together: nothing is sent twice).
    let running = null, again = false;
    const go = () => {
      if (running) { again = true; return; }
      running = run().catch(() => {}).finally(() => { running = null; if (again) { again = false; go(); } });
    };
    go();
    window.addEventListener('online', go);
    window.addEventListener('nw:send-unsent', go); // Settings → This device: Send now
    const off = onLive((m) => { if (m.type === 'live-connected') go(); }); // Workspace answers again (it was restarting)
    return () => { window.removeEventListener('online', go); window.removeEventListener('nw:send-unsent', go); off(); };
  }, [toast]);
  return null;
}

/** The company requires two-step verification: set it up before anything else. */
function RequiredTwoStep() {
  const { user, setUser, logout } = useAuth();
  return (
    <div className="auth-page">
      <div className="auth-card stack wide">
        <div className="brand big"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div>
        <h1>Set up two-step verification</h1>
        <p className="muted">{user.org_name} requires two-step verification for everyone. Set it up now to continue: you'll need your phone with an authenticator app.</p>
        <TwoStep onEnabled={async () => setUser((await get('/auth/me')).user)} />
        <button type="button" className="link-btn" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

/** An admin set this person's password: they choose their own before anything else. */
function RequiredPassword() {
  const { user, setUser, logout } = useAuth();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [rules, setRules] = useState('');
  useEffect(() => { get('/auth/password-rules').then((r) => setRules(r.text)).catch(() => {}); }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (f.next !== f.again) { setError('The new passwords don’t match'); return; }
    setBusy(true);
    try { setUser((await patch('/auth/me', { currentPassword: f.current, newPassword: f.next })).user); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <div className="auth-page">
      <form className="auth-card stack" onSubmit={submit}>
        <div className="brand big"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div>
        <h1>{user.password_leaked ? 'Choose a new password' : 'Choose your own password'}</h1>
        <p className="muted">{user.password_leaked ? `Your password has turned up in data breaches, ${user.name}, so attackers may try it. Choose a new one (not used anywhere else) to continue.` : user.password_expired ? `Your password has expired, ${user.name}. Choose a new one to continue.` : `Welcome, ${user.name}. Your password was set by an administrator; choose one only you know to continue.`}</p>
        {rules && <p className="small" role="note" style={{ margin: 0 }}>{rules}</p>}
        <label className="field"><span>{user.password_leaked || user.password_expired ? 'Current password' : 'Password you were given'}</span><input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
        <label className="field"><span>New password</span><input type="password" autoComplete="new-password" required minLength={8} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></label>
        <label className="field"><span>New password again</span><input type="password" autoComplete="new-password" required minLength={8} value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
        <button type="button" className="link-btn" onClick={logout}>Sign out</button>
      </form>
    </div>
  );
}

const APPS = [
  { to: '/home', icon: 'home', label: 'Home' },
  { to: '/mail', icon: 'mail', label: 'Mail', mail: true },
  { to: '/drive', icon: 'folder', label: 'Drive' },
  { to: '/calendar', icon: 'calendar', label: 'Calendar' },
  { to: '/contacts', icon: 'person', label: 'Contacts' },
  { to: '/tasks', icon: 'check', label: 'Tasks' },
  { to: '/chat', icon: 'chat', label: 'Chat' },
  { to: '/notes', icon: 'note', label: 'Notes' },
  { to: '/meet', icon: 'video', label: 'Meet' },
  { to: '/forms', icon: 'form', label: 'Forms' },
];

function Shell() {
  const { user, logout } = useAuth();
  useEffect(() => { applyAccent(user.org_accent); return () => applyAccent(null); }, [user.org_accent]); // the company's colour
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const mail = useMailStatus();
  const toast = useToast();
  const openMessage = useCallback((folder, uid) => navigate(`/mail/${encodeURIComponent(folder)}/${uid}`), [navigate]);
  const unread = useMailNotifications(!!mail?.enabled, { toast, openMessage });
  useEffect(() => { setBadgePart('mail', unread); }, [unread]); // on the app's icon, with notifications
  const openCalendar = useCallback(() => navigate('/calendar'), [navigate]);
  useEventReminders(true, { toast, openCalendar });
  useEffect(() => { syncVoiceLang(); }, []); // voice typing's language, kept with the account, for Meet and Slides too
  useTaskReminders({ toast, navigate });
  // Someone is calling you (a video call started in a direct message or a small private channel).
  useEffect(() => onLive((m) => {
    if (m.type !== 'ring') return;
    // From a chat, or asked from inside a meeting (no conversation: m.meeting is its name).
    toast(m.meeting ? `📞 ${m.from} is asking you to join “${m.meeting}”` : `📞 ${m.from} is calling you${m.title ? ` in #${m.title}` : ''}`, 'info', { duration: 30000, actions: [
      { label: 'Join', onClick: () => window.open(`/meet/${m.code}`, '_blank', 'noopener') },
      { label: 'Can’t talk', onClick: () => post(m.channel_id ? `/chat/channels/${m.channel_id}/ring/decline` : `/meet/${m.code}/invite/decline`, { to: m.from_id, code: m.code }).catch((e) => toast(e.message, 'error')) },
    ] });
  }), [toast]);
  // Someone on an event of yours is running late.
  useEffect(() => onLive((m) => {
    if (m.type !== 'running-late') return;
    toast(`⏱ ${m.text}`, 'info', { duration: 15000, action: { label: 'Open', onClick: () => navigate(`/calendar?event=${m.event_id}`) } });
  }), [toast, navigate]);
  // Someone booked time with you through a booking page.
  useEffect(() => onLive((m) => {
    if (m.type !== 'booking-made') return;
    const when = new Date(m.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    toast(`${m.by} booked “${m.page}” for ${when}`, 'info', { action: { label: 'Calendar', onClick: () => navigate('/calendar') } });
  }), [toast, navigate]);
  const chatUnread = useChatUnread();
  const [myStatus, setMyStatus] = useMyStatus(user.id);
  const paused = usePause(user.id);
  const setPause = async (at) => {
    try { await pauseUntil(at); toast(at ? `Notifications paused until ${whenText(at)}` : 'Notifications are back on'); } catch (e) { toast(e.message, 'error'); }
  };
  const [statusOpen, setStatusOpen] = useState(false);

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <header className="topbar">
        <button className="icon-btn mobile-only" aria-label="Menu" onClick={() => setNavOpen((o) => !o)}><Icon name="menu" /></button>
        <a className="brand" href="/drive" onClick={(e) => { e.preventDefault(); navigate('/drive'); }}>
          <BrandMark name={user.org_name} logo={user.org_logo} /><span className="brand-text">{user.org_name}</span>
        </a>
        <GlobalSearch />
        {user.cal_prefs?.nextMeeting !== false && <NextMeeting />}
        <TimerChip />
        {paused && (isQuietHours()
          ? <button type="button" className="icon-btn paused-mark" aria-label={`Quiet hours until ${whenText(paused)}. Settings`} title={`Quiet hours: notifications wait until ${whenText(paused)} (outside your working hours; change it in Settings)`} onClick={() => navigate('/settings')}>🔕</button>
          : <button type="button" className="icon-btn paused-mark" aria-label={`Notifications paused until ${whenText(paused)}. Resume`} title={`Notifications paused until ${whenText(paused)} (click to resume)`} onClick={() => setPause(null)}>🔕</button>)}
        <Bell />
        <Menu align="right" trigger={(p) => <button className="avatar-btn" aria-label="Account" title={myStatus ? statusLine(myStatus) : undefined} {...p}><Avatar name={user.name} userId={user.id} />{myStatus?.emoji && <span className="avatar-status" aria-hidden="true">{myStatus.emoji}</span>}</button>} items={[
          { label: `${user.name} · ${user.username}`, icon: 'person', onClick: () => navigate('/settings') },
          { label: myStatus ? `Status: ${statusLine(myStatus)}` : 'Set a status', icon: 'chat', onClick: () => setStatusOpen(true) },
          ...(paused ? [{ label: `Resume notifications (paused until ${whenText(paused)})`, icon: 'bell', onClick: () => setPause(null) }]
            : pauseChoices().map(([label, at]) => ({ label: `Pause notifications: ${label.toLowerCase()}`, icon: 'bell', onClick: () => setPause(at) }))),
          { label: 'Settings', icon: 'settings', onClick: () => navigate('/settings') },
          user.is_admin && { label: 'Admin console', icon: 'shield', onClick: () => navigate('/admin') },
          '-',
          { label: 'Sign out', icon: 'logout', onClick: logout },
        ]} />
      </header>
      {statusOpen && <StatusDialog current={myStatus} onClose={() => setStatusOpen(false)} onSaved={setMyStatus} />}
      <nav className="appnav" onClick={() => setNavOpen(false)}>
        {APPS.filter((a) => !a.mail || mail?.enabled).map((a) => (
          <NavLink key={a.to} to={a.to} className="appnav-item">
            <span className="appnav-icon"><Icon name={a.icon} />{a.mail && unread > 0 && <span className="nav-badge" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}{a.to === '/chat' && chatUnread > 0 && <span className="nav-badge" aria-label={`${chatUnread} unread`}>{chatUnread > 99 ? '99+' : chatUnread}</span>}</span>
            <span>{a.label}</span>
          </NavLink>
        ))}
        {user.is_admin && <NavLink to="/admin" className="appnav-item"><Icon name="shield" /><span>Admin</span></NavLink>}
      </nav>
      <main className="content">
        <Announcements />
        <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Navigate to={user.start_page === 'home' ? '/home' : '/drive'} replace />} />
          <Route path="/drive/*" element={<Drive />} />
          <Route path="/mail/:folder?/:uid?" element={<Mail />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/chat/:channelId?" element={<Chat />} />
          <Route path="/tasks/:listId?" element={<Tasks />} />
          <Route path="/forms/:id?" element={<Forms />} />
          <Route path="/sign/:token" element={<SignRoute />} />
          <Route path="/meet" element={<Meet />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/home" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          {user.is_admin && <Route path="/admin" element={<Admin />} />}
          <Route path="*" element={<Navigate to="/drive" replace />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}

/** Unread chat messages in all your conversations, for the badge on Chat. */
function useChatUnread() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let t = null;
    const load = () => { clearTimeout(t); t = setTimeout(() => get('/chat/channels').then((r) => setN(r.channels.reduce((sum, c) => sum + (c.muted ? c.mentions || 0 : c.unread || 0), 0))).catch(() => {}), 400); };
    load();
    const off = onLive((m) => { if (['message', 'chat-read', 'chat-unread', 'message-deleted', 'channels-changed', 'live-connected'].includes(m.type)) load(); });
    return () => { off(); clearTimeout(t); };
  }, []);
  return n;
}

/** While an app's code arrives (each app loads the first time it's opened). */
function Loading() {
  return <p className="muted page-loading" role="status" style={{ padding: 24 }}>Loading…</p>;
}
