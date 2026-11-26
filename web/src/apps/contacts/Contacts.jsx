import { companyNames, othersAt } from './companies.js';
import ConversationPick, { conversationName, latestFirst } from '../../components/ConversationPick.jsx';
import { has } from '../../fold.js';
import { matchesFilter } from './contactfilter.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { unreachable, changeAdd, appendKept, offlineId, keepChange, keepDelete } from '../offlinedocs.js';
import { contactKey } from './contactkeys.js';
import { stepTask } from '../tasks/taskkeys.js';
import { localToday } from '../tasks/taskmath.js';
import WithPerson from '../../components/WithPerson.jsx';
import { useNavigate, useSearchParams } from 'react-router';
import { addToTasksWithToast } from '../tasks/addtask.js';
import TasksAbout from '../../components/TasksAbout.jsx';
import { useMailStatus } from '../../mailStatus.js';
import { get, post, put, patch, del, postText, onLive, refreshOn } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import RecentlyDeleted from '../../components/RecentlyDeleted.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, NotSent, PromptModal, useToast } from '../../components/ui.jsx';
import { printHtml } from '../mail/mailprint.js';
import { contactsPrintHtml } from './contactprint.js';
import { useAuth } from '../../App.jsx';
import DrivePicker from '../../components/DrivePicker.jsx';
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
import { sortContacts, CONTACT_SORTS, touchAgo } from './sortcontacts.js';
import { withFreeTime } from '../../components/scheduleWith.js';
import { useBatches } from '../../components/useBatches.jsx';

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

const NEW_GROUP = '__new__';

