// The Alternating colours window: stripe a range, with a heading and footer row, in a ready-made or
// custom set of colours (the rules are in bands.js).
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { BAND_STYLES, cleanBand, overlaps, textOn } from './bands.js';
import { parseRange } from './charts.js';

export function BandsDialog({ bands, defaultRange, onSave, onClose }) {
  const existing = (bands || []).find((b) => overlaps(b.range, defaultRange));
  const [band, setBand] = useState(() => existing || cleanBand({ range: defaultRange, ...BAND_STYLES[0], header: true }));
  const set = (patch) => setBand((b) => ({ ...b, ...patch }));
  const valid = !!parseRange(band.range);
  const clash = valid && (bands || []).some((b) => b.id !== band.id && overlaps(b.range, band.range));
  const others = (bands || []).filter((b) => b.id !== band.id);
  const save = () => { const b = cleanBand(band); if (b) onSave([...others, b]); };
  const rows = [band.header && ['head', 'Heading'], ['odd', 'Colour 1'], ['even', 'Colour 2'], band.footer && ['foot', 'Footer']].filter(Boolean);
  return (
    <Modal title="Alternating colours" onClose={onClose}
      footer={<>
        {existing && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => onSave(others)}>Remove alternating colours</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!valid || clash} onClick={save}>Done</button>
      </>}>
      <div className="stack">
        <label className="field">Apply to range
          <input value={band.range} onChange={(e) => set({ range: e.target.value.toUpperCase() })} placeholder="A1:D20" aria-invalid={!valid || clash} />
        </label>
        {!valid && <p className="error small" style={{ margin: 0 }}>Type a range such as A1:D20.</p>}
        {clash && <p className="error small" style={{ margin: 0 }}>That range overlaps other alternating colours.</p>}
        <div className="row" style={{ gap: 16 }}>
          <label className="check"><input type="checkbox" checked={band.header} onChange={(e) => set({ header: e.target.checked })} /> Heading row</label>
          <label className="check"><input type="checkbox" checked={band.footer} onChange={(e) => set({ footer: e.target.checked })} /> Footer row</label>
        </div>
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Styles</div>
          <div className="band-styles" role="radiogroup" aria-label="Styles">
            {BAND_STYLES.map((s) => {
              const on = s.head === band.head && s.even === band.even && s.odd === band.odd;
              return (
                <button key={s.name} type="button" role="radio" aria-checked={on} aria-label={s.name} title={s.name} className={`band-style ${on ? 'on' : ''}`}
                  onClick={() => set({ head: s.head, odd: s.odd, even: s.even, foot: s.foot })}>
                  {band.header && <span style={{ background: s.head }} />}<span style={{ background: s.odd }} /><span style={{ background: s.even }} /><span style={{ background: s.odd }} />
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Custom colours</div>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {rows.map(([k, label]) => (
              <label key={k} className="row small band-colour" style={{ gap: 6 }}>
                <input type="color" value={band[k]} onChange={(e) => set({ [k]: e.target.value })} aria-label={`${label} colour`} /> {label}
              </label>
            ))}
          </div>
        </div>
        <div className="band-preview" aria-hidden="true">
          {[...rows.filter(([k]) => k === 'head'), ['odd'], ['even'], ['odd'], ...rows.filter(([k]) => k === 'foot')].map(([k], i) => (
            <div key={i} style={{ background: band[k], color: textOn(band[k]), fontWeight: k === 'head' ? 700 : 400 }}>{k === 'head' ? 'Heading' : k === 'foot' ? 'Total' : 'Row'}</div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
