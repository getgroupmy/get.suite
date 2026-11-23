import { useEffect, useState } from 'react';
import { get, formatBytes } from '../api.js';
import Icon from './Icon.jsx';
import { Modal } from './ui.jsx';

const KIND_ICON = { doc: 'doc', sheet: 'sheet', slides: 'slides' };
const KIND_NAME = { doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation' };

/** Where to open a Drive item: Docs, Sheets and Slides in their app; other files as they are (a new tab). */
export const openUrl = (f) => (f.kind === 'folder' ? `/drive/folder/${f.id}` : KIND_ICON[f.kind] ? `/${f.kind === 'doc' ? 'docs' : f.kind === 'sheet' ? 'sheets' : 'slides'}/${f.id}` : `/api/files/${f.id}/raw`);

/** Pick a file from Drive: recent ones, or search, each saying which folder it's in. `accept` says which items can be picked. */
export default function DrivePicker({ title = 'Attach from Drive', accept = (x) => x.kind === 'file', empty = 'No files found.', onClose, onPick }) {
  const [items, setItems] = useState(null);
  const [term, setTerm] = useState('');
  useEffect(() => {
    const url = term ? `/files?view=search&q=${encodeURIComponent(term)}` : '/files?view=recent';
    let live = true; // typed on meanwhile: this answer is for an older search, and is dropped
    const t = setTimeout(() => get(url).then((l) => { if (live) setItems(l.filter(accept)); }).catch(() => { if (live) setItems([]); }), term ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [term]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={title} onClose={onClose}>
      <input className="filter" style={{ width: '100%' }} placeholder="Search your files" aria-label="Search your files" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
      <ul className="pick-list">
        {items === null && <li className="muted">Loading…</li>}
        {items?.length === 0 && <li className="muted">{empty}</li>}
        {items?.map((x) => <li key={x.id}><button type="button" onClick={() => onPick(x)}><Icon name={KIND_ICON[x.kind] || 'file'} />
          {/* which folder it's in, so two "Budget"s are told apart */}
          <span className="grow">{x.name}{x.parent_name && <span className="muted small"> · in {x.parent_name}</span>}</span>
          <span className="muted small">{x.kind === 'file' ? formatBytes(x.size) : KIND_NAME[x.kind]}</span></button></li>)}
      </ul>
    </Modal>
  );
}
