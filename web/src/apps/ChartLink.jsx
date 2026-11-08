// Charts from a spreadsheet in Slides and Docs: choosing one, and seeing whether the spreadsheet
// has changed since (for people who can open it).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ChartView from './sheets/Chart.jsx';
import { get } from '../api.js';
import { Modal } from '../components/ui.jsx';
import { importBook, onImports, refreshImports } from './sheets/imports.js';
import { chartsIn, chartNow } from './slides/linkedchart.js';

/** The spreadsheet a chart came from, as it is now (for people who can open it). */
export function useChartNow(item) {
  const [, setTick] = useState(0);
  useEffect(() => onImports(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    refreshImports(); // the latest, each time a chart is selected, coming back to the tab, and each minute
    window.addEventListener('focus', refreshImports);
    const t = setInterval(refreshImports, 60000);
    return () => { window.removeEventListener('focus', refreshImports); clearInterval(t); };
  }, [item.fileId]);
  const book = importBook(item.fileId);
  if (!book || book.error) return { state: book ? 'no-access' : 'loading' };
  const now = chartNow(book, item.chartId, { book: importBook, depth: 0 });
  return now ? { state: 'ok', now } : { state: 'gone' };
}

/** Choose one of a spreadsheet's charts. */
export function ChartPick({ file, onClose, onPick }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { get(`/files/${file.id}/content`).then((r) => setContent(r.content)).catch((e) => setError(e.message)); }, [file.id]);
  const charts = content ? chartsIn(content) : [];
  return (
    <Modal title={`Charts in “${file.name}”`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
      {error && <p className="error">{error}</p>}
      {!content && !error && <p className="muted">Loading…</p>}
      {content && !charts.length && <p className="muted">This spreadsheet has no charts yet. Make one there with the <strong>Chart</strong> button, then come back.</p>}
      <ul className="chart-pick">
        {charts.map((c) => (
          <li key={c.id}><button type="button" className="btn" onClick={() => onPick({ id: c.id, now: chartNow(content, c.id, { book: importBook, depth: 0 }) })}>
            {c.title || 'Untitled chart'} <span className="muted small">{c.type} · on {c.sheet}</span></button></li>
        ))}
      </ul>
    </Modal>
  );
}


/** A chart (with its title) drawn at the size of the box it's in. */
export function ChartBox({ item, style }) {
  const ref = useRef();
  const [size, setSize] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const titleH = item.title && size ? Math.max(14, Math.min(28, size.h * 0.08)) : 0;
  return (
    <div ref={ref} className="slide-chart" style={style}>
      {item.title && <div className="slide-chart-title" style={{ fontSize: titleH * 0.8, height: titleH }}>{item.title}</div>}
      {size && <ChartView type={item.chartType} data={item.data || { categories: [], series: [] }} width={size.w} height={size.h - titleH} />}
    </div>
  );
}
