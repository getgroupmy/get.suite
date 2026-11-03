import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { get, post, startLive, stopLive } from './api.js';
import { useMailStatus } from './mailStatus.js';
import { useMailNotifications } from './mailNotify.js';
import Icon from './components/Icon.jsx';
import { Avatar, Menu, ToastProvider, useToast } from './components/ui.jsx';
import Login from './apps/Login.jsx';
import Drive from './apps/drive/Drive.jsx';
import DocEditor from './apps/docs/DocEditor.jsx';
import SheetEditor from './apps/sheets/SheetEditor.jsx';
import Calendar from './apps/calendar/Calendar.jsx';
import Contacts from './apps/contacts/Contacts.jsx';
import Chat from './apps/chat/Chat.jsx';
import Admin from './apps/admin/Admin.jsx';
import Mail from './apps/mail/Mail.jsx';
import Settings from './apps/Settings.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export default function App() {
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
        {!state.user ? <Login needsSetup={state.needsSetup} /> : (
          <BrowserRouter>
            <Routes>
              <Route path="/docs/:id" element={<DocEditor />} />
              <Route path="/sheets/:id" element={<SheetEditor />} />
              <Route path="*" element={<Shell />} />
            </Routes>
          </BrowserRouter>
        )}
      </ToastProvider>
    </AuthCtx.Provider>
  );
}

const APPS = [
  { to: '/mail', icon: 'mail', label: 'Mail', mail: true },
  { to: '/drive', icon: 'folder', label: 'Drive' },
  { to: '/calendar', icon: 'calendar', label: 'Calendar' },
  { to: '/contacts', icon: 'person', label: 'Contacts' },
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
          if (q) navigate(`/drive/search?q=${encodeURIComponent(q)}`);
        }}>
          <Icon name="search" />
          <input name="q" placeholder="Search in Drive" aria-label="Search in Drive" />
        </form>
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
            <span className="appnav-icon"><Icon name={a.icon} />{a.mail && unread > 0 && <span className="nav-badge" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}</span>
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
          <Route path="/settings" element={<Settings />} />
          {user.is_admin && <Route path="/admin" element={<Admin />} />}
          <Route path="*" element={<Navigate to="/drive" replace />} />
        </Routes>
      </main>
    </div>
  );
}
