import PhishingAdmin from './PhishingAdmin.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, put, patch, del, formatBytes, postText, postBlob } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Menu, Modal, PromptModal, useToast } from '../../components/ui.jsx';
import { inactive, lastActiveText } from './lastactive.js';
import AnnouncementsAdmin from './AnnouncementsAdmin.jsx';
import GroupsAdmin from './GroupsAdmin.jsx';
import { useAuth } from '../../App.jsx';
import EmailAdmin from './EmailAdmin.jsx';
import SecurityAdmin from './SecurityAdmin.jsx';
import DataProtectionAdmin from './DataProtectionAdmin.jsx';
import ActivityAdmin from './ActivityAdmin.jsx';
import StorageAdmin from './StorageAdmin.jsx';
import ReportsAdmin from './ReportsAdmin.jsx';
import SystemAdmin from './SystemAdmin.jsx';
import DrivesAdmin from './DrivesAdmin.jsx';
import LinksAdmin from './LinksAdmin.jsx';
import AppsAdmin from './AppsAdmin.jsx';
import { useMailStatus } from '../../mailStatus.js';
import { readFeatures } from '../calendar/roomfit.js';

/** Bring a Slack workspace's export (.zip) into Chat: its public channels, messages and threads. */
function SlackImport() {
  const toast = useToast();
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [check, setCheck] = useState(null); // { file, preview }: what it would bring in, to confirm
  const send = (file, preview) => fetch(`/api/chat/import/slack${preview ? '?preview=1' : ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/zip' }, body: file })
    .then(async (res) => { const r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(r.error || 'The import didn’t work'); return r; });
  const look = async (file) => {
    if (!file) return;
    setBusy(true); setDone(null);
    try { const preview = await send(file, true); setCheck({ file, preview, picked: new Set(preview.channels.map((c) => c.name)) }); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const run = async (file, channels) => {
    if (!file) return;
    setBusy(true); setDone(null);
    try {
      const res = await fetch(`/api/chat/import/slack${channels ? `?channels=${encodeURIComponent(channels.join(','))}` : ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/zip' }, body: file });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || 'The import didn’t work');
      setDone(r);
      toast(`Imported ${r.channels.length} channel${r.channels.length === 1 ? '' : 's'} with ${r.messages} message${r.messages === 1 ? '' : 's'} from Slack`);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3 className="small" style={{ margin: '8px 0 0' }}>Moving from Slack</h3>
      <p className="muted small" style={{ margin: 0 }}>In Slack: <em>Workspace settings → Import/export data → Export</em>, then download the .zip and pick it here. Its public channels come in with their messages, threads, reactions and dates; people are matched to yours by email, and anyone who isn't here keeps their Slack name. The history isn't marked unread.</p>
      <input ref={ref} type="file" accept=".zip,application/zip" hidden aria-label="Slack export" onChange={(e) => { look(e.target.files[0]); e.target.value = ''; }} />
      {check && (
        <ConfirmModal title="Import from Slack?" danger={false} onClose={() => setCheck(null)}
          confirm={(() => { const n = check.preview.channels.filter((c) => check.picked.has(c.name)).reduce((t, c) => t + c.messages, 0); return `Import ${n} message${n === 1 ? '' : 's'}`; })()}
          message={`${check.preview.channels.length} channel${check.preview.channels.length === 1 ? '' : 's'} with ${check.preview.messages} message${check.preview.messages === 1 ? '' : 's'}; ${check.preview.people_matched} of ${check.preview.people_matched + check.preview.not_here.length} people who wrote in them are here (matched by email).`}
          onConfirm={async () => {
            if (!check.picked.size) throw new Error('Tick at least one channel');
            const { file, picked, preview } = check; setCheck(null);
            await run(file, picked.size === preview.channels.length ? null : [...picked]);
          }}>
          <fieldset className="small" style={{ maxHeight: 220, overflow: 'auto', margin: '0 0 8px', border: 0, padding: 0 }}>
            <legend className="muted">Channels to bring in</legend>
            {check.preview.channels.map((c) => (
              <label key={c.name} className="check"><input type="checkbox" checked={check.picked.has(c.name)} onChange={(e) => {
                const picked = new Set(check.picked); if (e.target.checked) picked.add(c.name); else picked.delete(c.name);
                setCheck({ ...check, picked });
              }} /> #{c.name}{c.renamed ? ` → #${c.name} (Slack), as the name is taken` : ''}: {c.messages} message{c.messages === 1 ? '' : 's'}{c.archived ? ' (archived)' : ''}</label>
            ))}
          </fieldset>
          {check.preview.not_here.length > 0 && <p className="muted small" style={{ marginTop: 0 }}>Not here, so their messages keep their Slack name: {check.preview.not_here.join(', ')}.</p>}
        </ConfirmModal>
      )}
      <div><button type="button" className="btn" disabled={busy} onClick={() => ref.current?.click()}><Icon name="upload" size={18} /> {busy ? 'Importing…' : 'Import from Slack…'}</button></div>
      {done && <p className="small" role="status" style={{ margin: 0 }}>{done.channels.map((c) => `#${c.name}`).join(', ')}: {done.messages} messages. {done.people_matched} of {done.people_matched + done.people_not_here} people matched by email.{done.reactions ? ` ${done.reactions} reaction${done.reactions === 1 ? '' : 's'}.` : ''}{done.reactions_left_out ? ` ${done.reactions_left_out} left out (custom emoji, or by people who aren’t here).` : ''}</p>}
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'users'); // ?tab=activity (from a security alert)
  const [orgId, setOrgId] = useState(user.org_id); // which company the Users tab shows
  const mail = useMailStatus();
  const tabs = [['users', 'Users'], ...(mail?.enabled ? [['email', 'Email'], ['phishing', 'Phishing']] : []), ['dlp', 'Data protection'], ['company', 'Company settings'], ['groups', 'Groups'], ['announcements', 'Announcements'], ['activity', 'Activity'], ['reports', 'Reports'], ['storage', 'Storage'], ['drives', 'Shared drives'], ['links', 'Share links'], ['apps', 'Apps'], ...(user.is_super ? [['companies', 'All companies'], ['security', 'Security'], ['system', 'System']] : [])];

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
      {tab === 'phishing' && <PhishingAdmin />}
      {tab === 'company' && <CompanySettings />}
      {tab === 'dlp' && <DataProtectionAdmin />}
      {tab === 'groups' && <GroupsAdmin />}
      {tab === 'announcements' && <AnnouncementsAdmin mail={!!mail?.enabled} />}
      {tab === 'activity' && <ActivityAdmin orgId={orgId} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'reports' && <ReportsAdmin orgId={user.is_super && orgId !== user.org_id ? orgId : null} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'storage' && <StorageAdmin orgId={user.is_super ? orgId : null} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'drives' && <DrivesAdmin orgId={user.is_super ? orgId : null} orgPicker={user.is_super ? <OrgPicker orgId={orgId} setOrgId={setOrgId} /> : null} />}
      {tab === 'links' && <LinksAdmin />}
      {tab === 'apps' && <AppsAdmin />}
      {tab === 'security' && <SecurityAdmin />}
      {tab === 'system' && user.is_super && <SystemAdmin />}
      {tab === 'companies' && <Companies onManageUsers={(id) => { setOrgId(id); setTab('users'); }} />}
    </div>
  );
}

