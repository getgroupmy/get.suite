import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import OAuthConsent from './apps/oauth/Consent.jsx';
import OAuthSignOut from './apps/oauth/SignOut.jsx';
import { setBadgePart } from './appbadge.js';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate, useParams } from 'react-router';
import { get, post, patch, startLive, stopLive, onLive, idleMs } from './api.js';
import { useMailStatus } from './mailStatus.js';
import { useMailNotifications } from './mailNotify.js';
import { useEventReminders } from './eventReminders.js';
import { useTaskReminders } from './taskReminders.js';
import Icon from './components/Icon.jsx';
import Bell from './components/Bell.jsx';
import GlobalSearch from './components/GlobalSearch.jsx';
import Announcements from './components/Announcements.jsx';
import BrandMark from './components/BrandMark.jsx';
import { applyAccent } from './theme.js';
import { Avatar, Menu, ToastProvider, useToast, DataCheckHost } from './components/ui.jsx';
import Login, { ResetPassword } from './apps/Login.jsx';
import PublishedPage from './apps/PublishedPage.jsx';
import PublicLink from './apps/PublicLink.jsx';
import InviteAnswer from './apps/calendar/InviteAnswer.jsx';
import { SignPage } from './apps/docs/Signatures.jsx';
const SignRoute = () => <SignPage token={useParams().token} />;
import BookingPage, { CancelBooking } from './apps/calendar/BookingPage.jsx';
import ConfidentialPage from './apps/mail/ConfidentialPage.jsx';
import { TwoStep } from './apps/Settings.jsx';
import Drive from './apps/drive/Drive.jsx';
import DocEditor from './apps/docs/DocEditor.jsx';
import RequestAccess from './apps/RequestAccess.jsx';
import SheetEditor from './apps/sheets/SheetEditor.jsx';
import SlidesEditor from './apps/slides/SlidesEditor.jsx';
import PresenterView from './apps/slides/PresenterView.jsx';
import { ShortcutsHelp } from './components/Shortcuts.jsx';
import { StatusDialog, useMyStatus } from './components/StatusDialog.jsx';
import { statusLine } from './components/status.js';
import { usePause, pauseUntil, pauseChoices, isQuietHours } from './pause.js';
import { whenText } from './components/schedule.jsx';
import Calendar from './apps/calendar/Calendar.jsx';
import Contacts from './apps/contacts/Contacts.jsx';
import Tasks from './apps/tasks/Tasks.jsx';
import Forms from './apps/forms/Forms.jsx';
import Notes from './apps/notes/Notes.jsx';
import Home from './apps/home/Home.jsx';
import Meet from './apps/meet/Meet.jsx';
import MeetRoom from './apps/meet/MeetRoom.jsx';
import FormRespond from './apps/forms/FormRespond.jsx';
import Chat from './apps/chat/Chat.jsx';
import Admin from './apps/admin/Admin.jsx';
import Mail from './apps/mail/Mail.jsx';
import Settings from './apps/Settings.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export default function App() {
  // Share links work without an account, signed in or not.
  const link = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (link) return <PublicLink token={link[1]} />;
  // Answering a calendar invitation from outside (no account).
  const invite = window.location.pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/?$/);
  // Booking time from a booking link (no account needed).
  const booking = window.location.pathname.match(/^\/b\/([A-Za-z0-9_-]+)\/?$/);
  if (booking) return <BookingPage token={booking[1]} />;
  const cancelling = window.location.pathname.match(/^\/b\/cancel\/([A-Za-z0-9_-]+)\/?$/);
  if (cancelling) return <CancelBooking token={cancelling[1]} />;
  // A confidential message (Mail → 🔒): its recipients read it here.
  const confidential = window.location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/);
  if (confidential) return <ConfidentialGate token={confidential[1]} />;
  // Filling in a form (company forms ask you to sign in first).
  const form = window.location.pathname.match(/^\/f\/([A-Za-z0-9_-]+)\/?$/);
  if (form) return <FormGate token={form[1]} />;
  // Signing a document from a private link (no account needed).
  // A published document, spreadsheet or presentation (no account needed).
  const pub = window.location.pathname.match(/^\/pub\/([A-Za-z0-9_-]+)\/?$/);
  if (pub) return <PublishedPage token={pub[1]} />;
  // Choosing a new password from a "Forgot password?" email (no account session needed).
  const reset = window.location.pathname.match(/^\/reset\/([A-Za-z0-9_-]+)\/?$/);
  if (reset) return <ToastProvider><ResetPassword token={reset[1]} /></ToastProvider>;
  const sign = window.location.pathname.match(/^\/sign\/([A-Za-z0-9_-]+)\/?$/);
  if (sign) return <SignPage token={sign[1]} />;
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
    get('/auth/status').then((s) => setState({ loading: false, ...s })).catch(() => setState({ loading: false, user: null }));
    const onOut = () => setState((s) => {
      // Signed out by the company's limit on time away: say so on the sign-in page.
      if (s.user?.session_idle_min && idleMs() > s.user.session_idle_min * 60e3) { try { sessionStorage.setItem('nw-signed-out', `You were signed out after ${s.user.session_idle_min} minutes without activity.`); } catch { /* private mode */ } }
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
    const t = setInterval(() => { if (idleMs() > idleLimit * 60e3) get('/auth/me').catch(() => window.dispatchEvent(new Event('nw:signed-out'))); }, 15000);
    return () => clearInterval(t);
  }, [idleLimit]);

  if (state.loading) return <div className="splash">Loading…</div>;

  const auth = {
    user: state.user,
    setUser: (user) => setState((s) => ({ ...s, user, needsSetup: false })),
    logout: async () => { await post('/auth/logout').catch(() => {}); setState((s) => ({ ...s, user: null })); },
  };

  return (
    <AuthCtx.Provider value={auth}>
      <ToastProvider>
        {!state.user ? (guestMeet && !state.needsSetup
          ? <BrowserRouter><Routes><Route path="/meet/:code" element={<MeetRoom guest onSignIn={() => setGuestSignIn(true)} />} /></Routes></BrowserRouter>
          : <Login needsSetup={state.needsSetup} canReset={!!state.can_reset} />) : state.user.needs_two_factor ? <RequiredTwoStep /> : state.user.must_change_password ? <RequiredPassword /> : (
          <BrowserRouter>
            <ShortcutsHelp />
            <DataCheckHost />
            <Routes>
              <Route path="/docs/:id" element={<DocEditor />} />
              <Route path="/access/:id" element={<RequestAccess />} />
              <Route path="/sheets/:id" element={<SheetEditor />} />
              <Route path="/slides/:id/presenter" element={<PresenterView />} />
              <Route path="/slides/:id" element={<SlidesEditor />} />
              <Route path="/meet/:code" element={<MeetRoom />} />
              <Route path="/oauth/consent" element={<OAuthConsent />} />
              <Route path="/oauth/signout" element={<OAuthSignOut />} />
              <Route path="*" element={<Shell />} />
            </Routes>
          </BrowserRouter>
        )}
      </ToastProvider>
    </AuthCtx.Provider>
  );
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
        <h1>Choose your own password</h1>
        <p className="muted">{user.password_expired ? `Your password has expired, ${user.name}. Choose a new one to continue.` : `Welcome, ${user.name}. Your password was set by an administrator; choose one only you know to continue.`}</p>
        {rules && <p className="small" role="note" style={{ margin: 0 }}>{rules}</p>}
        <label className="field"><span>Password you were given</span><input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
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
  useTaskReminders({ toast, navigate });
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
