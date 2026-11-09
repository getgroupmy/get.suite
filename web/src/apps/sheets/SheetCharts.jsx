// Charts placed on a sheet: a card you can drag by its title and resize from its corner, and the
// dialog to make or change one (with a live preview).
import { useEffect, useRef, useState } from 'react';
import ChartView from './Chart.jsx';
import { CHART_TYPES, chartData, parseRange } from './charts.js';
import { Modal, Menu } from '../../components/ui.jsx';

export const MIN_W = 240, MIN_H = 180;

/** One chart on the sheet. `onChange(next)` is called once a move or resize ends. */
export function ChartCard({ chart, value, canEdit, onChange, onEdit, onDelete }) {
  const [live, setLive] = useState(null); // position/size while dragging
  const drag = useRef(null);
  const box = { x: chart.x, y: chart.y, w: chart.w, h: chart.h, ...live };
  const data = chartData(chart.range, value);

  const start = (mode) => (e) => {
    if (!canEdit || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, from: { x: chart.x, y: chart.y, w: chart.w, h: chart.h } };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    setLive(d.mode === 'move'
      ? { x: Math.max(0, d.from.x + dx), y: Math.max(0, d.from.y + dy) }
      : { w: Math.max(MIN_W, d.from.w + dx), h: Math.max(MIN_H, d.from.h + dy) });
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live) onChange({ ...chart, ...live });
    setLive(null);
  };
  // Escape while dragging puts it back.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && drag.current) { drag.current = null; setLive(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className={`chart-card ${live ? 'dragging' : ''}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-label={`Chart: ${chart.title || 'Untitled'}`}
      onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); if (canEdit) onEdit(); }}>
      <header className={`chart-head ${canEdit ? 'movable' : ''}`} onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <h3 title={chart.title}>{chart.title || <span className="muted">Untitled chart</span>}</h3>
        {canEdit && (
          <Menu trigger={(p) => <button type="button" className="icon-btn chart-menu" aria-label={`Options for chart ${chart.title || ''}`.trim()} {...p}>⋮</button>} items={[
            { label: 'Edit chart', icon: 'edit', onClick: onEdit },
            { label: 'Delete chart', icon: 'trash', danger: true, onClick: onDelete },
          ]} />
        )}
      </header>
      {data.note && <p className="muted small chart-note">{data.note}</p>}
      <ChartView type={chart.type} data={data} width={box.w - 20} height={box.h - 44 - (data.note ? 18 : 0)} />
      {canEdit && <span className="chart-resize" aria-hidden="true" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />}
    </section>
  );
}

/** Make or change a chart: its kind, the cells it shows and a title. */
export function ChartDialog({ initial, value, onSave, onClose }) {
  const [type, setType] = useState(initial.type);
  const [range, setRange] = useState(initial.range);
  const [title, setTitle] = useState(initial.title || '');
  const ok = !!parseRange(range);
  const data = chartData(range, value);
  const save = (e) => { e?.preventDefault(); if (ok && !data.error) { onSave({ ...initial, type, range: range.toUpperCase().replace(/\s/g, ''), title: title.trim().slice(0, 120) }); onClose(); } };
  return (
    <Modal title={initial.id ? 'Edit chart' : 'Insert chart'} onClose={onClose} wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!ok || !!data.error} onClick={save}>{initial.id ? 'Save' : 'Insert'}</button></>}>
      <form className="chart-form" onSubmit={save}>
        <div className="stack">
          <fieldset className="chart-types">
            <legend className="sr-only">Chart type</legend>
            {CHART_TYPES.map(([v, label]) => (
              <label key={v} className={type === v ? 'on' : ''}><input type="radio" name="chart-type" value={v} checked={type === v} onChange={() => setType(v)} />{label}</label>
            ))}
          </fieldset>
          <label className="field"><span>Cells</span><input value={range} onChange={(e) => setRange(e.target.value)} placeholder="A1:C10" aria-invalid={!ok} /></label>
          <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Optional" /></label>
          <p className="muted small">The first row and column are used as names when they hold text.{(type === 'pie' || type === 'doughnut') && ` A ${type} shows the first series.`}{type === 'scatter' && ' For a scatter, the first column of numbers is across (X) when the rows have no names, and the others go up (Y).'}</p>
          <button type="submit" hidden />
        </div>
        <div className="chart-preview" aria-label="Preview">
          {title && <h3>{title}</h3>}
          {ok ? <ChartView type={type} data={data} width={400} height={title ? 236 : 260} /> : <div className="chart-empty muted small">Choose cells like A1:C10</div>}
        </div>
      </form>
    </Modal>
  );
}
