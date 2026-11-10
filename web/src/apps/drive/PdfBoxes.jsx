// Where each signer signs a PDF: pick a signer and Signature or Date, then click on a page to put a box
// there (drag to move, × to remove). The boxes are filled in with their signature and the date they signed.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import PdfPages from './PdfPages.jsx';

const SIZE = { signature: [0.32, 0.06], date: [0.22, 0.03] };

export default function PdfBoxesDialog({ file, signers, fields: initial, onSave, onClose }) {
  const [fields, setFields] = useState(() => initial.map((f, i) => ({ ...f, key: `f${i}` })));
  const [who, setWho] = useState(signers[0]);
  const [type, setType] = useState('signature');
  const nameOf = (email) => email;
  const place = (page, fx, fy) => {
    const [w, h] = SIZE[type];
    setFields((l) => [...l, { key: Math.random().toString(36).slice(2), email: who, type, page, x: Math.min(Math.max(fx - w / 2, 0), 1 - w), y: Math.min(Math.max(fy - h / 2, 0), 1 - h), w, h }]);
  };
  const colour = (email) => `pdf-box-c${signers.indexOf(email) % 5}`;
  return (
    <Modal title="Where they sign" wide onClose={onClose}
      footer={<><span className="muted small grow">{fields.length ? `${fields.length} box${fields.length === 1 ? '' : 'es'}` : 'Optional: without boxes, signatures go on a page at the end'}</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => onSave(fields.map(({ key, ...f }) => f))}>Done</button></>}>
      <div className="stack">
        <div className="row wrap" role="toolbar" aria-label="Box to add">
          <label className="field"><span>For</span><select aria-label="For" value={who} onChange={(e) => setWho(e.target.value)}>{signers.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label className="field"><span>Box</span><select aria-label="Box" value={type} onChange={(e) => setType(e.target.value)}><option value="signature">Signature</option><option value="date">Date signed</option></select></label>
          <span className="muted small" style={{ alignSelf: 'end' }}>Click on a page to put it there</span>
        </div>
        <div className="pdf-boxes-pages">
          <PdfPages url={`/api/files/${file.id}/raw`} width={640} onPageClick={place}
            boxes={fields.map((f) => ({ ...f, label: `${f.type === 'date' ? 'Date' : 'Signature'}: ${nameOf(f.email)}`, className: colour(f.email) }))}
            onBoxRemove={(key) => setFields((l) => l.filter((f) => f.key !== key))}
            onBoxMove={(key, x, y) => setFields((l) => l.map((f) => (f.key === key ? { ...f, x, y } : f)))} />
        </div>
      </div>
    </Modal>
  );
}
