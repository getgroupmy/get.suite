import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, patch, del } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Empty, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

const FIELDS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company']];

export default function Contacts() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState('mine');
  const [contacts, setContacts] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = () => get('/contacts').then(setContacts).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); get('/users/directory').then(setDirectory); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const match = (c) => !filter || Object.values(c).some((v) => typeof v === 'string' && v.toLowerCase().includes(filter.toLowerCase()));
  const list = tab === 'mine' ? (contacts || []).filter(match) : directory.filter(match);

  async function message(person) {
    const { id } = await post('/chat/dm', { user_id: person.id });
    navigate(`/chat/${id}`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Contacts</h1>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing({})}><Icon name="plus" size={18} /> New contact</button>
      </div>
      <div className="row wrap">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My contacts</button>
          <button role="tab" aria-selected={tab === 'dir'} className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>Directory</button>
        </div>
        <input className="filter" placeholder="Filter" aria-label="Filter contacts" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {tab === 'mine' && contacts?.length === 0 ? <Empty icon="person" title="No contacts yet">Add people you work with outside your NAS users.</Empty> : (
        <table className="files">
          <thead><tr><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Phone</th><th className="hide-sm">Company</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td className="name"><Avatar name={c.name} size={28} /><span>{c.name}</span></td>
                <td className="hide-sm">{(c.email || c.username) ? <a href={`mailto:${c.email || c.username}`}>{c.email || c.username}</a> : <span className="muted">—</span>}</td>
                <td className="hide-sm">{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className="muted">—</span>}</td>
                <td className="hide-sm muted">{tab === 'mine' ? c.company || '—' : user.org_name}</td>
                <td className="actions">
                  {tab === 'mine' ? <>
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
      {editing && <ContactDialog contact={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && <ConfirmModal title="Delete contact?" message={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}
        onConfirm={async () => { await del(`/contacts/${deleting.id}`); load(); }} />}
    </div>
  );
}

function ContactDialog({ contact, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', notes: '', ...contact });
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    const body = { name: f.name, email: f.email || '', phone: f.phone || '', company: f.company || '', notes: f.notes || '' };
    try { if (contact.id) await patch(`/contacts/${contact.id}`, body); else await post('/contacts', body); onSaved(); }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal title={contact.id ? 'Edit contact' : 'New contact'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {FIELDS.map(([k, label], i) => (
          <label key={k} className="field"><span>{label}</span>
            <input autoFocus={i === 0} required={k === 'name'} type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'} value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        <label className="field"><span>Notes</span><textarea rows={3} value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
