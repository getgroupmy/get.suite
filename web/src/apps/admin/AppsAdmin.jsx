// Admin → Apps: other apps the company runs that let people "Sign in with Workspace" (OpenID Connect).
import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../../api.js';
import { ConfirmModal, Modal, useToast } from '../../components/ui.jsx';

export default function AppsAdmin() {
  const toast = useToast();
  const [apps, setApps] = useState(null);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState(null); // { name, client_id, client_secret } just made (the secret is shown once)
  const [removing, setRemoving] = useState(null);
  const load = useCallback(() => get('/oauth/apps').then(setApps).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);
  const issuer = window.location.origin;
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => {});
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Sign in with Workspace</h2>
        <p className="muted" style={{ margin: 0 }}>Let people sign in to the company's other apps (Nextcloud, Gitea, Grafana, a wiki…) with their Workspace account, using OpenID Connect. Add the app here, then put these in its OpenID Connect (or “OAuth2 / OIDC”) settings:</p>
        <dl className="oidc-facts">
          <dt>Issuer (discovery)</dt><dd><code>{issuer}</code> <button type="button" className="link-btn small" onClick={() => copy(issuer, 'Issuer')}>Copy</button><div className="muted small">{issuer}/.well-known/openid-configuration</div></dd>
          <dt>Scopes</dt><dd><code>openid profile email</code></dd>
        </dl>
      </div>
      <div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 18 }}>Apps</h2><button type="button" className="btn primary" onClick={() => setAdding(true)}>Add app</button></div>
      {apps && !apps.length && <p className="muted">No apps yet.</p>}
      {apps?.length > 0 && (
        <table className="files" aria-label="Apps">
          <thead><tr><th>App</th><th>Client ID</th><th className="hide-sm">Sends people back to</th><th className="hide-sm">Last sign-in</th><th aria-label="Actions" /></tr></thead>
          <tbody>{apps.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td><code className="small">{a.client_id}</code></td>
              <td className="hide-sm small">{a.redirect_uris.map((u) => <div key={u} className="ellipsis" title={u}>{u}</div>)}</td>
              <td className="hide-sm muted small">{a.last_used_at ? new Date(a.last_used_at).toLocaleString() : 'Never'}</td>
              <td className="actions">
                <button type="button" className="btn small" onClick={async () => { try { const r = await post(`/oauth/apps/${a.id}/secret`); setShown({ name: a.name, client_id: a.client_id, client_secret: r.client_secret, renewed: true }); } catch (e) { toast(e.message, 'error'); } }}>New secret</button>
                <button type="button" className="btn small danger" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)}>Remove</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {adding && <AddApp onClose={() => setAdding(false)} onMade={(made) => { setAdding(false); setShown(made); load(); }} />}
      {shown && (
        <Modal title={shown.renewed ? `New secret for ${shown.name}` : `${shown.name} added`} onClose={() => setShown(null)} footer={<button type="button" className="btn primary" onClick={() => setShown(null)}>Done</button>}>
          <div className="stack">
            <p style={{ margin: 0 }}>Put these in the app's sign-in settings. <strong>Copy the secret now:</strong> it isn't shown again{shown.renewed ? ', and the old one has stopped working' : ''}.</p>
            <label className="field"><span>Client ID</span><span className="row"><input readOnly value={shown.client_id} aria-label="Client ID" className="grow" /><button type="button" className="btn small" onClick={() => copy(shown.client_id, 'Client ID')}>Copy</button></span></label>
            <label className="field"><span>Client secret</span><span className="row"><input readOnly value={shown.client_secret} aria-label="Client secret" className="grow" /><button type="button" className="btn small" onClick={() => copy(shown.client_secret, 'Client secret')}>Copy</button></span></label>
          </div>
        </Modal>
      )}
      {removing && <ConfirmModal title={`Remove ${removing.name}?`} confirm="Remove" message="People can't sign in to it with Workspace any more, and anyone signed in through it is signed out of it the next time it checks."
        onClose={() => setRemoving(null)} onConfirm={async () => { await del(`/oauth/apps/${removing.id}`); setRemoving(null); load(); }} />}
    </div>
  );
}

function AddApp({ onClose, onMade }) {
  const [name, setName] = useState('');
  const [uris, setUris] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { onMade(await post('/oauth/apps', { name, redirect_uris: uris.split(/\s+/).filter(Boolean) })); } catch (err) { setError(err.message); }
  };
  return (
    <Modal title="Add an app" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Name (people see it when they sign in)</span><input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Company wiki" maxLength={100} /></label>
        <label className="field"><span>Redirect (callback) address, one per line — from the app's settings</span>
          <textarea rows={3} required value={uris} onChange={(e) => setUris(e.target.value)} placeholder="https://wiki.example.com/auth/callback" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Add app</button></div>
      </form>
    </Modal>
  );
}