/** Allowed networks: Workspace only from the company's own addresses (offices, VPN). */
function Networks({ org, save }) {
  const [text, setText] = useState(org.allowed_nets || '');
  const [on, setOn] = useState(!!org.allowed_nets);
  return (
    <form className="card stack" aria-labelledby="nets-h" onSubmit={(e) => { e.preventDefault(); save({ allowed_nets: on ? text : '' }, on && text.trim() ? 'Workspace now works only from these networks' : 'Workspace works from anywhere'); }}>
      <h2 id="nets-h">Networks</h2>
      <label className="check"><input type="radio" name="nets" checked={!on} onChange={() => setOn(false)} /> Workspace works from anywhere</label>
      <label className="check"><input type="radio" name="nets" checked={on} onChange={() => { setOn(true); if (!text.trim() && org.your_ip) setText(org.your_ip); }} /> Only from these addresses and ranges (offices, VPN)</label>
      {on && <label className="field"><span>Addresses and ranges, one per line</span>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'203.0.113.10\n198.51.100.0/24'} /></label>}
      <p className="muted small" style={{ margin: 0 }}>Your address now: <code>{org.your_ip}</code>. It must be in the list, so you don't shut yourself out. From anywhere else, people can't sign in and are signed out of the web app. Phones and mail apps aren't affected.</p>
      <div><button className="btn">Save networks</button></div>
    </form>
  );
}

