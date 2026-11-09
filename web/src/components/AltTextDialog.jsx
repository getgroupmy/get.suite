// Alt text for a picture (Docs and Slides): a short description that screen readers read out in
// its place, and that Word and PowerPoint files carry as the picture's Alt Text.
import { useState } from 'react';
import { Modal } from './ui.jsx';

export const MAX_ALT = 500;

export default function AltTextDialog({ value, onSave, onClose }) {
  const [text, setText] = useState(value || '');
  const save = () => onSave(text.replace(/\s+/g, ' ').trim().slice(0, MAX_ALT));
  return (
    <Modal title="Alt text" onClose={onClose}
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Describe the picture for people who can't see it: what it shows and why it's there (“Bar chart: sales doubled from 2025 to 2026”). Screen readers read this out instead of the picture.</p>
        <label className="field"><span>Description</span>
          <textarea rows={3} value={text} maxLength={MAX_ALT} autoFocus onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } }} /></label>
        <span className="muted small" aria-live="polite">{text.length} / {MAX_ALT}</span>
      </div>
    </Modal>
  );
}
