// Organise a PDF's pages: thumbnails to drag into a new order (or move with ← →), turn (↻) or take out
// (×), then save as a new version of the PDF (its old pages stay in version history) or as a copy.
import { useEffect, useRef, useState } from 'react';
import { post } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';

const THUMB = 132;

export default function PdfOrganizeDialog({ file, canEdit, onClose, onDone }) {
  const toast = useToast();
  const [pages, setPages] = useState(null); // [{ key, page (0-based original), rotate, w, h, pdf }]
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const dragFrom = useRef(null);

  useEffect(() => {
    let gone = false, doc = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        doc = await pdfjs.getDocument({ url: `/api/files/${file.id}/raw`, withCredentials: true }).promise;
        const list = [];
        for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
          const p = await doc.getPage(i);
          const v = p.getViewport({ scale: 1 });
          list.push({ key: `p${i}`, page: i - 1, rotate: 0, w: THUMB, h: (v.height / v.width) * THUMB, pdf: p });
        }
        if (!gone) setPages(list);
      } catch (e) { if (!gone) setError(/password/i.test(e?.message) ? 'This PDF is password-protected' : 'This PDF couldn’t be read'); }
    })();
    return () => { gone = true; doc?.destroy?.(); };
  }, [file.id]);

  const move = (from, to) => setPages((l) => { if (to < 0 || to >= l.length) return l; const n = [...l]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; });
  const turn = (i) => setPages((l) => l.map((p, k) => (k === i ? { ...p, rotate: (p.rotate + 90) % 360 } : p)));
  const remove = (i) => setPages((l) => l.filter((_, k) => k !== i));
  const changed = pages && (pages.some((p, i) => p.page !== i || p.rotate) || pages.length !== pages.reduce((m, p) => Math.max(m, p.page + 1), 0));
  const save = async (as) => {
    setBusy(true);
    try {
      const r = await post(`/files/${file.id}/pdf/organize`, { pages: pages.map((p) => ({ page: p.page, rotate: p.rotate })), as });
      toast(as === 'version' ? `Saved: “${file.name}” has its pages as you set them (the old ones are in Version history)` : `Made “${r.name}”`);
      onDone(r);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };

  return (
    <Modal title={`Organise pages of “${file.name}”`} wide onClose={onClose}
      footer={<><span className="muted small grow">{pages ? `${pages.length} page${pages.length === 1 ? '' : 's'} · drag to reorder` : ''}</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!changed || busy || !pages?.length} onClick={() => save('copy')}>Save as a copy</button>
        {canEdit && <button type="button" className="btn primary" disabled={!changed || busy || !pages?.length} onClick={() => save('version')}>Save</button>}</>}>
      {error ? <p className="error">{error}</p> : !pages ? <p className="muted">Opening the PDF…</p> : (
        <ol className="pdf-thumbs" aria-label="Pages">
          {pages.map((p, i) => (
            <li key={p.key} className="pdf-thumb" draggable aria-label={`Page ${p.page + 1}${p.rotate ? `, turned ${p.rotate}°` : ''}`}
              onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; }}>
              <div className="pdf-thumb-frame" style={{ width: THUMB + 8, height: Math.max(p.w, p.h) + 8 }}>
                <Thumb page={p} />
              </div>
              <div className="row pdf-thumb-tools">
                <button type="button" className="icon-btn small" aria-label={`Move page ${p.page + 1} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)}>←</button>
                <button type="button" className="icon-btn small" aria-label={`Turn page ${p.page + 1}`} onClick={() => turn(i)}>↻</button>
                <button type="button" className="icon-btn small" aria-label={`Take out page ${p.page + 1}`} disabled={pages.length === 1} onClick={() => remove(i)}>×</button>
                <button type="button" className="icon-btn small" aria-label={`Move page ${p.page + 1} later`} disabled={i === pages.length - 1} onClick={() => move(i, i + 1)}>→</button>
              </div>
              <span className="muted small">{p.page + 1}</span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

/** One page, small, turned as set (the picture is drawn once; turning is just how it's shown). */
function Thumb({ page }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    if (!c || c.dataset.drawn) return;
    c.dataset.drawn = '1';
    const ratio = window.devicePixelRatio || 1;
    const v = page.pdf.getViewport({ scale: (THUMB / page.pdf.getViewport({ scale: 1 }).width) * ratio });
    c.width = v.width; c.height = v.height;
    page.pdf.render({ canvasContext: c.getContext('2d'), viewport: v }).promise.then(() => { c.dataset.ready = '1'; }).catch(() => {});
  }, [page]);
  return <canvas ref={ref} style={{ width: page.w, height: page.h, transform: `rotate(${page.rotate}deg)` }} />;
}
