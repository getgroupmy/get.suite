// A file looked at in Workspace instead of downloaded: pictures, PDF, text, audio and video as
// they are, Word, Excel and PowerPoint as Docs, Sheets and Slides would show them, and a zip's
// contents, with ← → (or the arrow keys) to the others that can be shown. Used for email
// attachments and files in Chat. `urls` gives each item's view, download, office and zip address.
import { useEffect } from 'react';
import { formatBytes } from '../api.js';
import { Modal } from './ui.jsx';
import Icon from './Icon.jsx';
import OfficePreview from '../apps/OfficePreview.jsx';
import ZipContents from '../apps/ZipContents.jsx';
import { previewKind } from './viewkind.js';

export default function FileViewer({ items, at, urls, onStep, onSave = null, onClose }) {
  const a = items[at];
  const kind = previewKind(a.filename);
  const shown = items.filter((x) => previewKind(x.filename));
  const many = shown.length > 1;
  useEffect(() => {
    const key = (e) => {
      if (!many || e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onStep(e.key === 'ArrowRight' ? 1 : -1); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const src = urls.view(a);
  const body = kind === 'zip' ? <ZipContents url={urls.zip(a)} />
    : kind === 'office' ? <OfficePreview url={urls.office(a)} />
    : kind === 'picture' ? <img src={src} alt={a.filename} className="preview-media" />
    : kind === 'video' ? <video src={src} controls className="preview-media" />
    : kind === 'audio' ? <audio src={src} controls />
    : <iframe src={src} title={a.filename} className="preview-frame" />;
  return (
    <Modal wide title={a.filename} onClose={onClose} footer={<>
      {many && <><button type="button" className="btn" aria-label="Previous file" onClick={() => onStep(-1)}>←</button>
        <span className="muted small">{shown.indexOf(a) + 1} of {shown.length}</span>
        <button type="button" className="btn" aria-label="Next file" onClick={() => onStep(1)}>→</button></>}
      <span className="grow" />
      {onSave && <button type="button" className="btn" onClick={() => onSave(a)}><Icon name="folder" size={18} /> Save to Drive</button>}
      <a className="btn primary" href={urls.download(a)}><Icon name="download" size={18} /> Download</a>
    </>}>
      <div className="preview" key={a.key}>{body}</div>
      <p className="muted small">{formatBytes(a.size)}</p>
    </Modal>
  );
}
