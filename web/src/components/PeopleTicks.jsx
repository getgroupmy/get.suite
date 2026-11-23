// A list of colleagues to tick (who a note is shared with, who reviews a file, who is in a group).
// With more than a handful of people a "Find people" box narrows it by name or address — words in
// any order, accents aside — and says how many are ticked, so nobody scrolls a whole company.
// With onAddMany, the company's groups are offered as buttons (+ Sales (4)) that tick everyone in one.
import { useEffect, useState } from 'react';
import { Avatar } from './ui.jsx';
import { get } from '../api.js';
import { matchesFilter } from '../apps/contacts/contactfilter.js';

export const FIND_FROM = 9; // people before the box is worth having

export default function PeopleTicks({ people, chosen, onToggle, onAddMany, label, withAddress = false }) {
  const [find, setFind] = useState('');
  const [groups, setGroups] = useState([]);
  useEffect(() => { if (onAddMany) get('/groups').then(setGroups).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Each group's people who are in this list (not you, nor anyone who can't be picked here), with someone still to tick.
  const known = new Set(people.map((p) => p.id));
  const offered = groups.map((g) => ({ ...g, ids: g.members.map((m) => m.id).filter((id) => known.has(id)) })).filter((g) => g.ids.length);
  const big = people.length >= FIND_FROM;
  const shown = big && find.trim() ? people.filter((p) => matchesFilter({ name: p.name, username: p.username }, find)) : people;
  const ticked = people.filter((p) => chosen.has(p.id)).length;
  return (
    <div className="people-ticks stack-tight">
      {big && (
        <div className="row small" style={{ gap: 8 }}>
          <input type="search" className="grow" aria-label={`Find people: ${label}`} placeholder="Find people" value={find} onChange={(e) => setFind(e.target.value)} />
          <span className="muted" aria-live="polite">{ticked ? `${ticked} ticked` : 'Nobody ticked'}</span>
        </div>
      )}
      {offered.length > 0 && (
        <div className="row wrap group-picks" role="group" aria-label={`Add a group: ${label}`}>
          {offered.map((g) => {
            const all = g.ids.every((id) => chosen.has(id));
            return <button key={g.id} type="button" className="btn small" disabled={all} title={all ? `Everyone in ${g.name} is ticked` : `Tick everyone in ${g.name}`} onClick={() => onAddMany(g.ids)}>+ {g.name} ({g.ids.length})</button>;
          })}
        </div>
      )}
      <ul className="group-people" aria-label={label}>
        {shown.map((p) => (
          <li key={p.id}><label className="check"><input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => onToggle(p.id, e.target.checked)} /> <Avatar name={p.name} size={22} userId={p.id} /> {p.name}{withAddress && <> <span className="muted small">{p.username}</span></>}</label></li>
        ))}
        {!shown.length && <li className="muted small">Nobody fits “{find.trim()}”.</li>}
      </ul>
    </div>
  );
}
