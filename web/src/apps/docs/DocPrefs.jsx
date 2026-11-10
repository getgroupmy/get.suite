// Tools → Preferences (Docs): spell check, autocorrect while typing, and your own replacements. Kept on the server
// for you, so they follow you to other devices.
import { useState } from 'react';
import { Modal, useToast } from '../../components/ui.jsx';
import { put } from '../../api.js';
import { BUILT_IN } from './autocorrect.js';

export function DocPrefsDialog({ prefs, onSaved, onClose }) {
  const toast = useToast();
  const [on, setOn] = useState(prefs.autocorrect);
  const [spell, setSpell] = useState(prefs.spellcheck !== false);
  const [subs, setSubs] = useState(prefs.subs.length ? prefs.subs : []);
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const add = () => {
    const f = from.trim();
    if (!f || /\s/.test(f) || !to) return;
    setSubs([...subs.filter((s) => s.from !== f), { from: f, to }]);
    setFrom(''); setTo('');
  };
  const save = async () => {
    try { const p = await put('/doc-prefs', { autocorrect: on, subs, spellcheck: spell }); onSaved(p); toast('Preferences saved'); onClose(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title="Preferences" onClose={onClose} wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <label className="check"><input type="checkbox" checked={spell} onChange={(e) => setSpell(e.target.checked)} /> Underline misspelt words (spell check)</label>
        <p className="muted small" style={{ margin: 0 }}>Your browser checks the spelling, in its own languages; right-click an underlined word for suggestions.</p>
        <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Autocorrect while typing</label>
        <p className="muted small" style={{ margin: 0 }}>
          Curly quotes, and {BUILT_IN.map(([a, b]) => `${a} → ${b}`).join(', ')}. Press Backspace straight after a change to keep what you typed.
        </p>
        <h3 className="small" style={{ margin: '8px 0 0' }}>Your replacements</h3>
        <p className="muted small" style={{ margin: 0 }}>Type the short form and a space (or punctuation) and it becomes the long one: <i>addr</i> → your address.</p>
        {subs.length > 0 && (
          <ul className="doc-subs" aria-label="Your replacements">
            {subs.map((s) => (
              <li key={s.from}><code>{s.from}</code><span aria-hidden="true">→</span><span className="grow">{s.to}</span>
                <button type="button" className="link-btn small" aria-label={`Remove ${s.from}`} onClick={() => setSubs(subs.filter((x) => x.from !== s.from))}>Remove</button></li>
            ))}
          </ul>
        )}
        <div className="row" style={{ gap: 8, alignItems: 'end' }}>
          <label className="field"><span>Replace</span><input value={from} maxLength={40} onChange={(e) => setFrom(e.target.value.replace(/\s/g, ''))} placeholder="addr" /></label>
          <label className="field grow"><span>With</span><input value={to} maxLength={500} onChange={(e) => setTo(e.target.value)} placeholder="12 High Street, Leeds" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /></label>
          <button type="button" className="btn" disabled={!from.trim() || !to} onClick={add}>Add</button>
        </div>
      </div>
    </Modal>
  );
}
