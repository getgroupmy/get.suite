import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { cleanupSuggestions, looksLikeHeader } from './cleanup.js';
import { rangeText } from './charts.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Cleanup suggestions for a table: each with what it found and a Fix button (or Fix all). */
export function CleanupDialog({ sheet, range, value, readOnly, onFix, onClose }) {
  const [header, setHeader] = useState(() => looksLikeHeader(sheet, range));
  const list = cleanupSuggestions(sheet, range, value, { header });
  const fixAll = () => { for (const s of [...list].sort((a, b) => (a.kind === 'duplicates') - (b.kind === 'duplicates'))) onFix(s, header); }; // duplicates last: tidy first, so more rows match
  return (
    <Modal title="Cleanup suggestions" onClose={onClose}
      footer={<>{list.length > 1 && !readOnly && <button type="button" className="btn primary" onClick={fixAll}>Fix all</button>}<button type="button" className="btn" onClick={onClose}>Close</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>Looking at {rangeText(range)}. Only text is changed: numbers, dates and formulas are left as they are.</p>
      <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> The first row has headings (left alone)</label>
      {!list.length && <p className="cleanup-none">✓ Nothing to tidy here.</p>}
      <ul className="cleanup-list">
        {list.map((s) => (
          <li key={s.kind + (s.col || '')}>
            <div className="grow">
              {s.kind === 'spaces' && <><strong>Extra spaces</strong><div className="muted small">{plural(s.count, 'cell')} with spaces at the ends or doubled inside</div></>}
              {s.kind === 'spelling' && <><strong>Column {s.col}: the same value written differently</strong>
                <div className="muted small">{s.groups.slice(0, 4).map((g) => `${g.forms.map((f) => `“${f}”`).join(', ')} → “${g.to}”`).join('; ')}{s.groups.length > 4 ? ` and ${s.groups.length - 4} more` : ''}</div></>}
              {s.kind === 'duplicates' && <><strong>Duplicate rows</strong><div className="muted small">{plural(s.count, 'row')} the same as one above</div></>}
            </div>
            {!readOnly && <button type="button" className="btn small" aria-label={s.kind === 'spelling' ? `Fix column ${s.col}` : s.kind === 'spaces' ? 'Fix extra spaces' : 'Remove duplicate rows'} onClick={() => onFix(s, header)}>
              {s.kind === 'duplicates' ? 'Remove' : 'Fix'}</button>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
