// Signatures drawn or typed: the box to draw one in (Docs' signing page, signing a PDF, a form's
// signature question), a typed name as a picture, and a drawing trimmed to its ink.
import { useEffect, useRef, useState } from 'react';

export const INK = '#1a237e';
export const SCRIPT_FONT = "'Brush Script MT', 'Segoe Script', 'Lucida Handwriting', cursive";

/** Text as a PNG picture (twice the size shown, so it prints sharply): { png, w, h } in shown pixels. */
export function textPicture(text, { size = 14, font = 'Helvetica, Arial, sans-serif', color = INK } = {}) {
  const k = 3, c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = `${size * k}px ${font}`;
  const w = Math.ceil(g.measureText(text).width) + 4 * k, h = Math.ceil(size * 1.35 * k);
  c.width = w; c.height = h;
  g.font = `${size * k}px ${font}`; g.fillStyle = color; g.textBaseline = 'middle';
  g.fillText(text, 2 * k, h / 2);
  return { png: c.toDataURL('image/png'), w: w / k, h: h / k };
}
/** A drawn signature's picture trimmed to its ink: { png, w, h } (shown pixels at 160 wide). */
export function trimmed(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      if (x1 <= x0) return resolve(null);
      const out = document.createElement('canvas'); out.width = x1 - x0 + 8; out.height = y1 - y0 + 8;
      out.getContext('2d').drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
      const w = 160, h = (out.height / out.width) * 160;
      resolve({ png: out.toDataURL('image/png'), w, h });
    };
    img.src = dataUrl;
  });
}

/** A box to draw a signature in (mouse, pen or finger). `onChange(dataUrl | null)`. */
export function SignaturePad({ onChange }) {
  const ref = useRef();
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current, ctx = c.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a237e';
  }, []);
  const at = (e) => { const r = ref.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => { e.preventDefault(); ref.current.setPointerCapture(e.pointerId); drawing.current = true; const ctx = ref.current.getContext('2d'); ctx.beginPath(); ctx.moveTo(...at(e)); };
  const move = (e) => { if (!drawing.current) return; const ctx = ref.current.getContext('2d'); ctx.lineTo(...at(e)); ctx.stroke(); setEmpty(false); };
  const up = () => { if (!drawing.current) return; drawing.current = false; onChange(ref.current.toDataURL('image/png')); };
  const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); setEmpty(true); onChange(null); };
  return (
    <div className="sign-pad-wrap">
      <canvas ref={ref} className="sign-pad" aria-label="Draw your signature" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {!empty && <button type="button" className="link-btn small" onClick={clear}>Clear</button>}
    </div>
  );
}
