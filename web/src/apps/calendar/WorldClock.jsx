import { useEffect, useState } from 'react';
import { put } from '../../api.js';
import { useAuth } from '../../App.jsx';
import { useToast } from '../../components/ui.jsx';
import { allZones, clockLine, cityOf } from '../../components/zones.js';

/** The time now in the places you pick (kept with your account), ticking each minute. */
export default function WorldClock() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [zones, setZones] = useState(() => user.world_clocks || []);
  const [now, setNow] = useState(Date.now());
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30e3);
    return () => clearInterval(t);
  }, []);
  const save = async (next) => {
    const before = zones;
    setZones(next);
    try { const r = await put('/users/me/world-clocks', { zones: next }); setZones(r.zones); setUser?.({ ...user, world_clocks: r.zones }); }
    catch (e) { setZones(before); toast(e.message, 'error'); }
  };
  return (
    <section className="world-clock" aria-label="World clock">
      <div className="subnav-title row">World clock<div className="grow" />
        {zones.length < 8 && <button type="button" className="icon-btn" aria-label="Add a clock" title="Add a place" onClick={() => setAdding(!adding)}>+</button>}</div>
      {adding && (
        <select aria-label="Place to add" autoFocus value="" onChange={(e) => { if (e.target.value) { save([...zones, e.target.value]); setAdding(false); } }} onBlur={() => setAdding(false)}>
          <option value="">Choose a place…</option>
          {allZones().filter((z) => !zones.includes(z)).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select>
      )}
      {!zones.length && !adding && <p className="muted small" style={{ margin: '0 12px' }}>Add places to see the time there now.</p>}
      <ul className="world-clock-list">
        {zones.map((z) => {
          const c = clockLine(z, now);
          return (
            <li key={z} title={z}>
              <span className="grow ellipsis">{c.city}</span>
              <span className="muted small">{c.day ? `${c.day}, ` : ''}{c.diff}</span>
              <strong className="world-clock-time">{c.time}</strong>
              <button type="button" className="icon-btn" aria-label={`Remove ${cityOf(z)}`} onClick={() => save(zones.filter((x) => x !== z))}>×</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
