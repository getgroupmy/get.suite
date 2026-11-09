// An app you signed in to with Workspace has signed you out of itself and asks whether to sign out of
// Workspace too (when it couldn't prove it's you: otherwise that happens at once).
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useAuth } from '../../App.jsx';

export default function SignOut() {
  const { user } = useAuth();
  const params = Object.fromEntries(new URLSearchParams(window.location.search));
  const [info, setInfo] = useState(null);
  useEffect(() => { get(`/oauth/signout?${new URLSearchParams(params)}`).then(setInfo).catch(() => setInfo({ app: null, back: null })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const out = async () => { await post('/auth/logout').catch(() => {}); window.location.assign(info?.back || '/'); };
  return (
    <div className="consent-page">
      <div className="card stack consent-card">
        <h1>Sign out of Workspace?</h1>
        <p style={{ margin: 0 }}>{info?.app ? <><strong>{info.app}</strong> signed you out.</> : 'An app asked to sign you out.'} You're still signed in to Workspace as <strong>{user.username}</strong>.</p>
        <div className="row end">
          <button type="button" className="btn" onClick={() => window.location.assign(info?.back || '/')}>Stay signed in</button>
          <button type="button" className="btn primary" disabled={!info} onClick={out}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