export default function Contacts() {
  const [sending, setSending] = useState(null); // a contact being sent in Chat
  const [qr, setQr] = useState(null); // a contact shown as a QR code to scan with a phone
  const [history, setHistory] = useState(null); // a contact whose emails and meetings are shown
  const toast = useToast();
  const navigate = useNavigate();
  // Open in Sheets: your contacts (or the ticked ones) as a new spreadsheet in My Drive.
  const toSheet = async (ids) => {
    try { const r = await post('/contacts/sheet', ids ? { ids } : {}); toast(`Made “${r.name}” in your Drive`); navigate(`/sheets/${r.id}`); } catch (e) { toast(e.message, 'error'); }
  };
  const { user } = useAuth();
  // Keyboard (contactkeys.js): J / K move between the people listed (the focus with them), and the row's
  // own buttons do the rest: Enter or O opens (edit, or a colleague's card), S stars, # deletes; C a new one.
  const keysOn = useRef(true);
  keysOn.current = user?.keys !== false;
  useEffect(() => {
    const rows = () => [...document.querySelectorAll('tbody tr[data-contact]')];
    const onKey = (e) => {
      if (document.querySelector('.modal-backdrop, [role=menu], [role=dialog]')) return;
      const row = document.activeElement?.closest?.('tr[data-contact]');
      const action = contactKey(e, !!row && document.activeElement === row);
      if (!action || (!keysOn.current && e.key !== 'Enter')) return;
      if (action === 'new') { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'New contact'); if (b) { e.preventDefault(); b.click(); } return; }
      if (action === 'next' || action === 'prev') {
        const all = rows();
        const ids = all.map((r) => r.dataset.contact);
        const id = stepTask(ids, row?.dataset.contact || null, action);
        const to = all[ids.indexOf(id)];
        if (to) { e.preventDefault(); to.focus(); to.scrollIntoView?.({ block: 'nearest' }); }
        return;
      }
      if (!row) return;
      const button = action === 'open' ? row.querySelector('button[aria-label^="Edit "], td.name button')
        : action === 'star' ? row.querySelector('button.star') : row.querySelector('button[aria-label^="Delete "]');
      if (button) { e.preventDefault(); button.click(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
  const [pickingSheet, setPickingSheet] = useState(false); // Import → From Sheets…
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
  // Someone's status changes (set by them, or worked out from their calendar or a focus session): the Directory shows it at once.
  useEffect(() => onLive((m) => { if (m.type === 'status-changed') get('/users/directory').then(setDirectory).catch(() => {}); }), []);
  useEffect(() => onLive((m) => { if (refreshOn(m, 'directory-changed')) get('/users/directory').then(setDirectory).catch(() => {}); }), []);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { const again = () => loadRef.current(); window.addEventListener('nw:changes-sent', again); return () => window.removeEventListener('nw:changes-sent', again); }, []); // added offline, now made
  useEffect(() => onLive((m) => { if (refreshOn(m, 'contacts-changed', 'tasks-changed')) loadRef.current(); }), []); // made or changed in another tab, on another device, or (shared ones) by a colleague
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

  const match = (c) => matchesFilter(c, filter);
  const [sort, setSort] = useState('first'); // your own way of sorting your contacts
  useEffect(() => { get('/contacts/view').then((r) => setSort(r.sort)).catch(() => {}); }, []);
  const chooseSort = async (next) => { setSort(next); try { await put('/contacts/view', { sort: next }); } catch (e) { toast(e.message, 'error'); } };
  // Someone an event can invite: a colleague, or anyone with an address when this server sends email.
  const mail = useMailStatus();
  const canInvite = (c) => !!c.email && (!!mail?.enabled || directory.some((u) => (u.email || u.username || '').toLowerCase() === c.email.toLowerCase()));
  const filtered = (tab === 'mine' ? (contacts || []) : tab === 'company' ? company : directory).filter(match).filter(whereOk);
  const list = tab === 'mine' ? sortContacts(filtered, sort) : filtered;
  // Thousands of contacts: the table is filled 200 rows at a time (Select all still takes everyone listed).
  const batch = useBatches(list, 200, `${tab}|${filter}|${sort}|${whereFilter || ''}`);
  const own = tab === 'mine' || tab === 'company'; // address-book rows, not NAS users
  // Several of your contacts at once: email them, add them to a group, star them, or delete them.
  const [picked, setPicked] = useState(() => new Set());
  const [myGroups, setMyGroups] = useState([]);
  const [deletingMany, setDeletingMany] = useState(false);
  const [newGroup, setNewGroup] = useState(false); // naming a group for the people selected
  const [settingCompany, setSettingCompany] = useState(false); // one company for the people selected
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

  const addToGroup = (g) => many({ action: 'group', group_id: g.id }, (r) => `${r.added} added to ${g.name}${r.without_email ? ` (${r.without_email} without an email address left out)` : ''}`);
  /** "+ New group…": a group made with a name, the people selected put in it. */
  async function groupFromPicked(name) {
    const g = await post('/contacts/groups', { name, members: [] });
    setMyGroups((gs) => [...gs, g]);
    await addToGroup(g);
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
        <Menu trigger={(p) => <button className="btn" {...p}><Icon name="upload" size={18} /> Import</button>} items={[
          { label: 'From a file (.vcf or .csv)…', icon: 'upload', onClick: () => importInput.current.click() },
          { label: 'From Sheets…', icon: 'sheet', onClick: () => setPickingSheet(true) }, // (a spreadsheet in Drive, its first sheet, read as a CSV is)
        ]} />
        {pickingSheet && <DrivePicker title="Import contacts from a spreadsheet" accept={(x) => x.kind === 'sheet'} empty="No spreadsheets found." onClose={() => setPickingSheet(false)}
          onPick={async (x) => {
            setPickingSheet(false);
            try {
              const r = await post('/contacts/from-sheet', { file: x.id, sheet: 0 });
              toast(`${r.added} contact${r.added === 1 ? '' : 's'} imported from “${x.name}”${r.skipped ? `, ${r.skipped} already here` : ''}`);
              setTab('mine');
              load();
            } catch (e) { toast(e.message, 'error'); }
          }} />}
        <input ref={importInput} type="file" accept=".vcf,.vcard,.csv,text/vcard,text/csv" hidden aria-label="Contacts file to import" onChange={(e) => { importFile(e.target.files[0]); e.target.value = ''; }} />
        <Menu trigger={(p) => <button className="btn" {...p}><Icon name="download" size={18} /> Export</button>} items={[
          { label: 'vCard (.vcf): phones, Outlook, Apple', icon: 'download', onClick: () => { window.location.href = '/api/contacts/export?format=vcf'; } },
          { label: 'CSV: Gmail, spreadsheets', icon: 'download', onClick: () => { window.location.href = '/api/contacts/export?format=csv'; } },
          { label: 'Open in Sheets', icon: 'sheet', onClick: () => toSheet(null) },
          { label: 'Print the list', icon: 'print', onClick: () => printHtml(contactsPrintHtml(contacts || [], { title: 'My contacts' })) },
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
        {tab === 'dir' && <button type="button" className="btn small" title="Everyone in the Directory in a new spreadsheet: a phone list" onClick={async () => {
          try { const r = await post('/users/directory/sheet', {}); toast(`Made “${r.name}” in your Drive`, 'info', { action: { label: 'Open', onClick: () => navigate(`/sheets/${r.id}`) } }); } catch (e) { toast(e.message, 'error'); }
        }}><Icon name="sheet" size={16} /> Open in Sheets</button>}
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
        <><table className="files">
          {selecting && picked.size > 0 && (
            <caption className="contact-batch-cap"><div className="contact-batch" role="toolbar" aria-label="Change the selected contacts">
              <strong className="small" aria-live="polite">{picked.size} selected</strong>
              <button type="button" className="btn small" disabled={!chosen.some((c) => c.email)} title="Write to everyone selected who has an email address"
                onClick={() => navigate(`/mail?compose=${encodeURIComponent(chosen.filter((c) => c.email).map((c) => formatAddress({ name: c.name, email: c.email })).join(', '))}`)}><Icon name="mail" size={16} /> Email</button>
              <select aria-label="Add the selected contacts to a group" value=""
                onChange={(e) => { if (e.target.value === NEW_GROUP) { setNewGroup(true); return; } const g = myGroups.find((x) => x.id === e.target.value); if (g) addToGroup(g); }}>
                <option value="">Add to group…</option>
                {myGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                <option value={NEW_GROUP}>+ New group…</option>
              </select>
              {myGroups.length > 0 && <select aria-label="Take the selected contacts out of a group" value=""
                onChange={(e) => { const g = myGroups.find((x) => x.id === e.target.value); if (g) many({ action: 'ungroup', group_id: g.id }, (r) => (r.removed ? `${nPeople(r.removed)} taken out of ${g.name}` : `None of them were in ${g.name}`)); }}>
                <option value="">Remove from group…</option>
                {myGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>}
              <button type="button" className="btn small" onClick={() => many({ action: 'star' }, (r) => `${nPeople(r.changed)} starred`)}>★ Star</button>
              <button type="button" className="btn small" onClick={() => many({ action: 'unstar' }, (r) => `${nPeople(r.changed)} unstarred`)}>☆ Unstar</button>
              <select aria-label="Keep in touch with the selected contacts" value="x" title="A reminder when it's been that long since you were in touch"
                onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); many({ action: 'touch', touch_days: v }, (r) => (v ? `${nPeople(r.changed)}: ${TOUCH.find(([d]) => d === v)[1].toLowerCase()}` : `${nPeople(r.changed)}: no reminder`)); }}>
                <option value="x" disabled>Keep in touch…</option>
                {TOUCH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button type="button" className="btn small" title="One company (and job title) for everyone selected" onClick={() => setSettingCompany(true)}>Set company…</button>
              {chosen.some((c) => !c.shared) && <button type="button" className="btn small" title={`Everyone at ${user.org_name} sees them, and finds them when writing mail`}
                onClick={() => many({ action: 'share' }, (r) => `${nPeople(r.changed)} shared with everyone at ${user.org_name}`)}><Icon name="people" size={16} /> Share with {user.org_name}</button>}
              {chosen.some((c) => c.shared) && <button type="button" className="btn small" onClick={() => many({ action: 'unshare' }, (r) => `${nPeople(r.changed)} no longer shared`)}>Stop sharing</button>}
              <Menu trigger={(p) => <button type="button" className="btn small" {...p}><Icon name="download" size={16} /> Export selected</button>} items={[
                { label: 'vCard (.vcf): phones, Outlook, Apple', icon: 'download', onClick: () => { window.location.href = `/api/contacts/export?ids=${[...picked].join(',')}`; } },
                { label: 'CSV: Gmail, spreadsheets', icon: 'download', onClick: () => { window.location.href = `/api/contacts/export?format=csv&ids=${[...picked].join(',')}`; } },
                { label: 'Open in Sheets', icon: 'sheet', onClick: () => toSheet([...picked]) },
              ]} />
              <button type="button" className="btn small" title="Each as a card in a Chat conversation: colleagues can add them to their contacts" onClick={() => setSending(chosen)}><Icon name="chat" size={16} /> Send in Chat…</button>
              <button type="button" className="btn small" onClick={() => printHtml(contactsPrintHtml(chosen, { title: 'Contacts' }))}><Icon name="print" size={16} /> Print</button>
              <button type="button" className="btn small danger" onClick={() => setDeletingMany(true)}><Icon name="trash" size={16} /> Delete</button>
              <button type="button" className="link-btn small" onClick={() => setPicked(new Set())}>Clear</button>
            </div></caption>
          )}
          <thead><tr>{selecting && <th className="pick-col"><input type="checkbox" aria-label="Select all shown" checked={allShown} onChange={() => setPicked(allShown ? new Set() : new Set(list.map((c) => c.id)))} /></th>}<th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Phone</th><th className="hide-sm">Company</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {batch.shown.map((c) => (
              <tr key={c.id} data-contact={c.id} tabIndex={-1} aria-label={c.name} className={picked.has(c.id) ? 'picked' : ''}>
                {selecting && <td className="pick-col"><input type="checkbox" aria-label={`Select ${c.name}`} checked={picked.has(c.id)} onChange={() => pickOne(c.id)} /></td>}
                <td className="name"><Avatar name={c.name} size={28} userId={tab === 'dir' ? c.id : undefined} email={c.email || c.username} src={tab !== 'dir' ? photoUrl(c) : undefined} /><span>{tab === 'dir' ? <button type="button" className="link-btn person-name" onClick={() => setCard(c.id)}>{c.name}</button> : c.name}{c.shared && tab === 'mine' ? <span className="muted"> · Shared with company</span> : null}{c.offline && <> <NotSent /></>}{tab === 'mine' && sort === 'touch' && <span className="muted small contact-touch"> · {touchAgo(c.last_contact)}</span>}{tab === 'company' && <span className="muted"> · Added by {c.owner_id === user.id ? 'you' : c.owner_name}</span>}{c.status && <span className="person-status" aria-label={`Status: ${statusLine(c.status)}`}> · {statusLine(c.status)}</span>}{tab === 'dir' && whereToday[c.id] && <span className="muted person-where" title="Working location"> · {placeText(whereToday[c.id])} {dayName(whereDay)}</span>}</span></td>
                <td className="hide-sm">{(c.email || c.username) ? <a href={`mailto:${c.email || c.username}`}>{c.email || c.username}</a> : <span className="muted">—</span>}
                  {c.more_emails?.map((m) => <div key={m.value} className="small"><a href={`mailto:${m.value}`}>{m.value}</a> <span className="muted">{TYPE_LABELS[m.type]}</span></div>)}</td>
                <td className="hide-sm">{(c.phone || c.work_phone) ? <a href={`tel:${c.phone || c.work_phone}`}>{c.phone || c.work_phone}</a> : <span className="muted">—</span>}
                  {c.more_phones?.map((m) => <div key={m.value} className="small"><a href={`tel:${m.value}`}>{m.value}</a> <span className="muted">{TYPE_LABELS[m.type]}</span></div>)}</td>
                <td className="hide-sm muted">{own && (c.custom_fields?.length > 0 || c.dates?.length > 0 || c.related?.length > 0) && (
                  <div className="small contact-extra">
                    {/* a related person's name finds them in your contacts */}
                    {(c.related || []).map((x, i) => <span key={`r${i}`}>{i > 0 && ' · '}{x.label}: <button type="button" className="link-btn related-link" title={`Find ${x.name} in your contacts`} onClick={() => setFilter(x.name)}>{x.name}</button></span>)}
                    {[...(c.custom_fields || []).map((x) => `${x.label}: ${x.value}`), ...(c.dates || []).map((x) => `${x.label}: ${x.date.startsWith('--') ? x.date.slice(2) : x.date}`)].map((t, i) => <span key={`f${i}`}>{(i > 0 || c.related?.length > 0) && ' · '}{t}</span>)}
                  </div>
                )}{own ? <>{c.title}{c.title && c.company && ' · '}{c.company && <button type="button" className="link-btn company-link" title={`Show everyone at ${c.company.trim()}`} onClick={() => setFilter(c.company.trim().replace(/\s+/g, ' '))}>{c.company}</button>}{!c.title && !c.company && '—'}</> : [c.job_title, c.department].filter(Boolean).join(' · ') || user.org_name}{own && c.website && <> · <a href={c.website} target="_blank" rel="noopener noreferrer">{c.website.replace(/^https?:\/\//, '')}</a></>}</td>
                <td className="actions">
                  {own && tab !== 'mine' && !c.can_edit && <button className="icon-btn contact-qr" aria-label={`QR code for ${c.name}`} title="QR code: scan it with a phone's camera to add the contact, or download it as a vCard" onClick={() => setQr(c)}>▦</button>}
                  {own && tab !== 'mine' && !c.can_edit && <button className="icon-btn" aria-label={`Send ${c.name} in Chat`} title="Send in Chat: colleagues can add it to their contacts" onClick={() => setSending(c)}><Icon name="share" size={18} /></button>}
                  {own ? (tab === 'mine' || c.can_edit) && <>
                    {tab === 'mine' && <button className={`icon-btn star ${c.starred ? 'on' : ''}`} aria-pressed={!!c.starred} aria-label={c.starred ? `Unstar ${c.name}` : `Star ${c.name}`} title={c.starred ? 'Starred: first in your contacts and when writing mail' : 'Star: keep them first in your contacts and when writing mail'}
                      onClick={async () => { try { await patch(`/contacts/${c.id}`, { starred: !c.starred }); load(); } catch (e) { toast(e.message, 'error'); } }}>{c.starred ? '★' : '☆'}</button>}
                    <button className="icon-btn" aria-label={`History with ${c.name}`} title="Your log of calls and meetings, and emails and meetings with them" onClick={() => setHistory(c)}><Icon name="clock" size={18} /></button>
                    {canInvite(c) && <button className="icon-btn" aria-label={`Schedule a meeting with ${c.name}`} title="Schedule a meeting: a new event with them invited, to set and save" onClick={() => {
                      const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
                      navigate('/calendar', { state: { newEvent: { title: `Meeting with ${c.name}`, start: t.getTime(), end: t.getTime() + 30 * 60e3, all_day: 0, location: '', description: '', guests: [{ email: c.email, name: c.name }] } } });
                    }}><Icon name="calendar" size={18} /></button>}
                    <button className="icon-btn" aria-label={`Add a task about ${c.name}`} title="Add to Tasks: a task to get in touch, linking back here" onClick={() => addToTasksWithToast(toast, navigate, { title: `Get in touch with ${c.name}`, link: { url: `/contacts?q=${encodeURIComponent(c.name)}`, label: `Contact: ${c.name}` } }).then(load)}><Icon name="check" size={18} /></button>
                    {c.tasks_open > 0 && <TasksAbout url={`/contacts?q=${encodeURIComponent(c.name)}`} what="contact" bump={c.tasks_open} />}
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
        {batch.more}</>
      )}
      {card && <PersonCard userId={card} onClose={() => setCard(null)} />}
      {merging && <DuplicatesDialog onClose={() => setMerging(false)} onMerged={load} />}
      {undoing && <UndoChangesDialog onClose={() => setUndoing(false)} onDone={() => { setUndoing(false); setTab('mine'); load(); }} />}
      {history && <Modal title={`With ${history.name}`} onClose={() => setHistory(null)} footer={<button type="button" className="btn" onClick={() => setHistory(null)}>Close</button>}><ContactLog contact={history} onChanged={load} /><WithPerson email={history.email} onOpen={() => setHistory(null)} /></Modal>}
      {qr && <ContactQr contact={qr} onClose={() => setQr(null)} />}
      {sending && <SendContact contacts={[sending].flat()} onClose={() => setSending(null)} />}
      {editing && <ContactDialog key={editing.id || 'new'} contact={editing} orgName={user.org_name} all={contacts || []} onOpen={setEditing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {settingCompany && <SetCompany count={picked.size} companies={[...new Set((contacts || []).map((c) => c.company).filter(Boolean))].sort()} onClose={() => setSettingCompany(false)}
        onSave={(body) => many({ action: 'company', ...body }, (r) => (body.company ? `${nPeople(r.changed)} now at ${body.company}` : `Company cleared for ${nPeople(r.changed)}`))} />}
      {newGroup && <PromptModal title={`New group of ${nPeople(picked.size)}`} label="Group name" confirm="Make the group" onSubmit={groupFromPicked} onClose={() => setNewGroup(false)} />}
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
          catch (e) {
            // No connection: to Trash when it's back (gone from the list meanwhile, also after reloading).
            if (unreachable(e)) { await keepDelete({ url: `/contacts/${c.id}`, user: user?.id, label: c.name, id: c.id }); load(); toast(`${c.name} deleted on this device, moved to Trash when the connection is back`); return; }
            toast(e.message, 'error');
          }
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
          <p className="muted small" style={{ margin: 0 }}>These contacts share an email address, phone number or name. Merging keeps the one you choose, fills in what it's missing from the others, adds their other email addresses and phone numbers, dates, fields and related people to it, and notes anything else that differs. The others are deleted.</p>
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
/** One company (and, if typed, a job title) for several contacts at once: an empty company clears it. */
function SetCompany({ count, companies, onSave, onClose }) {
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const submit = async (e) => { e.preventDefault(); await onSave({ company: company.trim(), ...(title.trim() && { title: title.trim() }) }); onClose(); };
  return (
    <Modal title={`Company for ${nPeople(count)}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Company</span><input autoFocus list="set-company-list" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Empty to clear it" /></label>
        <datalist id="set-company-list">{companies.map((c) => <option key={c} value={c} />)}</datalist>
        <label className="field"><span>Job title (optional)</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Left as it is if empty" /></label>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{company.trim() ? 'Set company' : 'Clear company'}</button></div>
      </form>
    </Modal>
  );
}

/** Deleted contacts, kept 30 days: put one back, or delete it (or everything) for good. */
function ContactsTrash({ filter, onRestored }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [emptying, setEmptying] = useState(false);
  const [pickedT, setPickedT] = useState(() => new Set()); // ticked to restore or delete together
  const [forgettingMany, setForgettingMany] = useState(false);
  const load = () => get('/contacts/trash').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const many = async (action) => {
    try {
      const r = await post('/contacts/trash/batch', { ids: [...pickedT], action });
      toast(action === 'restore' ? `${nPeople(r.restored)} put back` : `${nPeople(r.deleted)} deleted for good`);
      setPickedT(new Set()); load(); if (action === 'restore') onRestored();
    } catch (e) { toast(e.message, 'error'); }
  };
  if (!data) return null;
  if (!data.contacts.length) return <Empty icon="trash" title="Trash is empty">Contacts you delete (here or on your phone) stay here for {data.days} days, so you can put them back.</Empty>;
  const f = filter.toLowerCase();
  const shown = data.contacts.filter((c) => !f || [c.name, c.email, c.phone, c.company].some((v) => has(v, f)));
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
        {pickedT.size > 0 && (
          <caption className="contact-batch-cap"><div className="contact-batch" role="toolbar" aria-label="Change the selected deleted contacts">
            <strong className="small" aria-live="polite">{pickedT.size} selected</strong>
            <button type="button" className="btn small" onClick={() => many('restore')}>Restore</button>
            <button type="button" className="btn small danger" onClick={() => setForgettingMany(true)}><Icon name="trash" size={16} /> Delete for good</button>
            <button type="button" className="link-btn small" onClick={() => setPickedT(new Set())}>Clear</button>
          </div></caption>
        )}
        <thead><tr><th className="pick-col"><input type="checkbox" aria-label="Select all deleted contacts shown" checked={shown.length > 0 && shown.every((c) => pickedT.has(c.id))} onChange={(e) => setPickedT(e.target.checked ? new Set(shown.map((c) => c.id)) : new Set())} /></th><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Deleted</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id}>
              <td className="pick-col"><input type="checkbox" aria-label={`Select deleted contact ${c.name}`} checked={pickedT.has(c.id)} onChange={(e) => { const n = new Set(pickedT); e.target.checked ? n.add(c.id) : n.delete(c.id); setPickedT(n); }} /></td>
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
      {forgettingMany && <ConfirmModal title={`Delete ${nPeople(pickedT.size)} for good?`} confirm="Delete for good" message="This can't be undone." onClose={() => setForgettingMany(false)}
        onConfirm={async () => { setForgettingMany(false); await many('delete'); }} />}
      {emptying && <ConfirmModal title="Empty trash?" confirm="Delete for good" message={`${nPeople(data.contacts.length)} will be deleted for good. This can't be undone.`} onClose={() => setEmptying(false)}
        onConfirm={async () => { setEmptying(false); try { const r = await del('/contacts/trash'); toast(`${nPeople(r.deleted)} deleted for good`); load(); } catch (e) { toast(e.message, 'error'); } }} />}
    </>
  );
}

function OtherContacts({ filter, onAdded }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [pickedO, setPickedO] = useState(() => new Set()); // addresses ticked to add or forget together
  const load = () => get('/contacts/other').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const addMany = async () => {
    const people = (list || []).filter((c) => pickedO.has(c.email)).map((c) => ({ name: c.name || c.email.split('@')[0], email: c.email }));
    try { const r = await post('/contacts/add-people', { people }); toast(`${nPeople(r.added)} added to your contacts`); setPickedO(new Set()); load(); onAdded(); } catch (e) { toast(e.message, 'error'); }
  };
  const forgetMany = async () => {
    try { const r = await post('/contacts/other/forget', { emails: [...pickedO] }); toast(`${r.forgotten === 1 ? '1 address' : `${r.forgotten} addresses`} forgotten`); setPickedO(new Set()); load(); } catch (e) { toast(e.message, 'error'); }
  };
  if (!list) return null;
  if (!list.length) return <Empty icon="person" title="No other contacts">People you email who aren't in your contacts show up here, and are suggested when you write.</Empty>;
  const f = filter.toLowerCase();
  const shown = list.filter((c) => !f || c.email.includes(f) || has(c.name, f));
  const add = async (c) => {
    try { await post('/contacts', { name: c.name || c.email.split('@')[0], email: c.email }); toast(`${c.name || c.email} added to your contacts`); load(); onAdded(); } catch (e) { toast(e.message, 'error'); }
  };
  const forget = async (c) => { try { await del(`/contacts/other/${encodeURIComponent(c.email)}`); load(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <table className="files">
      {pickedO.size > 0 && (
        <caption className="contact-batch-cap"><div className="contact-batch" role="toolbar" aria-label="Change the selected other contacts">
          <strong className="small" aria-live="polite">{pickedO.size} selected</strong>
          <button type="button" className="btn small" onClick={addMany}>Add to contacts</button>
          <button type="button" className="btn small" title="Take them off Other contacts (they come back if you email them again)" onClick={forgetMany}>Forget</button>
          <button type="button" className="link-btn small" onClick={() => setPickedO(new Set())}>Clear</button>
        </div></caption>
      )}
      <thead><tr><th className="pick-col"><input type="checkbox" aria-label="Select all other contacts shown" checked={shown.length > 0 && shown.every((c) => pickedO.has(c.email))} onChange={(e) => setPickedO(e.target.checked ? new Set(shown.map((c) => c.email)) : new Set())} /></th><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Emailed</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {shown.map((c) => (
          <tr key={c.email}>
            <td className="pick-col"><input type="checkbox" aria-label={`Select ${c.email}`} checked={pickedO.has(c.email)} onChange={(e) => { const n = new Set(pickedO); e.target.checked ? n.add(c.email) : n.delete(c.email); setPickedO(n); }} /></td>
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
  const [pickedF, setPickedF] = useState(() => new Set()); // addresses ticked to email, add or forget together
  const load = () => get('/contacts/frequent').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenF = (list || []).filter((c) => pickedF.has(c.email));
  const addable = chosenF.filter((c) => !c.contact_id && !c.colleague_id);
  const addMany = async () => {
    try { const r = await post('/contacts/add-people', { people: addable.map((c) => ({ name: c.name || c.email.split('@')[0], email: c.email })) }); toast(`${nPeople(r.added)} added to your contacts`); setPickedF(new Set()); load(); onAdded(); } catch (e) { toast(e.message, 'error'); }
  };
  const forgetMany = async () => {
    try { const r = await post('/contacts/frequent/forget', { emails: [...pickedF] }); toast(`${r.forgotten === 1 ? '1 person' : `${r.forgotten} people`} forgotten`); setPickedF(new Set()); load(); } catch (e) { toast(e.message, 'error'); }
  };
  if (!list) return null;
  if (!list.length) return <Empty icon="person" title="Nobody yet">The people you email most from Workspace show up here, most often first.</Empty>;
  const f = filter.toLowerCase();
  const shown = list.filter((c) => !f || c.email.includes(f) || has(c.name, f));
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
      {pickedF.size > 0 && (
        <caption className="contact-batch-cap"><div className="contact-batch" role="toolbar" aria-label="Change the selected people">
          <strong className="small" aria-live="polite">{pickedF.size} selected</strong>
          <button type="button" className="btn small" onClick={() => navigate(`/mail?compose=${encodeURIComponent(chosenF.map((c) => formatAddress({ name: c.name, email: c.email })).join(', '))}`)}><Icon name="mail" size={16} /> Email</button>
          <button type="button" className="btn small" disabled={!addable.length} title={addable.length ? '' : 'They’re all contacts or colleagues already'} onClick={addMany}>Add to contacts</button>
          <button type="button" className="btn small" title="Leave them out of Frequent and Mail's suggestions" onClick={forgetMany}>Forget</button>
          <button type="button" className="link-btn small" onClick={() => setPickedF(new Set())}>Clear</button>
        </div></caption>
      )}
      <thead><tr><th className="pick-col"><input type="checkbox" aria-label="Select everyone shown" checked={shown.length > 0 && shown.every((c) => pickedF.has(c.email))} onChange={(e) => setPickedF(e.target.checked ? new Set(shown.map((c) => c.email)) : new Set())} /></th><th>Name</th><th className="hide-sm">Email</th><th className="hide-sm">Emailed</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {shown.map((c) => (
          <tr key={c.email}>
            <td className="pick-col"><input type="checkbox" aria-label={`Select ${c.email}`} checked={pickedF.has(c.email)} onChange={(e) => { const n = new Set(pickedF); e.target.checked ? n.add(c.email) : n.delete(c.email); setPickedF(n); }} /></td>
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
        <input type="date" aria-label="When (today if empty)" value={when} max={localToday()} onChange={(e) => setWhen(e.target.value)} />
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
  const shown = list.filter((c) => !filter || has(`${c.name} ${c.email || ''}`, filter));
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

function ContactDialog({ contact, orgName, all = [], onOpen, onClose, onSaved }) {
  const { user } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', notes: '', ...contact });
  // Who else of your contacts is at this company (as it stands in the box), and the companies there are to fill in.
  const start = useRef(JSON.stringify({ name: '', email: '', phone: '', company: '', notes: '', ...contact }));
  const colleagues = othersAt(all, { id: contact.id, company: f.company });
  const firms = companyNames(all);
  const openOther = (c) => {
    if (JSON.stringify(f) !== start.current) return toast('Save or cancel your changes here first', 'error');
    onOpen?.(c);
  };
  // Write to everyone at this company at once: this contact (once saved) and the others there, those with an address.
  const navigateTo = useNavigate();
  const everyone = [...(contact.id && f.email ? [f] : []), ...colleagues].filter((c) => c.email);
  // …or keep them as a contact group named after the company, to write to (or invite) by its name later.
  const groupAll = async () => {
    const name = String(f.company).trim().replace(/\s+/g, ' ');
    try {
      await post('/contacts/groups', { name, members: everyone.map((c) => ({ name: c.name || '', email: c.email })) });
      toast(`Group “${name}” made with ${everyone.length} people: type its name in To to write to them all`);
    } catch (e) { toast(e.message, 'error'); }
  };
  const emailAll = () => {
    if (JSON.stringify(f) !== start.current) return toast('Save or cancel your changes here first', 'error');
    navigateTo(`/mail?compose=${encodeURIComponent(everyone.map((c) => formatAddress({ name: c.name, email: c.email })).join(', '))}`);
  };
  const [error, setError] = useState('');
  // A new contact's id, the same however often Save is pressed (a second press while the first is on its way makes no second contact).
  const newId = useRef(null);
  const [busy, setBusy] = useState(false);
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
  // What the dialog opened with: changing someone sends only what was changed here, so a change made elsewhere
  // meanwhile (a phone number added on a phone) isn't put back.
  const formBody = (f) => ({ name: f.name, email: f.email || '', phone: f.phone || '', company: f.company || '', title: f.title || '', website: f.website || '', address: f.address || '', notes: f.notes || '', birthday: f.birthday || null, shared: !!f.shared,
      more_emails: (f.more_emails || []).filter((x) => x.value.trim()), more_phones: (f.more_phones || []).filter((x) => x.value.trim()),
      dates: (f.dates || []).filter((x) => x.date), custom_fields: (f.custom_fields || []).filter((x) => x.label.trim() || x.value.trim()),
      related: (f.related || []).filter((x) => x.name.trim()) });
  const opened = useRef(null);
  if (opened.current === null) opened.current = formBody(f);
  async function submit(e) {
    e.preventDefault();
    let body = formBody(f);
    if (contact.id) body = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(opened.current[k])));
    const mine = !contact.id || contact.owner_id === user.id;
    if (!contact.id) body.id = (newId.current ??= offlineId()); // so one added offline is made once when the connection is back
    if (busy) return;
    setBusy(true);
    try {
      const saved = contact.id ? await patch(`/contacts/${contact.id}`, { ...body, ...(mine && { touch_days: f.touch_days || null }) }) : await post('/contacts', body);
      if (!contact.id && f.touch_days) await patch(`/contacts/${saved.id}`, { touch_days: f.touch_days });
      await savePhoto(saved.id || contact.id); onSaved();
    }
    catch (err) {
      // No connection, adding someone: kept here and made when it's back; in the list meanwhile (also after reloading).
      if (!contact.id && unreachable(err)) {
        await changeAdd({ method: 'POST', url: '/contacts', body, user: user.id, label: f.name });
        if (f.touch_days) await changeAdd({ method: 'PATCH', url: `/contacts/${body.id}`, body: { touch_days: f.touch_days }, user: user.id, label: f.name });
        await appendKept('/contacts', { ...body, owner_id: user.id, created_at: new Date().toISOString(), offline: true });
        window.dispatchEvent(new Event('nw:changes'));
        toast(`${f.name} saved on this device, added when the connection is back${pic && pic !== 'remove' ? ' (add the photo then)' : ''}`);
        onSaved();
        return;
      }
      // Changing someone already here: the same, the list shows the change meanwhile (a new photo waits for the connection).
      if (contact.id && unreachable(err)) {
        const changes = { ...body, ...(mine && { touch_days: f.touch_days || null }) };
        await keepChange({ method: 'PATCH', url: `/contacts/${contact.id}`, body: changes, user: user.id, label: f.name, id: contact.id });
        toast(`${f.name} changed on this device, saved when the connection is back${pic ? ' (change the photo then)' : ''}`);
        onSaved();
        return;
      }
      setError(err.message);
    } finally { setBusy(false); }
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
              <input autoFocus={i === 0} required={k === 'name'} type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'} placeholder={k === 'website' ? 'example.com' : undefined} value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })}
                list={k === 'company' ? 'contact-companies' : undefined} />
            </label>
            {k === 'company' && <datalist id="contact-companies">{firms.map((n) => <option key={n} value={n} />)}</datalist>}
            {k === 'company' && colleagues.length > 0 && (
              <p className="muted small also-at" style={{ margin: 0 }}>Also at {String(f.company).trim()}:{' '}
                {colleagues.slice(0, 6).map((c, n) => <span key={c.id}>{n > 0 && ', '}<button type="button" className="link-btn small" onClick={() => openOther(c)}>{c.name || c.email}</button></span>)}
                {colleagues.length > 6 && ` and ${colleagues.length - 6} more`}
                {everyone.length > 1 && <> · <button type="button" className="link-btn small" onClick={emailAll}>Email all {everyone.length}</button>
                  {' · '}<button type="button" className="link-btn small" onClick={groupAll}>Make a group</button></>}</p>
            )}
            {(k === 'email' || k === 'phone') && <MoreField kind={`${k}s`} list={f[`more_${k}s`] || []} onChange={(l) => setF({ ...f, [`more_${k}s`]: l })} />}
          </div>
        ))}
        <label className="field"><span>Address</span><textarea rows={3} value={f.address || ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <BirthdayField value={f.birthday || ''} onChange={(birthday) => setF({ ...f, birthday })} />
        <DatesField list={f.dates || []} onChange={(dates) => setF({ ...f, dates })} />
        <RelatedField list={f.related || []} onChange={(related) => setF({ ...f, related })} />
        <CustomFields list={f.custom_fields || []} onChange={(custom_fields) => setF({ ...f, custom_fields })} />
        <label className="field"><span>Notes</span><textarea rows={3} value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        {(!contact.id || contact.owner_id === user.id) && <label className="field"><span>Keep in touch</span>
          <select value={f.touch_days || ''} onChange={(e) => setF({ ...f, touch_days: e.target.value ? Number(e.target.value) : null })}>
            {TOUCH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="muted small">Shows them under Keep in touch when it's been longer than this. Sending them email counts.</span></label>}
        <label className="check"><input type="checkbox" checked={!!f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} /> Share with everyone at {orgName}</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
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
const RELATIONS = ['Spouse', 'Partner', 'Child', 'Parent', 'Sibling', 'Friend', 'Manager', 'Assistant', 'Relative', 'Other'];
/** Related people: who they are to this person (Spouse, Manager… or a word of your own) and their name; up to ten. */
function RelatedField({ list, onChange }) {
  const set = (i, patch) => onChange(list.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <fieldset className="stack-tight contact-more"><legend className="small">Related people</legend>
      {list.map((r, i) => (
        <div key={i} className="row wrap" style={{ gap: 6 }}>
          <input aria-label={`Related person ${i + 1}: who they are`} list="contact-relations" placeholder="Spouse, Manager…" value={r.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} style={{ width: 128 }} />
          <input aria-label={`Related person ${i + 1}: name`} placeholder="Name" value={r.name} maxLength={200} onChange={(e) => set(i, { name: e.target.value })} className="grow" />
          <button type="button" className="icon-btn" aria-label={`Remove related person ${i + 1}`} onClick={() => onChange(list.filter((_, k) => k !== i))}>×</button>
        </div>
      ))}
      <datalist id="contact-relations">{RELATIONS.map((x) => <option key={x} value={x} />)}</datalist>
      {list.length < 10 && <div><button type="button" className="link-btn small" onClick={() => onChange([...list, { label: 'Spouse', name: '' }])}>+ Add a person</button></div>}
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
/** Several groups merged into a new one: its name, and whether the old ones go. */
function MergeGroups({ count, onMerge, onClose }) {
  const [name, setName] = useState('');
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => { e.preventDefault(); if (!name.trim()) return; try { await onMerge(name.trim(), remove); onClose(); } catch (err) { setError(err.message); } };
  return (
    <Modal title={`Merge ${count} groups`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>A new group with everyone in them, each address once.</p>
        <label className="field"><span>New group's name</span><input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError(''); }} /></label>
        <label className="check"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Remove the old groups</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()}>Merge</button></div>
      </form>
    </Modal>
  );
}

function Groups({ filter }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [groups, setGroups] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [pickedG, setPickedG] = useState(() => new Set()); // groups ticked to merge or delete together
  const [merging, setMerging] = useState(false);
  const [deletingMany, setDeletingMany] = useState(false);
  const [bin, setBin] = useState(false); // Recently deleted groups
  const groupFile = useRef(null);
  // A group from a .vcf or .csv file, named after the file (numbered by the server if that name's taken).
  const importGroup = async (file) => {
    if (!file) return;
    try {
      const name = (file.name.replace(/\.(vcf|csv)$/i, '').trim() || 'Imported group').slice(0, 92);
      const g = await postText(`/contacts/groups/import?name=${encodeURIComponent(name)}`, await file.text());
      toast(`Group “${g.name}” made with ${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}${g.left_out ? ` (${g.left_out} without an email address left out)` : ''}`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  };
  const load = () => get('/contacts/groups').then(setGroups).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (groups || []).filter((g) => !filter || has(g.name, filter) || g.members.some((m) => has(`${m.name} ${m.email}`, filter)));
  const nGroups = (n) => `${n} group${n === 1 ? '' : 's'}`;
  const putBack = (ids) => async () => { try { for (const id of ids) await post(`/contacts/groups/bin/${id}/restore`); load(); } catch (e) { toast(e.message, 'error'); } };
  // Your own order: swap a group with the one above or below it.
  const orderGroup = async (g, by) => {
    const ids = groups.map((x) => x.id), i = ids.indexOf(g.id), j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { setGroups(await put('/contacts/groups/order', { ids })); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="stack">
      <div className="row"><button type="button" className="btn primary" onClick={() => setEditing({ name: '', members: [] })}><Icon name="plus" size={18} /> New group</button>
        <input ref={groupFile} type="file" accept=".vcf,.csv,text/vcard,text/csv" hidden aria-label="Import a group" onChange={(e) => { importGroup(e.target.files[0]); e.target.value = ''; }} />
        <button type="button" className="btn" title="A group from a vCard (.vcf) or CSV file: one a group was downloaded as, or exported from Gmail, Outlook or Apple Contacts" onClick={() => groupFile.current?.click()}><Icon name="upload" size={18} /> Import…</button>
        <span className="muted small grow">Type a group's name in To, Cc or Bcc to put in everyone in it.</span>
        <button type="button" className="btn small" onClick={() => setBin(true)}><Icon name="trash" size={16} /> Recently deleted</button></div>
      {bin && <RecentlyDeleted title="Recently deleted groups" what="Groups" list="/contacts/groups/bin" restore={(id) => `/contacts/groups/bin/${id}/restore`} forever={(id) => `/contacts/groups/bin/${id}`} empty="/contacts/groups/bin"
        note="Groups you delete are kept here for 30 days, then deleted for good. Restoring one brings it back with its people."
        onClose={() => setBin(false)} onRestored={() => { setBin(false); load(); }} />}
      {groups && !groups.length ? <Empty icon="people" title="No groups yet">Make one for people you often email together: a team, a board, a club.</Empty> : (
        <table className="files">
          {pickedG.size > 0 && (
            <caption className="contact-batch-cap"><div className="contact-batch" role="toolbar" aria-label="Change the selected groups">
              <strong className="small" aria-live="polite">{nGroups(pickedG.size)} selected</strong>
              <button type="button" className="btn small" disabled={pickedG.size < 2} title={pickedG.size < 2 ? 'Tick two groups or more' : 'One new group with everyone in them'} onClick={() => setMerging(true)}>Merge…</button>
              <button type="button" className="btn small danger" onClick={() => setDeletingMany(true)}><Icon name="trash" size={16} /> Delete</button>
              <button type="button" className="link-btn small" onClick={() => setPickedG(new Set())}>Clear</button>
            </div></caption>
          )}
          <thead><tr><th className="pick-col"><input type="checkbox" aria-label="Select all groups shown" checked={shown.length > 0 && shown.every((g) => pickedG.has(g.id))} onChange={(e) => setPickedG(e.target.checked ? new Set(shown.map((g) => g.id)) : new Set())} /></th><th>Group</th><th className="hide-sm">People</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.id}>
                <td className="pick-col"><input type="checkbox" aria-label={`Select group ${g.name}`} checked={pickedG.has(g.id)} onChange={(e) => { const n = new Set(pickedG); e.target.checked ? n.add(g.id) : n.delete(g.id); setPickedG(n); }} /></td>
                <td className="name"><Avatar name={g.name} size={28} /><span>{g.name}</span></td>
                <td className="hide-sm muted ellipsis" style={{ maxWidth: 420 }} title={g.members.map(formatAddress).join(', ')}>{g.members.length} · {g.members.slice(0, 3).map((m) => m.name || m.email).join(', ')}{g.members.length > 3 ? '…' : ''}</td>
                <td className="actions">
                  <button className="icon-btn" aria-label={`Email ${g.name}`} title="Email the group" disabled={!g.members.length} onClick={() => navigate(`/mail?compose=${encodeURIComponent(g.members.map(formatAddress).join(', '))}`)}><Icon name="mail" size={18} /></button>
                  <button className="icon-btn" aria-label={`Schedule a meeting with ${g.name}`} title="Schedule a meeting with the group" disabled={!g.members.length} onClick={async () => {
                    // A new event with everyone in the group, at the first hour you and its colleagues are free.
                    const t = Math.ceil(Date.now() / 18e5) * 18e5;
                    const { ev, moved } = await withFreeTime({ title: g.name, start: t, end: t + 36e5, all_day: 0, location: '', description: '', guests: g.members.map((m) => ({ email: m.email, name: m.name })) });
                    navigate('/calendar', { state: { newEvent: ev } });
                    if (moved) toast(`The first hour you’re all free: ${new Date(ev.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`);
                  }}><Icon name="calendar" size={18} /></button>
                  <button className="icon-btn" aria-label={`Add ${g.name}’s members to Contacts`} title="Save the group's people as contacts of yours (colleagues and those already there left out)" disabled={!g.members.length} onClick={async () => {
                    try { const r = await post(`/contacts/groups/${g.id}/add-to-contacts`, {}); toast(r.added ? `Added ${r.added === 1 ? r.names[0] : `${r.added} people`} to your contacts` : 'Everyone in this group is already in your contacts or a colleague'); }
                    catch (e) { toast(e.message, 'error'); }
                  }}><Icon name="person" size={18} /></button>
                  <button className="icon-btn" aria-label={`Open ${g.name} in Sheets`} title="The group in a new spreadsheet: names, addresses, phones and companies" disabled={!g.members.length} onClick={async () => {
                    try { const r = await post(`/contacts/groups/${g.id}/sheet`, {}); toast(`Made “${r.name}” in your Drive`, 'info', { action: { label: 'Open', onClick: () => navigate(`/sheets/${r.id}`) } }); }
                    catch (e) { toast(e.message, 'error'); }
                  }}><Icon name="sheet" size={18} /></button>
                  {g.members.length > 0 && <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label={`Download ${g.name}`} title="The group as contact cards, for a phone, Outlook or Gmail" {...p}><Icon name="download" size={18} /></button>} items={[
                    { label: 'vCard (.vcf)', onClick: () => { window.location.href = `/api/contacts/groups/${g.id}/export`; } },
                    { label: 'CSV (Gmail, Outlook)', onClick: () => { window.location.href = `/api/contacts/groups/${g.id}/export?format=csv`; } },
                  ]} />}
                  <button className="icon-btn" aria-label={`Make a copy of ${g.name}`} title="A copy with the same people, to change into a similar group" onClick={async () => {
                    try { const c = await post(`/contacts/groups/${g.id}/copy`); toast(`“${c.name}” made`); load(); setEditing(c); } catch (e) { toast(e.message, 'error'); }
                  }}><Icon name="copy" size={18} /></button>
                  <button className="icon-btn" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}><Icon name="edit" size={18} /></button>
                  {!filter && groups.length > 1 && <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label={`Move ${g.name}`} title="Put your groups in your own order" {...p}><Icon name="move" size={18} /></button>} items={[
                    ...(groups[0].id !== g.id ? [{ label: 'Move up', icon: 'move', onClick: () => orderGroup(g, -1) }] : []),
                    ...(groups[groups.length - 1].id !== g.id ? [{ label: 'Move down', icon: 'move', onClick: () => orderGroup(g, 1) }] : []),
                  ]} />}
                  <button className="icon-btn" aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)}><Icon name="trash" size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {merging && <MergeGroups count={pickedG.size} onClose={() => setMerging(false)}
        onMerge={async (name, remove) => {
          const r = await post('/contacts/groups/batch', { ids: [...pickedG], action: 'merge', name, remove });
          setPickedG(new Set()); load();
          toast(`Made “${r.group.name}” with ${r.group.members.length} ${r.group.members.length === 1 ? 'person' : 'people'}${r.removed ? `; ${nGroups(r.removed)} removed` : ''}`, 'info', r.bin_ids.length ? { action: { label: 'Undo removing', onClick: putBack(r.bin_ids) } } : undefined);
        }} />}
      {deletingMany && <ConfirmModal title={`Delete ${nGroups(pickedG.size)}?`} message="The people in them stay in your contacts." onClose={() => setDeletingMany(false)}
        onConfirm={async () => {
          const r = await post('/contacts/groups/batch', { ids: [...pickedG], action: 'delete' });
          setPickedG(new Set()); load();
          toast(`${nGroups(r.deleted)} deleted`, 'info', { action: { label: 'Undo', onClick: putBack(r.bin_ids) } });
        }} />}
      {editing && <GroupDialog group={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && <ConfirmModal title="Delete group?" message={`Delete the group “${deleting.name}”? The people in it stay in your contacts.`} onClose={() => setDeleting(null)}
        onConfirm={async () => {
          const g = deleting;
          const r = await del(`/contacts/groups/${g.id}`); load();
          if (r?.bin_id) toast(`Group “${g.name}” deleted`, 'info', { action: { label: 'Undo', onClick: async () => { await post(`/contacts/groups/bin/${r.bin_id}/restore`); load(); } } });
        }} />}
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
        <label className="field group-people-field"><span>People (type names or addresses; suggestions come from your contacts and colleagues)</span>
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
  const hit = (p) => !f || [p.name, p.job_title, p.department, p.username].some((v) => v && has(v, f));
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

function SendContact({ contacts, onClose }) {
  const contact = contacts[0];
  const many = contacts.length > 1;
  const toast = useToast();
  const navigate = useNavigate();
  const [convs, setConvs] = useState(null);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    get('/chat/channels').then((d) => {
      const open = latestFirst(d.channels || []); // the latest first; a direct message (with someone) chosen
      setConvs(open);
      setTo((open.find((c) => c.dm_key && c.dm_name) || open[0])?.id || '');
    }).catch((e) => setError(e.message));
  }, []);
  const name = conversationName;
  async function submit(e) {
    e.preventDefault();
    try {
      // Each as its own card (the message goes with the first), in order.
      for (const [k, c] of contacts.entries()) await post(`/chat/channels/${to}/contact`, c.colleague ? { user_id: c.id, body: k ? '' : note } : { contact_id: c.id, body: k ? '' : note });
      onClose();
      toast(`${many ? `${contacts.length} contacts` : contact.name} sent to ${name(convs.find((c) => c.id === to))}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/chat/${to}`) } });
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal title={many ? `Send ${contacts.length} contacts in Chat` : `Send ${contact.name} in Chat`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>{contact.colleague
          ? 'Everyone in the conversation sees their name, address, job title, department and work phone, and can add them to their own contacts.'
          : 'Everyone in the conversation sees the name, email addresses, phone numbers, company, job title, address and website, and can add them to their own contacts. Notes and dates stay with you.'}</p>
        <ConversationPick conversations={convs} value={to} onChange={setTo} disabled={!convs} />
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
