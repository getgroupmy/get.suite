// A sketch pad (Notes, and Docs → Drawing): draw freehand with the mouse, a pen or a finger, or
// drag out lines, arrows, boxes and ellipses, in six colours and four sizes, with an eraser, Undo
// and Clear. Saved as a PNG picture.
import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui.jsx';
import { arrowHead } from './drawmath.js';

const INKS = [['#202124', 'Black'], ['#d93025', 'Red'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#f9ab00', 'Yellow'], ['#9334e6', 'Purple']];
const TOOLS = [['pen', '✎ Pen'], ['line', '╱ Line'], ['arrow', '→ Arrow'], ['box', '▭ Box'], ['ellipse', '◯ Ellipse']];

export default function DrawPad({ title = 'Drawing', saveLabel = 'Add', onSave, onClose }) {
  const canvas = useRef();
  const [ink, setInk] = useState(INKS[0][0]);
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState('pen');
  const [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const strokes = useRef([]); // snapshots for undo
  const [, rerender] = useState(0);
  useEffect(() => {
    const c = canvas.current, g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  }, []);
  const at = (e) => { const r = canvas.current.getBoundingClientRect(); return [(e.clientX - r.left) * (canvas.current.width / r.width), (e.clientY - r.top) * (canvas.current.height / r.height)]; };
  const shape = (g, kind, [x0, y0], [x1, y1]) => {
    g.beginPath();
    if (kind === 'line' || kind === 'arrow') {
      g.moveTo(x0, y0); g.lineTo(x1, y1);
      if (kind === 'arrow') { const [a, b] = arrowHead(x0, y0, x1, y1, Math.max(12, size * 3)); g.moveTo(x1, y1); g.lineTo(...a); g.moveTo(x1, y1); g.lineTo(...b); }
    } else if (kind === 'box') g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    g.stroke();
  };
  const down = (e) => {
    const c = canvas.current, g = c.getContext('2d');
    const before = g.getImageData(0, 0, c.width, c.height);
    strokes.current.push(before); if (strokes.current.length > 30) strokes.current.shift();
    rerender((n) => n + 1);
    c.setPointerCapture(e.pointerId);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = erase ? '#ffffff' : ink; g.lineWidth = erase ? size * 4 : size;
    const start = at(e);
    const kind = erase ? 'pen' : tool;
    if (kind === 'pen') { g.beginPath(); g.moveTo(...start); g.lineTo(start[0] + 0.01, start[1] + 0.01); g.stroke(); }
    // Shapes are drawn again from the picture before them as the pointer moves, so only the last one stays.
    const move = (m) => {
      if (kind === 'pen') { g.lineTo(...at(m)); g.stroke(); return; }
      g.putImageData(before, 0, 0);
      shape(g, kind, start, at(m));
    };
    const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); };
    c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  };
  const undo = () => { const last = strokes.current.pop(); if (last) { canvas.current.getContext('2d').putImageData(last, 0, 0); rerender((n) => n + 1); } };
  const clear = () => { const c = canvas.current, g = c.getContext('2d'); strokes.current.push(g.getImageData(0, 0, c.width, c.height)); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); rerender((n) => n + 1); };
  const save = () => { setBusy(true); canvas.current.toBlob(async (blob) => { try { await onSave(new File([blob], 'drawing.png', { type: 'image/png' })); onClose(); } catch { setBusy(false); } }, 'image/png'); };
  return (
    <Modal wide title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || !strokes.current.length} onClick={save}>{busy ? 'Saving…' : saveLabel}</button></>}>
      <div className="stack-tight">
        <div className="row wrap draw-tools" role="toolbar" aria-label="Drawing tools">
          <span role="radiogroup" aria-label="Tool" className="row" style={{ gap: 4 }}>
            {TOOLS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={!erase && tool === k} className={`btn small ${!erase && tool === k ? 'primary' : ''}`} onClick={() => { setTool(k); setErase(false); }}>{label}</button>)}
          </span>
          {INKS.map(([c, name]) => <button key={c} type="button" className={`swatch ${!erase && ink === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Ink ${name}`} aria-pressed={!erase && ink === c} onClick={() => { setInk(c); setErase(false); }} />)}
          <select aria-label="Pen size" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[[2, 'Fine'], [4, 'Medium'], [8, 'Thick'], [16, 'Marker']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
          <button type="button" className={`btn small ${erase ? 'primary' : ''}`} aria-pressed={erase} onClick={() => setErase(!erase)}>Eraser</button>
          <button type="button" className="btn small" disabled={!strokes.current.length} onClick={undo}>Undo</button>
          <button type="button" className="btn small" onClick={clear}>Clear</button>
        </div>
        <canvas ref={canvas} width={1000} height={600} className="draw-pad" aria-label="Drawing area" onPointerDown={down} />
      </div>
    </Modal>
  );
}
