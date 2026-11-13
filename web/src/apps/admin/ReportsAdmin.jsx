// Admin → Reports: how the company used Workspace over the last 7, 30 or 90 days, per person.
import { useEffect, useMemo, useState } from 'react';
import { get } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { lastActiveText } from './lastactive.js';
import { axisOf, summaryOf, dayLabel } from './activechart.js';

const COLUMNS = [['files_created', 'Files created'], ['files_edited', 'Files edited'], ['chat_messages', 'Chat messages'], ['meetings', 'Meetings organised'], ['tasks_done', 'Tasks done'], ['video_meetings', 'Video meetings'], ['video_minutes', 'Time in video meetings', (n) => minutesText(n)]];
/** 95 → "1 h 35 min", 20 → "20 min". */
export const minutesText = (n) => (n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`);

export default function ReportsAdmin({ orgId, orgPicker }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState(null);
  const [sort, setSort] = useState('name');
  const qs = `days=${days}${orgId ? `&org_id=${orgId}` : ''}`;
  useEffect(() => { setR(null); get(`/users/report?${qs}`).then(setR).catch(() => setR({ people: [], error: true })); }, [qs]);
  const rows = useMemo(() => (r?.people || []).slice().sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'last_active' ? (b.last_active || 0) - (a.last_active || 0) : b[sort] - a[sort])), [r, sort]);
  const total = (k) => rows.reduce((n, p) => n + p[k], 0);
  return (
    <div className="stack">
      <div className="row wrap">
        {orgPicker}
        <label className="row small">Over the last <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
        <div className="grow" />
        <a className="btn" href={`/api/users/report?${qs}&format=csv`} download><Icon name="download" size={18} /> Download CSV</a>
      </div>
      {!r ? <p className="muted">Loading…</p> : <>
        <p role="status" style={{ margin: 0 }}><strong>{r.active}</strong> of {r.people.length} people used Workspace in the last {days} days.</p>
        {r.per_day && <ActiveChart perDay={r.per_day} people={r.people.length} />}
        <table className="files report" aria-label="Usage">
          <thead><tr>
            <th><button type="button" className="link-btn" onClick={() => setSort('name')}>Name</button></th>
            <th><button type="button" className="link-btn" onClick={() => setSort('last_active')}>Last active</button></th>
            {COLUMNS.map(([k, label]) => <th key={k} className="num"><button type="button" className="link-btn" onClick={() => setSort(k)}>{label}</button></th>)}
          </tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.disabled ? 'dim' : ''}>
                <td>{p.name}{p.disabled ? ' (suspended)' : ''}<div className="muted small">{p.email}</div></td>
                <td className="muted">{lastActiveText(p.last_active)}</td>
                {COLUMNS.map(([k, , show]) => <td key={k} className="num">{p[k] ? (show ? show(p[k]) : p[k]) : <span className="muted">0</span>}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th>Total</th><th />{COLUMNS.map(([k, , show]) => <th key={k} className="num">{show ? show(total(k)) : total(k)}</th>)}</tr></tfoot>
        </table>
      </>}
    </div>
  );
}

/** Active people per day: thin bars on a light grid, a tooltip on each day, and the numbers as a table too. */
function ActiveChart({ perDay, people }) {
  const { days, since } = perDay;
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const { top, ticks } = axisOf(Math.max(...days.map((d) => d.active), 0));
  const sum = summaryOf(days, since);
  const W = 720, H = 180, L = 28, B = 22, T = 8;
  const plotW = W - L - 4, plotH = H - B - T;
  const slot = plotW / days.length, bar = Math.max(2, Math.min(24, slot - 2));
  const y = (v) => T + plotH - (v / top) * plotH;
  const counted = (d) => !since || d.day >= since;
  const labelEvery = Math.ceil(days.length / 8);
  return (
    <section className="card stack-tight active-chart" aria-labelledby="active-chart-h">
      <div className="row wrap">
        <h3 id="active-chart-h" className="grow" style={{ margin: 0 }}>Active people per day</h3>
        <button type="button" className="link-btn small" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? 'Show chart' : 'Show as table'}</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {sum.counted ? <>On average <strong>{sum.average.toFixed(1)}</strong> of {people} a day{sum.peak && <>; busiest on {dayLabel(sum.peak.day)} ({sum.peak.active})</>}.</> : 'Nothing recorded yet.'}
        {since && since > days[0].day && <> Counted from {dayLabel(since)}, when this report started recording.</>}
        {' '}Days are in UTC.
      </p>
      {asTable ? (
        <div className="active-chart-table" tabIndex={0} role="region" aria-label="Active people per day, as a table"><table className="files report" aria-label="Active people per day">
          <thead><tr><th>Day</th><th className="num">Active people</th></tr></thead>
          <tbody>{days.slice().reverse().map((d) => <tr key={d.day}><td>{dayLabel(d.day)}</td><td className="num">{counted(d) ? d.active : <span className="muted">not recorded</span>}</td></tr>)}</tbody>
        </table></div>
      ) : (
        <div className="active-chart-plot" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Active people per day over the last ${days.length - 1} days: on average ${sum.average.toFixed(1)}`}>
            {ticks.map((v) => <g key={v}>
              <line x1={L} x2={W - 4} y1={y(v)} y2={y(v)} className={v ? 'grid' : 'base'} />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="tick">{v}</text>
            </g>)}
            {days.map((d, i) => {
              const x = L + i * slot + (slot - bar) / 2, h = (d.active / top) * plotH;
              return <g key={d.day} data-day={d.day} onMouseEnter={() => setHover(i)}>
                <rect x={L + i * slot} y={T} width={slot} height={plotH} className="hit" />
                {counted(d) && d.active > 0 && <path className={`bar${hover === i ? ' on' : ''}`}
                  d={`M${x},${y(0)} V${y(d.active) + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bar / 2)},-${Math.min(4, h)} H${x + bar - Math.min(4, bar / 2)} q${Math.min(4, bar / 2)},0 ${Math.min(4, bar / 2)},${Math.min(4, h)} V${y(0)} Z`} />}
                {!counted(d) && <line x1={x} x2={x + bar} y1={y(0) - 1} y2={y(0) - 1} className="uncounted" />}
                {(i % labelEvery === 0 || i === days.length - 1) && (days.length - 1 - i >= labelEvery / 2 || i === days.length - 1) && <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="tick">{i === days.length - 1 ? 'Today' : dayLabel(d.day).slice(4)}</text>}
              </g>;
            })}
          </svg>
          {hover !== null && <div role="tooltip" className="active-chart-tip" style={{ left: `${Math.min(90, Math.max(10, ((L + hover * slot + slot / 2) / W) * 100))}%` }}>
            <strong>{dayLabel(days[hover].day)}</strong><br />{counted(days[hover]) ? `${days[hover].active} ${days[hover].active === 1 ? 'person' : 'people'}` : 'Not recorded'}
          </div>}
        </div>
      )}
    </section>
  );
}
