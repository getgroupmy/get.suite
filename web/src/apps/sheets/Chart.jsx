// Drawing a chart (SVG): column and bar (side by side or stacked), line, area, scatter, pie and
// doughnut, with a tooltip on hover, a legend when there is more than one series, and a table view
// of the numbers behind it.
import { useState } from 'react';
import { niceScale, shortNumber, pieSlices, stackedRuns, scatterOf, isStacked, isRound, isHorizontal } from './charts.js';

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
  const scatter = type === 'scatter' && !data.error ? scatterOf(data) : null;
  const legendItems = scatter ? (scatter.points.length > 1 ? scatter.points.map((s, i) => ({ name: s.name, slot: i })) : []) : isRound(type) ? pieSlices(data).map((s) => ({ name: `${s.name} · ${Math.round(s.share * 100)}%`, slot: s.slot })) : series.length > 1 ? series.map((s, i) => ({ name: s.name, slot: i })) : [];
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
  if (isRound(type)) {
    const slices = pieSlices(data);
    const r = Math.max(10, Math.min(w, h) / 2 - 6), cx = w / 2, cy = h / 2;
    const ri = type === 'doughnut' ? r * 0.58 : 0; // the hole
    const pt = (a, rr = r) => [cx + rr * Math.sin(a * 2 * Math.PI), cy - rr * Math.cos(a * 2 * Math.PI)];
    const total = slices.reduce((t, s) => t + s.value, 0);
    plot = slices.map((s) => {
      const [x0, y0] = pt(s.start), [x1, y1] = pt(s.end);
      const big = s.share > 0.5 ? 1 : 0;
      let d;
      if (ri) {
        const [i0, j0] = pt(s.start, ri), [i1, j1] = pt(s.end, ri);
        d = s.share >= 0.9999
          ? `M${cx},${cy - r}A${r},${r} 0 1 1 ${cx - 0.01},${cy - r}ZM${cx},${cy - ri}A${ri},${ri} 0 1 0 ${cx + 0.01},${cy - ri}Z`
          : `M${x0},${y0}A${r},${r} 0 ${big} 1 ${x1},${y1}L${i1},${j1}A${ri},${ri} 0 ${big} 0 ${i0},${j0}Z`;
      } else d = s.share >= 0.9999 ? `M${cx},${cy - r}A${r},${r} 0 1 1 ${cx - 0.01},${cy - r}Z` : `M${cx},${cy}L${x0},${y0}A${r},${r} 0 ${big} 1 ${x1},${y1}Z`;
      const [lx, ly] = pt((s.start + s.end) / 2, ri ? (r + ri) / 2 : r * 0.66);
      return (
        <g key={s.slot} onMouseEnter={() => setHover({ i: s.slot, x: lx, y: ly })} onMouseLeave={() => setHover(null)}>
          <path d={d} fill={color(s.slot)} fillRule="evenodd" stroke="var(--surface)" strokeWidth="2" opacity={hover && hover.i !== s.slot ? 0.55 : 1} />
          {s.share >= 0.08 && r > 50 && <text x={lx} y={ly} className="chart-slice-label" fill={`var(--series-ink-${(s.slot % 8) + 1})`} textAnchor="middle" dominantBaseline="central">{Math.round(s.share * 100)}%</text>}
        </g>
      );
    });
    if (ri && r > 40) plot.push(<g key="total"><text x={cx} y={cy - 7} textAnchor="middle" className="chart-total">{shortNumber(total)}</text><text x={cx} y={cy + 11} textAnchor="middle" className="chart-tick">Total</text></g>);
    if (hover) { const s = slices[hover.i]; if (s) tip = { x: hover.x, y: hover.y, title: s.name, rows: [[null, `${fmt(s.value)} (${Math.round(s.share * 1000) / 10}%)`]] }; }
  } else if (scatter) {
    const xsAll = scatter.points.flatMap((p) => p.values.map(([x]) => x)), ysAll = scatter.points.flatMap((p) => p.values.map(([, y]) => y));
    if (!ysAll.length) return <div className="chart-empty muted small">There are no points to show</div>;
    // Both axes fit the points (they needn't start at 0), with a little room around them.
    const pad = (lo, hi) => { const d = (hi - lo) * 0.05 || Math.abs(hi) * 0.1 || 1; return [lo - d, hi + d]; };
    const sy = niceScale(...pad(Math.min(...ysAll), Math.max(...ysAll)), Math.max(2, Math.min(6, Math.floor(h / 50))), true);
    const sx = niceScale(...pad(Math.min(...xsAll), Math.max(...xsAll)), Math.max(2, Math.min(8, Math.floor(w / 70))), true);
    const valLabelW = Math.max(...sy.ticks.map((t) => shortNumber(t).length)) * 7 + 10;
    const m = { l: valLabelW, r: 12, t: 8, b: 22 };
    const pw = Math.max(10, w - m.l - m.r), ph = Math.max(10, h - m.t - m.b);
    const X = (v) => m.l + ((v - sx.lo) / (sx.hi - sx.lo)) * pw, Y = (v) => m.t + ph - ((v - sy.lo) / (sy.hi - sy.lo)) * ph;
    const grid = [
      ...sy.ticks.map((t) => <g key={`y${t}`}><line x1={m.l} x2={m.l + pw} y1={Y(t)} y2={Y(t)} className={t === 0 ? 'chart-base' : 'chart-grid'} /><text x={m.l - 6} y={Y(t)} textAnchor="end" dominantBaseline="central" className="chart-tick">{shortNumber(t)}</text></g>),
      ...sx.ticks.map((t) => <g key={`x${t}`}><line x1={X(t)} x2={X(t)} y1={m.t} y2={m.t + ph} className={t === 0 ? 'chart-base' : 'chart-grid'} /><text x={X(t)} y={m.t + ph + 15} textAnchor="middle" className="chart-tick">{shortNumber(t)}</text></g>),
    ];
    const dots = scatter.points.flatMap((p, si) => p.values.map(([x, y], k) => (
      <circle key={`${si}-${k}`} cx={X(x)} cy={Y(y)} r={hover && hover.si === si && hover.k === k ? 6 : 4} fill={color(si)} fillOpacity="0.8" stroke="var(--surface)" strokeWidth="1"
        onMouseEnter={() => setHover({ si, k, x: X(x), y: Y(y) - 8 })} onMouseLeave={() => setHover(null)} />)));
    plot = <>{grid}{dots}</>;
    if (hover) { const p = scatter.points[hover.si]; const [x, y] = p?.values[hover.k] || []; if (p) tip = { x: hover.x, y: hover.y, title: `${scatter.xName || 'X'}: ${fmt(x)}`, rows: [[hover.si, `${p.name}: ${fmt(y)}`]] }; }
  } else {
    const stacked = isStacked(type);
    const runs = stacked ? stackedRuns(series, categories.length) : null;
    const all = stacked ? runs.flat().filter(Boolean).flat() : series.flatMap((s) => s.values).filter((v) => v !== null);
    const horiz = isHorizontal(type);
    const sc = niceScale(Math.min(...all), Math.max(...all), Math.max(2, Math.min(6, Math.floor((horiz ? w : h) / 50))));
    const n = Math.max(1, categories.length);
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
    if (type === 'line' || type === 'area') {
      const x = (i) => catPos(i) + band / 2;
      marks = series.map((s, si) => {
        const segs = [];
        let cur = [];
        s.values.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), valPos(v)]); });
        if (cur.length) segs.push(cur);
        return (
          <g key={si}>
            {type === 'area' && segs.filter((pts) => pts.length > 1).map((pts, k) => (
              <polygon key={`a${k}`} points={[[pts[0][0], zero], ...pts, [pts[pts.length - 1][0], zero]].map((p) => p.join(',')).join(' ')} fill={color(si)} fillOpacity={series.length > 1 ? 0.22 : 0.3} stroke="none" />))}
            {segs.map((pts, k) => (pts.length > 1
              ? <polyline key={k} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={color(si)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              : <circle key={k} cx={pts[0][0]} cy={pts[0][1]} r="3" fill={color(si)} />))}
            {hover && s.values[hover.i] !== null && <circle cx={x(hover.i)} cy={valPos(s.values[hover.i])} r="4.5" fill={color(si)} stroke="var(--surface)" strokeWidth="2" />}
          </g>
        );
      });
      if (hover) marks.unshift(<line key="x" x1={x(hover.i)} x2={x(hover.i)} y1={m.t} y2={m.t + ph} className="chart-cross" />);
    } else if (stacked) {
      const thick = band * 0.62;
      marks = categories.map((_, i) => series.map((s, si) => {
        const run = runs[si][i];
        if (!run) return null;
        const at = catPos(i) + (band - thick) / 2;
        const a = valPos(run[0]), b = valPos(run[1]);
        return horiz
          ? <rect key={`${i}-${si}`} x={Math.min(a, b)} y={at} width={Math.max(1, Math.abs(b - a) - 1)} height={thick} fill={color(si)} opacity={hover && hover.i !== i ? 0.55 : 1} />
          : <rect key={`${i}-${si}`} x={at} y={Math.min(a, b) + 1} width={thick} height={Math.max(1, Math.abs(b - a) - 1)} fill={color(si)} opacity={hover && hover.i !== i ? 0.55 : 1} />;
      }));
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
    if (hover) {
      const rows = series.map((s, si) => [si, `${series.length > 1 ? `${s.name}: ` : ''}${fmt(s.values[hover.i])}`]);
      if (stacked && series.length > 1) rows.push([null, `Total: ${fmt(series.reduce((t, s) => t + (s.values[hover.i] || 0), 0))}`]);
      tip = { x: hover.x, y: hover.y, title: categories[hover.i], rows };
    }
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
