import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

export default function EmailAdmin({ orgId, orgPicker }) {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  useEffect(() => { get('/mail-admin/status').then(setStatus); }, []);
  if (!status) return null;
  if (!status.enabled) {
    return <div className="card"><h2>Email is not set up</h2><p className="muted">Start the mail container and set <code>MAIL_CONFIG_DIR</code> and <code>MAIL_HOSTNAME</code> (see README → Email).</p></div>;
  }
  const qs = orgId !== user.org_id ? `?org_id=${orgId}` : '';
  return (
    <div className="stack">
      {orgPicker}
      {user.is_super && <HostCheck />}
      <Domains qs={qs} />
      <Aliases qs={qs} orgId={orgId} />
      <SharedMailboxes qs={qs} orgId={orgId} />
      <MailApps hostname={status.hostname} />
    </div>
  );
}

function HostCheck() {
  const [r, setR] = useState(null);
  const run = () => { setR('loading'); get('/mail-admin/host-check').then(setR); };
  return (
    <div className="card stack">
      <div className="row"><h2 className="grow">Mail server</h2><button className="btn small" onClick={run}>Check</button></div>
      <p className="muted small" style={{ margin: 0 }}>Every domain's MX record points at one hostname. It needs an A record to your fixed IP, and your ISP must set the IP's reverse DNS (PTR) to the same name, or large providers will reject your mail.</p>
      {r === 'loading' && <p className="muted">Checking…</p>}
      {r && r !== 'loading' && (
        <p className={r.ok ? 'ok' : 'error'} style={{ margin: 0 }}>
          {r.ok ? '✓ ' : '✗ '}{r.host}{r.ips?.length ? ` → ${r.ips.join(', ')}` : ''}{r.ptr?.length ? ` · PTR ${r.ptr.join(', ')}` : ''}{r.note ? ` · ${r.note}` : ''}
        </p>
      )}
    </div>
  );
}

