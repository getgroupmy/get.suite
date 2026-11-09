// "Sign in with Workspace": another app (registered by an admin) asks to sign you in. You say yes
// once; after that, going back to the app signs you in straight away.
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useAuth } from '../../App.jsx';

const WHAT = { profile: 'your name', email: 'your email address' };

export default function Consent() {
  const { user } = useAuth();
  const params = Object.fromEntries(new URLSearchParams(window.location.search));
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (path) => {
    setBusy(true);
    try { const r = await post(path, params); window.location.assign(r.redirect); } catch (e) { setError(e.message); setBusy(false); }
  };
  useEffect(() => {
    get(`/oauth/request?${new URLSearchParams(params)}`).then((r) => { setInfo(r); if (r.granted) go('/oauth/approve'); }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sees = (info?.scopes || []).map((s) => WHAT[s]).filter(Boolean);
  return (
    <div className="consent-page">
      <div className="card stack consent-card">
        {error ? <><h1>Can’t sign you in</h1><p className="error" role="alert">{error}</p></>
          : !info || info.granted ? <p className="muted">Signing you in…</p> : <>
            <h1>Sign in to {info.app}</h1>
            <p style={{ margin: 0 }}><strong>{info.app}</strong> (at {info.host}) wants to sign you in with your Workspace account, <strong>{user.username}</strong>.</p>
            <p className="muted" style={{ margin: 0 }}>It will see {sees.length ? sees.join(' and ') : 'only that it’s you'}. It won’t see your password, mail or files.</p>
            <div className="row end">
              <button type="button" className="btn" disabled={busy} onClick={() => go('/oauth/deny')}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => go('/oauth/approve')}>Allow</button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>You can take this back later in Settings → Apps you sign in to.</p>
          </>}
      </div>
    </div>
  );
}
