// Quoted history in a reply: the earlier messages copied under it ("On … wrote:" and a quote, Gmail's
// and Outlook's blocks, "> " lines in plain text). The reader shows the new part and folds the rest
// away behind a button. Only a quote at the end counts, and only when something comes before it.

const textOf = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();

// Where a quoted history starts, in the HTML of the major mail programs (and Workspace's own replies).
const HTML_MARKERS = [
  /<div[^>]*class=["'][^"']*gmail_quote[^"']*["']/i, // Gmail
  /<blockquote[^>]*type=["']cite["']/i, // Apple Mail, Thunderbird
  /<div[^>]*id=["'](?:appendonsend|divRplyFwdMsg)["']/i, // Outlook
  /<div[^>]*class=["'][^"']*(?:moz-cite-prefix|yahoo_quoted)[^"']*["']/i, // Thunderbird's "On … wrote:", Yahoo
  /<hr[^>]*>\s*(?:<[^>]+>\s*)*<b>\s*From:\s*<\/b>/i, // Outlook on the web
  /<p>\s*On [^<]{4,300}? wrote:\s*<\/p>\s*<blockquote/i, // Workspace and others: a line, then the quote
];

/** { main, quoted } for an HTML body; quoted is null when there's no history to fold away. */
export function splitHtmlQuote(html) {
  const s = String(html || '');
  let at = -1;
  for (const re of HTML_MARKERS) { const m = re.exec(s); if (m && (at < 0 || m.index < at)) at = m.index; }
  if (at <= 0) return { main: s, quoted: null };
  const main = s.slice(0, at), quoted = s.slice(at);
  if (!textOf(main) || textOf(quoted).length < 2) return { main: s, quoted: null };
  return { main, quoted };
}

/** { main, quoted } for a plain-text body. */
export function splitTextQuote(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  // The quote runs to the end: "> " lines (blank lines allowed), maybe headed by "On … wrote:".
  let start = lines.length;
  while (start > 0 && (/^\s*>/.test(lines[start - 1]) || !lines[start - 1].trim())) start--;
  const quotedLines = lines.slice(start).filter((l) => /^\s*>/.test(l)).length;
  let at = quotedLines >= 1 ? start : -1;
  if (at >= 0) {
    let k = at - 1;
    while (k >= 0 && !lines[k].trim()) k--;
    if (k >= 0 && /wrote:\s*$/i.test(lines[k]) && /^(On|Am|Le|El|Il|Op)\b/.test(lines[k].trim())) at = k;
    else if (k >= 1 && /wrote:\s*$/i.test(lines[k]) && /^(On|Am|Le)\b/.test(lines[k - 1].trim())) at = k - 1; // the line wrapped
  }
  // Outlook's plain text: "-----Original Message-----" or a From:/Sent: block to the end.
  const orig = lines.findIndex((l) => /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(l.trim()));
  if (orig > 0 && (at < 0 || orig < at)) at = orig;
  if (at <= 0) return { main: String(text || ''), quoted: null };
  const main = lines.slice(0, at).join('\n').replace(/\s+$/, ''), quoted = lines.slice(at).join('\n');
  if (!main.trim()) return { main: String(text || ''), quoted: null };
  return { main, quoted };
}
