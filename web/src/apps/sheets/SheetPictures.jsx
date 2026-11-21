// Pictures floating over a sheet's cells (from an Excel file, or put in here): drag one to move it,
// its corner to resize it (Shift keeps its shape free; otherwise it keeps its proportions), Delete to take it away;
// its alt text (what a screen reader says, and what Excel and LibreOffice files keep) from its menu.
import { useEffect, useRef, useState } from 'react';
import { Menu } from '../../components/ui.jsx';

const MIN = 16;

/** One picture on the sheet. `onChange(next)` is called once a move or resize ends; `onDelete()` takes it away. */
export function PictureCard({ fileId, picture, canEdit, onChange, onDelete, onAlt, zoom = 1 }) {
  const [live, setLive] = useState(null);
  const drag = useRef(null);
  const box = { x: picture.x, y: picture.y, w: picture.w, h: picture.h, ...live };
  const alt = picture.alt || 'Picture';

  const start = (mode) => (e) => {
    if (!canEdit || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, from: { x: picture.x, y: picture.y, w: picture.w, h: picture.h } };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / zoom, dy = (e.clientY - d.sy) / zoom;
    if (d.mode === 'move') { setLive({ x: Math.round(Math.max(0, d.from.x + dx)), y: Math.round(Math.max(0, d.from.y + dy)) }); return; }
    const w = Math.max(MIN, d.from.w + dx);
    setLive({ w: Math.round(w), h: Math.round(e.shiftKey ? Math.max(MIN, d.from.h + dy) : Math.max(MIN, (w * d.from.h) / d.from.w)) });
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live) onChange({ ...picture, ...live });
    setLive(null);
  };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && drag.current) { drag.current = null; setLive(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <figure className={`sheet-picture ${live ? 'dragging' : ''} ${canEdit ? 'movable' : ''}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      tabIndex={0} aria-label={`Picture: ${alt}`}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (canEdit && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); onDelete(); } }}
      onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <img src={`/api/files/${encodeURIComponent(fileId)}/pictures/${encodeURIComponent(picture.file)}`} alt={alt} draggable={false} />
      {canEdit && <Menu trigger={(p) => <button type="button" className="icon-btn picture-menu" aria-label={`Options for picture ${alt}`} {...p}>⋮</button>} items={[
        onAlt && { label: 'Alt text…', onClick: onAlt },
        { label: 'Delete picture', icon: 'trash', danger: true, onClick: onDelete },
      ].filter(Boolean)} />}
      {canEdit && <span className="chart-resize" aria-hidden="true" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />}
    </figure>
  );
}
