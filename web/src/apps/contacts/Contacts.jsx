import { useEffect, useMemo, useRef, useState } from 'react';
import WithPerson from '../../components/WithPerson.jsx';
import { useNavigate, useSearchParams } from 'react-router';
import { get, post, put, patch, del, postText, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import AddressInput from '../../components/AddressInput.jsx';
import { parseAddresses, formatAddress } from '../../components/addresses.js';
import { placeText, isoDay, comingDays, PLACES } from '../../components/workloc.js';
import { UNDO_CHOICES, UNDO_DAYS, undoTime, changedText } from './undochanges.js';
import { statusLine } from '../../components/status.js';
import { orgTree, chainOf } from '../../components/orgchart.js';
import PersonCard from '../../components/PersonCard.jsx';
import { photoBlob, photoUrl } from './photo.js';
import QRCode from 'qrcode';
import { sinceText } from '../home/dates.js';
import { sortContacts, CONTACT_SORTS } from './sortcontacts.js';

const FIELDS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company'], ['title', 'Job title'], ['website', 'Website']];
const TYPE_LABELS = { work: 'Work', home: 'Home', mobile: 'Mobile', other: 'Other' };
const nPeople = (n) => `${n} contact${n === 1 ? '' : 's'}`;
const MORE_TYPES = { emails: ['work', 'home', 'other'], phones: ['mobile', 'work', 'home', 'other'] };

/** Other email addresses or phone numbers of a contact, each with a label; "+ Add …" adds a row. */
function MoreField({ kind, list, onChange }) {
  const one = kind === 'emails' ? 'email' : 'phone';
  const set = (i, patch) => onChange(list.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <div className="more-field">
      {list.map((x, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <select aria-label={`Label for ${one} ${i + 2}`} value={x.type} onChange={(e) => set(i, { type: e.target.value })}>
            {MORE_TYPES[kind].map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
          <input className="grow" type={kind === 'emails' ? 'email' : 'tel'} aria-label={`${kind === 'emails' ? 'Email' : 'Phone'} ${i + 2}`} value={x.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button type="button" className="icon-btn" aria-label={`Remove ${one} ${i + 2}`} onClick={() => onChange(list.filter((_, k) => k !== i))}><Icon name="close" size={16} /></button>
        </div>
      ))}
      {list.length < 10 && <button type="button" className="link-btn small" onClick={() => onChange([...list, { type: kind === 'emails' ? 'home' : 'work', value: '' }])}>+ Add {kind === 'emails' ? 'another email' : 'another phone'}</button>}
    </div>
  );
}

export default function Contacts() {
  const [sending, setSending] = useState(null); // a contact being sent in Chat
  const [qr, setQr] = useState(null); // a contact shown as a QR code to scan with a phone
  const [history, setHistory] = useState(null); // a contact whose emails and meetings are shown
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState(() => (['touch', 'dir', 'frequent'].includes(new URLSearchParams(window.location.search).get('tab')) ? new URLSearchParams(window.location.search).get('tab') : 'mine')); // ?tab=touch or ?tab=dir from Home
  const [contacts, setContacts] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [params] = useSearchParams();
  useEffect(() => { if (['touch', 'dir', 'frequent'].includes(params.get('tab'))) setTab(params.get('tab')); }, [params]); // from the bell or Home, even when already here
  const [filter, setFilter] = useState(params.get('q') || ''); // ?q= from a birthday on the calendar
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [merging, setMerging] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // Birthday and date reminders: off, on the morning, or the day before (in this browser's time zone).
  const [remind, setRemind] = useState(null);
  useEffect(() => { get('/contacts/reminders').then((r) => setRemind(r.when)).catch(() => {}); }, []);
  const setReminders = async (when) => {
    try {
      const r = await put('/contacts/reminders', { when, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
      setRemind(r.when);
      toast(when === 'off' ? 'Birthday reminders off' : when === 'day' ? 'You’ll be reminded on the morning of birthdays and dates' : 'You’ll be reminded the day before birthdays and dates');
    } catch (e) { toast(e.message, 'error'); }
  };
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
  useEffect(() => onLive((m) => { if (m.type === 'directory-changed') get('/users/directory').then(setDirectory).catch(() => {}); }), []);
  const [chart, setChart] = useState(false); // Directory as an org chart
  const [card, setCard] = useState(null); // a colleague's card (their id)
  // Where colleagues are working on a day (today, or one of the next working days), and how many are
  // where each day: to plan office days.
  const days = comingDays(5);
  const [whereDay, setWhereDay] = useState(isoDay(new Date()));
  const [whereToday, setWhereToday] = useState({});
  const [whereFilter, setWhereFilter] = useState(''); // '' | office | home | other | none
  const [daySums, setDaySums] = useState({});
  useEffect(() => { get(`/location/people?date=${whereDay}`).then(setWhereToday).catch(() => {}); }, [whereDay]);
  useEffect(() => { if (tab === 'dir') get(`/location/summary?from=${isoDay(days[0])}&to=${isoDay(days[days.length - 1])}`).then(setDaySums).catch(() => {}); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const dayName = (iso) => (iso === isoDay(new Date()) ? 'today' : `on ${new Date(`${iso}T12:00`).toLocaleDateString([], { weekday: 'long' })}`);
  const whereOk = (c) => tab !== 'dir' || !whereFilter || (whereFilter === 'none' ? !whereToday[c.id] : whereToday[c.id]?.place === whereFilter);

  const match = (c) => !filter || Object.values(c).some((v) => typeof v === 'string' && v.toLowerCase().includes(filter.toLowerCase()));
  const [sort, setSort] = useState('first'); // your own way of sorting your contacts
  useEffect(() => { get('/contacts/view').then((r) => setSort(r.sort)).catch(() => {}); }, []);
  const chooseSort = async (next) => { setSort(next); try { await put('/contacts/view', { sort: next }); } catch (e) { toast(e.message, 'error'); } };
  const filtered = (tab === 'mine' ? (contacts || []) : tab === 'company' ? company : directory).filter(match).filter(whereOk);
  const list = tab === 'mine' ? sortContacts(filtered, sort) : filtered;
  const own = tab === 'mine' || tab === 'company'; // address-book rows, not NAS users
  // Several of your contacts at once: email them, add them to a group, star them, or delete them.
  const [picked, setPicked] = useState(() => new Set());
  const [myGroups, setMyGroups] = useState([]);
  const [deletingMany, setDeletingMany] = useState(false);
  useEffect(() => { setPicked(new Set()); if (tab === 'mine') get('/contacts/groups').then(setMyGroups).catch(() => {}); }, [tab]);
  const selecting = tab === 'mine';
  const chosen = (contacts || []).filter((c) => picked.has(c.id));
  const pickOne = (id) => setPicked((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  const allShown = list.length > 0 && list.every((c) => picked.has(c.id));
  /** Undo a delete: the contacts come back from the trash as they were. */
  async function putBack(ids) {
    try { for (const id of ids) await post(`/contacts/trash/${id}/restore`); toast(ids.length === 1 ? 'Contact put back' : `${nPeople(ids.length)} put back`); load(); }
    catch (e) { toast(e.message, 'error'); load(); }
  }

  async function many(body, say) {
    try { const r = await post('/contacts/batch', { ids: [...picked], ...body }); toast(say(r)); setPicked(new Set()); load(); } catch (e) { toast(e.message, 'error'); }
  }

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
        {remind && <Menu trigger={(p) => <button className="btn" title="Birthday and date reminders" {...p}>🎂 Reminders{remind !== 'off' ? ' · on' : ''}</button>} items={[
          ['off', 'No reminders'], ['day', 'On the morning (from 9:00)'], ['before', 'The day before'],
        ].map(([k, label]) => ({ label: `${remind === k ? '✓ ' : ''}${label}`, onClick: () => setReminders(k) }))} />}
        <button className="btn" onClick={() => setUndoing(true)} title="Put your contacts back as they were at an earlier time"><Icon name="restore" size={18} /> Undo changes</button>
        <button className="btn primary" onClick={() => setEditing({})}><Icon name="plus" size={18} /> New contact</button>
      </div>
      <div className="row wrap">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My contacts</button>
          <button role="tab" aria-selected={tab === 'dir'} className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>Directory</button>
          <button role="tab" aria-selected={tab === 'company'} className={tab === 'company' ? 'on' : ''} onClick={() => setTab('company')}>Company</button>
          <button role="tab" aria-selected={tab === 'other'} className={tab === 'other' ? 'on' : ''} onClick={() => setTab('other')}>Other contacts</button>
          <button role="tab" aria-selected={tab === 'frequent'} className={tab === 'frequent' ? 'on' : ''} onClick={() => setTab('frequent')}>Frequent</button>
          <button role="tab" aria-selected={tab === 'touch'} className={tab === 'touch' ? 'on' : ''} onClick={() => setTab('touch')}>Keep in touch</button>
          <button role="tab" aria-selected={tab === 'groups'} className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>Groups</button>
          <button role="tab" aria-selected={tab === 'trash'} className={tab === 'trash' ? 'on' : ''} onClick={() => setTab('trash')}>Trash</button>
        </div>
        <input className="filter" placeholder="Filter" aria-label="Filter contacts" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {tab === 'mine' && <select aria-label="Sort contacts" value={sort} onChange={(e) => chooseSort(e.target.value)}>{CONTACT_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        {tab === 'dir' && <button type="button" className={`btn small ${chart ? 'primary' : ''}`} aria-pressed={chart} onClick={() => setChart(!chart)}>Org chart</button>}
      </div>
      {tab === 'dir' && !chart && (
        <div className="row wrap where-days">
          <div className="where-strip" role="group" aria-label="Who's where">
            {days.map((d) => { const iso = isoDay(d); const n = daySums[iso]; return (
              <button key={iso} type="button" className={`where-day ${whereDay === iso ? 'on' : ''}`} aria-pressed={whereDay === iso} onClick={() => setWhereDay(iso)}
                title={n ? `${n.office} in the office, ${n.home} at home, ${n.other} elsewhere` : undefined}>
                <strong>{iso === isoDay(new Date()) ? 'Today' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</strong>
                <span className="small">🏢 {n?.office ?? '–'}</span>
              </button>); })}
          </div>
          <select aria-label="Where they are" value={whereFilter} onChange={(e) => setWhereFilter(e.target.value)}>
            <option value="">Everyone</option>
            {PLACES.map(([k, icon, label]) => <option key={k} value={k}>{icon} {k === 'office' ? 'In the office' : k === 'home' ? 'At home' : label}</option>)}
            <option value="none">Not said</option>
          </select>
        </div>
      )}
      {tab === 'dir' && chart ? <OrgChart people={directory} filter={filter} onMessage={message} me={user.id} onOpen={setCard} /> : tab === 'groups' ? <Groups filter={filter} /> : tab === 'touch' ? <KeepInTouch filter={filter} /> : tab === 'trash' ? <ContactsTrash filter={filter} onRestored={load} /> : tab === 'other' ? <OtherContacts filter={filter} onAdded={load} /> : tab === 'frequent' ? <Frequent filter={filter} onAdded={load} /> : tab === 'mine' && contacts?.length === 0 ? <Empty icon="person" title="No contacts yet">Add people you work with outside your NAS users.</Empty>
        : tab === 'company' && company.length === 0 ? <Empty icon="person" title="No company contacts yet">Contacts shared with everyone at {user.org_name} appear here. Tick “Share with everyone at {user.org_name}” on a contact to add it.</Empty> : (
        <table className="files">
          {selecting && picked.size > 0 && (
            <caption className="contact-batch-cap"><div className="contact-batch" role="toolbar" aria-label="Change the selected contacts">
              <strong className="small" aria-live="polite">{picked.size} selected</strong>
              <button type="button" className="btn small" disabled={!chosen.some((c) => c.email)} title="Write to everyone selected who has an email address"
                onClick={() => navigate(`/mail?compose=${encodeURIComponent(chosen.filter((c) => c.email).map((c) => formatAddress({ name: c.name, email: c.email })).join(', '))}`)}><Icon name="mail" size={16} /> Email</button>
              <select aria-label="Add the selected contacts to a group" value="" disabled={!myGroups.length} title={myGroups.length ? '' : 'Make a group first (Groups tab)'}
                onChange={(e) => { const g = myGroups.find((x) => x.id === e.target.value); if (g) many({ action: 'group', group_id: g.id }, (r) => `${r.added} added to ${g.name}${r.without_email ? ` (${r.without_email} without an email address left out)` : ''}`); }}>
                <option value="">Add to group…</option>
                {myGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button type="button" className="btn small" onClick={() => many({ action: 'star' }, (r) => `${nPeople(r.changed)} starred`)}>★ Star</button>
              <button type="button" className="btn small" onClick={() => many({ action: 'unstar' }, (r) => `${nPeople(r.changed)} unstarred`)}>☆ Unstar</button>
              <button type="button" className="btn small danger" onClick={() => setDeletingMany(true)}><Icon name="trash" size={16} /> Delete</button>
              <button type="button" className="link-btn small" onClick={() => setPicked(new Set())}>Clear</button>
            </div></caption>
          )}
          <thead><tr>{selecting && <th className="pick-col"><input type="checkbox" aria-label="Select all shown" checked={allShown} onChange={() => setPicked(allShown ? new Set() : new Set(list.map((c) => c.id)))} /></th>}<th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Phone</th><th className="hide-sm">Company</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className={picked.has(c.id) ? 'picked' : ''}>
                {selecting && <td className="pick-col"><input type="checkbox" aria-label={`Select ${c.name}`} checked={picked.has(c.id)} onChange={() => pickOne(c.id)} /></td>}
                <td className="name"><Avatar name={c.name} size={28} userId={tab === 'dir' ? c.id : undefined} email={c.email || c.username} src={tab !== 'dir' ? photoUrl(c) : undefined} /><span>{tab === 'dir' ? <button type="button" className="link-btn person-name" onClick={() => setCard(c.id)}>{c.name}</button> : c.name}{c.shared && tab === 'mine' ? <span className="muted"> · Shared with company</span> : null}{tab === 'company' && <span className="muted"> · Added by {c.owner_id === user.id ? 'you' : c.owner_name}</span>}{c.status && <span className="person-status" aria-label={`Status: ${statusLine(c.status)}`}> · {statusLine(c.status)}</span>}{tab === 'dir' && whereToday[c.id] && <span className="muted person-where" title="Working location"> · {placeText(whereToday[c.id])} {dayName(whereDay)}</span>}</span></td>
                <td className="hide-sm">{(c.email || c.username) ? <a href={`mailto:${c.email || c.username}`}>{c.email || c.username}</a> : <span className="muted">—</span>}
                  {c.more_emails?.map((m) => <div key={m.value} className="small"><a href={`mailto:${m.value}`}>{m.value}</a> <span className="muted">{TYPE_LABELS[m.type]}</span></div>)}</td>
                <td className="hide-sm">{(c.phone || c.work_phone) ? <a href={`tel:${c.phone || c.work_phone}`}>{c.phone || c.work_phone}</a> : <span className="muted">—</span>}
                  {c.more_phones?.map((m) => <div key={m.value} className="small"><a href={`tel:${m.value}`}>{m.value}</a> <span className="muted">{TYPE_LABELS[m.type]}</span></div>)}</td>
                <td className="hide-sm muted">{own && (c.custom_fields?.length > 0 || c.dates?.length > 0) && <div className="small contact-extra">{[...(c.custom_fields || []).map((x) => `${x.label}: ${x.value}`), ...(c.dates || []).map((x) => `${x.label}: ${x.date.startsWith('--') ? x.date.slice(2) : x.date}`)].join(' · ')}</div>}{own ? [c.title, c.company].filter(Boolean).join(' · ') || '—' : [c.job_title, c.department].filter(Boolean).join(' · ') || user.org_name}{own && c.website && <> · <a href={c.website} target="_blank" rel="noopener noreferrer">{c.website.replace(/^https?:\/\//, '')}</a></>}</td>
                <td className="actions">
                  {own && tab !== 'mine' && !c.can_edit && <button className="icon-btn contact-qr" aria-label={`QR code for ${c.name}`} title="QR code: scan it with a phone's camera to add the contact, or download it as a vCard" onClick={() => setQr(c)}>▦</button>}
                  {own && tab !== 'mine' && !c.can_edit && <button className="icon-btn" aria-label={`Send ${c.name} in Chat`} title="Send in Chat: colleagues can add it to their contacts" onClick={() => setSending(c)}><Icon name="share" size={18} /></button>}
                  {own ? (tab === 'mine' || c.can_edit) && <>
                    {tab === 'mine' && <button className={`icon-btn star ${c.starred ? 'on' : ''}`} aria-pressed={!!c.starred} aria-label={c.starred ? `Unstar ${c.name}` : `Star ${c.name}`} title={c.starred ? 'Starred: first in your contacts and when writing mail' : 'Star: keep them first in your contacts and when writing mail'}
                      onClick={async () => { try { await patch(`/contacts/${c.id}`, { starred: !c.starred }); load(); } catch (e) { toast(e.message, 'error'); } }}>{c.starred ? '★' : '☆'}</button>}
                    <button className="icon-btn" aria-label={`History with ${c.name}`} title="Your log of calls and meetings, and emails and meetings with them" onClick={() => setHistory(c)}><Icon name="clock" size={18} /></button>
                    <button className="icon-btn contact-qr" aria-label={`QR code for ${c.name}`} title="QR code: scan it with a phone's camera to add the contact, or download it as a vCard" onClick={() => setQr(c)}>▦</button>
                    <button className="icon-btn" aria-label={`Send ${c.name} in Chat`} title="Send in Chat: colleagues can add it to their contacts" onClick={() => setSending(c)}><Icon name="share" size={18} /></button>
                    <button className="icon-btn" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Icon name="edit" size={18} /></button>
                    <button className="icon-btn" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Icon name="trash" size={18} /></button>
                  </> : c.id !== user.id && (
                    <><button className="icon-btn" aria-label={`Message ${c.name}`} onClick={() => message(c)}><Icon name="chat" size={18} /></button>
                    <button className="icon-btn" aria-label={`Send ${c.name}'s card in Chat`} title="Send their card in Chat: others can add them to their contacts" onClick={() => setSending({ ...c, colleague: true })}><Icon name="share" size={18} /></button></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {card && <PersonCard userId={card} onClose={() => setCard(null)} />}
      {merging && <DuplicatesDialog onClose={() => setMerging(false)} onMerged={load} />}
      {undoing && <UndoChangesDialog onClose={() => setUndoing(false)} onDone={() => { setUndoing(false); setTab('mine'); load(); }} />}
      {history && <Modal title={`With ${history.name}`} onClose={() => setHistory(null)} footer={<button type="button" className="btn" onClick={() => setHistory(null)}>Close</button>}><ContactLog contact={history} onChanged={load} /><WithPerson email={history.email} onOpen={() => setHistory(null)} /></Modal>}
      {qr && <ContactQr contact={qr} onClose={() => setQr(null)} />}
      {sending && <SendContact contact={sending} onClose={() => setSending(null)} />}
      {editing && <ContactDialog contact={editing} orgName={user.org_name} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deletingMany && <ConfirmModal title={`Delete ${nPeople(picked.size)}?`} confirm="Delete" message="They go to Trash for 30 days (and off your phone on its next sync)." onClose={() => setDeletingMany(false)}
        onConfirm={async () => {
          setDeletingMany(false);
          const ids = [...picked];
          try {
            const r = await post('/contacts/batch', { ids, action: 'delete' });
            setPicked(new Set()); load();
            toast(`${nPeople(r.deleted)} moved to Trash`, 'info', { action: { label: 'Undo', onClick: () => putBack(ids) } });
          } catch (e) { toast(e.message, 'error'); }
        }} />}
      {deleting && <ConfirmModal title="Delete contact?" message={`Delete ${deleting.name}? It goes to Trash for 30 days.`} onClose={() => setDeleting(null)}
        onConfirm={async () => {
          const c = deleting;
          try { await del(`/contacts/${c.id}`); load(); toast(`${c.name} moved to Trash`, 'info', { action: { label: 'Undo', onClick: () => putBack([c.id]) } }); }
          catch (e) { toast(e.message, 'error'); }
        }} />}
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
  const line = (c) => [c.email, ...(c.more_emails || []).map((m) => m.value), c.phone, ...(c.more_phones || []).map((m) => m.value), [c.title, c.company].filter(Boolean).join(' · ')].filter(Boolean).join(' · ') || 'No details';
  return (
    <Modal wide title="Merge duplicates" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {groups === null ? <p className="muted">Looking…</p> : !groups.length ? <p className="muted">No duplicates: no two contacts share an email address, phone number or name.</p> : (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>These contacts share an email address, phone number or name. Merging keeps the one you choose, fills in what it's missing from the others, adds their other email addresses and phone numbers to it, and notes anything else that differs. The others are deleted.</p>
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
/** Deleted contacts, kept 30 days: put one back, or delete it (or everything) for good. */
function ContactsTrash({ filter, onRestored }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [emptying, setEmptying] = useState(false);
  const load = () => get('/contacts/trash').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  if (!data.contacts.length) return <Empty icon="trash" title="Trash is empty">Contacts you delete (here or on your phone) stay here for {data.days} days, so you can put them back.</Empty>;
  const f = filter.toLowerCase();
  const shown = data.contacts.filter((c) => !f || [c.name, c.email, c.phone, c.company].some((v) => (v || '').toLowerCase().includes(f)));
  const daysLeft = (c) => Math.max(1, Math.ceil((c.gone_at - Date.now()) / 86400000));
  const restore = async (c) => { try { await post(`/contacts/trash/${c.id}/restore`); toast(`${c.name} put back`); load(); onRestored(); } catch (e) { toast(e.message, 'error'); } };
  const forget = async (c) => { try { await del(`/contacts/trash/${c.id}`); toast(`${c.name} deleted for good`); load(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <>
      <div className="row" style={{ margin: '0 0 8px' }}>
        <span className="muted small grow">Deleted contacts are kept {data.days} days, then deleted for good.</span>
        <button type="button" className="btn small" onClick={() => setEmptying(true)}>Empty trash</button>
      </div>
      <table className="files">
        <thead><tr><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Deleted</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id}>
              <td className="name"><Avatar name={c.name} size={28} email={c.email} /><span>{c.name}{!c.mine && <span className="muted"> · company contact</span>}</span></td>
              <td className="hide-sm">{c.email || c.phone || ''}</td>
              <td className="hide-sm muted">{new Date(c.deleted_at).toLocaleDateString()} · gone in {daysLeft(c)} {daysLeft(c) === 1 ? 'day' : 'days'}</td>
              <td className="actions">
                <button className="btn small" onClick={() => restore(c)}>Restore</button>
                <button className="icon-btn" aria-label={`Delete ${c.name} for good`} title="Delete for good" onClick={() => forget(c)}><Icon name="trash" size={18} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {emptying && <ConfirmModal title="Empty trash?" confirm="Delete for good" message={`${nPeople(data.contacts.length)} will be deleted for good. This can't be undone.`} onClose={() => setEmptying(false)}
        onConfirm={async () => { setEmptying(false); try { const r = await del('/contacts/trash'); toast(`${nPeople(r.deleted)} deleted for good`); load(); } catch (e) { toast(e.message, 'error'); } }} />}
    </>
  );
}

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

/** Frequently contacted: who you've emailed most from Workspace lately, to write to again in a click. */
function Frequent({ filter, onAdded }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const load = () => get('/contacts/frequent').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return null;
  if (!list.length) return <Empty icon="person" title="Nobody yet">The people you email most from Workspace show up here, most often first.</Empty>;
  const f = filter.toLowerCase();
  const shown = list.filter((c) => !f || c.email.includes(f) || (c.name || '').toLowerCase().includes(f));
  const add = async (c) => {
    try { await post('/contacts', { name: c.name || c.email.split('@')[0], email: c.email }); toast(`${c.name || c.email} added to your contacts`); load(); onAdded(); } catch (e) { toast(e.message, 'error'); }
  };
  // Forgetting also stops Mail suggesting them (Include …?) until you write to them again.
  const forget = async (c) => { try { await del(`/contacts/frequent?email=${encodeURIComponent(c.email)}`); toast(`${c.name || c.email} forgotten`); load(); } catch (e) { toast(e.message, 'error'); } };
  const forgetAll = async () => {
    if (!window.confirm('Forget everyone you\'ve emailed? This list empties, and Mail stops suggesting people to include until it learns again from what you send.')) return;
    try { await del('/contacts/frequent'); toast('Forgotten'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <>
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
      <p className="muted small" style={{ margin: 0 }}>From what you've sent in Workspace in the last six months; Mail also uses it to suggest who to include.</p>
      <button className="btn small" onClick={forgetAll}>Clear all</button>
    </div>
    <table className="files" aria-label="Frequently contacted">
      <thead><tr><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Emailed</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {shown.map((c) => (
          <tr key={c.email}>
            <td className="name"><Avatar name={c.name || c.email} size={28} email={c.email} /><span>{c.name || c.email}</span>
              {c.colleague_id && <span className="muted small"> · colleague</span>}</td>
            <td className="hide-sm">{c.email}</td>
            <td className="hide-sm muted">{c.times === 1 ? 'once' : `${c.times} times`}, last {new Date(c.last_at).toLocaleDateString()}</td>
            <td className="actions">
              <div className="row end" style={{ gap: 6, alignItems: 'center' }}>
                <button className="btn small" onClick={() => navigate(`/mail?compose=${encodeURIComponent(formatAddress({ name: c.name, email: c.email }))}`)}><Icon name="mail" size={16} /> Email</button>
                {!c.contact_id && !c.colleague_id && <button className="btn small" onClick={() => add(c)}>Add to contacts</button>}
                <button className="icon-btn" aria-label={`Forget ${c.name || c.email}`} title="Forget: leave them out of Frequent and Mail's suggestions" onClick={() => forget(c)}><Icon name="close" size={18} /></button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

const TOUCH = [['', 'No reminder'], [7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every month'], [60, 'Every 2 months'], [90, 'Every 3 months'], [180, 'Every 6 months'], [365, 'Every year']];

const LOG_KINDS = [['call', '📞 Call'], ['meeting', '🤝 Meeting'], ['note', '📝 Note']];
/** Your log with a contact: calls, meetings and notes, newest first. A call or meeting counts for Keep in touch. */
function ContactLog({ contact, onChanged }) {
  const toast = useToast();
  const [entries, setEntries] = useState(null);
  const [kind, setKind] = useState('call');
  const [text, setText] = useState('');
  const [when, setWhen] = useState(''); // YYYY-MM-DD, empty for now
  const load = () => get(`/contacts/${contact.id}/log`).then(setEntries).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, [contact.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await post(`/contacts/${contact.id}/log`, { kind, text, ...(when && { at: new Date(`${when}T12:00:00`).getTime() }) });
      setText(''); setWhen(''); load(); if (kind !== 'note') onChanged?.();
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <section className="contact-log stack-tight" aria-label="Log">
      <h3 className="small">Log</h3>
      <form className="row wrap" style={{ gap: 6 }} onSubmit={add}>
        <input aria-label="What happened" placeholder="Talked about the renewal…" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} style={{ flex: '1 1 100%' }} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>{LOG_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input type="date" aria-label="When (today if empty)" value={when} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setWhen(e.target.value)} />
        <button className="btn small" disabled={!text.trim()}>Add</button>
      </form>
      {entries && !entries.length && <p className="muted small">Nothing logged yet. Calls and meetings you log count for Keep in touch.</p>}
      {entries?.length > 0 && <ul className="with-list">{entries.map((x) => (
        <li key={x.id}><span aria-hidden="true">{LOG_KINDS.find(([v]) => v === x.kind)?.[1].split(' ')[0]}</span>
          <span className="grow">{x.text}</span><span className="muted small nowrap">{new Date(x.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <button type="button" className="icon-btn" aria-label={`Remove: ${x.text}`} onClick={async () => { try { await del(`/contacts/${contact.id}/log/${x.id}`); load(); } catch (e) { toast(e.message, 'error'); } }}><Icon name="close" size={14} /></button></li>
      ))}</ul>}
    </section>
  );
}

/** Who you're due to be in touch with (most overdue first): write to them, or mark that you've been in touch. */
function KeepInTouch({ filter }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const load = () => get('/contacts/keep-in-touch').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return null;
  const shown = list.filter((c) => !filter || `${c.name} ${c.email || ''}`.toLowerCase().includes(filter.toLowerCase()));
  if (!list.length) return <Empty icon="person" title="Nobody to catch up with">Choose how often to keep in touch in a contact's window (Edit → Keep in touch). When it's been longer, they show up here.</Empty>;
  return (
    <ul className="keep-in-touch" aria-label="Keep in touch">
      {shown.map((c) => (
        <li key={c.id} className="row">
          <Avatar name={c.name} size={32} email={c.email} />
          <span className="grow"><strong>{c.name}</strong><div className="muted small">Last in touch: {sinceText(c.last_contact)} · {TOUCH.find(([v]) => v === c.touch_days)?.[1].toLowerCase()}</div></span>
          {c.email && <button type="button" className="btn small" onClick={() => navigate(`/mail?compose=${encodeURIComponent(c.email)}`)}><Icon name="mail" size={16} /> Email</button>}
          <button type="button" className="btn small" aria-label={`In touch with ${c.name}`} title="You've talked another way (a call, a meeting): start the clock again"
            onClick={async () => { try { await post(`/contacts/${c.id}/contacted`, {}); toast(`Noted: in touch with ${c.name}`); load(); } catch (e) { toast(e.message, 'error'); } }}>✓ In touch</button>
        </li>
      ))}
    </ul>
  );
}

function ContactDialog({ contact, orgName, onClose, onSaved }) {
  const { user } = useAuth();
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', notes: '', ...contact });
  const [error, setError] = useState('');
  // The photo: unchanged (null), a new one picked ({ blob, url }), or taken away ('remove').
  const [pic, setPic] = useState(null);
  const picInput = useRef();
  const shownPhoto = pic === 'remove' ? undefined : pic?.url || photoUrl(contact);
  async function pickPhoto(file) {
    if (!file) return;
    try { const blob = await photoBlob(file); setPic({ blob, url: URL.createObjectURL(blob) }); }
    catch { setError('That picture can’t be read. Try a JPEG or PNG.'); }
  }
  async function savePhoto(id) {
    if (!pic) return;
    const r = await fetch(`/api/contacts/${id}/photo`, pic === 'remove'
      ? { method: 'DELETE', headers: { 'x-requested-with': 'nas-workspace' } }
      : { method: 'PUT', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'image/jpeg' }, body: pic.blob });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The photo couldn’t be saved');
  }
  async function submit(e) {
    e.preventDefault();
    const body = { name: f.name, email: f.email || '', phone: f.phone || '', company: f.company || '', title: f.title || '', website: f.website || '', address: f.address || '', notes: f.notes || '', birthday: f.birthday || null, shared: !!f.shared,
      more_emails: (f.more_emails || []).filter((x) => x.value.trim()), more_phones: (f.more_phones || []).filter((x) => x.value.trim()),
      dates: (f.dates || []).filter((x) => x.date), custom_fields: (f.custom_fields || []).filter((x) => x.label.trim() || x.value.trim()) };
    const mine = !contact.id || contact.owner_id === user.id;
    try {
      const saved = contact.id ? await patch(`/contacts/${contact.id}`, { ...body, ...(mine && { touch_days: f.touch_days || null }) }) : await post('/contacts', body);
      if (!contact.id && f.touch_days) await patch(`/contacts/${saved.id}`, { touch_days: f.touch_days });
      await savePhoto(saved.id || contact.id); onSaved();
    }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal title={contact.id ? 'Edit contact' : 'New contact'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="row contact-photo" style={{ gap: 12 }}>
          <Avatar name={f.name || '?'} size={64} src={shownPhoto} />
          <button type="button" className="btn small" onClick={() => picInput.current.click()}>{shownPhoto ? 'Change photo' : 'Add photo'}</button>
          {shownPhoto && <button type="button" className="link-btn small" onClick={() => setPic('remove')}>Remove photo</button>}
          <input ref={picInput} type="file" accept="image/*" hidden aria-label="Photo" onChange={(e) => { pickPhoto(e.target.files[0]); e.target.value = ''; }} />
        </div>
        {FIELDS.map(([k, label], i) => (
          <div key={k} className="stack-tight">
            <label className="field"><span>{label}</span>
              <input autoFocus={i === 0} required={k === 'name'} type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'} placeholder={k === 'website' ? 'example.com' : undefined} value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </label>
            {(k === 'email' || k === 'phone') && <MoreField kind={`${k}s`} list={f[`more_${k}s`] || []} onChange={(l) => setF({ ...f, [`more_${k}s`]: l })} />}
          </div>
        ))}
        <label className="field"><span>Address</span><textarea rows={3} value={f.address || ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <BirthdayField value={f.birthday || ''} onChange={(birthday) => setF({ ...f, birthday })} />
        <DatesField list={f.dates || []} onChange={(dates) => setF({ ...f, dates })} />
        <CustomFields list={f.custom_fields || []} onChange={(custom_fields) => setF({ ...f, custom_fields })} />
        <label className="field"><span>Notes</span><textarea rows={3} value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        {(!contact.id || contact.owner_id === user.id) && <label className="field"><span>Keep in touch</span>
          <select value={f.touch_days || ''} onChange={(e) => setF({ ...f, touch_days: e.target.value ? Number(e.target.value) : null })}>
            {TOUCH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="muted small">Shows them under Keep in touch when it's been longer than this. Sending them email counts.</span></label>}
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

const DATE_LABELS = ['Anniversary', 'Work anniversary', 'Other'];
/** Other dates: a label (Anniversary, or your own) and a date, with or without the year; up to ten. */
function DatesField({ list, onChange }) {
  const set = (i, patch) => onChange(list.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <fieldset className="stack-tight contact-more"><legend className="small">Other dates</legend>
      {list.map((d, i) => {
        const noYear = d.date.startsWith('--'), shown = noYear ? `2000${d.date.slice(1)}` : d.date;
        return (
          <div key={i} className="row wrap" style={{ gap: 6 }}>
            <input aria-label={`Date ${i + 1} label`} list="date-labels" value={d.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} style={{ width: 128 }} />
            <input aria-label={`Date ${i + 1}`} type="date" value={shown} min="1850-01-01" max="2200-12-31" onChange={(e) => set(i, { date: e.target.value ? (noYear ? `--${e.target.value.slice(5)}` : e.target.value) : '' })} />
            <label className="check small"><input type="checkbox" checked={noYear} disabled={!d.date} onChange={(e) => set(i, { date: e.target.checked ? `--${shown.slice(5)}` : shown })} /> Year not known</label>
            <button type="button" className="icon-btn" aria-label={`Remove date ${i + 1}`} onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
          </div>
        );
      })}
      <datalist id="date-labels">{DATE_LABELS.map((l) => <option key={l} value={l} />)}</datalist>
      {list.length < 10 && <div><button type="button" className="link-btn small" onClick={() => onChange([...list, { label: 'Anniversary', date: '' }])}>+ Add a date</button></div>}
    </fieldset>
  );
}
/** Fields of your own: a label and a value (a customer number, a parking space); up to ten. */
function CustomFields({ list, onChange }) {
  const set = (i, patch) => onChange(list.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <fieldset className="stack-tight contact-more"><legend className="small">Fields of your own</legend>
      {list.map((c, i) => (
        <div key={i} className="row wrap" style={{ gap: 6 }}>
          <input aria-label={`Field ${i + 1} label`} placeholder="Label" value={c.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} style={{ width: 128 }} />
          <input aria-label={`Field ${i + 1} value`} placeholder="Value" value={c.value} maxLength={500} onChange={(e) => set(i, { value: e.target.value })} className="grow" />
          <button type="button" className="icon-btn" aria-label={`Remove field ${i + 1}`} onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
        </div>
      ))}
      {list.length < 10 && <div><button type="button" className="link-btn small" onClick={() => onChange([...list, { label: '', value: '' }])}>+ Add a field</button></div>}
    </fieldset>
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

/** Who reports to whom: the Directory as a tree (filtering shows the matching people with their managers). */
function OrgChart({ people, filter, onMessage, me, onOpen }) {
  const f = filter.trim().toLowerCase();
  const hit = (p) => !f || [p.name, p.job_title, p.department, p.username].some((v) => v && v.toLowerCase().includes(f));
  const keep = new Set();
  if (f) for (const p of people) if (hit(p)) { keep.add(p.id); for (const m of chainOf(people, p.id)) keep.add(m.id); }
  const tree = orgTree(f ? people.filter((p) => keep.has(p.id)) : people);
  if (!people.some((p) => p.manager_id)) return <Empty icon="people" title="No org chart yet">An admin sets who each person reports to in Admin → Users → ⋮ → Job and manager.</Empty>;
  const node = (p) => (
    <li key={p.id}>
      <div className={`org-card ${f && hit(p) ? 'hit' : ''}`} aria-label={`${p.name}${p.job_title ? `, ${p.job_title}` : ''}`}>
        <Avatar name={p.name} size={32} userId={p.id} />
        <span className="grow"><button type="button" className="link-btn" onClick={() => onOpen(p.id)}><strong>{p.name}</strong></button>{(p.job_title || p.department) && <span className="muted small"><br />{[p.job_title, p.department].filter(Boolean).join(' · ')}</span>}</span>
        {p.reports.length > 0 && <span className="muted small" title="Reports">{p.reports.length}</span>}
        {p.id !== me && <button className="icon-btn" aria-label={`Message ${p.name}`} onClick={() => onMessage(p)}><Icon name="chat" size={16} /></button>}
      </div>
      {p.reports.length > 0 && <ul>{p.reports.map(node)}</ul>}
    </li>
  );
  return <ul className="org-chart" aria-label="Org chart">{tree.map(node)}</ul>;
}

/** Send a contact into a Chat conversation (a channel or a direct message), with a note if you like. */
/** A contact as a QR code (a vCard: scan it with a phone's camera to add it), and as a .vcf to download. */
function ContactQr({ contact, onClose }) {
  const [img, setImg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/contacts/${contact.id}/vcard`, { credentials: 'same-origin', headers: { 'x-requested-with': 'nas-workspace' } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('Couldn’t get the contact'))))
      .then((text) => QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'L' }))
      .then(setImg).catch((e) => setError(/too big|big to/i.test(e.message) ? 'There’s too much on this contact for a QR code: download the vCard instead.' : e.message));
  }, [contact.id]);
  return (
    <Modal title={`QR code for ${contact.name}`} onClose={onClose}>
      <div className="stack contact-qr-box">
        <p className="muted small" style={{ margin: 0 }}>Point a phone’s camera at it to add {contact.name} to its contacts. It holds the name, email addresses, phone numbers, company, job title, address and website; notes and dates stay with you.</p>
        {img && <img src={img} alt={`QR code with ${contact.name}’s contact card`} width={240} height={240} />}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <a className="btn" href={`/api/contacts/${contact.id}/vcard?download=1`} download>Download vCard (.vcf)</a>
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

function SendContact({ contact, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [convs, setConvs] = useState(null);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    get('/chat/channels').then((d) => {
      const open = (d.channels || []).filter((c) => !c.archived_at);
      setConvs(open);
      setTo((open.find((c) => c.dm_key && c.dm_name) || open[0])?.id || '');
    }).catch((e) => setError(e.message));
  }, []);
  const name = (c) => (c.dm_key ? `${c.dm_name || 'Notes to self'}${c.dm_org ? ` (${c.dm_org})` : ''}` : `# ${c.name}`);
  async function submit(e) {
    e.preventDefault();
    try {
      await post(`/chat/channels/${to}/contact`, contact.colleague ? { user_id: contact.id, body: note } : { contact_id: contact.id, body: note });
      onClose();
      toast(`${contact.name} sent to ${name(convs.find((c) => c.id === to))}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/chat/${to}`) } });
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal title={`Send ${contact.name} in Chat`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>{contact.colleague
          ? 'Everyone in the conversation sees their name, address, job title, department and work phone, and can add them to their own contacts.'
          : 'Everyone in the conversation sees the name, email addresses, phone numbers, company, job title, address and website, and can add them to their own contacts. Notes and dates stay with you.'}</p>
        <label className="field"><span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} required disabled={!convs}>
            {(convs || []).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
          </select>
        </label>
        <label className="field"><span>Add a message (optional)</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={8000} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to}>Send</button></div>
      </form>
    </Modal>
  );
}

// Undo changes: pick how far back; it says how many contacts that touches, then puts them back.
function UndoChangesDialog({ onClose, onDone }) {
  const toast = useToast();
  const [key, setKey] = useState('10m');
  const [custom, setCustom] = useState('');
  const [changed, setChanged] = useState(null);
  const [busy, setBusy] = useState(false);
  // Worked out when the choice is made (not on every render, which would keep moving it).
  const to = useMemo(() => undoTime(key, custom), [key, custom]);
  useEffect(() => {
    setChanged(null);
    if (to === null) return;
    const t = setTimeout(() => get(`/contacts/undo?since=${to}`).then((r) => setChanged(r.changed)).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [to]);
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  async function undo() {
    setBusy(true);
    try {
      const r = await post('/contacts/undo', { to });
      toast(r.changed ? `Undid changes to ${r.changed} contact${r.changed === 1 ? '' : 's'}` : 'Nothing to undo');
      onDone();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title="Undo changes" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={to === null || !changed || busy} onClick={undo}>Undo</button>
    </>}>
      <p>Put your contacts back as they were at an earlier time (up to {UNDO_DAYS} days ago). Contacts added since then go to the Trash; deleted ones come back.</p>
      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend className="muted small">Go back to</legend>
        {[...UNDO_CHOICES, { key: 'custom', label: 'A time of my own' }].map((c) => (
          <label key={c.key} className="row" style={{ gap: 8 }}><input type="radio" name="undo-to" checked={key === c.key} onChange={() => setKey(c.key)} /> {c.label}</label>
        ))}
        {key === 'custom' && <input type="datetime-local" aria-label="Date and time to go back to" value={custom} onChange={(e) => setCustom(e.target.value)}
          min={local(new Date(Date.now() - UNDO_DAYS * 864e5))} max={local(new Date())} />}
      </fieldset>
      <p className="muted" role="status">{to === null ? (key === 'custom' ? 'Pick a date and time in the last 30 days.' : '') : changed === null ? 'Checking…' : changedText(changed)}</p>
    </Modal>
  );
}
