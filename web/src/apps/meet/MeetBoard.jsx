// The meeting's whiteboard: everyone in the room draws on the same board (pen, lines, arrows, boxes,
// ellipses, an eraser), sees the others' strokes as they finish them, can take back their own last
// stroke, clear the board, and (people with an account) save it to Drive as a picture.
import { useEffect, useRef, useState } from 'react';
import { drawStroke } from '../../components/drawmath.js';
import { uploadFile } from '../../api.js';
import { useToast } from '../../components/ui.jsx';

const W = 1000, H = 600; // board units (the server's too)
const INKS = [['#202124', 'Black'], ['#d93025', 'Red'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#f9ab00', 'Yellow'], ['#9334e6', 'Purple']];
const TOOLS = [['pen', '✎ Pen'], ['line', '╱ Line'], ['arrow', '→ Arrow'], ['box', '▭ Box'], ['ellipse', '◯ Ellipse'], ['erase', 'Eraser']];
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default function MeetBoard({ m, title, canSave, onClose }) {
  const toast = useToast();
  const canvas = useRef();
  const [tool, setTool] = useState('pen');
  const [ink, setInk] = useState(INKS[0][0]);
  const [size, setSize] = useState(4);
  const [busy, setBusy] = useState(false);
  const drawing = useRef(null); // the stroke being drawn here, shown until the board has it

  const paint = () => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    for (const s of m.board) drawStroke(g, s, c.width / W);
    if (drawing.current) drawStroke(g, drawing.current, c.width / W);
  };
  useEffect(() => { paint(); });

  const at = (e) => { const r = canvas.current.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * W * 10) / 10, Math.round(((e.clientY - r.top) / r.height) * H * 10) / 10]; };
  const down = (e) => {
    const c = canvas.current;
    c.setPointerCapture(e.pointerId);
    const s = { id: newId(), kind: tool, color: ink, size, points: [at(e)] };
    drawing.current = s;
    paint();
    const move = (ev) => {
      const p = at(ev);
      if (s.kind === 'pen' || s.kind === 'erase') { if (s.points.length < 600) s.points.push(p); } else s.points = [s.points[0], p];
      paint();
    };
    const up = () => {
      c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up);
      m.boardStroke(s);
      // Kept on screen until the board sends it back (a moment later).
      setTimeout(() => { if (drawing.current === s) { drawing.current = null; paint(); } }, 1500);
    };
    c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  };
  // The stroke came back from the board: stop drawing our own copy.
  useEffect(() => { if (drawing.current && m.board.some((x) => x.id === drawing.current.id)) drawing.current = null; });

  const save = () => {
    setBusy(true);
    canvas.current.toBlob(async (blob) => {
      try {
        const name = `Whiteboard – ${title} – ${new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.png`.replace(/[\\/:*?"<>|]+/g, ' ');
        await uploadFile(new File([blob], name, { type: 'image/png' }), null);
        toast(`Saved to your Drive as “${name}”`);
      } catch (err) { toast(err.message, 'error'); }
      setBusy(false);
    }, 'image/png');
  };

  return (
    <section className="meet-board" aria-label="Whiteboard">
      <div className="row wrap draw-tools" role="toolbar" aria-label="Whiteboard tools">
        <span role="radiogroup" aria-label="Tool" className="row wrap" style={{ gap: 4 }}>
          {TOOLS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={tool === k} className={`btn small ${tool === k ? 'primary' : ''}`} onClick={() => setTool(k)}>{label}</button>)}
        </span>
        {INKS.map(([c, name]) => <button key={c} type="button" className={`swatch ${ink === c && tool !== 'erase' ? 'on' : ''}`} style={{ background: c }} aria-label={`Ink ${name}`} aria-pressed={ink === c && tool !== 'erase'} onClick={() => { setInk(c); if (tool === 'erase') setTool('pen'); }} />)}
        <select aria-label="Pen size" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[[2, 'Fine'], [4, 'Medium'], [8, 'Thick'], [16, 'Marker']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
        <button type="button" className="btn small" onClick={() => m.boardUndo()} title="Take back your last stroke">Undo</button>
        <button type="button" className="btn small" disabled={!m.board.length} onClick={() => m.boardClear()} title="Clear the board for everyone">Clear</button>
        <span className="grow" />
        {canSave && <button type="button" className="btn small" disabled={busy || !m.board.length} onClick={save}>{busy ? 'Saving…' : 'Save to Drive'}</button>}
        <button type="button" className="btn small" onClick={onClose}>Close board</button>
      </div>
      <canvas ref={canvas} width={W} height={H} className="draw-pad" aria-label="Whiteboard drawing area" onPointerDown={down} />
    </section>
  );
}
