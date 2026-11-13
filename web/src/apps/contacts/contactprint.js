// Printing contacts as an address list: a table of name, email, phone and company (with their title and address),
// alphabetical as shown, for a desk, a binder, or a PDF.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The page to print for contacts ([{ name, email, phone, company, title, address, more_emails, more_phones }]). */
export function contactsPrintHtml(list, { title = 'Contacts', date = new Date() } = {}) {
  const lines = (main, more) => [main, ...(more || []).map((m) => m.value)].filter(Boolean).map(esc).join('<br>');
  const rows = list.map((c) => `<tr><td class="name">${esc(c.name)}${c.title ? `<div class="sub">${esc(c.title)}</div>` : ''}</td>`
    + `<td>${lines(c.email, c.more_emails)}</td><td>${lines(c.phone, c.more_phones)}</td>`
    + `<td>${esc(c.company || '')}${c.address ? `<div class="sub">${esc(c.address).replace(/\n/g, '<br>')}</div>` : ''}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { font: 12px/1.45 system-ui, sans-serif; color: #000; margin: 20px; } h1 { font-size: 18px; margin: 0 0 2px; } .when { color: #555; margin: 0 0 12px; }
    table { border-collapse: collapse; width: 100%; } th { text-align: left; border-bottom: 2px solid #000; padding: 4px 8px 4px 0; }
    td { border-bottom: 1px solid #ccc; padding: 5px 8px 5px 0; vertical-align: top; overflow-wrap: anywhere; } tr { break-inside: avoid; }
    .name { font-weight: 600; } .sub { color: #555; font-weight: normal; font-size: 11px; }
  </style></head><body><h1>${esc(title)}</h1><p class="when">${list.length} ${list.length === 1 ? 'person' : 'people'} · ${esc(date.toLocaleDateString([], { dateStyle: 'long' }))}</p>
  <table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Company</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
