// The Custom number format window (Sheets): type a format code (as in Excel or Google Sheets) or pick a
// common one, and see what the selected cell will look like.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { formatCode, cleanCode, CODE_EXAMPLES, MAX_CODE } from './numfmt.js';
import { display } from './formula.js';

export function CustomFormatDialog({ initial, sample, onSave, onClose }) {
  const [code, setCode] = useState(initial || '#,##0.00');
  const value = sample === '' || sample === null || sample === undefined || typeof sample === 'object' ? 1234.5 : sample;
  const show = (c, v = value) => { const r = formatCode(v, c); return r ? r : { text: display(v), colour: null }; };
  // The examples use the cell's value when it suits them (a number, or a date for date codes), else a stand-in.
  const isDateCode = (c) => /[dmyhs]/i.test(c.replace(/"[^"]*"/g, '')) && !/[0#]/.test(c);
  const exampleFor = (c) => (isDateCode(c) ? (typeof value === 'number' && value >= 1 ? value : 46335.6041666667) : typeof value === 'number' && value !== 0 ? value : 1234.5);
  const now = show(code);
  return (
    <Modal title="Custom number format" onClose={onClose} wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!cleanCode(code)} onClick={() => onSave(cleanCode(code))}>Apply</button></>}>
      <div className="stack">
        <label className="field"><span>Format code</span>
          <input value={code} maxLength={MAX_CODE} onChange={(e) => setCode(e.target.value)} spellCheck={false} style={{ fontFamily: 'var(--mono, monospace)' }}
            onKeyDown={(e) => { if (e.key === 'Enter' && cleanCode(code)) onSave(cleanCode(code)); }} /></label>
        <div className="numfmt-preview" aria-live="polite"><span className="muted small">Looks like</span> <output aria-label="Preview" style={{ color: now.colour || undefined }}>{now.text || ' '}</output></div>
        <p className="muted small" style={{ margin: 0 }}>
          <code>0</code> a digit, <code>#</code> a digit if needed, <code>,</code> thousands, <code>%</code> percent, <code>"text"</code> words, <code>;</code> separates positive;negative;zero;text, <code>[Red]</code> a colour, <code>d m yyyy hh:mm</code> dates and times.
        </p>
        <ul className="numfmt-examples" aria-label="Examples">
          {CODE_EXAMPLES.map((c) => {
            const r = show(c, exampleFor(c));
            return (
              <li key={c}><button type="button" className={`numfmt-example ${c === code ? 'on' : ''}`} onClick={() => setCode(c)}>
                <code>{c}</code><span style={{ color: r.colour || undefined }}>{r.text}</span></button></li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
