// A slicer on the sheet: a chip naming a column of a table and what it shows ("All", "North", "2 of 4").
// Clicking it ticks the values to show, as the filter's menu does; dragging moves it.
import { useRef, useState } from 'react';
import { FilterMenu } from './SheetFilter.jsx';
import { Menu } from '../../components/ui.jsx';
import { slicerSummary } from './filter.js';

export function SlicerCard({ slicer, heading, values, headings, canEdit, onChange, onDelete, zoom = 1 }) {
  const [menu, setMenu] = useState(null);
  const [live, setLive] = useState(null);
  const drag = useRef(null);
  const at = { x: slicer.x, y: slicer.y, ...live };
  const summary = slicerSummary(slicer, values);
  const filtered = summary !== 'All';
  const down = (e) => {
    if (e.button !== 0 || e.target.closest('.slicer-more')) return;
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, moved: false, target: e.currentTarget };
    if (canEdit) e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || !canEdit) return;
    const dx = (e.clientX - d.sx) / zoom, dy = (e.clientY - d.sy) / zoom;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setLive({ x: Math.max(0, slicer.x + dx), y: Math.max(0, slicer.y + dy) });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved && live) onChange({ ...slicer, ...live });
    else if (canEdit) setMenu(d.target);
    setLive(null);
  };
  return (
    <div className={`slicer ${filtered ? 'on' : ''} ${live ? 'dragging' : ''}`} style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="slicer-chip" aria-label={`Slicer: ${heading}, showing ${summary}`} aria-haspopup="dialog"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setLive(null); }}
        onKeyDown={(e) => { if (canEdit && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMenu(e.currentTarget); } }}
        title={canEdit ? 'Click to choose what to show; drag to move' : `Showing ${summary}`}>
        <span className="slicer-name">{heading}</span>
        <span className="slicer-value">{summary}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {canEdit && (
        <Menu trigger={(p) => <button type="button" className="icon-btn slicer-more" aria-label={`Options for slicer ${heading}`} {...p}>⋮</button>} items={[
          ...headings.filter((h) => h.col !== slicer.col).map((h) => ({ label: `Filter by ${h.name || `column ${h.col}`}`, onClick: () => onChange({ ...slicer, col: h.col, hidden: [] }) })),
          ...(filtered ? [{ label: 'Show all', icon: 'check', onClick: () => onChange({ ...slicer, hidden: [] }) }] : []),
          { label: 'Delete slicer', icon: 'trash', danger: true, onClick: onDelete },
        ]} />
      )}
      {menu && (
        <FilterMenu anchor={menu} column={slicer.col} label={`Slicer: ${heading}`} values={values} hidden={slicer.hidden || []}
          onApply={(hidden) => { onChange({ ...slicer, hidden }); setMenu(null); }} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
