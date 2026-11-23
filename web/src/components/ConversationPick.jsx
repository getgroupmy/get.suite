// Choosing a Chat conversation to send something to (Send in Chat, Forward): the one with the latest message
// first, and, with more than six, a box to find one by name (accents and capitals aside) that narrows the list.
import { useState } from 'react';
import { has } from '../fold.js';

export const conversationName = (c) => (c.dm_key ? `${c.dm_name || 'Notes to self'}${c.dm_org ? ` (${c.dm_org})` : ''}` : `# ${c.name}`);
/** Open conversations, the latest message first. */
export const latestFirst = (list) => list.filter((c) => !c.archived_at).sort((a, b) => (b.last_at || 0) - (a.last_at || 0));

// conversations: already in order (latestFirst). ariaLabel names the list when its visible label isn't enough.
export default function ConversationPick({ conversations, value, onChange, ariaLabel, disabled }) {
  const [find, setFind] = useState('');
  const list = conversations || [];
  const shown = list.filter((c) => has(conversationName(c), find));
  const narrow = (v) => {
    setFind(v);
    const left = list.filter((c) => has(conversationName(c), v));
    if (!left.some((c) => c.id === value)) onChange(left[0]?.id || '');
  };
  return (
    <>
      {list.length > 6 && <input type="search" placeholder="Find a conversation" aria-label="Find by name" value={find} onChange={(e) => narrow(e.target.value)} />}
      <label className="field"><span>To</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} required disabled={disabled} {...(ariaLabel && { 'aria-label': ariaLabel })}>
          {shown.map((c) => <option key={c.id} value={c.id}>{conversationName(c)}</option>)}
        </select>
      </label>
      {list.length > 0 && !shown.length && <p className="muted small">No conversation is called that.</p>}
    </>
  );
}
