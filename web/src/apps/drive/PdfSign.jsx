// Fill & sign a PDF: its pages shown here (pdf.js, loaded only when this opens); click a tool, then a
// spot on a page, to put your signature (drawn or typed), today's date, some text or a tick there; drag
// them into place. Saving makes a signed copy beside the PDF (the server stamps each one as a picture).
import { useEffect, useRef, useState } from 'react';
import { post } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { SignaturePad } from '../docs/Signatures.jsx';

const PAGE_PX = 640; // how wide each page shows
const INK = '#1a237e';

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
function trimmed(dataUrl) {
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

export default function PdfSignDialog({ file, onClose, onDone }) {
  const toast = useToast();
  const [pages, setPages] = useState(null); // [{ w, h }] shown size
  const [error, setError] = useState(null);
  const canvases = useRef([]);
  const [items, setItems] = useState([]); // { id, page, x, y, w, h (fractions), png, label }
  const [tool, setTool] = useState(null); // { png, w, h (shown px), label } waiting to be placed
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);

  useEffect(() => {
    let gone = false, doc = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        doc = await pdfjs.getDocument({ url: `/api/files/${file.id}/raw`, withCredentials: true }).promise;
        const sizes = [];
        for (let i = 1; i <= Math.min(doc.numPages, 200); i++) {
          const p = await doc.getPage(i);
          const v = p.getViewport({ scale: 1 });
          sizes.push({ w: PAGE_PX, h: (v.height / v.width) * PAGE_PX, page: p });
        }
        if (gone) return;
        setPages(sizes);
      } catch (e) { if (!gone) setError(/password/i.test(e?.message) ? 'This PDF is password-protected' : 'This PDF couldn’t be read'); }
    })();
    return () => { gone = true; doc?.destroy?.(); };
  }, [file.id]);
  // Draw each page once its canvas is there (sharp on high-density screens).
  useEffect(() => {
    if (!pages) return;
    pages.forEach(async (pg, i) => {
      const c = canvases.current[i];
      if (!c || c.dataset.drawn) return;
      c.dataset.drawn = '1';
      const ratio = window.devicePixelRatio || 1;
      const v = pg.page.getViewport({ scale: (PAGE_PX / pg.page.getViewport({ scale: 1 }).width) * ratio });
      c.width = v.width; c.height = v.height;
      await pg.page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
      c.dataset.ready = '1';
    });
  }, [pages]);

  const place = (e, i) => {
    if (!tool || drag.current) return;
    const r = e.currentTarget.getBoundingClientRect(), pg = pages[i];
    const w = tool.w / pg.w, h = tool.h / pg.h;
    const x = Math.min(Math.max((e.clientX - r.left) / pg.w - w / 2, 0), 1 - w), y = Math.min(Math.max((e.clientY - r.top) / pg.h - h / 2, 0), 1 - h);
    setItems((l) => [...l, { id: Math.random().toString(36).slice(2), page: i, x, y, w, h, png: tool.png, label: tool.label }]);
    if (!tool.keep) setTool(null);
  };
  const startDrag = (e, it) => {
    e.stopPropagation(); e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: it.id, sx: e.clientX, sy: e.clientY, x: it.x, y: it.y, moved: false };
  };
  const moveDrag = (e) => {
    const d = drag.current;
    if (!d) return;
    const it = items.find((x) => x.id === d.id), pg = pages[it.page];
    const nx = Math.min(Math.max(d.x + (e.clientX - d.sx) / pg.w, 0), 1 - it.w), ny = Math.min(Math.max(d.y + (e.clientY - d.sy) / pg.h, 0), 1 - it.h);
    d.moved = true;
    setItems((l) => l.map((x) => (x.id === d.id ? { ...x, x: nx, y: ny } : x)));
  };
  const endDrag = () => { setTimeout(() => { drag.current = null; }, 0); };

  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const save = async () => {
    setBusy(true);
    try {
      const r = await post(`/files/${file.id}/pdf/sign`, { items: items.map(({ page, x, y, w, h, png }) => ({ page, x, y, w, h, png })) });
      toast(`Saved “${r.name}”`);
      onDone(r);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  const armText = (label, text, opts) => { if (!text) return; setTool({ ...textPicture(text, opts), label }); };

  return (
    <Modal title={`Fill & sign “${file.name}”`} wide onClose={onClose}
      footer={<><span className="muted small grow">{items.length ? `${items.length} placed · drag to move, × to remove` : 'Choose what to add, then click where it goes'}</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!items.length || busy} onClick={save}>{busy ? 'Saving…' : 'Save signed copy'}</button></>}>
      <div className="pdf-sign">
        <div className="row wrap pdf-sign-tools" role="toolbar" aria-label="Add to the PDF">
          <button type="button" className={`btn small ${tool?.label === 'Signature' ? 'on' : ''}`} onClick={() => setSigning(true)}>✍ Signature</button>
          <button type="button" className={`btn small ${tool?.label === 'Date' ? 'on' : ''}`} onClick={() => armText('Date', today)}>📅 Date</button>
          <button type="button" className={`btn small ${tool?.label === 'Text' ? 'on' : ''}`} onClick={() => armText('Text', window.prompt('Text to add') || '')}>T Text</button>
          <button type="button" className={`btn small ${tool?.label === 'Tick' ? 'on' : ''}`} onClick={() => armText('Tick', '✓', { size: 18 })}>✓ Tick</button>
          {tool && <span className="small" role="status">Click on a page to put the {tool.label.toLowerCase()} there</span>}
        </div>
        {error ? <p className="error">{error}</p> : !pages ? <p className="muted">Opening the PDF…</p> : (
          <div className="pdf-sign-pages" onPointerMove={moveDrag} onPointerUp={endDrag}>
            {pages.map((pg, i) => (
              <div key={i} className={`pdf-sign-page ${tool ? 'placing' : ''}`} style={{ width: pg.w, height: pg.h }} onClick={(e) => place(e, i)} aria-label={`Page ${i + 1}`} role="group">
                <canvas ref={(el) => { canvases.current[i] = el; }} style={{ width: pg.w, height: pg.h }} />
                {items.filter((it) => it.page === i).map((it) => (
                  <div key={it.id} className="pdf-sign-item" style={{ left: `${it.x * 100}%`, top: `${it.y * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%` }}
                    onPointerDown={(e) => startDrag(e, it)} onClick={(e) => e.stopPropagation()} aria-label={`${it.label} on page ${i + 1}`}>
                    <img src={it.png} alt="" draggable={false} />
                    <button type="button" className="pdf-sign-remove" aria-label={`Remove ${it.label.toLowerCase()}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setItems((l) => l.filter((x) => x.id !== it.id)); }}>×</button>
                  </div>
                ))}
                <span className="pdf-sign-num muted small">{i + 1}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {signing && <SignatureMaker onClose={() => setSigning(false)} onDone={(sig) => { setSigning(false); setTool({ ...sig, label: 'Signature', keep: false }); }} />}
    </Modal>
  );
}

/** Draw a signature, or type your name in a handwriting style. */
function SignatureMaker({ onClose, onDone }) {
  const [mode, setMode] = useState('draw');
  const [drawn, setDrawn] = useState(null);
  const [name, setName] = useState('');
  const use = async () => {
    if (mode === 'draw') { const t = drawn && (await trimmed(drawn)); if (t) onDone(t); return; }
    if (name.trim()) onDone(textPicture(name.trim(), { size: 26, font: "'Brush Script MT', 'Segoe Script', 'Lucida Handwriting', cursive" }));
  };
  return (
    <Modal title="Your signature" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={mode === 'draw' ? !drawn : !name.trim()} onClick={use}>Use it</button></>}>
      <div className="stack">
        <div className="row" role="radiogroup" aria-label="How to sign">
          <label className="check"><input type="radio" checked={mode === 'draw'} onChange={() => setMode('draw')} /> Draw</label>
          <label className="check"><input type="radio" checked={mode === 'type'} onChange={() => setMode('type')} /> Type</label>
        </div>
        {mode === 'draw' ? <SignaturePad onChange={setDrawn} /> : <>
          <label className="field"><span>Your name</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} /></label>
          <div className="sign-typed big" aria-hidden="true">{name || ' '}</div>
        </>}
      </div>
    </Modal>
  );
}
