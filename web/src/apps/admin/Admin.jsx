import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, formatBytes } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Menu, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import EmailAdmin from './EmailAdmin.jsx';
import SecurityAdmin from './SecurityAdmin.jsx';
import ActivityAdmin from './ActivityAdmin.jsx';
import StorageAdmin from './StorageAdmin.jsx';
import { useMailStatus } from '../../mailStatus.js';

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState('users');
  const [orgId, setOrgId] = useState(user.org_id); // which company the Users tab shows
  const mail = useMailStatus();
  const tabs = [['users', 'Users'], ...(mail?.enabled ? [['email', 'Email']] : []), ['company', 'Company settings'], ['activity', 'Activity'], ['storage', 'Storage'], ...(user.is_super ? [['companies', 'All companies'], ['security', 'Security']] : [])];

  return (
    <div className="page">
      <div className="page-head"><h1>Admin</h1></div>
      <div className="tabs" role="tablist" style={{ alignSelf: 'flex-start' }}>
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'users' && <Users orgId={orgId} setOrgId={setOrgId} />}
      {tab === 'email' && <EmailAdmin orgId={orgId} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'company' && <CompanySettings />}
      {tab === 'activity' && <ActivityAdmin orgId={orgId} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'storage' && <StorageAdmin orgId={user.is_super ? orgId : null} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'security' && <SecurityAdmin />}
      {tab === 'companies' && <Companies onManageUsers={(id) => { setOrgId(id); setTab('users'); }} />}
    </div>
  );
}

