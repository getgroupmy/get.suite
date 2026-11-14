// Admin → Security checkup: the company's open security points, worst first, each with a way to the fix.
import { useEffect, useState } from 'react';
import { get, post, patch } from '../../api.js';
import { ConfirmModal, useToast } from '../../components/ui.jsx';

const TAB_NAMES = { users: 'Users', company: 'Company settings', links: 'Share links', phishing: 'Phishing', email: 'Email' };
const MARK = { warn: ['⚠', 'Needs attention'], tip: ['💡', 'Worth doing'], ok: ['✓', 'Done'] };

export default function CheckupAdmin({ onGo }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [reload, setReload] = useState(0);
  const [suspending, setSuspending] = useState(null); // the "not used" item, while confirming
  useEffect(() => { get('/orgs/current/checkup').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error')); }, [toast, reload]);
  if (!items) return null;
  const warns = items.filter((x) => x.status === 'warn').length;
  return (
    <section className="card stack" aria-labelledby="checkup-h">
      <h2 id="checkup-h">Security checkup</h2>
      <p role="status" className={warns ? 'checkup-summary warn' : 'checkup-summary'}>
        {warns ? `${warns} thing${warns === 1 ? '' : 's'} need${warns === 1 ? 's' : ''} attention` : 'Nothing urgent: a few things may still be worth doing.'}
      </p>
      <ul className="checkup-list" aria-label="Checkup">
        {items.map((x) => (
          <li key={x.id} className={`checkup-item ${x.status}`}>
            <span className="checkup-mark" aria-hidden="true">{MARK[x.status][0]}</span>
            <div className="grow">
              <strong>{x.title}</strong> <span className="sr-only">({MARK[x.status][1]})</span>
              {x.detail && <p className="small" style={{ margin: '2px 0 0' }}>{x.detail}</p>}
            </div>
            {x.remind && <button type="button" className="btn small" aria-label={`Remind them: ${x.title}`} onClick={async () => {
              try { const r = await post(`/orgs/current/checkup/remind-${x.remind}`); toast(`Reminded ${r.reminded} ${r.reminded === 1 ? 'person' : 'people'} ${x.remind === 'recovery' ? 'to add a recovery email' : 'to add a second step'}`); } catch (e) { toast(e.message, 'error'); }
            }}>Remind them</button>}
            {x.fix && <button type="button" className="btn small primary" onClick={async () => {
              try { await patch('/orgs/current', x.fix.settings); toast(`Done: ${x.fix.label.toLowerCase()}`); setReload((n) => n + 1); } catch (e) { toast(e.message, 'error'); }
            }}>{x.fix.label}</button>}
            {x.id === 'inactive' && x.ids?.length > 0 && <button type="button" className="btn small" onClick={() => setSuspending(x)}>Suspend {x.ids.length === 1 ? 'this account' : `these ${x.ids.length} accounts`}</button>}
            {x.status !== 'ok' && x.tab && TAB_NAMES[x.tab] && <button type="button" className="btn small" onClick={() => onGo(x.tab)}>Go to {TAB_NAMES[x.tab]}</button>}
          </li>
        ))}
      </ul>
      {suspending && <ConfirmModal title={`Suspend ${suspending.ids.length === 1 ? suspending.people[0] : `${suspending.ids.length} accounts`}?`} confirm="Suspend"
        message={`${suspending.people.join(', ')}: they're signed out everywhere and can't sign in until restored (Admin → Users). Their mail keeps arriving and nothing is deleted.`}
        onClose={() => setSuspending(null)} onConfirm={async () => {
          try { const r = await post('/users/bulk', { ids: suspending.ids, action: 'suspend' }); toast(`Suspended ${r.done}${r.skipped.length ? ` (skipped: ${r.skipped.map((x) => `${x.name}: ${x.reason}`).join('; ')})` : ''}`); setReload((n) => n + 1); }
          catch (e) { toast(e.message, 'error'); }
        }} />}
    </section>
  );
}
