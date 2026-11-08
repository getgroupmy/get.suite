// Admin: company groups ("Marketing", "Managers"). Sharing a file or folder with a group shares it with
// everyone in it; people added later get it too, and people taken off lose it.
import { useEffect, useState } from 'react';
import { get, post, put, patch, del } from '../../api.js';
import { Avatar, ConfirmModal, useToast } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

export default function GroupsAdmin() {
  const toast = useToast();
  const [groups, setGroups] = useState(null);
  const [people, setPeople] = useState([]);
  const [name, setName] = useState('');
  const [domains, setDomains] = useState([]); // for a group's email address (when the server has email)
  const [mailOn, setMailOn] = useState(false);
  useEffect(() => { get('/orgs/current').then((o) => setDomains(o.domains || [])).catch(() => {}); get('/mail/status').then((m) => setMailOn(!!m.enabled)).catch(() => {}); }, []);
  const [open, setOpen] = useState(null); // group id being edited
  const [gone, setGone] = useState(null);
  const load = () => get('/groups').then(setGroups).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); get('/users/directory').then(setPeople).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (e) => {
    e.preventDefault();
    try { const g = await post('/groups', { name }); setName(''); setOpen(g.id); load(); } catch (err) { toast(err.message, 'error'); }
  };
  const setMembers = async (g, ids) => {
    // The tick moves straight away; the server's answer follows.
    setGroups((list) => list.map((x) => (x.id === g.id ? { ...x, members: people.filter((p) => ids.includes(p.id)).map(({ id, name, username }) => ({ id, name, username })) } : x)));
    try { await put(`/groups/${g.id}/members`, { user_ids: ids }); } catch (err) { toast(err.message, 'error'); }
    load();
  };
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <form className="card stack" onSubmit={create} aria-label="New group">
        <h2 style={{ margin: 0 }}>Groups</h2>
        <p className="muted small" style={{ margin: 0 }}>Share files and folders with a whole team at once (Share → <em>Share with a group…</em>). Whoever is in the group has access: people you add later get it, and people you take off lose it.</p>
        <div className="row"><input className="grow" required maxLength={80} aria-label="Group name" placeholder="New group, e.g. Marketing" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary">Create group</button></div>
      </form>
      {groups?.length === 0 && <p className="muted">No groups yet.</p>}
      <ul className="group-list">
        {groups?.map((g) => {
          const inIt = new Set(g.members.map((m) => m.id));
          return (
            <li key={g.id} className="card stack-tight" aria-label={`Group ${g.name}`}>
              <div className="row">
                <Icon name="people" />
                <strong className="grow">{g.name}</strong>
                <span className="muted small">{g.members.length === 1 ? '1 person' : `${g.members.length} people`} · {g.files === 1 ? 'shared 1 item' : `shared ${g.files} items`}</span>
                <button type="button" className="btn small" aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>{open === g.id ? 'Done' : 'Members'}</button>
                <button type="button" className="icon-btn" aria-label={`Delete group ${g.name}`} onClick={() => setGone(g)}><Icon name="trash" size={18} /></button>
              </div>
              {g.members.length > 0 && <p className="muted small" style={{ margin: 0 }}>{g.members.map((m) => m.name).join(', ')}</p>}
              {mailOn && <GroupEmail group={g} domains={domains} onSaved={load} />}
              {open === g.id && (
                <div className="stack-tight group-edit">
                  <input aria-label={`Description of ${g.name}`} placeholder="Description (optional)" defaultValue={g.description} maxLength={300}
                    onBlur={async (e) => { if (e.target.value !== g.description) { try { await patch(`/groups/${g.id}`, { description: e.target.value }); load(); } catch (err) { toast(err.message, 'error'); } } }} />
                  <ul className="group-people" aria-label={`People in ${g.name}`}>
                    {people.map((p) => (
                      <li key={p.id}><label className="check"><input type="checkbox" checked={inIt.has(p.id)}
                        onChange={(e) => setMembers(g, e.target.checked ? [...inIt, p.id] : [...inIt].filter((x) => x !== p.id))} />
                        <Avatar name={p.name} size={22} userId={p.id} /> {p.name} <span className="muted small">{p.username}</span></label></li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {gone && <ConfirmModal title={`Delete the group “${gone.name}”?`} message={`Its ${gone.members.length} members lose access to what was shared with the group (${gone.files} ${gone.files === 1 ? 'item' : 'items'}), unless it was also shared with them directly.`}
        onClose={() => setGone(null)} onConfirm={async () => { await del(`/groups/${gone.id}`); setGone(null); load(); }} />}
    </div>
  );
}

/** A group's email address: mail to it reaches everyone in the group, and they can send as it. */
function GroupEmail({ group, domains, onSaved }) {
  const toast = useToast();
  const cur = group.email;
  const [local, setLocal] = useState(group.email ? group.email.split('@')[0] : '');
  const [domain, setDomain] = useState(group.email ? group.email.split('@')[1] : domains[0] || '');
  useEffect(() => { if (!domain && domains[0]) setDomain(domains[0]); }, [domains]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (clear) => {
    try { const r = await put(`/groups/${group.id}/email`, clear ? { local: null } : { local, domain }); toast(r.email ? `Mail to ${r.email} now reaches everyone in ${group.name}` : 'Email address removed'); if (clear) setLocal(''); onSaved(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <form className="row wrap group-email" onSubmit={(e) => { e.preventDefault(); if (local.trim()) save(false); }} aria-label={`Email address of ${group.name}`}>
      <span className="small">Email address</span>
      <input aria-label={`Address for ${group.name}`} placeholder="e.g. sales" value={local} maxLength={64} onChange={(e) => setLocal(e.target.value)} style={{ width: 140 }} />
      <span>@</span>
      <select aria-label={`Domain for ${group.name}`} value={domain} onChange={(e) => setDomain(e.target.value)}>{domains.map((d) => <option key={d}>{d}</option>)}</select>
      <button className="btn small" disabled={!local.trim() || `${local}@${domain}`.toLowerCase() === cur}>Save</button>
      {cur && <button type="button" className="link-btn small" onClick={() => save(true)}>Remove</button>}
      {cur && <span className="muted small">Members get mail sent to {cur} and can send from it.</span>}
    </form>
  );
}
