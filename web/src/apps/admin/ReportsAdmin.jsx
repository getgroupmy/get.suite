// Admin → Reports: how the company used Workspace over the last 7, 30 or 90 days, per person.
import { useEffect, useMemo, useState } from 'react';
import { get } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { lastActiveText } from './lastactive.js';

const COLUMNS = [['files_created', 'Files created'], ['files_edited', 'Files edited'], ['chat_messages', 'Chat messages'], ['meetings', 'Meetings organised'], ['tasks_done', 'Tasks done']];

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
                {COLUMNS.map(([k]) => <td key={k} className="num">{p[k] || <span className="muted">0</span>}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th>Total</th><th />{COLUMNS.map(([k]) => <th key={k} className="num">{total(k)}</th>)}</tr></tfoot>
        </table>
      </>}
    </div>
  );
}
