import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { get, post, patch, del, postText } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import AddressInput from '../../components/AddressInput.jsx';
import { parseAddresses, formatAddress } from '../../components/addresses.js';
import { placeText, isoDay } from '../../components/workloc.js';
import { statusLine } from '../../components/status.js';

const FIELDS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company'], ['title', 'Job title'], ['website', 'Website']];

export default function Contacts() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState('mine');
  const [contacts, setContacts] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(params.get('q') || ''); // ?q= from a birthday on the calendar
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [merging, setMerging] = useState(false);
  const [company, setCompany] = useState([]);

  const load = () => {
    get('/contacts').then(setContacts).catch((e) => toast(e.message, 'error'));
    get('/contacts?scope=company').then(setCompany).catch(() => {});
  };
  // Import a .vcf or .csv from a phone, Gmail or Outlook; people already here are skipped.
  const importInput = useRef();
  const importFile = async (file) => {
    if (!file) return;
    try {
      const r = await postText('/contacts/import', await file.text());
      toast(`${r.added} contact${r.added === 1 ? '' : 's'} imported${r.skipped ? `, ${r.skipped} already here` : ''}`);
      setTab('mine');
      load();
    } catch (e) { toast(e.message, 'error'); }
  };
  useEffect(() => { load(); get('/users/directory').then(setDirectory); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Where colleagues are working today (those who've said).
  const [whereToday, setWhereToday] = useState({});
  useEffect(() => { get(`/location/people?date=${isoDay(new Date())}`).then(setWhereToday).catch(() => {}); }, []);

  const match = (c) => !filter || Object.values(c).some((v) => typeof v === 'string' && v.toLowerCase().includes(filter.toLowerCase()));
  const list = (tab === 'mine' ? (contacts || []) : tab === 'company' ? company : directory).filter(match);
  const own = tab === 'mine' || tab === 'company'; // address-book rows, not NAS users

  async function message(person) {
    const { id } = await post('/chat/dm', { user_id: person.id });
    navigate(`/chat/${id}`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Contacts</h1>
        <div className="grow" />
        <button className="btn" onClick={() => importInput.current.click()}><Icon name="upload" size={18} /> Import</button>
        <input ref={importInput} type="file" accept=".vcf,.vcard,.csv,text/vcard,text/csv" hidden aria-label="Contacts file to import" onChange={(e) => { importFile(e.target.files[0]); e.target.value = ''; }} />
        <Menu trigger={(p) => <button className="btn" {...p}><Icon name="download" size={18} /> Export</button>} items={[
          { label: 'vCard (.vcf): phones, Outlook, Apple', icon: 'download', onClick: () => { window.location.href = '/api/contacts/export?format=vcf'; } },
          { label: 'CSV: Gmail, spreadsheets', icon: 'download', onClick: () => { window.location.href = '/api/contacts/export?format=csv'; } },
        ]} />
        <button className="btn" onClick={() => setMerging(true)} title="Find contacts that are the same person and merge them">Merge duplicates</button>
        <button className="btn primary" onClick={() => setEditing({})}><Icon name="plus" size={18} /> New contact</button>
      </div>
      <div className="row wrap">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My contacts</button>
          <button role="tab" aria-selected={tab === 'dir'} className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>Directory</button>
          <button role="tab" aria-selected={tab === 'company'} className={tab === 'company' ? 'on' : ''} onClick={() => setTab('company')}>Company</button>
          <button role="tab" aria-selected={tab === 'other'} className={tab === 'other' ? 'on' : ''} onClick={() => setTab('other')}>Other contacts</button>
          <button role="tab" aria-selected={tab === 'groups'} className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>Groups</button>
        </div>
        <input className="filter" placeholder="Filter" aria-label="Filter contacts" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {tab === 'groups' ? <Groups filter={filter} /> : tab === 'other' ? <OtherContacts filter={filter} onAdded={load} /> : tab === 'mine' && contacts?.length === 0 ? <Empty icon="person" title="No contacts yet">Add people you work with outside your NAS users.</Empty>
        : tab === 'company' && company.length === 0 ? <Empty icon="person" title="No company contacts yet">Contacts shared with everyone at {user.org_name} appear here. Tick “Share with everyone at {user.org_name}” on a contact to add it.</Empty> : (
        <table className="files">
          <thead><tr><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Phone</th><th className="hide-sm">Company</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td className="name"><Avatar name={c.name} size={28} userId={tab === 'dir' ? c.id : undefined} email={c.email || c.username} /><span>{c.name}{c.shared && tab === 'mine' ? <span className="muted"> · Shared with company</span> : null}{tab === 'company' && <span className="muted"> · Added by {c.owner_id === user.id ? 'you' : c.owner_name}</span>}{c.status && <span className="person-status" aria-label={`Status: ${statusLine(c.status)}`}> · {statusLine(c.status)}</span>}{tab === 'dir' && whereToday[c.id] && <span className="muted person-where" title="Working location today"> · {placeText(whereToday[c.id])} today</span>}</span></td>
                <td className="hide-sm">{(c.email || c.username) ? <a href={`mailto:${c.email || c.username}`}>{c.email || c.username}</a> : <span className="muted">—</span>}</td>
                <td className="hide-sm">{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className="muted">—</span>}</td>
                <td className="hide-sm muted">{own ? [c.title, c.company].filter(Boolean).join(' · ') || '—' : user.org_name}{own && c.website && <> · <a href={c.website} target="_blank" rel="noopener noreferrer">{c.website.replace(/^https?:\/\//, '')}</a></>}</td>
                <td className="actions">
                  {own ? (tab === 'mine' || c.can_edit) && <>
                    <button className="icon-btn" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Icon name="edit" size={18} /></button>
                    <button className="icon-btn" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Icon name="trash" size={18} /></button>
                  </> : c.id !== user.id && (
                    <button className="icon-btn" aria-label={`Message ${c.name}`} onClick={() => message(c)}><Icon name="chat" size={18} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {merging && <DuplicatesDialog onClose={() => setMerging(false)} onMerged={load} />}
      {editing && <ContactDialog contact={editing} orgName={user.org_name} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && <ConfirmModal title="Delete contact?" message={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}
        onConfirm={async () => { await del(`/contacts/${deleting.id}`); load(); }} />}
    </div>
  );
}

/** Contacts that look like the same person, in groups: choose which to keep and merge each group. */
function DuplicatesDialog({ onClose, onMerged }) {
  const toast = useToast();
  const [groups, setGroups] = useState(null);
  const [keep, setKeep] = useState({}); // group index → id to keep
  const find = () => get('/contacts/duplicates').then((g) => { setGroups(g); setKeep({}); }).catch((e) => toast(e.message, 'error'));
  useEffect(() => { find(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const merge = async (g, i) => {
    const keepId = keep[i] || g[0].id;
    try {
      const m = await post('/contacts/merge', { keep: keepId, ids: g.map((c) => c.id) });
      toast(`Merged ${g.length} contacts into ${m.name}`);
      onMerged();
      find();
    } catch (e) { toast(e.message, 'error'); }
  };
  const line = (c) => [c.email, c.phone, [c.title, c.company].filter(Boolean).join(' · ')].filter(Boolean).join(' · ') || 'No details';
  return (
    <Modal wide title="Merge duplicates" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {groups === null ? <p className="muted">Looking…</p> : !groups.length ? <p className="muted">No duplicates: no two contacts share an email address, phone number or name.</p> : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>These contacts share an email address, phone number or name. Merging keeps the one you choose, fills in what it's missing from the others, and adds anything different (another email or phone) to its notes. The others are deleted.</p>
          {groups.map((g, i) => (
            <fieldset key={g.map((c) => c.id).join()} className="dup-group" aria-label={`Duplicates of ${g[0].name}`}>
              {g.map((c) => (
                <label key={c.id} className="dup-row">
                  <input type="radio" name={`keep-${i}`} checked={(keep[i] || g[0].id) === c.id} onChange={() => setKeep({ ...keep, [i]: c.id })} aria-label={`Keep ${c.name}`} />
                  <Avatar name={c.name} size={28} />
                  <span className="grow"><strong>{c.name}</strong><br /><span className="muted small">{line(c)}</span></span>
                </label>
              ))}
              <div className="row end"><button type="button" className="btn primary small" onClick={() => merge(g, i)}>Merge {g.length}</button></div>
            </fieldset>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** People you've emailed who aren't in your contacts: add them, or forget them. */
function OtherContacts({ filter, onAdded }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => get('/contacts/other').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return null;
  if (!list.length) return <Empty icon="person" title="No other contacts">People you email who aren't in your contacts show up here, and are suggested when you write.</Empty>;
  const f = filter.toLowerCase();
  const shown = list.filter((c) => !f || c.email.includes(f) || (c.name || '').toLowerCase().includes(f));
  const add = async (c) => {
    try { await post('/contacts', { name: c.name || c.email.split('@')[0], email: c.email }); toast(`${c.name || c.email} added to your contacts`); load(); onAdded(); } catch (e) { toast(e.message, 'error'); }
  };
  const forget = async (c) => { try { await del(`/contacts/other/${encodeURIComponent(c.email)}`); load(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <table className="files">
      <thead><tr><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Emailed</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {shown.map((c) => (
          <tr key={c.email}>
            <td className="name"><Avatar name={c.name || c.email} size={28} email={c.email} /><span>{c.name || c.email}</span></td>
            <td className="hide-sm"><a href={`mailto:${c.email}`}>{c.email}</a></td>
            <td className="hide-sm muted">{c.times === 1 ? 'once' : `${c.times} times`}, last {new Date(c.last_at).toLocaleDateString()}</td>
            <td className="actions">
              <button className="btn small" onClick={() => add(c)}>Add to contacts</button>
              <button className="icon-btn" aria-label={`Forget ${c.email}`} title="Remove from Other contacts" onClick={() => forget(c)}><Icon name="close" size={18} /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContactDialog({ contact, orgName, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', notes: '', ...contact });
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    const body = { name: f.name, email: f.email || '', phone: f.phone || '', company: f.company || '', title: f.title || '', website: f.website || '', address: f.address || '', notes: f.notes || '', birthday: f.birthday || null, shared: !!f.shared };
    try { if (contact.id) await patch(`/contacts/${contact.id}`, body); else await post('/contacts', body); onSaved(); }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal title={contact.id ? 'Edit contact' : 'New contact'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {FIELDS.map(([k, label], i) => (
          <label key={k} className="field"><span>{label}</span>
            <input autoFocus={i === 0} required={k === 'name'} type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'} placeholder={k === 'website' ? 'example.com' : undefined} value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        <label className="field"><span>Address</span><textarea rows={3} value={f.address || ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <BirthdayField value={f.birthday || ''} onChange={(birthday) => setF({ ...f, birthday })} />
        <label className="field"><span>Notes</span><textarea rows={3} value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={!!f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} /> Share with everyone at {orgName}</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

/**
 * A birthday: a date, or day and month only ("Year not known", stored as --MM-DD as phones do).
 * The date box needs a year, so a leap year stands in while the year is unknown.
 */
function BirthdayField({ value, onChange }) {
  const noYear = value.startsWith('--');
  const shown = noYear ? `2000${value.slice(1)}` : value;
  return (
    <div className="field"><label htmlFor="bday"><span>Birthday</span></label>
      <span className="row">
        <input id="bday" type="date" value={shown} min="1850-01-01" max="2200-12-31" onChange={(e) => onChange(e.target.value ? (noYear ? `--${e.target.value.slice(5)}` : e.target.value) : '')} />
        <label className="check small"><input type="checkbox" checked={noYear} disabled={!value} onChange={(e) => onChange(e.target.checked ? `--${shown.slice(5)}` : shown)} /> Year not known</label>
        {value && <button type="button" className="link-btn small" onClick={() => onChange('')}>Clear</button>}
      </span>
    </div>
  );
}

/** Your groups: lists of people to email at once (type the group's name in To, or Email group here). */
function Groups({ filter }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [groups, setGroups] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const load = () => get('/contacts/groups').then(setGroups).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (groups || []).filter((g) => !filter || g.name.toLowerCase().includes(filter.toLowerCase()) || g.members.some((m) => `${m.name} ${m.email}`.toLowerCase().includes(filter.toLowerCase())));
  return (
    <div className="stack">
      <div className="row"><button type="button" className="btn primary" onClick={() => setEditing({ name: '', members: [] })}><Icon name="plus" size={18} /> New group</button>
        <span className="muted small">Type a group's name in To, Cc or Bcc to put in everyone in it.</span></div>
      {groups && !groups.length ? <Empty icon="people" title="No groups yet">Make one for people you often email together: a team, a board, a club.</Empty> : (
        <table className="files">
          <thead><tr><th>Group</th><th className="hide-sm">People</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.id}>
                <td className="name"><Avatar name={g.name} size={28} /><span>{g.name}</span></td>
                <td className="hide-sm muted ellipsis" style={{ maxWidth: 420 }} title={g.members.map(formatAddress).join(', ')}>{g.members.length} · {g.members.slice(0, 3).map((m) => m.name || m.email).join(', ')}{g.members.length > 3 ? '…' : ''}</td>
                <td className="actions">
                  <button className="icon-btn" aria-label={`Email ${g.name}`} title="Email the group" disabled={!g.members.length} onClick={() => navigate(`/mail?compose=${encodeURIComponent(g.members.map(formatAddress).join(', '))}`)}><Icon name="mail" size={18} /></button>
                  <button className="icon-btn" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}><Icon name="edit" size={18} /></button>
                  <button className="icon-btn" aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)}><Icon name="trash" size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <GroupDialog group={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && <ConfirmModal title="Delete group?" message={`Delete the group “${deleting.name}”? The people in it stay in your contacts.`} onClose={() => setDeleting(null)}
        onConfirm={async () => { await del(`/contacts/groups/${deleting.id}`); load(); }} />}
    </div>
  );
}

function GroupDialog({ group, onClose, onSaved }) {
  const [name, setName] = useState(group.name);
  const [people, setPeople] = useState(group.members.map(formatAddress).join(', '));
  const [error, setError] = useState('');
  const parsed = parseAddresses(people);
  async function submit(e) {
    e.preventDefault();
    if (parsed.bad.length) { setError(`Not an email address: ${parsed.bad.join(', ')}`); return; }
    try { if (group.id) await patch(`/contacts/groups/${group.id}`, { name, members: parsed.list }); else await post('/contacts/groups', { name, members: parsed.list }); onSaved(); }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal wide title={group.id ? 'Edit group' : 'New group'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Group name</span><input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field group-people"><span>People (type names or addresses; suggestions come from your contacts and colleagues)</span>
          <AddressInput label="People" value={people} onChange={setPeople} placeholder="name@company.com, …" /></label>
        <p className="muted small" style={{ margin: 0 }}>{parsed.list.length} {parsed.list.length === 1 ? 'person' : 'people'}</p>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
