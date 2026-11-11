// Is this server's address on a spam blocklist? Mail from a listed address is often refused or sent
// to Junk, and a self-hosted server can land on one after a single compromised account or a reused IP.
// Each list is a DNS zone: look up the IP's octets reversed under it (1.2.3.4 → 4.3.2.1.zen.spamhaus.org);
// an answer in 127.0.0.0/8 means listed, "no such name" means not.
export const BLOCKLISTS = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', remove: 'https://check.spamhaus.org/' },
  { zone: 'bl.spamcop.net', name: 'SpamCop', remove: 'https://www.spamcop.net/bl.shtml' },
  { zone: 'b.barracudacentral.org', name: 'Barracuda', remove: 'https://www.barracudacentral.org/rbl/removal-request' },
  { zone: 'psbl.surriel.com', name: 'PSBL', remove: 'https://psbl.org/' },
  { zone: 'bl.mailspike.net', name: 'Mailspike', remove: 'https://mailspike.org/' },
  { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT level 1', remove: 'https://www.uceprotect.net/en/rblcheck.php' },
];

const v4 = (ip) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)?.slice(1).every((n) => Number(n) <= 255);
/** Private, loopback and other addresses blocklists don't cover. */
export const isPublicV4 = (ip) => v4(ip) && !/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip);

/**
 * One list's verdict for an IP: { status: 'listed' | 'clear' | 'unknown', codes, note }.
 * Spamhaus answers 127.255.255.x when it won't answer (queries through a big public DNS service,
 * or too many): that isn't a listing.
 */
export async function lookup(ip, list, resolve4) {
  const name = `${ip.split('.').reverse().join('.')}.${list.zone}`;
  try {
    const answers = await resolve4(name);
    const codes = answers.filter((a) => a.startsWith('127.'));
    if (!codes.length) return { status: 'unknown', codes: [], note: 'Unexpected answer' };
    if (codes.every((a) => a.startsWith('127.255.255.'))) return { status: 'unknown', codes, note: 'The list wouldn’t answer this server (public DNS resolvers are refused): set MAIL_DNS_SERVERS to your own resolver' };
    return { status: 'listed', codes, note: null };
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return { status: 'clear', codes: [], note: null };
    return { status: 'unknown', codes: [], note: `Couldn’t ask (${e.code || e.message})` };
  }
}

/** Every list, for every public IPv4 address given. */
export async function checkBlocklists(ips, resolve4) {
  const out = [];
  for (const ip of ips.filter(isPublicV4)) {
    const lists = await Promise.all(BLOCKLISTS.map(async (l) => ({ ...l, ...(await lookup(ip, l, resolve4)) })));
    out.push({ ip, listed: lists.filter((l) => l.status === 'listed').length, lists });
  }
  return out;
}
