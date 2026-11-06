// Drawing a chart (SVG): column, bar, line and pie, with a tooltip on hover, a legend when there
// is more than one series, and a table view of the numbers behind it.
import { useState } from 'react';
import { niceScale, shortNumber, pieSlices } from './charts.js';

const color = (i) => `var(--series-${(i % 8) + 1})`;
const fmt = (v) => (v === null || v === undefined ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 6 }));
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

/** A bar with its far (data) end rounded and the end at the baseline square. */
function barPath(x, y, w, h, r, end) {
  if (w <= 0 || h <= 0) return '';
  const k = Math.min(r, w / 2, h / 2);
  if (end === 'top') return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`;
  if (end === 'bottom') return `M${x},${y}V${y + h - k}Q${x},${y + h} ${x + k},${y + h}H${x + w - k}Q${x + w},${y + h} ${x + w},${y + h - k}V${y}Z`;
  if (end === 'right') return `M${x},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h - k}Q${x + w},${y + h} ${x + w - k},${y + h}H${x}Z`;
  return `M${x + w},${y}H${x + k}Q${x},${y} ${x},${y + k}V${y + h - k}Q${x},${y + h} ${x + k},${y + h}H${x + w}Z`; // left
}

export default function ChartView({ type, data, width, height }) {
  const [hover, setHover] = useState(null); // { i, x, y }
  const [table, setTable] = useState(false);
  const { categories, series } = data;
  const legendItems = type === 'pie' ? pieSlices(data).map((s) => ({ name: `${s.name} · ${Math.round(s.share * 100)}%`, slot: s.slot })) : series.length > 1 ? series.map((s, i) => ({ name: s.name, slot: i })) : [];
  const legendH = legendItems.length ? 26 : 0;
  const h = Math.max(60, height - legendH - 24); // 24: the table/chart switch row
  const w = Math.max(80, width);

  if (data.error) return <div className="chart-empty muted small">{data.error}</div>;
  if (table) {
    return (
      <div className="chart-view" style={{ height }}>
        <div className="chart-table-wrap" style={{ height: height - 24 }}>
          <table className="chart-table">
            <thead><tr><th />{series.map((s, i) => <th key={i}>{s.name}</th>)}</tr></thead>
            <tbody>{categories.map((c, r) => <tr key={r}><th>{c}</th>{series.map((s, i) => <td key={i}>{fmt(s.values[r])}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <div className="chart-switch"><button type="button" className="link-btn small" onClick={() => setTable(false)}>Show chart</button></div>
      </div>
    );
  }

  let plot;
  let tip = null;
  if (type === 'pie') {
    const slices = pieSlices(data);
    const r = Math.max(10, Math.min(w, h) / 2 - 6), cx = w / 2, cy = h / 2;
    const pt = (a, rr = r) => [cx + rr * Math.sin(a * 2 * Math.PI), cy - rr * Math.cos(a * 2 * Math.PI)];
    plot = slices.map((s) => {
      const [x0, y0] = pt(s.start), [x1, y1] = pt(s.end);
      const d = s.share >= 0.9999 ? `M${cx},${cy - r}A${r},${r} 0 1 1 ${cx - 0.01},${cy - r}Z` : `M${cx},${cy}L${x0},${y0}A${r},${r} 0 ${s.share > 0.5 ? 1 : 0} 1 ${x1},${y1}Z`;
      const [lx, ly] = pt((s.start + s.end) / 2, r * 0.66);
      return (
        <g key={s.slot} onMouseEnter={() => setHover({ i: s.slot, x: lx, y: ly })} onMouseLeave={() => setHover(null)}>
          <path d={d} fill={color(s.slot)} stroke="var(--surface)" strokeWidth="2" opacity={hover && hover.i !== s.slot ? 0.55 : 1} />
          {s.share >= 0.08 && r > 50 && <text x={lx} y={ly} className="chart-slice-label" fill={`var(--series-ink-${(s.slot % 8) + 1})`} textAnchor="middle" dominantBaseline="central">{Math.round(s.share * 100)}%</text>}
        </g>
      );
    });
    if (hover) { const s = slices[hover.i]; if (s) tip = { x: hover.x, y: hover.y, title: s.name, rows: [[null, `${fmt(s.value)} (${Math.round(s.share * 1000) / 10}%)`]] }; }
  } else {
    const all = series.flatMap((s) => s.values).filter((v) => v !== null);
    const sc = niceScale(Math.min(...all), Math.max(...all), Math.max(2, Math.min(6, Math.floor((type === 'bar' ? w : h) / 50))));
    const n = Math.max(1, categories.length);
    const horiz = type === 'bar';
    const catLabelW = horiz ? Math.min(120, Math.max(24, ...categories.map((c) => c.length * 6.5))) : 0;
    const valLabelW = horiz ? 0 : Math.max(...sc.ticks.map((t) => shortNumber(t).length)) * 7 + 10;
    const m = { l: horiz ? catLabelW + 8 : valLabelW, r: 10, t: 8, b: 22 };
    const pw = Math.max(10, w - m.l - m.r), ph = Math.max(10, h - m.t - m.b);
    const valPos = (v) => (horiz ? m.l + ((v - sc.lo) / (sc.hi - sc.lo)) * pw : m.t + ph - ((v - sc.lo) / (sc.hi - sc.lo)) * ph);
    const band = (horiz ? ph : pw) / n;
    const catPos = (i) => (horiz ? m.t : m.l) + band * i;
    const zero = valPos(0);
    const every = Math.ceil(n / Math.max(1, Math.floor((horiz ? ph / 16 : pw / 56))));
    const grid = sc.ticks.map((t) => (horiz
      ? <g key={t}><line x1={valPos(t)} x2={valPos(t)} y1={m.t} y2={m.t + ph} className={t === 0 ? 'chart-base' : 'chart-grid'} /><text x={valPos(t)} y={m.t + ph + 15} textAnchor="middle" className="chart-tick">{shortNumber(t)}</text></g>
      : <g key={t}><line x1={m.l} x2={m.l + pw} y1={valPos(t)} y2={valPos(t)} className={t === 0 ? 'chart-base' : 'chart-grid'} /><text x={m.l - 6} y={valPos(t)} textAnchor="end" dominantBaseline="central" className="chart-tick">{shortNumber(t)}</text></g>));
    const catLabels = categories.map((c, i) => (i % every ? null : horiz
      ? <text key={i} x={m.l - 6} y={catPos(i) + band / 2} textAnchor="end" dominantBaseline="central" className="chart-tick">{clip(c, Math.floor(catLabelW / 6.5))}</text>
      : <text key={i} x={catPos(i) + band / 2} y={m.t + ph + 15} textAnchor="middle" className="chart-tick">{clip(c, Math.max(3, Math.floor((band * every) / 7)))}</text>));
    let marks;
    if (type === 'line') {
      const x = (i) => catPos(i) + band / 2;
      marks = series.map((s, si) => {
        const segs = [];
        let cur = [];
        s.values.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), valPos(v)]); });
        if (cur.length) segs.push(cur);
        return (
          <g key={si}>
            {segs.map((pts, k) => (pts.length > 1
              ? <polyline key={k} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={color(si)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              : <circle key={k} cx={pts[0][0]} cy={pts[0][1]} r="3" fill={color(si)} />))}
            {hover && s.values[hover.i] !== null && <circle cx={x(hover.i)} cy={valPos(s.values[hover.i])} r="4.5" fill={color(si)} stroke="var(--surface)" strokeWidth="2" />}
          </g>
        );
      });
      if (hover) marks.unshift(<line key="x" x1={x(hover.i)} x2={x(hover.i)} y1={m.t} y2={m.t + ph} className="chart-cross" />);
    } else {
      const k = series.length;
      const group = band * (k > 1 ? 0.8 : 0.7);
      const gap = k > 1 ? 2 : 0;
      const thick = Math.max(1, (group - gap * (k - 1)) / k);
      marks = categories.map((_, i) => series.map((s, si) => {
        const v = s.values[i];
        if (v === null || v === 0) return null;
        const at = catPos(i) + (band - group) / 2 + si * (thick + gap);
        const p = valPos(v);
        const d = horiz
          ? barPath(Math.min(zero, p), at, Math.abs(p - zero), thick, 4, v > 0 ? 'right' : 'left')
          : barPath(at, Math.min(zero, p), thick, Math.abs(p - zero), 4, v > 0 ? 'top' : 'bottom');
        return <path key={`${i}-${si}`} d={d} fill={color(si)} opacity={hover && hover.i !== i ? 0.55 : 1} />;
      }));
    }
    // Hover targets: the whole band of each category, bigger than its marks.
    const hits = categories.map((c, i) => (horiz
      ? <rect key={i} x={m.l} y={catPos(i)} width={pw} height={band} fill="transparent" onMouseEnter={() => setHover({ i, x: m.l + pw / 2, y: catPos(i) + band / 2 })} />
      : <rect key={i} x={catPos(i)} y={m.t} width={band} height={ph} fill="transparent" onMouseEnter={() => setHover({ i, x: catPos(i) + band / 2, y: m.t + 10 })} />));
    plot = <>{grid}{catLabels}{marks}<g onMouseLeave={() => setHover(null)}>{hits}</g></>;
    if (hover) tip = { x: hover.x, y: hover.y, title: categories[hover.i], rows: series.map((s, si) => [si, `${series.length > 1 ? `${s.name}: ` : ''}${fmt(s.values[hover.i])}`]) };
  }

  return (
    <div className="chart-view" style={{ height }}>
      {legendItems.length > 0 && (
        <ul className="chart-legend" aria-label="Legend">
          {legendItems.map((l) => <li key={l.slot}><span className="chart-key" style={{ background: color(l.slot) }} />{l.name}</li>)}
        </ul>
      )}
      <div className="chart-plot">
        <svg width={w} height={h} role="img" aria-label={`${type} chart of ${series.map((s) => s.name).join(', ')}`}>{plot}</svg>
        {tip && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(tip.x, 70), w - 70), top: tip.y }}>
            <strong>{tip.title}</strong>
            {tip.rows.map(([slot, text], i) => <div key={i}>{slot !== null && <span className="chart-key" style={{ background: color(slot) }} />}{text}</div>)}
          </div>
        )}
      </div>
      <div className="chart-switch"><button type="button" className="link-btn small" onClick={() => setTable(true)}>Show data</button></div>
    </div>
  );
}