/** Where someone is signed in on the web (for a lost laptop or a phone left logged in), with sign-out. */
function UserDevices({ user, onClose }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = useCallback(() => get(`/users/${user.id}/sessions`).then(setList).catch((e) => { toast(e.message, 'error'); onClose(); }), [user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const out = async (sid) => {
    try { const r = await del(`/users/${user.id}/sessions/${sid}`); toast(r.signedOut ? `Signed out ${r.signedOut === 1 ? 'that device' : `${r.signedOut} devices`}` : 'Nothing to sign out'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`${user.name}'s signed-in devices`} onClose={onClose} footer={<>
      {list?.some((d) => !d.yours) && <button type="button" className="btn danger" onClick={() => out('all')}>Sign out everywhere</button>}
      <button type="button" className="btn primary" onClick={onClose}>Done</button>
    </>}>
      {!list ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">{user.name} isn't signed in anywhere on the web.</p> : (
        <ul className="storage-list" aria-label="Devices">
          {list.map((d) => (
            <li key={d.id}>
              <span className="grow"><strong>{d.device}</strong>{d.yours ? ' (this browser)' : ''}<br />
                <span className="muted small">{d.ip ? `${d.ip} · ` : ''}last active {new Date(d.last_seen || d.created_at).toLocaleString()} · signed in {new Date(d.created_at).toLocaleDateString()}</span></span>
              {!d.yours && <button type="button" className="btn small" onClick={() => out(d.id)}>Sign out</button>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Phones and mail apps that sync with a password keep working until the password is changed (⋮ → Reset password).</p>
    </Modal>
  );
}

/** Add the chosen people to one of the company's groups (keeping its members). */
function AddToGroup({ ids, onClose, onDone }) {
  const toast = useToast();
  const [groups, setGroups] = useState(null);
  const [gid, setGid] = useState('');
  useEffect(() => { get('/groups').then((g) => { setGroups(g); setGid(g[0]?.id || ''); }).catch((e) => toast(e.message, 'error')); }, [toast]);
  const save = async () => {
    const g = groups.find((x) => x.id === gid);
    try {
      await put(`/groups/${g.id}/members`, { user_ids: [...new Set([...g.members.map((m) => m.id), ...ids])] });
      toast(`Added to ${g.name}`); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Add ${ids.length} ${ids.length === 1 ? 'person' : 'people'} to a group`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!gid} onClick={save}>Add</button></>}>
      {groups === null ? <p className="muted">Loading…</p> : !groups.length ? <p>There are no groups yet: make one in the Groups tab.</p> : (
        <label className="field"><span>Group</span><select value={gid} onChange={(e) => setGid(e.target.value)}>{groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>)}</select></label>
      )}
    </Modal>
  );
}

// ---------------- users of one company ----------------
function Users({ orgId, setOrgId }) {
  const toast = useToast();
  // Bring in their data: a Download your data .zip into this person's account (moving them from another server).
  const restoreRef = useRef(null);
  const restoreFor = useRef(null);
  const restore = async (file) => {
    const u = restoreFor.current;
    if (!file || !u) return;
    toast(`Bringing ${u.name}’s data in…`);
    try {
      const r = await postBlob(`/takeout/restore?user=${encodeURIComponent(u.id)}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, file, 'application/zip');
      const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
      const parts = [r.drive?.files > 0 && `${n(r.drive.files, 'file', 'files')} in Drive`, r.mail?.started && n(r.mail.folders, 'mail folder', 'mail folders'), r.calendar && n(r.calendar.added, 'event', 'events'),
        r.contacts && n(r.contacts.added, 'contact', 'contacts'), r.tasks && n(r.tasks.lists, 'task list', 'task lists'), r.notes && n(r.notes.added, 'note', 'notes')].filter(Boolean);
      toast(`${u.name}: brought in ${parts.join(', ') || 'nothing new'}`);
      for (const x of [r.mail, r.filters, r.templates, r.event_templates, r.signatures]) if (x?.error) toast(x.error, 'error');
    } catch (e) { toast(e.message, 'error'); }
  };
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [inactiveOnly, setInactiveOnly] = useState(false);
  const [domains, setDomains] = useState([]);
  const [dialog, setDialog] = useState(null);
  const qs = orgId !== me.org_id ? `?org_id=${orgId}` : '';

  const load = useCallback(() => get(`/users${qs}`).then(setUsers).catch((e) => toast(e.message, 'error')), [qs, toast]);
  useEffect(() => { setUsers(null); load(); }, [load]);
  useEffect(() => {
    if (me.is_super) get('/orgs').then((list) => { setDomains(list.find((o) => o.id === orgId)?.domains || []); });
    else get('/orgs/current').then((o) => setDomains(o.domains));
  }, [me.is_super, orgId]);

  const act = (fn, msg) => async () => { try { await fn(); toast(msg); load(); } catch (e) { toast(e.message, 'error'); } };
  // Several people at once: tick them, then act on all of them.
  const [picked, setPicked] = useState(new Set());
  useEffect(() => { setPicked(new Set()); }, [orgId]);
  const toggle = (id) => setPicked((s0) => { const s = new Set(s0); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const bulk = async (action, value) => {
    try {
      const r = await post('/users/bulk', { ids: [...picked], action, value });
      toast(`${r.done} ${r.done === 1 ? 'person' : 'people'} updated${r.skipped.length ? `; skipped ${r.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}` : ''}`, r.skipped.length ? 'error' : 'info');
      setPicked(new Set()); load();
    } catch (e) { toast(e.message, 'error'); }
  };
  const shown = users?.filter((u) => !inactiveOnly || inactive(u)) || [];

  return <>
    <input ref={restoreRef} type="file" accept=".zip,application/zip" hidden aria-label="Their data to bring in" onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; restore(f); }} />
    <div className="row wrap">
      {me.is_super && <OrgPicker orgId={orgId} setOrgId={setOrgId} />}
      <label className="check"><input type="checkbox" checked={inactiveOnly} onChange={(e) => setInactiveOnly(e.target.checked)} /> Only people inactive for 90 days or more</label>
      <div className="grow" />
      <button className="btn" onClick={() => setDialog({ type: 'import' })}><Icon name="upload" size={18} /> Import from CSV</button>
      <a className="btn" href={`/api/users/export${qs}`} download><Icon name="download" size={18} /> Export as CSV</a>
      <button className="btn primary" onClick={() => setDialog({ type: 'new' })}><Icon name="plus" size={18} /> Add user</button>
    </div>
    {picked.size > 0 && (
      <div className="select-bar" role="toolbar" aria-label="Selected people">
        <strong>{picked.size} selected</strong>
        <button className="btn small" onClick={() => setDialog({ type: 'bulk-suspend' })}>Suspend</button>
        <button className="btn small" onClick={() => bulk('restore')}>Restore</button>
        <button className="btn small" onClick={() => bulk('signout')}>Sign out everywhere</button>
        <button className="btn small" onClick={() => setDialog({ type: 'bulk-department' })}>Set department…</button>
        <button className="btn small" onClick={() => setDialog({ type: 'bulk-group' })}>Add to group…</button>
        <div className="grow" />
        <button className="btn small" onClick={() => setPicked(new Set())}>Clear</button>
      </div>
    )}
    <table className="files">
      <thead><tr><th className="check-col"><input type="checkbox" aria-label="Select everyone shown" checked={shown.length > 0 && shown.every((u) => picked.has(u.id))}
        onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((u) => u.id)) : new Set())} /></th><th>Name</th><th className="hide-sm">Email address</th><th className="hide-sm">Role</th><th className="hide-sm">Storage</th><th className="hide-sm">Mailbox size</th><th className="hide-sm">Last active</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {inactiveOnly && users && !users.some((u) => inactive(u)) && <tr><td colSpan={8} className="muted">Everyone has used their account in the last 90 days.</td></tr>}
        {users?.filter((u) => !inactiveOnly || inactive(u)).map((u) => (
          <tr key={u.id} className={`${u.disabled ? 'dim' : ''} ${picked.has(u.id) ? 'selected' : ''}`}>
            <td className="check-col"><input type="checkbox" aria-label={`Select ${u.name}`} checked={picked.has(u.id)} onChange={() => toggle(u.id)} /></td>
            <td className="name"><Avatar name={u.name} size={28} userId={u.id} /><span>{u.name}{u.disabled ? ' (disabled)' : ''}</span></td>
            <td className="hide-sm muted">{u.username}</td>
            <td className="hide-sm">{u.is_super ? <span className="pill">Platform owner</span> : u.is_admin ? <span className="pill">Admin</span> : 'User'}
              {u.two_factor ? <span className="pill ok" title="Signs in with a password and a code from their phone">2-step</span> : null}
              {u.passkeys ? <span className="pill ok" title={`Has ${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}: signs in with a fingerprint, face, PIN or security key`}>🔑 Passkey</span> : null}
              {u.legal_hold ? <span className="pill warn" title={`Legal hold${u.hold_note ? `: ${u.hold_note}` : ''}${u.hold_by_name ? ` (by ${u.hold_by_name}` : ''}${u.hold_at ? `${u.hold_by_name ? ', ' : ' ('}${new Date(u.hold_at).toLocaleDateString()})` : u.hold_by_name ? ')' : ''}. Nothing of theirs is deleted for good.`}>On hold</span> : null}</td>
            <td className="hide-sm muted">{formatBytes(u.storage_used)}{u.drive_quota_mb ? ` of ${formatBytes(u.drive_quota_mb * 1048576)}` : ''}</td>
            <td className="hide-sm muted">{u.mail_quota_mb ? formatBytes(u.mail_quota_mb * 1048576) : 'Unlimited'}</td>
            <td className="hide-sm muted" title={u.last_active ? new Date(u.last_active).toLocaleString() : undefined}>{lastActiveText(u.last_active)}</td>
            <td className="actions">
              {!(u.is_super && !me.is_super) && (
                <Menu trigger={(p) => <button className="icon-btn" aria-label={`Actions for ${u.name}`} {...p}><Icon name="more" /></button>} items={[
                  { label: 'Reset password', icon: 'edit', onClick: () => setDialog({ type: 'password', user: u }) },
                  { label: 'Change email address', icon: 'mail', onClick: () => setDialog({ type: 'address', user: u }) },
                  { label: 'Job and manager', icon: 'person', onClick: () => setDialog({ type: 'job', user: u }) },
                  { label: 'Mailbox size', icon: 'mail', onClick: () => setDialog({ type: 'quota', user: u }) },
                  { label: 'Drive storage limit', icon: 'folder', onClick: () => setDialog({ type: 'drivequota', user: u }) },
                  { label: 'Signed-in devices', icon: 'logout', onClick: () => setDialog({ type: 'devices', user: u }) },
                  (u.two_factor || u.passkeys) && u.id !== me.id && { label: 'Reset two-step verification', icon: 'shield', onClick: () => setDialog({ type: 'reset2fa', user: u }) },
                  u.id !== me.id && !u.is_super && { label: u.is_admin ? 'Remove admin' : 'Make admin', icon: 'shield', onClick: act(() => patch(`/users/${u.id}`, { is_admin: !u.is_admin }), 'Role updated') },
                  u.id !== me.id && !u.is_super && { label: u.disabled ? 'Enable account' : 'Disable account', icon: 'logout', onClick: act(() => patch(`/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Account enabled' : 'Account disabled') },
                  !u.is_super && (u.legal_hold
                    ? { label: 'Lift legal hold', icon: 'shield', onClick: () => setDialog({ type: 'release', user: u }) }
                    : { label: 'Put on legal hold…', icon: 'shield', onClick: () => setDialog({ type: 'hold', user: u }) }),
                  { label: 'Download their data (.zip)', icon: 'download', onClick: () => { window.location.href = `/api/takeout?user=${encodeURIComponent(u.id)}`; } },
                  { label: 'Bring in their data…', icon: 'upload', onClick: () => { restoreFor.current = u; restoreRef.current?.click(); } },
                  u.id !== me.id && !u.is_super && '-',
                  u.id !== me.id && !u.is_super && { label: 'Delete user and their files', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', user: u }) },
                ]} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {dialog?.type === 'bulk-suspend' && (
      <ConfirmModal title={`Suspend ${picked.size} ${picked.size === 1 ? 'person' : 'people'}?`} confirm="Suspend"
        message="They're signed out everywhere and can't sign in (on the web, phones or mail apps) until restored. Their mail keeps arriving and nothing is deleted."
        onClose={() => setDialog(null)} onConfirm={() => bulk('suspend')} />
    )}
    {dialog?.type === 'bulk-department' && <PromptModal title={`Department for ${picked.size} ${picked.size === 1 ? 'person' : 'people'}`} label="Department" confirm="Save"
      onClose={() => setDialog(null)} onSubmit={async (v) => { await bulk('department', v); setDialog(null); }} />}
    {dialog?.type === 'bulk-group' && <AddToGroup ids={[...picked]} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setPicked(new Set()); }} />}
    {dialog?.type === 'devices' && <UserDevices user={dialog.user} onClose={() => setDialog(null)} />}
    {dialog?.type === 'import' && <ImportUsers orgId={orgId} domains={domains} onClose={() => setDialog(null)} onDone={load} />}
    {dialog?.type === 'new' && <NewUser orgId={orgId} domains={domains} onClose={() => setDialog(null)} onSaved={(addr) => { setDialog(null); toast(`${addr} created`); load(); }} />}
    {dialog?.type === 'password' && <ResetPassword user={dialog.user} onClose={() => setDialog(null)} />}
    {dialog?.type === 'job' && <JobDialog user={dialog.user} people={users || []} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('Saved'); load(); }} />}
    {dialog?.type === 'address' && <ChangeAddress user={dialog.user} domains={domains} onClose={() => setDialog(null)} onSaved={(addr) => { setDialog(null); toast(`Address changed to ${addr}`); load(); }} />}
    {dialog?.type === 'drivequota' && <DriveLimit user={dialog.user} onClose={() => setDialog(null)} onSaved={(mb) => { setDialog(null); toast(mb ? `${dialog.user.name} can store up to ${mb} MB` : `No limit of their own for ${dialog.user.name}`); load(); }} />}
    {dialog?.type === 'quota' && <MailboxSize user={dialog.user} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('Mailbox size updated'); load(); }} />}
    {dialog?.type === 'hold' && <PromptModal title={`Put ${dialog.user.name} on legal hold`} label="Why (for the record)" confirm="Put on hold"
      message={`While ${dialog.user.name} is on hold, nothing of theirs is deleted for good: not their Drive trash, Chat messages or the mail in their Trash and Junk when the company's clean-ups run, and not by them or anyone else deleting it for good. Their account can't be deleted. They can still move things to the trash, which keeps them. They aren't told.`}
      onClose={() => setDialog(null)} onSubmit={async (v) => { await patch(`/users/${dialog.user.id}`, { legal_hold: true, hold_note: v }); setDialog(null); toast(`${dialog.user.name} is on legal hold`); load(); }} />}
    {dialog?.type === 'release' && <ConfirmModal title={`Lift the legal hold on ${dialog.user.name}?`} confirm="Lift hold" danger={false}
      message={`${dialog.user.hold_note ? `On hold for: ${dialog.user.hold_note}. ` : ''}Once lifted, their trash and old messages are cleaned up as usual again, and things can be deleted for good.`}
      onClose={() => setDialog(null)} onConfirm={async () => { await patch(`/users/${dialog.user.id}`, { legal_hold: false }); toast('Legal hold lifted'); load(); }} />}
    {dialog?.type === 'reset2fa' && (
      <ConfirmModal title={`Reset two-step verification for ${dialog.user.name}?`} confirm="Reset" danger={false}
        message={`Use this when ${dialog.user.name} has lost their phone. Their authenticator app and their passkeys stop working, so they can sign in with just their password, and should set two-step verification (or a passkey) up again in Settings. They are signed out everywhere now. Only do this once you're sure it's really them asking.`}
        onClose={() => setDialog(null)} onConfirm={async () => { await patch(`/users/${dialog.user.id}`, { reset_two_factor: true }); toast('Two-step verification reset. They were signed out everywhere.'); load(); }} />
    )}
    {dialog?.type === 'delete' && (
      <ConfirmModal title={`Delete ${dialog.user.name}?`} confirm="Delete user"
        message={`This permanently deletes ${dialog.user.username}, their ${dialog.heir ? '' : `files (${formatBytes(dialog.user.storage_used)}), `}calendar, contacts and messages. Consider disabling the account instead.`}
        onClose={() => setDialog(null)} onConfirm={async () => {
          const qs = new URLSearchParams({ ...(dialog.heir && { transfer_to: dialog.heir }), ...(dialog.mailTo && { mail_to: dialog.mailTo }), ...(dialog.eventsTo && { events_to: dialog.eventsTo }) });
          const r = await del(`/users/${dialog.user.id}${qs.toString() ? `?${qs}` : ''}`);
          const given = dialog.heir && r.files_moved ? `; ${r.files_moved} file${r.files_moved === 1 ? '' : 's'} given to ${users.find((x) => x.id === dialog.heir)?.name}` : '';
          const kept = r.drive_items_kept ? `; ${r.drive_items_kept} item${r.drive_items_kept === 1 ? '' : 's'} kept in shared drives` : '';
          const mail = r.mail_to ? `; their email now goes to ${r.mail_to}` : '';
          const meetings = dialog.eventsTo && r.meetings_moved ? `; ${r.meetings_moved} meeting${r.meetings_moved === 1 ? '' : 's'} given to ${users.find((x) => x.id === dialog.eventsTo)?.name}` : '';
          toast(`User deleted${given}${kept}${mail}${meetings}`); load();
        }}>
        <label className="field"><span>Their Drive files</span>
          <select value={dialog.heir || ''} onChange={(e) => setDialog({ ...dialog, heir: e.target.value || null })}>
            <option value="">Delete them too</option>
            {(users || []).filter((x) => x.id !== dialog.user.id && !x.disabled).map((x) => <option key={x.id} value={x.id}>Give them to {x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Email sent to {dialog.user.username} from now on</span>
          <select value={dialog.mailTo || ''} onChange={(e) => setDialog({ ...dialog, mailTo: e.target.value || null })}>
            <option value="">Bounce it (the address stops working)</option>
            {(users || []).filter((x) => x.id !== dialog.user.id && !x.disabled).map((x) => <option key={x.id} value={x.id}>Send it to {x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Upcoming meetings they organise</span>
          <select value={dialog.eventsTo || ''} onChange={(e) => setDialog({ ...dialog, eventsTo: e.target.value || null })}>
            <option value="">Cancel them</option>
            {(users || []).filter((x) => x.id !== dialog.user.id && !x.disabled).map((x) => <option key={x.id} value={x.id}>{x.name} organises them</option>)}
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>What they added to shared drives stays there either way. A shared drive they own goes to one of its editors (or to whoever gets their files, or to you).</p>
      </ConfirmModal>
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
    try { const r = await call(false); setDone(r); onDone(); toast(`${r.created} user${r.created === 1 ? '' : 's'} created${r.updated ? `, ${r.updated} updated` : ''}`); } catch (e) { setError(e.message); }
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
          <p style={{ margin: 0 }}><strong>{done.created}</strong> created{done.updated ? <>, <strong>{done.updated}</strong> updated</> : ''}. Passwords made up for people who had none are shown only now: download them or copy them to pass on.</p>
          <ImportTable rows={done.rows} result />
          <div className="row"><button type="button" className="btn primary" onClick={download}><Icon name="download" size={18} /> Download sign-in details (CSV)</button></div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>A CSV file with one person per row. The first row names the columns: <strong>Name</strong> (or First name and Last name), <strong>Email</strong> (a full address, or just the part before @), and optionally <strong>Password</strong> (at least 8 characters; one is made up if it's empty), <strong>Admin</strong> (yes), <strong>Job title</strong>, <strong>Department</strong>, <strong>Work phone</strong> and <strong>Manager</strong> (their email address). People already here get their job details brought up to date (empty cells leave what's there), so a file from <strong>Export</strong> can come back in. Up to 500 people.</p>
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
              : <button type="button" className="btn primary" disabled={!good.length} onClick={create}>{(() => { const n = good.filter((r) => !r.update).length, u = good.length - n; return [n && `Create ${n} user${n === 1 ? '' : 's'}`, u && `${n ? 'update' : 'Update'} ${u}`].filter(Boolean).join(', '); })()}</button>}
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
              <td>{r.error ? <span className="error">{r.error}</span> : result ? (r.updated ? 'Updated' : 'Created') : r.update ? 'Already here: details updated' : 'OK'}{r.warning && <span className="muted small"> · {r.warning}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewUser({ orgId, domains, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', local: '', domain: domains[0] || '', password: '', is_admin: false, must_change_password: true });
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
        <label className="check"><input type="checkbox" checked={f.must_change_password} onChange={(e) => setF({ ...f, must_change_password: e.target.checked })} /> Ask them to choose their own password when they first sign in</label>
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
  const { user: me } = useAuth();
  const [mustChange, setMustChange] = useState(true);
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title={`Reset password for ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/users/${user.id}`, { password: pw, must_change_password: mustChange }); toast('Password reset. The user was signed out everywhere.'); onClose(); }
        catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>New password</span><input autoFocus required minLength={8} type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {user.id !== me?.id && <label className="check"><input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} /> Ask them to choose their own password when they next sign in</label>}
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Reset password</button></div>
      </form>
    </Modal>
  );
}

// ---------------- the admin's own company ----------------
/** The company's password rules: length, letters and numbers, a symbol, nothing easy to guess, expiry. */
function PasswordRules({ org, save }) {
  const r = org.password_rules || { min: 8, mix: false, symbol: false, common: false, max_days: 0 };
  const set = (c, msg) => save({ password_rules: { ...r, ...c } }, msg || 'Password rules saved');
  return (
    <div className="card stack" aria-labelledby="pwr-h">
      <h2 id="pwr-h">Password rules</h2>
      <label className="field" style={{ maxWidth: 260 }}><span>Shortest password</span>
        <select aria-label="Shortest password" value={r.min} onChange={(e) => set({ min: Number(e.target.value) })}>
          {[8, 10, 12, 14, 16, 20].map((n) => <option key={n} value={n}>{n} characters</option>)}
        </select></label>
      <label className="check"><input type="checkbox" checked={r.mix} onChange={(e) => set({ mix: e.target.checked })} /> Letters and numbers</label>
      <label className="check"><input type="checkbox" checked={r.symbol} onChange={(e) => set({ symbol: e.target.checked })} /> A symbol (like ! # or -)</label>
      <label className="check"><input type="checkbox" checked={r.common} onChange={(e) => set({ common: e.target.checked })} /> Nothing easy to guess (well-known passwords, or the person's own name or address)</label>
      <label className="field" style={{ maxWidth: 260 }}><span>Passwords expire</span>
        <select aria-label="Passwords expire" value={r.max_days} onChange={(e) => { const d = Number(e.target.value); set({ max_days: d }, d ? `Passwords now expire after ${d} days` : 'Passwords no longer expire'); }}>
          {[[0, 'Never'], [30, 'After 30 days'], [60, 'After 60 days'], [90, 'After 90 days'], [180, 'After 180 days'], [365, 'After a year']].map(([d, n]) => <option key={d} value={d}>{n}</option>)}
        </select></label>
      <p className="muted small" style={{ margin: 0 }}>They apply whenever someone chooses a password (and to passwords you set or import). Existing passwords keep working; with an expiry, people choose a new one once theirs is older than that, before going on. Mail-app passwords are made by Workspace and are always strong.</p>
    </div>
  );
}

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
      setOrg({ ...o, your_ip: before.your_ip });
      setUser({ ...user, org_name: o.name, allow_external: o.allow_external, allow_links: o.allow_links, link_max_days: o.link_max_days, link_password: o.link_password });
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
        {org.allow_links && <>
          <label className="field" style={{ maxWidth: 360 }}><span>Links must expire within (days; empty for no limit)</span>
            <input type="number" min={1} max={365} defaultValue={org.link_max_days || ''} placeholder="No limit" aria-label="Links must expire within days"
              onBlur={(e) => { const v = e.target.value.trim(); const d = v ? Number(v) : null; if (d !== (org.link_max_days || null)) save({ link_max_days: d }, d ? `Links must now expire within ${d} day${d === 1 ? '' : 's'}` : 'Links can last as long as people choose'); }} />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!org.link_password} onChange={(e) => save({ link_password: e.target.checked }, e.target.checked ? 'Links now need a password' : 'Passwords on links are up to each person')} />
            Require a password on every link
          </label>
          <p className="muted small" style={{ margin: 0 }}>These apply to links made or changed from now on (existing ones stay as they are: see Admin → Share links). With passwords required, Mail can't send large files as links.</p>
        </>}
        <label className="check">
          <input type="checkbox" checked={org.meet_guests !== false} onChange={(e) => save({ meet_guests: e.target.checked }, e.target.checked ? 'Guests can ask to join meetings' : 'Guests can no longer join meetings')} />
          Let guests without an account ask to join video meetings from the meeting’s link (someone in the meeting lets them in)
        </label>
        <label className="check">
          <input type="checkbox" checked={org.allow_publish !== false} onChange={(e) => save({ allow_publish: e.target.checked }, e.target.checked ? 'Publishing to the web is on' : 'Publishing to the web is off: published pages no longer show')} />
          Let people publish documents, spreadsheets and presentations to the web (read-only pages anyone with the address can see)
        </label>
        <PublishedList />
        <label className="check">
          <input type="checkbox" checked={!!org.allow_api_tokens} onChange={(e) => save({ allow_api_tokens: e.target.checked }, e.target.checked ? 'People can make API tokens' : 'API tokens are off: existing ones stop working')} />
          Let people make API tokens for their own scripts (Settings → API tokens). Each acts as its owner, can be read-only, and expires
        </label>
        <CompanyTokens />
        <label className="check">
          <input type="checkbox" checked={!!org.push_private} onChange={(e) => save({ push_private: e.target.checked }, e.target.checked ? 'Notifications on phones now hide what’s written' : 'Notifications on phones show what’s written again')} />
          Keep what’s written off lock screens: notifications on phones and computers say who or what it’s from (“HR Team · New email”), not the subject or message
        </label>
      </div>
      <CompanySignature org={org} save={save} />
      <div className="card stack">
        <h2>Who has seen files</h2>
        <label className="check"><input type="checkbox" checked={org.view_history !== false} onChange={(e) => save({ view_history: e.target.checked }, e.target.checked ? 'Owners and editors can see who has opened their files' : 'Nobody sees who has opened files')} /> Show owners and editors who has opened their files (Drive → Details)</label>
        <p className="muted small" style={{ margin: 0 }}>Each person can also hide their own openings in Settings.</p>
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
      <Networks org={org} save={save} />
      <PasswordRules org={org} save={save} />
      <div className="card stack" aria-labelledby="mailempty-h">
        <h2 id="mailempty-h">Emptying Trash and Junk</h2>
        {[['mail_trash_days', 'Empty Trash after', 'Trash'], ['mail_junk_days', 'Empty Junk after', 'Junk']].map(([key, label, folder]) => (
          <label key={key} className="field" style={{ maxWidth: 320 }}><span>{label}</span>
            <select aria-label={label} value={org[key] ?? 0} onChange={(e) => { const d = Number(e.target.value); save({ [key]: d }, d ? `Mail is now deleted from ${folder} after ${d} days` : `${folder} is no longer emptied by itself`); }}>
              {[[0, 'Never'], [7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [365, 'A year']].map(([d, n]) => <option key={d} value={d}>{n}</option>)}
            </select></label>
        ))}
        <p className="muted small" style={{ margin: 0 }}>For everyone's mailbox in your company: mail that has been in Trash (or Junk) that long is deleted for good by the mail server, also when it's read on a phone or in Outlook. It frees the space it took.</p>
      </div>
      <div className="card stack" aria-labelledby="mailfwd-h">
        <h2 id="mailfwd-h">Automatic forwarding</h2>
        <label className="check">
          <input type="checkbox" checked={org.allow_forwarding !== false} onChange={(e) => save({ allow_forwarding: e.target.checked }, e.target.checked ? 'People may forward their mail outside the company' : 'Mail is now only forwarded within the company')} />
          Let people forward their mail automatically to addresses outside the company
        </label>
        <p className="muted small" style={{ margin: 0 }}>Turned off, Mail → Forwarding and filters only send copies to your company's own domains, and forwarding already set up to anywhere else stops at once (it starts again if you turn this back on). Every forwarding address has to confirm with a code first, and turning forwarding on or off is in the activity log.</p>
      </div>
      <div className="card stack" aria-labelledby="askout-h">
        <h2 id="askout-h">Mail going outside the company</h2>
        <label className="check">
          <input type="checkbox" checked={!!org.ask_outside} onChange={(e) => save({ ask_outside: e.target.checked }, e.target.checked ? 'Mail now asks before a message goes outside the company' : 'Mail no longer asks before sending outside')} />
          Ask before sending a message to anyone outside the company
        </label>
        <p className="muted small" style={{ margin: 0 }}>Everyone sees who's outside as they write. With this on, <strong>Send</strong> (and <strong>Send later</strong>) also asks <em>Send outside …?</em> with those addresses, and the message only goes once they say so. Mail between colleagues goes as usual.</p>
      </div>
      <div className="card stack" aria-labelledby="sess-h">
        <h2 id="sess-h">Sign-in sessions</h2>
        <label className="field" style={{ maxWidth: 320 }}><span>Sign out after no activity for</span>
          <select aria-label="Sign out after no activity for" value={org.session_idle_min ?? 0} onChange={(e) => { const m = Number(e.target.value); save({ session_idle_min: m }, m ? `People are now signed out after ${m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`} without activity` : 'People stay signed in while away'); }}>
            {[[0, 'Never'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours']].map(([m, n]) => <option key={m} value={m}>{n}</option>)}
          </select></label>
        <label className="field" style={{ maxWidth: 320 }}><span>A sign-in lasts at most</span>
          <select aria-label="A sign-in lasts at most" value={org.session_max_hours ?? 0} onChange={(e) => { const h = Number(e.target.value); save({ session_max_hours: h }, h ? `Sign-ins now last at most ${h} hours` : 'Sign-ins last 30 days, renewed while used'); }}>
            {[[0, '30 days (renewed while used)'], [8, '8 hours'], [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']].map(([h, n]) => <option key={h} value={h}>{n}</option>)}
          </select></label>
        <p className="muted small" style={{ margin: 0 }}>For shared or front-desk computers. "No activity" means no typing, clicking or scrolling in Workspace (the app refreshing itself doesn't count). Once signed out, people sign in again; phones and mail apps aren't affected.</p>
      </div>
      <div className="card stack">
        <h2>Keeping chat</h2>
        <label className="field"><span>Keep chat messages</span>
          <select aria-label="Keep chat messages" value={String(org.chat_days ?? 0)} onChange={(e) => { const d = Number(e.target.value); save({ chat_days: d }, d ? `Chat messages older than ${d === 1825 ? '5 years' : d === 365 ? 'a year' : `${d} days`} will be deleted` : 'Chat messages are kept for good'); }}>
            {[[0, 'For good'], [1825, 'For 5 years'], [365, 'For a year'], [90, 'For 90 days'], [30, 'For 30 days']].map(([d, n]) => <option key={d} value={d}>{n}</option>)}
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>Older messages (with their threads, reactions and polls) are deleted every hour, in your company's channels and in direct messages with your people. Files sent in chat stay in Drive. This can't be undone.</p>
        <SlackImport />
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
      <p className="muted small" style={{ margin: 0 }}>Meeting rooms (or a projector, a company car…) people can book by adding them to an event. A room that's taken at that time declines. Say where each is and what's in it (video, a whiteboard…) to help people pick.</p>
      {rooms?.length > 0 && (
        <ul className="room-list" aria-label="Rooms">
          {rooms.map((r) => (
            <li key={r.id}>
              <input aria-label={`Name of ${r.name}`} defaultValue={r.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.name) run(() => patch(`/rooms/${r.id}`, { name: v }), 'Room renamed')(); }} />
              <input aria-label={`People ${r.name} fits`} type="number" min="1" placeholder="Seats" defaultValue={r.capacity ?? ''} style={{ width: 90 }}
                onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (r.capacity ?? null)) run(() => patch(`/rooms/${r.id}`, { capacity: v }))(); }} />
              <input aria-label={`Where ${r.name} is`} className="room-where" placeholder="Where (floor, building)" defaultValue={r.location ?? ''}
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== (r.location ?? '')) run(() => patch(`/rooms/${r.id}`, { location: v }))(); }} />
              <input aria-label={`Equipment in ${r.name}`} className="room-kit" placeholder="Equipment, with commas" defaultValue={(r.features || []).join(', ')}
                onBlur={(e) => { const v = readFeatures(e.target.value); e.target.value = v.join(', '); if (v.join('\n') !== (r.features || []).join('\n')) run(() => patch(`/rooms/${r.id}`, { features: v }))(); }} />
              <label className="check small room-admins" title="Someone from the meeting checks in within 10 minutes of the start (in Rooms now), or the room is released for others">
                <input type="checkbox" aria-label={`Release ${r.name} if nobody checks in`} defaultChecked={!!r.check_in}
                  onChange={(e) => { const el = e.target, on = el.checked; patch(`/rooms/${r.id}`, { check_in: on }).then(() => toast(on ? `${r.name}: check-in needed` : `${r.name}: no check-in`)).catch((err) => { el.checked = !on; toast(err.message, 'error'); }); }} /> ✅ Check-in</label>
              <label className="check small room-admins" title="Only admins can book it; others are declined"><input type="checkbox" aria-label={`Only admins can book ${r.name}`} defaultChecked={!!r.admins_only}
                onChange={(e) => { const el = e.target, on = el.checked; patch(`/rooms/${r.id}`, { admins_only: on }).then(() => toast(on ? `${r.name}: admins only` : `${r.name}: anyone can book`)).catch((err) => { el.checked = !on; toast(err.message, 'error'); }); }} /> 🔒 Admins only</label>
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
      <div className="row wrap" style={{ gap: 8 }}>
        <label className="btn small">Import from CSV…<input type="file" accept=".csv,text/csv" hidden aria-label="Rooms file to import"
          onChange={async (e) => {
            const f = e.target.files[0]; e.target.value = '';
            if (!f) return;
            try {
              const r = await postText('/rooms/import', await f.text());
              toast([`${r.added} added, ${r.updated} updated`, ...r.problems.slice(0, 3)].join(' · '), r.problems.length ? 'info' : undefined, { duration: r.problems.length ? 10000 : 4000 });
              load();
            } catch (err) { toast(err.message, 'error'); }
          }} /></label>
        {rooms?.length > 0 && <a className="btn small" href="/api/rooms/export.csv" download>Export as CSV</a>}
        <span className="muted small">Columns: Name, Seats, Where, Equipment, Admins only, Check-in (yes or no). Rooms with the same name are updated.</span>
      </div>
      {rooms?.length > 0 && <RoomUsage />}
    </div>
  );
}

/** How much each room was booked lately: to see which sit empty and which are always taken. */
function RoomUsage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  useEffect(() => { setData(null); get(`/rooms/usage?days=${days}`).then(setData).catch(() => setData({ rooms: [] })); }, [days]);
  return (
    <div className="stack room-usage">
      <div className="row"><h3 className="grow" style={{ margin: 0 }}>Usage</h3>
        <select aria-label="Usage over" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select></div>
      {!data ? <p className="muted small">Loading…</p> : (
        <table className="data-table" aria-label="Room usage">
          <thead><tr><th>Room</th><th>Bookings</th><th>Hours</th><th>Of working time</th><th title="Booked, but nobody checked in, so the room was released (rooms with check-in)">No-shows</th><th>Booked most by</th></tr></thead>
          <tbody>{data.rooms.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td><td>{r.bookings}</td><td>{r.hours}</td>
              <td><span className="usage-bar" aria-hidden="true"><span style={{ width: `${r.share}%` }} /></span> {r.share}%</td>
              <td className={r.no_shows ? 'usage-noshow' : 'muted'}>{r.no_shows || '—'}</td>
              <td className="muted small">{r.top.map((p) => `${p.name} (${p.bookings})`).join(', ') || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <p className="muted small" style={{ margin: 0 }}>Working time is weekdays, 8 hours a day. No-shows are bookings released because nobody checked in (rooms with ✅ Check-in). A room that's rarely booked could become something else; one that's always taken may mean you need another like it.</p>
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

/** A person's own Drive storage limit (empty: only the company's). */
function DriveLimit({ user, onClose, onSaved }) {
  const [mb, setMb] = useState(user.drive_quota_mb || '');
  const [error, setError] = useState('');
  return (
    <Modal title={`Drive storage for ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/users/${user.id}`, { drive_quota_mb: mb === '' ? null : Number(mb) }); onSaved(mb === '' ? null : Number(mb)); } catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>Most they can store, in MB (empty: no limit of their own)</span>
          <input type="number" min="1" step="1" autoFocus value={mb} placeholder="No limit" onChange={(e) => setMb(e.target.value)} /></label>
        <p className="muted small" style={{ margin: 0 }}>They use {formatBytes(user.storage_used)} now: their files, the trash and older versions. Once full, uploads and copies are refused until they free some space. The company's quota still applies.</p>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
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

/** Who's who for one person: job title, department, work phone and who they report to. */
function JobDialog({ user: u, people, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ job_title: u.job_title || '', department: u.department || '', work_phone: u.work_phone || '', manager_id: u.manager_id || '' });
  const save = async () => {
    try { await patch(`/users/${u.id}`, { ...f, manager_id: f.manager_id || null }); onSaved(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Job and manager: ${u.name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <label className="field"><span>Job title</span><input value={f.job_title} maxLength={100} onChange={(e) => setF({ ...f, job_title: e.target.value })} /></label>
        <label className="field"><span>Department</span><input value={f.department} maxLength={100} onChange={(e) => setF({ ...f, department: e.target.value })} /></label>
        <label className="field"><span>Work phone</span><input type="tel" value={f.work_phone} maxLength={40} onChange={(e) => setF({ ...f, work_phone: e.target.value })} /></label>
        <label className="field"><span>Reports to</span>
          <select value={f.manager_id} onChange={(e) => setF({ ...f, manager_id: e.target.value })}>
            <option value="">Nobody (top of the org chart)</option>
            {people.filter((p) => p.id !== u.id && !p.disabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
      </div>
    </Modal>
  );
}

/** One signature for everyone, filled in with each person's details. */
function CompanySignature({ org, save }) {
  const [text, setText] = useState(org.signature_template || '');
  const mode = org.signature_template ? org.signature_mode || 'off' : 'off';
  return (
    <form className="card stack" aria-labelledby="csig-h" onSubmit={(e) => { e.preventDefault(); save({ signature_template: text, ...(mode === 'off' && text.trim() && { signature_mode: 'default' }) }, 'Company signature saved'); }}>
      <h2 id="csig-h">Company signature</h2>
      <p className="muted small" style={{ margin: 0 }}>One line per line. <code>{'{name}'}</code>, <code>{'{job_title}'}</code>, <code>{'{department}'}</code>, <code>{'{work_phone}'}</code>, <code>{'{email}'}</code> (the address they send from) and <code>{'{company}'}</code> are filled in for each person; a line whose details are all missing is left out.</p>
      <label className="field"><span>Signature</span><textarea rows={5} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{name}\n{job_title} · {department}\n{company} · {work_phone}'} /></label>
      <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small"><strong>Who gets it</strong></legend>
        {[['off', 'Nobody (everyone writes their own)'], ['default', 'People who haven’t written their own'], ['always', 'Everyone (people can’t change theirs)']].map(([v, label]) => (
          <label key={v} className="check"><input type="radio" name="sigmode" checked={mode === v} disabled={v !== 'off' && !org.signature_template}
            onChange={() => save({ signature_mode: v }, v === 'off' ? 'Company signature off' : v === 'default' ? 'People without their own signature get the company one' : 'Everyone now uses the company signature')} /> {label}</label>
        ))}
      </fieldset>
      <div className="row end"><button className="btn primary" disabled={text === (org.signature_template || '')}>Save signature</button></div>
    </form>
  );
}

/** What the company has published to the web, to review or stop. */
function CompanyTokens() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => get('/tokens/company').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list?.length) return null;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString() : null);
  return (
    <section className="stack-tight" aria-label="API tokens in the company">
      <strong className="small">API tokens</strong>
      <ul className="plain-list">
        {list.map((t) => (
          <li key={t.id} className="row small"><span className="grow">{t.name} <span className="muted">· {t.user_name} · {t.scope === 'write' ? 'read and write' : 'read only'} · {t.expired ? 'expired' : t.expires_at ? `expires ${day(t.expires_at)}` : 'never expires'} · {t.last_used_at ? `last used ${day(t.last_used_at)}` : 'never used'}</span></span>
            <button type="button" className="btn small" aria-label={`Revoke ${t.name} of ${t.user_name}`} onClick={async () => { try { await del(`/tokens/company/${t.id}`); toast(`“${t.name}” revoked`); load(); } catch (e) { toast(e.message, 'error'); } }}>Revoke</button></li>
        ))}
      </ul>
    </section>
  );
}

function PublishedList() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => get('/publish').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list?.length) return <p className="muted small" style={{ margin: 0 }}>Nothing is published to the web now.</p>;
  return (
    <section className="stack-tight" aria-label="Published to the web">
      <strong className="small">Published to the web</strong>
      <ul className="plain-list">
        {list.map((p) => (
          <li key={p.file_id} className="row small"><span className="grow"><a href={p.path} target="_blank" rel="noreferrer">{p.name}</a> <span className="muted">· {p.owner_name} · opened {p.views} time{p.views === 1 ? '' : 's'}</span></span>
            <button type="button" className="btn small" aria-label={`Stop publishing ${p.name}`} onClick={async () => { try { await del(`/publish/${p.file_id}`); toast(`“${p.name}” is no longer published`); load(); } catch (e) { toast(e.message, 'error'); } }}>Stop</button></li>
        ))}
      </ul>
    </section>
  );
}