function Domains({ qs }) {
  const [domains, setDomains] = useState(null);
  const [checks, setChecks] = useState({});
  const toast = useToast();
  const [mailboxes, setMailboxes] = useState([]);
  useEffect(() => {
    setDomains(null); setChecks({});
    get(`/mail-admin/domains${qs}`).then(setDomains);
    get(`/users${qs}`).then((u) => setMailboxes(u.map((x) => x.username))).catch(() => {});
  }, [qs]);
  async function setCatchAll(name, catchall) {
    try {
      const r = await patch(`/mail-admin/domains/${encodeURIComponent(name)}${qs}`, { catchall: catchall || null });
      setDomains((list) => list.map((d) => (d.name === name ? { ...d, catchall: r.catchall } : d)));
      toast(r.catchall ? `Mail to unknown addresses @${name} now goes to ${r.catchall}` : `Catch-all for ${name} turned off`);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function check(name) {
    setChecks((c) => ({ ...c, [name]: 'loading' }));
    try { const r = await get(`/mail-admin/domains/${encodeURIComponent(name)}/check${qs}`); setChecks((c) => ({ ...c, [name]: r })); }
    catch (e) { toast(e.message, 'error'); setChecks((c) => ({ ...c, [name]: null })); }
  }
  const copy = (v) => navigator.clipboard?.writeText(v).then(() => toast('Copied'), () => toast('Copy failed', 'error'));

  return domains?.map((d) => {
    const c = checks[d.name];
    const result = (i) => (c && c !== 'loading' ? c.results[i] : null);
    return (
      <div key={d.name} className="card stack">
        <div className="row">
          <h2 className="grow">{d.name}</h2>
          {c && c !== 'loading' && <span className={c.ok ? 'pill' : 'pill ext'}>{c.ok ? 'All records OK' : 'Needs attention'}</span>}
          <button className="btn small" onClick={() => check(d.name)} disabled={c === 'loading'}>{c === 'loading' ? 'Checking…' : 'Check DNS'}</button>
        </div>
        <div className="row wrap catchall">
          <label className="field" style={{ flex: '0 1 360px' }}><span>Catch-all: mail to addresses that don't exist @{d.name} goes to</span>
            <select value={d.catchall || ''} onChange={(e) => setCatchAll(d.name, e.target.value)} aria-label={`Catch-all for ${d.name}`}>
              <option value="">Nobody (return it to the sender)</option>
              {mailboxes.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <p className="muted small" style={{ margin: 0, flex: '1 1 240px' }}>Handy for typos and old addresses, but catch-alls attract extra spam. Real mailboxes and aliases are not affected.</p>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Add these records at the company that hosts DNS for {d.name}. Changes can take up to an hour to show.</p>
        <div className="dns-table" role="table" aria-label={`DNS records for ${d.name}`}>
          {d.records.map((rec, i) => {
            const res = result(i);
            return (
              <div key={i} className="dns-row" role="row">
                <span className="dns-type" role="cell">{rec.type}</span>
                <span className="dns-host ellipsis" role="cell" title={rec.host}>{rec.host}</span>
                <code className="dns-value" role="cell">{rec.value}</code>
                <button className="icon-btn" aria-label={`Copy ${rec.type} value for ${rec.host}`} onClick={() => copy(rec.value)}><Icon name="doc" size={18} /></button>
                <span className="dns-purpose muted small" role="cell">
                  {rec.purpose}
                  {res && <span className={res.ok ? 'ok' : 'error'}> · {res.ok ? '✓ found' : `✗ ${res.note || (res.found.length ? `found: ${res.found.join(' | ')}` : 'missing')}`}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }) ?? null;
}

function Aliases({ qs, orgId }) {
  const toast = useToast();
  const [aliases, setAliases] = useState(null);
  const [domains, setDomains] = useState([]);
  const [dialog, setDialog] = useState(null);
  const load = useCallback(() => get(`/mail-admin/aliases${qs}`).then(setAliases), [qs]);
  useEffect(() => { load(); get(`/mail-admin/domains${qs}`).then((d) => setDomains(d.map((x) => x.name))); }, [load, qs]);

  return (
    <div className="card stack">
      <div className="row"><h2 className="grow">Aliases and group addresses</h2><button className="btn small" onClick={() => setDialog({ type: 'edit', alias: null })}><Icon name="plus" size={16} /> Add alias</button></div>
      <p className="muted small" style={{ margin: 0 }}>An alias delivers to one or more mailboxes (e.g. sales@ → three people), or forwards outside. Members can also send as the alias. postmaster@ and abuse@ automatically go to your admins unless you create them here.</p>
      {aliases?.length === 0 && <p className="muted">No aliases yet.</p>}
      {aliases?.length > 0 && (
        <table className="files">
          <thead><tr><th>Address</th><th>Delivers to</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {aliases.map((a) => (
              <tr key={a.id}>
                <td className="name"><span>{a.address}</span></td>
                <td className="muted">{a.targets.join(', ')}</td>
                <td className="actions">
                  <button className="icon-btn" aria-label={`Edit ${a.address}`} onClick={() => setDialog({ type: 'edit', alias: a })}><Icon name="edit" size={18} /></button>
                  <button className="icon-btn" aria-label={`Delete ${a.address}`} onClick={() => setDialog({ type: 'delete', alias: a })}><Icon name="trash" size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog?.type === 'edit' && <AliasDialog alias={dialog.alias} domains={domains} orgId={orgId} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('Alias saved'); load(); }} />}
      {dialog?.type === 'delete' && <ConfirmModal title={`Delete ${dialog.alias.address}?`} message="Mail sent to this address will bounce." onClose={() => setDialog(null)}
        onConfirm={async () => { await del(`/mail-admin/aliases/${dialog.alias.id}`); load(); }} />}
    </div>
  );
}

function AliasDialog({ alias, domains, orgId, onClose, onSaved }) {
  const [f, setF] = useState({ local: '', domain: domains[0] || '', targets: alias ? alias.targets.join(', ') : '' });
  const [error, setError] = useState('');
  return (
    <Modal title={alias ? `Edit ${alias.address}` : 'Add alias'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try {
          if (alias) await patch(`/mail-admin/aliases/${alias.id}`, { targets: f.targets });
          else await post('/mail-admin/aliases', { ...f, org_id: orgId });
          onSaved();
        } catch (err) { setError(err.message); }
      }}>
        {!alias && (
          <label className="field"><span>Address</span>
            <span className="address-input">
              <input autoFocus required autoCapitalize="none" spellCheck={false} value={f.local} onChange={(e) => setF({ ...f, local: e.target.value })} placeholder="sales" aria-label="Address before @" />
              <span className="muted">@</span>
              <select value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} aria-label="Domain">{domains.map((d) => <option key={d}>{d}</option>)}</select>
            </span>
          </label>
        )}
        <label className="field"><span>Delivers to (comma-separated)</span>
          <textarea rows={3} required value={f.targets} onChange={(e) => setF({ ...f, targets: e.target.value })} placeholder="anna@company.com, ben@company.com" autoFocus={!!alias} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function MailApps({ hostname }) {
  return (
    <div className="card stack">
      <h2>Phones and desktop mail apps</h2>
      <p className="muted small" style={{ margin: 0 }}>Users sign in with their Workspace email address and password.</p>
      <div className="dns-table">
        <div className="dns-row simple"><span className="dns-type">IMAP</span><code className="dns-value">{hostname} · port 993 · SSL/TLS</code></div>
        <div className="dns-row simple"><span className="dns-type">SMTP</span><code className="dns-value">{hostname} · port 465 · SSL/TLS (or 587 · STARTTLS)</code></div>
      </div>
    </div>
  );
}

/** Shared mailboxes (support@, info@…): their own mailbox, read and answered by the people chosen. */
function SharedMailboxes({ qs, orgId }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [domains, setDomains] = useState([]);
  const [people, setPeople] = useState([]);
  const [dialog, setDialog] = useState(null); // { type: 'edit', box } | { type: 'delete', box }
  const load = useCallback(() => get(`/mail-admin/shared${qs}`).then(setList), [qs]);
  useEffect(() => {
    load();
    get(`/mail-admin/domains${qs}`).then((d) => setDomains(d.map((x) => x.name)));
    get(`/users${qs}`).then((u) => setPeople((Array.isArray(u) ? u : u.users || []).filter((x) => !x.disabled))).catch(() => {});
  }, [load, qs]);
  return (
    <section className="card stack" aria-label="Shared mailboxes">
      <div className="row"><h2 className="grow">Shared mailboxes</h2><button className="btn small" onClick={() => setDialog({ type: 'edit', box: null })}><Icon name="plus" size={16} /> Add shared mailbox</button></div>
      <p className="muted small" style={{ margin: 0 }}>An address with its own mailbox (support@, info@, jobs@) that the people you choose read and answer in Mail, as that address: replies go out from it and are kept in its Sent, so everyone sees what was answered. Nobody signs in to it.</p>
      {list?.length === 0 && <p className="muted">No shared mailboxes yet.</p>}
      {list?.length > 0 && (
        <table className="files">
          <thead><tr><th>Address</th><th>People</th><th aria-label="Actions" /></tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.id}>
              <td className="name"><span>{b.name} <span className="muted small">{b.address}</span></span></td>
              <td className="muted">{b.members.map((m) => m.name).join(', ') || 'Nobody yet'}</td>
              <td className="actions">
                <button className="icon-btn" aria-label={`Edit ${b.address}`} onClick={() => setDialog({ type: 'edit', box: b })}><Icon name="edit" size={18} /></button>
                <button className="icon-btn" aria-label={`Delete ${b.address}`} onClick={() => setDialog({ type: 'delete', box: b })}><Icon name="trash" size={18} /></button>
              </td>
            </tr>))}</tbody>
        </table>
      )}
      {dialog?.type === 'edit' && <SharedDialog box={dialog.box} domains={domains} people={people} orgId={orgId} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('Shared mailbox saved'); load(); }} />}
      {dialog?.type === 'delete' && <ConfirmModal title={`Delete ${dialog.box.address}?`} message="Mail sent to this address will bounce, and its members can no longer open its mail." onClose={() => setDialog(null)}
        onConfirm={async () => { await del(`/mail-admin/shared/${dialog.box.id}`); load(); }} />}
    </section>
  );
}

function SharedDialog({ box, domains, people, orgId, onClose, onSaved }) {
  const [f, setF] = useState({ local: '', domain: domains[0] || '', name: box?.name || '', auto_subject: box?.auto_subject || 'We got your message', auto_reply: box?.auto_reply || '' });
  const [autoOn, setAutoOn] = useState(!!box?.auto_reply);
  const [members, setMembers] = useState(new Set((box?.members || []).map((m) => m.id)));
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const shown = people.filter((p) => !filter || `${p.name} ${p.username}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 100);
  return (
    <Modal title={box ? `Edit ${box.address}` : 'Add shared mailbox'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const auto = { auto_subject: f.auto_subject, auto_reply: autoOn ? f.auto_reply : '' };
          if (box) await patch(`/mail-admin/shared/${box.id}`, { name: f.name, members: [...members], ...auto });
          else await post('/mail-admin/shared', { ...f, ...auto, members: [...members], org_id: orgId });
          onSaved();
        } catch (err) { setError(err.message); }
      }}>
        {!box && (
          <label className="field"><span>Address</span>
            <span className="address-input">
              <input autoFocus required autoCapitalize="none" spellCheck={false} value={f.local} onChange={(e) => setF({ ...f, local: e.target.value })} placeholder="support" aria-label="Address before @" />
              <span className="muted">@</span>
              <select value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} aria-label="Domain">{domains.map((d) => <option key={d}>{d}</option>)}</select>
            </span>
          </label>
        )}
        <label className="field"><span>Name (shown on the mail it sends)</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Acme Support" maxLength={100} /></label>
        <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend><strong>People who use it</strong></legend>
          <input type="search" aria-label="Find people" placeholder="Find people" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="plain-list" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {shown.map((p) => <li key={p.id}><label className="check"><input type="checkbox" checked={members.has(p.id)} onChange={(e) => { const n = new Set(members); if (e.target.checked) n.add(p.id); else n.delete(p.id); setMembers(n); }} /> {p.name} <span className="muted small">{p.username}</span></label></li>)}
          </ul>
        </fieldset>
        <label className="check"><input type="checkbox" checked={autoOn} onChange={(e) => setAutoOn(e.target.checked)} /> Automatic reply to whoever writes in (once a day per sender)</label>
        {autoOn && <>
          <label className="field"><span>Reply subject</span><input value={f.auto_subject} onChange={(e) => setF({ ...f, auto_subject: e.target.value })} maxLength={200} /></label>
          <label className="field"><span>Reply text</span><textarea rows={4} required value={f.auto_reply} onChange={(e) => setF({ ...f, auto_reply: e.target.value })} maxLength={4000} placeholder="Thanks for writing to us. We answer within one working day." /></label>
        </>}
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
