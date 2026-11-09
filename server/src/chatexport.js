// A chat conversation to keep (Chat → ⋮ → Download conversation): every message in order, replies
// under the message they answer, with who wrote it and when (in the reader's time zone), attached
// files by name, and polls with their results. As plain text, or a page that reads well and prints.

const zoneOf = (tz) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'UTC'; } };
const stamp = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const dayOf = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms));
const timeOf = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A poll's results in words: "Lunch? — Pizza 3, Sushi 1". */
export function pollLine(poll) {
  if (!poll?.question) return '';
  return `📊 ${poll.question} — ${(poll.options || []).map((o) => `${o.text} ${Array.isArray(o.votes) ? o.votes.length : o.votes ?? 0}`).join(', ')}`;
}

/** Messages as kept: [{ who, at, body, edited, files: [names], poll, replies: [...] }] (oldest first). */
export function conversationText(title, messages, { tz = 'UTC', now = Date.now() } = {}) {
  const zone = zoneOf(tz);
  const lines = [`${title}`, `Downloaded ${stamp(now, zone)} (${zone}) · ${messages.length} message${messages.length === 1 ? '' : 's'}`, ''];
  let day = '';
  const one = (m, indent) => {
    const pad = indent ? '    ↳ ' : '';
    lines.push(`${pad}[${stamp(m.at, zone)}] ${m.who}${m.edited ? ' (edited)' : ''}:`);
    for (const l of String(m.body || '').split('\n')) if (l || !m.body) lines.push(`${indent ? '      ' : '  '}${l}`);
    for (const f of m.files || []) lines.push(`${indent ? '      ' : '  '}📎 ${f}`);
    if (m.poll) lines.push(`${indent ? '      ' : '  '}${pollLine(m.poll)}`);
  };
  for (const m of messages) {
    const d = dayOf(m.at, zone);
    if (d !== day) { if (day) lines.push(''); lines.push(`— ${d} —`); day = d; }
    one(m, false);
    for (const r of m.replies || []) one(r, true);
  }
  return `${lines.join('\n')}\n`;
}

export function conversationHtml(title, messages, { tz = 'UTC', now = Date.now() } = {}) {
  const zone = zoneOf(tz);
  let day = '';
  const msg = (m, reply) => `<div class="m${reply ? ' r' : ''}"><div class="h"><b>${esc(m.who)}</b> <span>${esc(timeOf(m.at, zone))}${m.edited ? ' · edited' : ''}</span></div>`
    + (m.body ? `<div class="b">${esc(m.body)}</div>` : '')
    + (m.files || []).map((f) => `<div class="f">📎 ${esc(f)}</div>`).join('')
    + (m.poll ? `<div class="f">${esc(pollLine(m.poll))}</div>` : '') + '</div>';
  const body = messages.map((m) => {
    const d = dayOf(m.at, zone);
    const head = d !== day ? `<h2>${esc(d)}</h2>` : '';
    day = d;
    return head + msg(m, false) + (m.replies || []).map((r) => msg(r, true)).join('');
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#202124}
h1{font-size:20px;margin:0}p.meta{color:#5f6368;margin:4px 0 16px}h2{font-size:13px;color:#5f6368;border-bottom:1px solid #e0e0e0;padding-bottom:4px;margin:20px 0 8px}
.m{margin:8px 0}.m.r{margin-left:28px;padding-left:10px;border-left:2px solid #e0e0e0}.h span{color:#5f6368;font-size:12px}.b{white-space:pre-wrap;overflow-wrap:anywhere}.f{color:#5f6368;font-size:13px}
</style></head><body><h1>${esc(title)}</h1><p class="meta">Downloaded ${esc(stamp(now, zone))} (${esc(zone)}) · ${messages.length} message${messages.length === 1 ? '' : 's'}</p>
${body}
</body></html>`;
}
