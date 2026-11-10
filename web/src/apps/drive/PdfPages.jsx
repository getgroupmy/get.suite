// A PDF's pages shown one under the other (pdf.js, loaded with this). Read-only, or with boxes drawn over
// the pages (`boxes`: [{ page, x, y, w, h (fractions), label, className, key }]) and clicks on a page
// reported as fractions (`onPageClick(page, fx, fy)`): the signing page and placing signature boxes use it.
import { useEffect, useRef, useState } from 'react';

export default function PdfPages({ url, width = 760, boxes = [], onPageClick, onBoxRemove, onBoxMove }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let gone = false, doc = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
        const list = [];
        for (let i = 1; i <= Math.min(doc.numPages, 300); i++) list.push(await doc.getPage(i));
        if (!gone) setPages(list);
      } catch { if (!gone) setError('This PDF couldn’t be shown'); }
    })();
    return () => { gone = true; doc?.destroy?.(); };
  }, [url]);
  if (error) return <p className="error">{error}</p>;
  if (!pages) return <p className="muted">Opening the PDF…</p>;
  return (
    <div className="pdf-pages" aria-label="The PDF">
      {pages.map((p, i) => <Page key={i} page={p} n={i + 1} width={width} boxes={boxes.filter((b) => b.page === i)} onClick={onPageClick && ((fx, fy) => onPageClick(i, fx, fy))} onBoxRemove={onBoxRemove} onBoxMove={onBoxMove} />)}
    </div>
  );
}

function Page({ page, n, width, boxes, onClick, onBoxRemove, onBoxMove }) {
  const ref = useRef();
  const drag = useRef(null);
  const base = page.getViewport({ scale: 1 });
  const w = Math.min(width, window.innerWidth - 32), h = (base.height / base.width) * w;
  useEffect(() => {
    const c = ref.current, ratio = window.devicePixelRatio || 1;
    const v = page.getViewport({ scale: (w / base.width) * ratio });
    c.width = v.width; c.height = v.height;
    page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise.then(() => { c.dataset.ready = '1'; }).catch(() => {});
  }, [page, w, base.width]);
  const click = (e) => {
    if (!onClick || drag.current?.moved) return;
    const r = e.currentTarget.getBoundingClientRect();
    onClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  return (
    <div className={`pdf-pages-wrap ${onClick ? 'placing' : ''}`} style={{ width: w, height: h }} onClick={click} role="group" aria-label={`Page ${n}`}
      onPointerMove={(e) => { const d = drag.current; if (!d) return; d.moved = true; onBoxMove(d.key, Math.min(Math.max(d.x + (e.clientX - d.sx) / w, 0), 1 - d.w), Math.min(Math.max(d.y + (e.clientY - d.sy) / h, 0), 1 - d.h)); }}
      onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); }}>
      <canvas ref={ref} className="pdf-pages-page" style={{ width: w, height: h }} aria-hidden="true" />
      {boxes.map((b) => (
        <div key={b.key} className={`pdf-box ${b.className || ''}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
          aria-label={b.label} onClick={(e) => e.stopPropagation()}
          onPointerDown={onBoxMove ? (e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { key: b.key, sx: e.clientX, sy: e.clientY, x: b.x, y: b.y, w: b.w, h: b.h, moved: false }; } : undefined}>
          <span className="pdf-box-label">{b.label}</span>
          {onBoxRemove && <button type="button" className="pdf-sign-remove" aria-label={`Remove ${b.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onBoxRemove(b.key); }}>×</button>}
        </div>
      ))}
    </div>
  );
}
