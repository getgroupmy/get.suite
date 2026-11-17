// 👏 on a thank-you (Home's Thanks card, a person's card): join in, or take yours off. Not on your own.
import { useState } from 'react';
import { post } from '../api.js';
import { useToast } from './ui.jsx';

export default function Clap({ kudos, onChange }) {
  const toast = useToast();
  const [k, setK] = useState(kudos);
  const [from, setFrom] = useState(kudos);
  if (from !== kudos) { setFrom(kudos); setK(kudos); } // the list reloaded (someone clapped): take its numbers
  const who = k.clappers?.length ? `${k.clappers.join(', ')}${k.claps > k.clappers.length ? ` and ${k.claps - k.clappers.length} more` : ''}` : '';
  if (k.mine) return k.claps ? <span className="kudos-clap muted small" title={who}>👏 {k.claps}</span> : null;
  const toggle = async () => {
    const on = !k.clapped;
    setK({ ...k, clapped: on, claps: k.claps + (on ? 1 : -1) });
    try { const r = await post(`/kudos/${k.id}/clap`, { on }); setK(r); onChange?.(r); } catch (e) { setK(k); toast(e.message, 'error'); }
  };
  return (
    <button type="button" className={`kudos-clap ${k.clapped ? 'on' : ''}`} aria-pressed={k.clapped}
      aria-label={`👏 ${k.clapped ? 'Applauding' : 'Applaud'}: ${k.claps} ${k.claps === 1 ? 'person' : 'people'}${who ? ` (${who})` : ''}`}
      title={who || 'Join in on this thank-you'} onClick={toggle}>👏{k.claps > 0 && <span> {k.claps}</span>}</button>
  );
}
