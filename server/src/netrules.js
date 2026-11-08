// Company networks: a company can allow Workspace only from its own networks (offices, VPN), as a
// list of addresses and ranges (orgs.allowed_nets, one per line; empty: from anywhere). Signing in
// and every request are checked; the platform owner is never shut out this way.
import net from 'node:net';
import { q } from './db.js';
import { parseCidr, normalizeIp } from './security/guard.js';

if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'allowed_nets')) q('ALTER TABLE orgs ADD COLUMN allowed_nets TEXT').run();

const family = (ip) => (net.isIPv6(ip) ? 'ipv6' : 'ipv4');
const lists = new Map(); // text → BlockList

/** The list as entered, checked and tidied (throws a message for a bad entry). */
export function readNets(value) {
  const entries = (Array.isArray(value) ? value : String(value ?? '').split(/[\n,]+/)).map((e) => String(e).trim()).filter(Boolean);
  if (entries.length > 100) throw new Error('Up to 100 addresses and ranges');
  const out = [];
  for (const e of entries) {
    const c = parseCidr(e);
    if (!c) throw new Error(`“${e}” is not an address or range (like 203.0.113.7 or 203.0.113.0/24)`);
    if (!out.includes(c.text)) out.push(c.text);
  }
  return out;
}

/** Is this address inside these ranges? */
export function inNets(ip, nets) {
  const key = nets.join('\n');
  if (!lists.has(key)) {
    const bl = new net.BlockList();
    for (const t of nets) { const c = parseCidr(t); bl.addSubnet(c.ip, c.prefix, family(c.ip)); }
    lists.set(key, bl);
  }
  const a = normalizeIp(ip);
  return net.isIP(a) ? lists.get(key).check(a, family(a)) : false;
}

/** May this person use Workspace from this address? */
export function networkAllowed(user, ip) {
  if (user.is_super) return true;
  const raw = q('SELECT allowed_nets FROM orgs WHERE id = ?').get(user.org_id)?.allowed_nets;
  if (!raw) return true;
  return inNets(ip, raw.split('\n').filter(Boolean));
}
export const NETWORK_REFUSED = 'Your company only allows Workspace from its own networks (the office or its VPN). Connect to one and try again.';
