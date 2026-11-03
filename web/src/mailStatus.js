import { useEffect, useState } from 'react';
import { get } from './api.js';

let cached = null;
/** { enabled, address, identities } — fetched once per page load. */
export function useMailStatus() {
  const [status, setStatus] = useState(cached);
  useEffect(() => {
    if (cached) return;
    get('/mail/status').then((s) => { cached = s; setStatus(s); }).catch(() => setStatus({ enabled: false }));
  }, []);
  return status;
}
