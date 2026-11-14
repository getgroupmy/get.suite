// Mail → Attachments: the files people sent you in a folder, newest first, by kind or by words,
// each opened, downloaded or saved to Drive on its own, or its email opened.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, formatBytes, mailboxParam } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { previewKind } from '../../components/viewkind.js';

const KINDS = [['', 'All files'], ['pdf', 'PDFs'], ['image', 'Pictures'], ['document', 'Documents'], ['spreadsheet', 'Spreadsheets'], ['presentation', 'Presentations'], ['archive', 'Archives'], ['other', 'Other']];
const ICON = { pdf: '📕', image: '🖼', document: '📄', spreadsheet: '📊', presentation: '📽', archive: '🗜', other: '📎' };
const enc = encodeURIComponent;

export function AttachmentsDialog({ folders, folder: start, onClose, onOpen }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [folder, setFolder] = useState(start || 'INBOX');
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [words, setWords] = useState('');
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => { const t = setTimeout(() => setWords(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const url = (before) => `/mail/attachments?folder=${enc(folder)}${kind ? `&kind=${kind}` : ''}${words ? `&q=${enc(words)}` : ''}${before ? `&before=${before}` : ''}`;
  useEffect(() => {
    const mine = ++seq.current; // the latest filters win
    setItems(null);
    get(url()).then((r) => { if (mine === seq.current) { setItems(r.items); setNext(r.next); } }).catch((e) => mine === seq.current && (toast(e.message, 'error'), setItems([])));
  }, [folder, kind, words]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = async () => {
    const mine = seq.current;
    setBusy(true);
    try { const r = await get(url(next)); if (mine === seq.current) { setItems((xs) => [...xs, ...r.items]); setNext(r.next); } }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const fileUrl = (a, view) => `/api/mail/messages/${a.uid}/parts/${a.part}?folder=${enc(folder)}${view ? '&view' : ''}${mailboxParam()}`;
  const save = async (a) => {
    try {
      const r = await post(`/mail/messages/${a.uid}/parts/${a.part}/save`, { folder });
      toast(`Saved ${r.file.name} to Drive`, 'info', { action: { label: 'Show', onClick: () => navigate(`/drive/folder/${r.folder_id}`) } });
    } catch (e) { toast(e.message, 'error'); }
  };
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '');
  return (
    <Modal wide title="Attachments" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <select aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
          {(folders?.length ? folders : [{ path: folder, name: folder }]).filter((f) => f.specialUse !== '\\Drafts').map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
        </select>
        <select aria-label="Kind of file" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="search" aria-label="Search attachments" placeholder="File name, sender or subject" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
      </div>
      {items === null ? <p className="muted" role="status">Looking through {folders?.find((f) => f.path === folder)?.name || folder}…</p>
        : !items.length ? <p className="muted" role="status">{kind || words ? 'No attachments match.' : 'No attachments in this folder.'}{next ? ' (Only the latest messages were looked through: Look further.)' : ''}</p> : (
        <ul className="rule-list attach-list" aria-label="Attachments">
          {items.map((a) => (
            <li key={`${a.uid}-${a.part}`}>
              <span aria-hidden="true" className="attach-kind">{ICON[a.kind] || '📎'}</span>
              <span className="grow" style={{ minWidth: 0 }}>
                <strong className="ellipsis" style={{ display: 'block' }}>{a.filename}</strong>
                <span className="muted small">{formatBytes(a.size)} · {a.from?.name || a.from?.address || 'Unknown sender'} · {day(a.date)} · {a.subject || '(No subject)'}</span>
              </span>
              {(a.kind === 'pdf' || a.kind === 'image') && previewKind(a.filename) && <a className="btn small" href={fileUrl(a, true)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.filename}`}>Open</a>}
              <a className="btn small" href={fileUrl(a)} download={a.filename} aria-label={`Download ${a.filename}`}>Download</a>
              <button type="button" className="btn small" aria-label={`Save ${a.filename} to Drive`} onClick={() => save(a)}>Save to Drive</button>
              <button type="button" className="btn small" aria-label={`Go to the email with ${a.filename}`} onClick={() => onOpen(folder, a.uid)}>Email</button>
            </li>
          ))}
        </ul>
      )}
      {items !== null && next && <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}><button type="button" className="btn" disabled={busy} onClick={more}>{busy ? 'Looking…' : 'Look further'}</button></div>}
    </Modal>
  );
}
