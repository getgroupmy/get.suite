// The Files panel at the top of a conversation: everything attached in it and the Workspace files
// linked in it (those you can open), newest first, with who shared each and a way back to the message.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, formatBytes } from '../../api.js';
import { useAuth } from '../../App.jsx';
import { useToast } from '../../components/ui.jsx';
import { saveItems } from './savefile.js';
import SaveToFolder from './SaveToFolder.jsx';
import { Menu } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

const OPEN = { doc: (id) => `/docs/${id}`, sheet: (id) => `/sheets/${id}`, slides: (id) => `/slides/${id}`, folder: (id) => `/drive/folder/${id}` };
const TYPES = [['', 'All'], ['pictures', 'Pictures'], ['documents', 'Documents'], ['pdf', 'PDFs'], ['media', 'Audio & video'], ['other', 'Other']];
/** The icon for a file in the panel: its kind for Workspace files, else by type (a picture, a PDF, sound or video). */
const iconOf = (f) => (f.kind !== 'file' ? f.kind : f.type === 'pictures' ? 'image' : f.type === 'pdf' ? 'pdf' : f.type === 'media' ? (/^video\//.test(f.mime || '') ? 'video' : 'audio') : 'file');
const KIND_NAME = { doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', folder: 'Folder' };

/** Where a file in the panel opens: a Workspace file in its app, an attachment from its message. */
export const fileHref = (f) => (f.how === 'attached' ? `/api/chat/messages/${f.message_id}/files/${f.id}?view` : (OPEN[f.kind]?.(f.id) || `/drive?preview=${f.id}`));

export default function ConvFiles({ channelId }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [type, setType] = useState('');
  const [list, setList] = useState(null);
  const [savingTo, setSavingTo] = useState(null);
  useEffect(() => { setOpen(false); setText(''); setType(''); }, [channelId]);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      get(`/chat/channels/${channelId}/files?${new URLSearchParams({ ...(text.trim() && { q: text.trim() }), ...(type && { type }) })}`)
        .then((r) => { if (alive) setList(r); }).catch(() => { if (alive) setList([]); });
    }, text ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [open, text, type, channelId]);
  const show = (f) => { setOpen(false); navigate(`/chat/${channelId}?msg=${f.message_id}${f.parent_id ? `&thread=${f.parent_id}` : ''}`); };
  return (
    <div className="pins-wrap">
      <button type="button" className={`btn small ${open ? 'primary' : ''}`} aria-expanded={open} aria-label="Files in this conversation" title="Files in this conversation" onClick={() => { setList(null); setOpen(!open); }}>📎</button>
      {open && (
        <div className="pins-panel conv-files" role="dialog" aria-label="Files in this conversation">
          <div className="row"><strong className="grow">Files</strong><button type="button" className="icon-btn" aria-label="Close files" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button></div>
          <input type="search" placeholder="Find a file by name" aria-label="Find a file by name" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="file-types" role="group" aria-label="Type of file">
            {TYPES.map(([v, label]) => <button key={v} type="button" className={`file-type ${type === v ? "on" : ""}`} aria-pressed={type === v} onClick={() => setType(v)}>{label}</button>)}
          </div>
          {list === null ? <p className="muted small">Loading…</p> : !list.length ? (
            <p className="muted small">{text.trim() ? 'No file by that name here.' : type ? `No ${type === 'pdf' ? 'PDFs' : TYPES.find(([v]) => v === type)[1].toLowerCase()} here.` : 'No files yet. Files attached here, and links to documents, sheets, presentations and folders, show up here.'}</p>
          ) : (
            <ul>
              {list.map((f) => (
                <li key={f.id}>
                  <Icon name={iconOf(f)} size={20} className={`ft ft-${iconOf(f)}`} />
                  <span className="grow conv-file">
                    <a href={fileHref(f)} target={f.how === 'attached' ? '_blank' : undefined} rel="noreferrer" onClick={(e) => { if (f.how !== 'attached') { e.preventDefault(); setOpen(false); navigate(fileHref(f)); } }}>{f.name}</a>
                    <span className="muted small">{f.how === 'attached' ? formatBytes(f.size) : (KIND_NAME[f.kind] || 'File')} · {f.user_name} · {new Date(f.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
                  </span>
                  {f.how === 'attached' && f.user_id !== user.id && <Menu align="right" trigger={(p) => <button type="button" className="link-btn small" aria-label={`Save ${f.name} to Drive`} {...p}>Save</button>} items={saveItems(toast, navigate, f.message_id, f, setSavingTo)} />}
                  <button type="button" className="link-btn small" aria-label={`Show ${f.name} in the conversation`} onClick={() => show(f)}>Show</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {savingTo && <SaveToFolder messageId={savingTo.messageId} file={savingTo.file} onClose={() => setSavingTo(null)} />}
    </div>
  );
}
