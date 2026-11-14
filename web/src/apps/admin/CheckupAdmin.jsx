// Admin → Security checkup: the company's open security points, worst first, each with a way to the fix.
import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { useToast } from '../../components/ui.jsx';

const TAB_NAMES = { users: 'Users', company: 'Company settings', links: 'Share links', phishing: 'Phishing', email: 'Email' };
const MARK = { warn: ['⚠', 'Needs attention'], tip: ['💡', 'Worth doing'], ok: ['✓', 'Done'] };

export default function CheckupAdmin({ onGo }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  useEffect(() => { get('/orgs/current/checkup').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error')); }, [toast]);
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
            {x.status !== 'ok' && x.tab && TAB_NAMES[x.tab] && <button type="button" className="btn small" onClick={() => onGo(x.tab)}>Go to {TAB_NAMES[x.tab]}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
