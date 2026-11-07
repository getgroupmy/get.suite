// Printing a message: a plain page with its headers and body, printed from a hidden frame that
// can't run anything the message contains.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address || '') : '');
const list = (l) => (l || []).map(who).join(', ');

/** The page to print for a message ({ from, to, cc, date, subject, html | text, attachments }). */
export function printDocument(m, { images = false } = {}) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${images ? ' https: http:' : ''}`;
  const rows = [['From', who(m.from)], ['To', list(m.to)], ['Cc', list(m.cc)], ['Date', m.date ? new Date(m.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }) : '']]
    .filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}:</th><td>${esc(v)}</td></tr>`).join('');
  const files = (m.attachments || []).length ? `<p class="files">Attachments: ${m.attachments.map((a) => esc(a.filename || a.name || 'file')).join(', ')}</p>` : '';
  const body = m.html ? m.html : `<pre>${esc(m.text)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(m.subject || '(no subject)')}</title>
<style>body{margin:24px;font:13px/1.5 system-ui,sans-serif;color:#000;background:#fff;overflow-wrap:anywhere}h1{font-size:18px;margin:0 0 8px}
table.head{border-collapse:collapse;margin-bottom:12px}table.head th{text-align:left;padding:1px 10px 1px 0;color:#555;font-weight:600;vertical-align:top}
.files{color:#555}hr{border:0;border-top:1px solid #bbb;margin:12px 0}pre{white-space:pre-wrap;font:inherit}img{max-width:100%;height:auto}</style></head>
<body><h1>${esc(m.subject || '(no subject)')}</h1><table class="head">${rows}</table>${files}<hr><div class="message">${body}</div></body></html>`;
}

/** Print it: a hidden frame (no scripts) holds the page; the browser's print dialog opens. */
export function printMessage(m, opts) { return printHtml(printDocument(m, opts)); }

/** Print a page of HTML from a hidden frame that can't run scripts. */
export function printHtml(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.className = 'print-frame';
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.srcdoc = html;
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { /* the page stays; nothing to clean */ }
    setTimeout(() => frame.remove(), 60e3);
  };
  document.body.appendChild(frame);
  return frame;
}
