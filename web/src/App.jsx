import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router';
import { get, post, startLive, stopLive, onLive } from './api.js';
import { useMailStatus } from './mailStatus.js';
import { useMailNotifications } from './mailNotify.js';
import { useEventReminders } from './eventReminders.js';
import { useTaskReminders } from './taskReminders.js';
import Icon from './components/Icon.jsx';
import Bell from './components/Bell.jsx';
import { Avatar, Menu, ToastProvider, useToast } from './components/ui.jsx';
import Login from './apps/Login.jsx';
import PublicLink from './apps/PublicLink.jsx';
import InviteAnswer from './apps/calendar/InviteAnswer.jsx';
import BookingPage from './apps/calendar/BookingPage.jsx';
import { TwoStep } from './apps/Settings.jsx';
import Drive from './apps/drive/Drive.jsx';
import DocEditor from './apps/docs/DocEditor.jsx';
import SheetEditor from './apps/sheets/SheetEditor.jsx';
import SlidesEditor from './apps/slides/SlidesEditor.jsx';
import PresenterView from './apps/slides/PresenterView.jsx';
import { ShortcutsHelp } from './components/Shortcuts.jsx';
import Calendar from './apps/calendar/Calendar.jsx';
import Contacts from './apps/contacts/Contacts.jsx';
import Tasks from './apps/tasks/Tasks.jsx';
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
  return invite ? <InviteAnswer token={invite[1]} /> : <Workspace />;
}

function Workspace() {
  const [state, setState] = useState({ loading: true, user: null, needsSetup: false });

  useEffect(() => {
    get('/auth/status').then((s) => setState({ loading: false, ...s })).catch(() => setState({ loading: false, user: null }));
    const onOut = () => setState((s) => ({ ...s, user: null }));
    window.addEventListener('nw:signed-out', onOut);
    return () => window.removeEventListener('nw:signed-out', onOut);
  }, []);

  useEffect(() => {
    if (state.user) startLive(); else stopLive();
  }, [state.user]);

  if (state.loading) return <div className="splash">Loading…</div>;

  const auth = {
    user: state.user,
    setUser: (user) => setState((s) => ({ ...s, user, needsSetup: false })),
    logout: async () => { await post('/auth/logout').catch(() => {}); setState((s) => ({ ...s, user: null })); },
  };

  return (
    <AuthCtx.Provider value={auth}>
      <ToastProvider>
        {!state.user ? <Login needsSetup={state.needsSetup} /> : state.user.needs_two_factor ? <RequiredTwoStep /> : (
          <BrowserRouter>
            <ShortcutsHelp />
            <Routes>
              <Route path="/docs/:id" element={<DocEditor />} />
              <Route path="/sheets/:id" element={<SheetEditor />} />
              <Route path="/slides/:id/presenter" element={<PresenterView />} />
              <Route path="/slides/:id" element={<SlidesEditor />} />
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

const APPS = [
  { to: '/mail', icon: 'mail', label: 'Mail', mail: true },
  { to: '/drive', icon: 'folder', label: 'Drive' },
  { to: '/calendar', icon: 'calendar', label: 'Calendar' },
  { to: '/contacts', icon: 'person', label: 'Contacts' },
  { to: '/tasks', icon: 'check', label: 'Tasks' },
  { to: '/chat', icon: 'chat', label: 'Chat' },
];

function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const mail = useMailStatus();
  const toast = useToast();
  const openMessage = useCallback((folder, uid) => navigate(`/mail/${encodeURIComponent(folder)}/${uid}`), [navigate]);
  const unread = useMailNotifications(!!mail?.enabled, { toast, openMessage });
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

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <header className="topbar">
        <button className="icon-btn mobile-only" aria-label="Menu" onClick={() => setNavOpen((o) => !o)}><Icon name="menu" /></button>
        <a className="brand" href="/drive" onClick={(e) => { e.preventDefault(); navigate('/drive'); }}>
          <span className="brand-mark">{user.org_name.slice(0, 1).toUpperCase()}</span><span className="brand-text">{user.org_name}</span>
        </a>
        <form className="search" role="search" onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get('q').trim();
          navigate(`/drive/search?q=${encodeURIComponent(q)}`); // empty: everything, to narrow with the filters
        }}>
          <Icon name="search" />
          <input name="q" placeholder="Search in Drive" aria-label="Search in Drive" />
        </form>
        <Bell />
        <Menu align="right" trigger={(p) => <button className="avatar-btn" aria-label="Account" {...p}><Avatar name={user.name} /></button>} items={[
          { label: `${user.name} · ${user.username}`, icon: 'person', onClick: () => navigate('/settings') },
          { label: 'Settings', icon: 'settings', onClick: () => navigate('/settings') },
          user.is_admin && { label: 'Admin console', icon: 'shield', onClick: () => navigate('/admin') },
          '-',
          { label: 'Sign out', icon: 'logout', onClick: logout },
        ]} />
      </header>
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
        <Routes>
          <Route path="/" element={<Navigate to="/drive" replace />} />
          <Route path="/drive/*" element={<Drive />} />
          <Route path="/mail/:folder?/:uid?" element={<Mail />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/chat/:channelId?" element={<Chat />} />
          <Route path="/tasks/:listId?" element={<Tasks />} />
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
    const load = () => { clearTimeout(t); t = setTimeout(() => get('/chat/channels').then((r) => setN(r.channels.reduce((sum, c) => sum + (c.unread || 0), 0))).catch(() => {}), 400); };
    load();
    const off = onLive((m) => { if (['message', 'chat-read', 'message-deleted', 'channels-changed', 'live-connected'].includes(m.type)) load(); });
    return () => { off(); clearTimeout(t); };
  }, []);
  return n;
}