// ---------------- users of one company ----------------
function Users({ orgId, setOrgId }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [domains, setDomains] = useState([]);
  const [dialog, setDialog] = useState(null);
  const qs = orgId !== me.org_id ? `?org_id=${orgId}` : '';

  const load = useCallback(() => get(`/users${qs}`).then(setUsers).catch((e) => toast(e.message, 'error')), [qs, toast]);
  useEffect(() => { setUsers(null); load(); }, [load]);
  useEffect(() => {
    if (me.is_super) get('/orgs').then((list) => { setOrgs(list); setDomains(list.find((o) => o.id === orgId)?.domains || []); });
    else get('/orgs/current').then((o) => setDomains(o.domains));
  }, [me.is_super, orgId]);

  const act = (fn, msg) => async () => { try { await fn(); toast(msg); load(); } catch (e) { toast(e.message, 'error'); } };

  return <>
    <div className="row wrap">
      {me.is_super && <OrgPicker orgId={orgId} setOrgId={setOrgId} />}
      <div className="grow" />
      <button className="btn" onClick={() => setDialog({ type: 'import' })}><Icon name="upload" size={18} /> Import from CSV</button>
      <button className="btn primary" onClick={() => setDialog({ type: 'new' })}><Icon name="plus" size={18} /> Add user</button>
    </div>
    <table className="files">
      <thead><tr><th>Name</th><th className="hide-sm">Email address</th><th className="hide-sm">Role</th><th className="hide-sm">Storage</th><th className="hide-sm">Mailbox size</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {users?.map((u) => (
          <tr key={u.id} className={u.disabled ? 'dim' : ''}>
            <td className="name"><Avatar name={u.name} size={28} userId={u.id} /><span>{u.name}{u.disabled ? ' (disabled)' : ''}</span></td>
            <td className="hide-sm muted">{u.username}</td>
            <td className="hide-sm">{u.is_super ? <span className="pill">Platform owner</span> : u.is_admin ? <span className="pill">Admin</span> : 'User'}
              {u.two_factor ? <span className="pill ok" title="Signs in with a password and a code from their phone">2-step</span> : null}</td>
            <td className="hide-sm muted">{formatBytes(u.storage_used)}</td>
            <td className="hide-sm muted">{u.mail_quota_mb ? formatBytes(u.mail_quota_mb * 1048576) : 'Unlimited'}</td>
            <td className="actions">
              {!(u.is_super && !me.is_super) && (
                <Menu trigger={(p) => <button className="icon-btn" aria-label={`Actions for ${u.name}`} {...p}><Icon name="more" /></button>} items={[
                  { label: 'Reset password', icon: 'edit', onClick: () => setDialog({ type: 'password', user: u }) },
                  { label: 'Change email address', icon: 'mail', onClick: () => setDialog({ type: 'address', user: u }) },
                  { label: 'Mailbox size', icon: 'mail', onClick: () => setDialog({ type: 'quota', user: u }) },
                  u.two_factor && u.id !== me.id && { label: 'Reset two-step verification', icon: 'shield', onClick: () => setDialog({ type: 'reset2fa', user: u }) },
                  u.id !== me.id && !u.is_super && { label: u.is_admin ? 'Remove admin' : 'Make admin', icon: 'shield', onClick: act(() => patch(`/users/${u.id}`, { is_admin: !u.is_admin }), 'Role updated') },
                  u.id !== me.id && !u.is_super && { label: u.disabled ? 'Enable account' : 'Disable account', icon: 'logout', onClick: act(() => patch(`/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Account enabled' : 'Account disabled') },
                  u.id !== me.id && !u.is_super && '-',
                  u.id !== me.id && !u.is_super && { label: 'Delete user and their files', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', user: u }) },
                ]} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {dialog?.type === 'import' && <ImportUsers orgId={orgId} domains={domains} onClose={() => setDialog(null)} onDone={load} />}
    {dialog?.type === 'new' && <NewUser orgId={orgId} domains={domains} onClose={() => setDialog(null)} onSaved={(addr) => { setDialog(null); toast(`${addr} created`); load(); }} />}
    {dialog?.type === 'password' && <ResetPassword user={dialog.user} onClose={() => setDialog(null)} />}
    {dialog?.type === 'address' && <ChangeAddress user={dialog.user} domains={domains} onClose={() => setDialog(null)} onSaved={(addr) => { setDialog(null); toast(`Address changed to ${addr}`); load(); }} />}
    {dialog?.type === 'quota' && <MailboxSize user={dialog.user} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('Mailbox size updated'); load(); }} />}
    {dialog?.type === 'reset2fa' && (
      <ConfirmModal title={`Reset two-step verification for ${dialog.user.name}?`} confirm="Reset" danger={false}
        message={`Use this when ${dialog.user.name} has lost their phone. They can then sign in with just their password, and should set two-step verification up again in Settings. They are signed out everywhere now. Only do this once you're sure it's really them asking.`}
        onClose={() => setDialog(null)} onConfirm={async () => { await patch(`/users/${dialog.user.id}`, { reset_two_factor: true }); toast('Two-step verification reset. They were signed out everywhere.'); load(); }} />
    )}
    {dialog?.type === 'delete' && (
      <ConfirmModal title={`Delete ${dialog.user.name}?`} confirm="Delete user"
        message={`This permanently deletes ${dialog.user.username}, their files (${formatBytes(dialog.user.storage_used)}), calendar, contacts and messages. Consider disabling the account instead.`}
        onClose={() => setDialog(null)} onConfirm={async () => { await del(`/users/${dialog.user.id}`); toast('User deleted'); load(); }} />
    )}
  </>;
}

/** Many people from a CSV: pick the file, check it, create the good rows, then hand out the passwords. */
function ImportUsers({ orgId, domains, onClose, onDone }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [domain, setDomain] = useState(domains[0] || '');
  const [rows, setRows] = useState(null); // the check
  const [done, setDone] = useState(null); // the results
  const [error, setError] = useState('');
  const fileInput = useRef();
  const call = (dry) => post('/users/import', { csv, domain, org_id: orgId, dry_run: dry });
  const check = async () => { setError(''); try { setRows((await call(true)).rows); } catch (e) { setError(e.message); } };
  const create = async () => {
    try { const r = await call(false); setDone(r); onDone(); toast(`${r.created} user${r.created === 1 ? '' : 's'} created`); } catch (e) { setError(e.message); }
  };
  const good = rows?.filter((r) => !r.error) || [];
  const download = () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Name', 'Email', 'Password'], ...done.rows.filter((r) => r.created).map((r) => [r.name, r.email, r.password || '(the one in your file)'])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.map((l) => l.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
    a.download = 'new-users.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Modal wide title="Import users" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>{done ? 'Done' : 'Cancel'}</button>}>
      {done ? (
        <div className="stack">
          <p style={{ margin: 0 }}><strong>{done.created}</strong> created. Passwords made up for people who had none are shown only now: download them or copy them to pass on.</p>
          <ImportTable rows={done.rows} result />
          <div className="row"><button type="button" className="btn primary" onClick={download}><Icon name="download" size={18} /> Download sign-in details (CSV)</button></div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>A CSV file with one person per row. The first row names the columns: <strong>Name</strong> (or First name and Last name), <strong>Email</strong> (a full address, or just the part before @), and optionally <strong>Password</strong> (at least 8 characters; one is made up if it's empty) and <strong>Admin</strong> (yes). Up to 500 people.</p>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => fileInput.current.click()}><Icon name="upload" size={18} /> Choose file</button>
            <span className="muted small">{fileName || 'No file chosen'}</span>
            <input ref={fileInput} type="file" accept=".csv,text/csv" hidden aria-label="CSV file of users" onChange={async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; setFileName(f.name); setCsv(await f.text()); setRows(null); }} />
            <label className="field" style={{ marginLeft: 'auto' }}><span>Domain for addresses without one</span>
              <select value={domain} onChange={(e) => { setDomain(e.target.value); setRows(null); }} aria-label="Domain">{domains.map((d) => <option key={d}>{d}</option>)}</select></label>
          </div>
          {error && <p className="error">{error}</p>}
          {rows && <ImportTable rows={rows} />}
          <div className="row end">
            {!rows ? <button type="button" className="btn primary" disabled={!csv} onClick={check}>Check</button>
              : <button type="button" className="btn primary" disabled={!good.length} onClick={create}>Create {good.length} user{good.length === 1 ? '' : 's'}</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ImportTable({ rows, result = false }) {
  return (
    <div className="import-table">
      <table className="files">
        <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>{result ? 'Password' : 'Admin'}</th><th>{result ? 'Result' : 'Check'}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.line} className={r.error ? 'bad' : ''}>
              <td className="muted">{r.line}</td><td>{r.name || <span className="muted">—</span>}</td><td>{r.email || <span className="muted">—</span>}</td>
              <td>{result ? (r.password ? <code>{r.password}</code> : r.created ? <span className="muted">from the file</span> : '') : r.admin ? 'Yes' : ''}</td>
              <td>{r.error ? <span className="error">{r.error}</span> : result ? 'Created' : 'OK'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewUser({ orgId, domains, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', local: '', domain: domains[0] || '', password: '', is_admin: false });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { const r = await post('/users', { ...f, org_id: orgId }); onSaved(r.username); } catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>Full name</span><input autoFocus required value={f.name} onChange={set('name')} /></label>
        <label className="field"><span>Email address</span>
          <span className="address-input">
            <input required autoCapitalize="none" spellCheck={false} value={f.local} onChange={set('local')} aria-label="Address before @" />
            <span className="muted">@</span>
            <select value={f.domain} onChange={set('domain')} aria-label="Domain">{domains.map((d) => <option key={d}>{d}</option>)}</select>
          </span>
        </label>
        <label className="field"><span>Temporary password</span><input required minLength={8} type="text" autoComplete="off" value={f.password} onChange={set('password')} /></label>
        <label className="check"><input type="checkbox" checked={f.is_admin} onChange={set('is_admin')} /> Company administrator</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Create user</button></div>
      </form>
    </Modal>
  );
}

/** A new address for someone: their mailbox, files and everything else stay theirs. */
function ChangeAddress({ user, domains, onClose, onSaved }) {
  const [local0, domain0] = user.username.split('@');
  const [f, setF] = useState({ local: local0, domain: domain0, keep_old_address: true });
  const [error, setError] = useState('');
  const next = `${f.local.trim().toLowerCase()}@${f.domain}`;
  return (
    <Modal title={`Change ${user.name}'s email address`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/users/${user.id}`, f); onSaved(next); } catch (err) { setError(err.message); }
      }}>
        <p className="muted small">Now: {user.username}</p>
        <label className="field"><span>New email address</span>
          <span className="address-input">
            <input autoFocus required autoCapitalize="none" spellCheck={false} value={f.local} onChange={(e) => setF({ ...f, local: e.target.value })} aria-label="New address before @" />
            <span className="muted">@</span>
            <select value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} aria-label="New domain">{domains.map((d) => <option key={d}>{d}</option>)}</select>
          </span>
        </label>
        <label className="check"><input type="checkbox" checked={f.keep_old_address} onChange={(e) => setF({ ...f, keep_old_address: e.target.checked })} /> Keep {user.username} as an alias, so mail sent to it still arrives</label>
        <p className="muted small">Their mailbox, files, calendar and chats stay as they are. From now on they sign in with the new address, also on phones and in Outlook (update the account there). Aliases they're in now point to the new address.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={next === user.username}>Change address</button></div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title={`Reset password for ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/users/${user.id}`, { password: pw }); toast('Password reset. The user was signed out everywhere.'); onClose(); }
        catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>New password</span><input autoFocus required minLength={8} type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Reset password</button></div>
      </form>
    </Modal>
  );
}

// ---------------- the admin's own company ----------------
function CompanySettings() {
  const toast = useToast();
  const { setUser, user } = useAuth();
  const [org, setOrg] = useState(null);
  const [name, setName] = useState('');
  useEffect(() => { get('/orgs/current').then((o) => { setOrg(o); setName(o.name); }); }, []);
  if (!org) return null;

  async function save(body, msg) {
    const before = org;
    setOrg({ ...org, ...body }); // optimistic
    try {
      const o = await patch('/orgs/current', body);
      setOrg(o);
      setUser({ ...user, org_name: o.name, allow_external: o.allow_external, allow_links: o.allow_links });
      toast(msg);
    } catch (e) { setOrg(before); toast(e.message, 'error'); }
  }

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save({ name }, 'Company name saved'); }}>
        <h2>Company</h2>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <div className="row end"><button className="btn primary">Save</button></div>
      </form>
      <Branding org={org} onChanged={async (o) => { if (o) setOrg(o); setUser((await get('/auth/me')).user); }} />
      <div className="card stack">
        <h2>Working with other companies</h2>
        <label className="check">
          <input type="checkbox" checked={org.allow_external} onChange={(e) => save({ allow_external: e.target.checked }, e.target.checked ? 'External collaboration on' : 'External collaboration off')} />
          Allow people to share files and chat with other companies on this server
        </label>
        <p className="muted small" style={{ margin: 0 }}>Turning this off immediately removes outside access to your files and pauses external direct messages. Turning it back on restores them.</p>
      </div>
      <div className="card stack">
        <h2>Links for people without an account</h2>
        <label className="check">
          <input type="checkbox" checked={org.allow_links} onChange={(e) => save({ allow_links: e.target.checked }, e.target.checked ? 'Share links are on' : 'Share links are off')} />
          Allow people to share files and folders by link with anyone, such as clients
        </label>
        <p className="muted small" style={{ margin: 0 }}>Turning this off immediately stops every existing link from working. Turning it back on restores the links that haven't expired.</p>
      </div>
      <div className="card stack">
        <h2>Drive trash</h2>
        <label className="field"><span>Empty the trash automatically</span>
          <select aria-label="Empty the trash automatically" value={String(org.trash_days ?? 30)} onChange={(e) => { const d = Number(e.target.value); save({ trash_days: d }, d ? `Trash is now emptied after ${d} days` : 'Trash is now kept until people empty it'); }}>
            {[[7, 'After 7 days'], [14, 'After 14 days'], [30, 'After 30 days'], [60, 'After 60 days'], [90, 'After 90 days'], [365, 'After a year'], [0, 'Never (people empty it themselves)']]
              .concat([[org.trash_days ?? 30, `After ${org.trash_days} days`]].filter(([d]) => ![7, 14, 30, 60, 90, 365, 0].includes(d)))
              .map(([d, n]) => <option key={d} value={d}>{n}</option>)}
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>Files and folders that have been in someone’s trash this long are deleted for good, with their versions, freeing the space. Each item in the trash says when it goes.</p>
      </div>
      <div className="card stack">
        <h2>Sign-in security</h2>
        <label className="check">
          <input type="checkbox" checked={org.require_2fa} onChange={(e) => save({ require_2fa: e.target.checked }, e.target.checked ? 'Two-step verification is now required' : 'Two-step verification is now optional')} />
          Require two-step verification for everyone in this company
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          People without it are asked to set it up at their next click, and can't use anything else until they have. It can't be turned off while required.
          You need it on your own account first. {org.require_2fa && org.without_2fa > 0
            ? `${org.without_2fa} ${org.without_2fa === 1 ? 'person still has' : 'people still have'} to set it up.`
            : org.require_2fa ? 'Everyone has set it up.' : ''}
        </p>
      </div>
      <Rooms />
      <div className="card stack">
        <h2>Domains and storage</h2>
        <div>{org.domains.map((d) => <span key={d} className="pill" style={{ marginRight: 6 }}>{d}</span>)}</div>
        <p className="muted small" style={{ margin: 0 }}>
          {org.users} users · {formatBytes(org.storage_used)} used{org.quota_mb ? ` of ${formatBytes(org.quota_mb * 1048576)}` : ''}.
          Ask the platform owner to add domains or change the quota.
        </p>
      </div>
    </div>
  );
}

/** Meeting rooms (and other things people book with events): add, rename, set how many fit, remove. */
function Rooms() {
  const toast = useToast();
  const [rooms, setRooms] = useState(null);
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const load = () => get('/rooms').then(setRooms).catch(() => setRooms([]));
  useEffect(() => { load(); }, []);
  const run = (fn, msg) => async () => { try { await fn(); if (msg) toast(msg); load(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="card stack">
      <h2>Rooms</h2>
      <p className="muted small" style={{ margin: 0 }}>Meeting rooms (or a projector, a company car…) people can book by adding them to an event. A room that's taken at that time declines.</p>
      {rooms?.length > 0 && (
        <ul className="room-list" aria-label="Rooms">
          {rooms.map((r) => (
            <li key={r.id}>
              <input aria-label={`Name of ${r.name}`} defaultValue={r.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.name) run(() => patch(`/rooms/${r.id}`, { name: v }), 'Room renamed')(); }} />
              <input aria-label={`People ${r.name} fits`} type="number" min="1" placeholder="Seats" defaultValue={r.capacity ?? ''} style={{ width: 90 }}
                onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (r.capacity ?? null)) run(() => patch(`/rooms/${r.id}`, { capacity: v }))(); }} />
              <button type="button" className="icon-btn" aria-label={`Remove ${r.name}`} onClick={run(() => del(`/rooms/${r.id}`), `${r.name} removed`)}><Icon name="trash" size={18} /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await post('/rooms', { name: name.trim(), capacity: capacity || null }); setName(''); setCapacity(''); }, 'Room added')(); }}>
        <input className="grow" aria-label="New room name" placeholder="Room name, e.g. Boardroom" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Seats" type="number" min="1" placeholder="Seats" style={{ width: 90 }} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        <button className="btn" disabled={!name.trim()}>Add room</button>
      </form>
    </div>
  );
}

// ---------------- platform owner: every company ----------------
function Companies({ onManageUsers }) {
  const toast = useToast();
  const { user } = useAuth();
  const [orgs, setOrgs] = useState(null);
  const [dialog, setDialog] = useState(null);
  const load = useCallback(() => get('/orgs').then(setOrgs).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);

  return <>
    <div className="row"><div className="grow" /><button className="btn primary" onClick={() => setDialog({ type: 'new' })}><Icon name="plus" size={18} /> Add company</button></div>
    <table className="files">
      <thead><tr><th>Company</th><th className="hide-sm">Domains</th><th className="hide-sm">Users</th><th className="hide-sm">Storage</th><th className="hide-sm">External</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {orgs?.map((o) => (
          <tr key={o.id}>
            <td className="name"><span className="brand-mark small-mark" aria-hidden="true">{o.name.slice(0, 1).toUpperCase()}</span><span>{o.name}</span></td>
            <td className="hide-sm muted">{o.domains.join(', ')}</td>
            <td className="hide-sm muted">{o.users}</td>
            <td className="hide-sm muted">{formatBytes(o.storage_used)}{o.quota_mb ? ` / ${formatBytes(o.quota_mb * 1048576)}` : ''}</td>
            <td className="hide-sm muted">{o.allow_external ? 'Allowed' : 'Off'}</td>
            <td className="actions">
              <Menu trigger={(p) => <button className="icon-btn" aria-label={`Actions for ${o.name}`} {...p}><Icon name="more" /></button>} items={[
                { label: 'Manage users', icon: 'people', onClick: () => onManageUsers(o.id) },
                { label: 'Edit company', icon: 'edit', onClick: () => setDialog({ type: 'edit', org: o }) },
                { label: 'Domains', icon: 'settings', onClick: () => setDialog({ type: 'domains', org: o }) },
                o.id !== user.org_id && '-',
                o.id !== user.org_id && { label: 'Delete company', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', org: o }) },
              ]} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {dialog?.type === 'new' && <NewCompany onClose={() => setDialog(null)} onSaved={(addr) => { setDialog(null); toast(`Company created. Admin: ${addr}`); load(); }} />}
    {dialog?.type === 'edit' && <EditCompany org={dialog.org} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('Company updated'); load(); }} />}
    {dialog?.type === 'domains' && <Domains org={dialog.org} onClose={() => { setDialog(null); load(); }} />}
    {dialog?.type === 'delete' && (
      <ConfirmModal title={`Delete ${dialog.org.name}?`} confirm="Delete company"
        message={`This permanently deletes ${dialog.org.name}, all ${dialog.org.users} of its users, ${formatBytes(dialog.org.storage_used)} of files, calendars, contacts and chat. This cannot be undone.`}
        onClose={() => setDialog(null)} onConfirm={async () => { await del(`/orgs/${dialog.org.id}`); toast('Company deleted'); load(); }} />
    )}
  </>;
}

function NewCompany({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', domain: '', admin_name: '', admin_local: '', admin_password: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add company" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { const r = await post('/orgs', f); onSaved(r.address); } catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>Company name</span><input autoFocus required value={f.name} onChange={set('name')} /></label>
        <label className="field"><span>Domain</span><input required placeholder="company.com" autoCapitalize="none" spellCheck={false} value={f.domain} onChange={set('domain')} /></label>
        <h3>First administrator</h3>
        <label className="field"><span>Full name</span><input required value={f.admin_name} onChange={set('admin_name')} /></label>
        <label className="field"><span>Email address</span>
          <span className="address-input">
            <input required autoCapitalize="none" spellCheck={false} value={f.admin_local} onChange={set('admin_local')} placeholder="admin" aria-label="Address before @" />
            <span className="muted">@{f.domain.trim().toLowerCase() || 'company.com'}</span>
          </span>
        </label>
        <label className="field"><span>Temporary password</span><input required minLength={8} type="text" autoComplete="off" value={f.admin_password} onChange={set('admin_password')} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Create company</button></div>
      </form>
    </Modal>
  );
}

function EditCompany({ org, onClose, onSaved }) {
  const [f, setF] = useState({ name: org.name, quota_mb: org.quota_mb, allow_external: org.allow_external });
  const [error, setError] = useState('');
  return (
    <Modal title={`Edit ${org.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/orgs/${org.id}`, { ...f, quota_mb: Number(f.quota_mb) || 0 }); onSaved(); } catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>Company name</span><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Storage quota in MB (0 = unlimited)</span><input type="number" min="0" step="1" value={f.quota_mb} onChange={(e) => setF({ ...f, quota_mb: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.allow_external} onChange={(e) => setF({ ...f, allow_external: e.target.checked })} /> Allow collaboration with other companies</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function Domains({ org, onClose }) {
  const toast = useToast();
  const [domains, setDomains] = useState(org.domains);
  const [name, setName] = useState('');
  return (
    <Modal title={`Domains of ${org.name}`} onClose={onClose}>
      <ul className="share-list">
        {domains.map((d) => (
          <li key={d}><span className="grow">{d}</span>
            <button className="icon-btn" aria-label={`Remove ${d}`} disabled={domains.length === 1} onClick={async () => {
              try { setDomains((await del(`/orgs/${org.id}/domains/${encodeURIComponent(d)}`)).domains); } catch (e) { toast(e.message, 'error'); }
            }}><Icon name="close" size={18} /></button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        try { setDomains((await post(`/orgs/${org.id}/domains`, { name })).domains); setName(''); } catch (err) { toast(err.message, 'error'); }
      }}>
        <input className="grow" placeholder="another-domain.com" aria-label="New domain" autoCapitalize="none" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()}>Add domain</button>
      </form>
      <p className="muted small">A domain can only be removed when no user has an address on it.</p>
    </Modal>
  );
}

function OrgPicker({ orgId, setOrgId }) {
  const [orgs, setOrgs] = useState([]);
  useEffect(() => { get('/orgs').then(setOrgs).catch(() => {}); }, []);
  if (orgs.length < 2) return null;
  return (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Company" style={{ alignSelf: 'flex-start' }}>
      {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

function MailboxSize({ user, onClose, onSaved }) {
  const [mb, setMb] = useState(user.mail_quota_mb || 0);
  const [error, setError] = useState('');
  return (
    <Modal title={`Mailbox size for ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/users/${user.id}`, { mail_quota_mb: Number(mb) || 0 }); onSaved(); } catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>Maximum mailbox size in MB (0 = unlimited)</span>
          <input type="number" min="0" step="1" autoFocus value={mb} onChange={(e) => setMb(e.target.value)} /></label>
        <p className="muted small" style={{ margin: 0 }}>When a mailbox is full, new mail to it bounces back to the sender.</p>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

const BRAND_COLOURS = ['#1a73e8', '#0b8043', '#d93025', '#e37400', '#8e24aa', '#00796b', '#3949ab', '#202124'];

/** The company's logo (top bar and sign-in page) and colour (buttons, highlights, links). */
function Branding({ org, onChanged }) {
  const toast = useToast();
  const input = useRef();
  const [busy, setBusy] = useState(false);
  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const res = await fetch('/api/orgs/current/logo', { method: 'PUT', headers: { 'x-requested-with': 'nas-workspace', 'content-type': file.type || 'application/octet-stream' }, body: file });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Upload failed');
      toast('Logo saved'); await onChanged(data);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const colour = async (accent) => { try { await onChanged(await patch('/orgs/current', { accent })); toast(accent ? 'Colour saved' : 'Back to the usual colour'); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="card stack">
      <h2>Branding</h2>
      <div className="row" style={{ gap: 12 }}>
        <div className="brand-preview">{org.logo ? <img src={org.logo} alt="Company logo" /> : <span className="muted small">No logo</span>}</div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => input.current.click()}>{org.logo ? 'Change logo' : 'Upload logo'}</button>
            {org.logo && <button type="button" className="btn" onClick={async () => { await onChanged(await del('/orgs/current/logo')); toast('Logo removed'); }}>Remove</button>}
          </div>
          <span className="muted small">A PNG, JPEG or WebP picture up to 1 MB; square works best. Shown in the top bar and on the sign-in page.</span>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Logo file" onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="muted small">Colour (buttons, highlights and links, for everyone in the company)</span>
        <div className="label-colors" role="radiogroup" aria-label="Company colour">
          {BRAND_COLOURS.map((c) => <button key={c} type="button" role="radio" aria-checked={(org.accent || '#1a73e8') === c} aria-label={c} className={(org.accent || '#1a73e8') === c ? 'on' : ''} style={{ background: c }} onClick={() => colour(c === '#1a73e8' ? null : c)} />)}
          <label className="custom-colour" title="Another colour"><input type="color" aria-label="Another colour" value={org.accent || '#1a73e8'} onChange={(e) => colour(e.target.value)} /></label>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>The sign-in page shows your logo and colour when Workspace is opened at an address on one of your domains (for example workspace.{org.domains?.[0] || 'yourcompany.com'}).</p>
    </div>
  );
}
