// Printing a form's responses: each response on its own page (when it came, who sent it, the score of a quiz), then
// every question with the answer as the Individual view shows it, for paper records or a PDF.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GRIDS = new Set(['grid', 'checkgrid']);
/** A signature answer: the PNG picture drawn (or typed) on the form. */
export const isSignature = (a) => typeof a === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(a);

/** One answer as text: grids row by row, rankings numbered, files by name, lists joined. */
export function answerText(q, a) {
  if (a === undefined || a === null || a === '') return null;
  if (GRIDS.has(q.type)) return (q.rows || []).filter((row) => a[row] !== undefined).map((row) => `${row}: ${[a[row]].flat().join(', ')}`).join('\n');
  if (q.type === 'signature') return 'Signed';
  if (q.type === 'file' && Array.isArray(a)) return a.map((f) => `📎 ${f.name}`).join(', ');
  if (q.type === 'rank' && Array.isArray(a)) return a.map((o, k) => `${k + 1}. ${o}`).join('\n');
  return Array.isArray(a) ? a.join(', ') : String(a);
}

/** The page to print: the form's title, then each response as a page. */
export function responsesPrintHtml(form, responses, { when = (t) => new Date(t).toLocaleString() } = {}) {
  const qs = (form.questions || []).filter((q) => q.type !== 'section');
  const page = (r, i) => {
    const who = r.user ? `${r.user.name} (${r.user.email})` : r.email || '';
    const score = r.max > 0 ? ` · ${r.score} / ${r.max}` : '';
    const rows = qs.map((q) => {
      const t = answerText(q, r.answers?.[q.id]);
      const mark = r.right && q.id in r.right ? (r.right[q.id] ? ' ✓' : ' ✗') : '';
      const shown = q.type === 'signature' && isSignature(r.answers?.[q.id]) ? `<img class="sig" src="${esc(r.answers[q.id])}" alt="Signature">` : t === null ? 'No answer' : esc(t).replace(/\n/g, '<br>');
      return `<div class="q"><div class="t">${esc(q.title || 'Untitled question')}${mark}</div><div class="a${t === null ? ' none' : ''}">${shown}</div></div>`;
    }).join('');
    return `<section class="r"><h1>${esc(form.title || 'Form')}</h1><p class="meta">Response ${i + 1} of ${responses.length} · ${esc(when(r.created_at))}${who ? ` · ${esc(who)}` : ''}${esc(score)}</p>${rows}</section>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(form.title || 'Form')}: responses</title><style>
    body { font: 13px/1.5 system-ui, sans-serif; color: #000; margin: 24px; } h1 { font-size: 18px; margin: 0; } .meta { color: #555; margin: 2px 0 14px; }
    .q { margin: 0 0 12px; break-inside: avoid; } .t { font-weight: 600; } .a { white-space: normal; overflow-wrap: anywhere; } .none { color: #777; font-style: italic; } .sig { max-width: 240px; max-height: 80px; display: block; }
    section.r + section.r { break-before: page; }
  </style></head><body>${responses.map(page).join('')}</body></html>`;
}

/** A blank copy of the form to fill in on paper: each question with room to answer (circles, boxes, lines, grids). */
export function blankFormHtml(form) {
  const box = (round) => `<span class="${round ? 'o' : 'b'}"></span>`;
  const lines = (n) => Array.from({ length: n }, () => '<div class="line"></div>').join('');
  const field = (q) => {
    switch (q.type) {
      case 'choice': case 'dropdown': case 'checkbox': {
        const round = q.type !== 'checkbox';
        const opts = (q.options || []).map((o) => `<div class="opt">${box(round)} ${esc(o)}</div>`).join('');
        return opts + (q.other ? `<div class="opt">${box(round)} Other: <span class="fill"></span></div>` : '');
      }
      case 'rank': return `${(q.options || []).map((o) => `<div class="opt"><span class="num"></span> ${esc(o)}</div>`).join('')}<p class="hint">Number them in order, 1 first.</p>`;
      case 'scale': return `<div class="scale">${q.low ? `<span>${esc(q.low)}</span>` : ''}${Array.from({ length: q.max || 5 }, (_, i) => `<span class="cell">${box(true)}<br>${i + 1}</span>`).join('')}${q.high ? `<span>${esc(q.high)}</span>` : ''}</div>`;
      case 'rating': return `<div class="scale">${Array.from({ length: q.max || 5 }, (_, i) => `<span class="cell">${box(true)}<br>${i + 1}</span>`).join('')}</div>`;
      case 'grid': case 'checkgrid': return `<table class="grid"><tr><th></th>${(q.columns || []).map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${(q.rows || []).map((r) => `<tr><th>${esc(r)}</th>${(q.columns || []).map(() => `<td>${box(q.type === 'grid')}</td>`).join('')}</tr>`).join('')}</table>`;
      case 'date': return '<div class="short">____ / ____ / ________</div>';
      case 'time': return '<div class="short">____ : ____</div>';
      case 'paragraph': return lines(4);
      case 'signature': return `${lines(1)}<p class="hint">Sign here.</p>`;
      case 'file': return '<p class="hint">(A file is attached to this answer online.)</p>';
      default: return lines(1);
    }
  };
  let n = 0;
  const body = (form.questions || []).map((q) => {
    if (q.type === 'section') return `<h2 class="section">${esc(q.title || 'Section')}</h2>${q.help ? `<p class="help">${esc(q.help)}</p>` : ''}`;
    n += 1;
    return `<div class="q"><div class="t">${n}. ${esc(q.title || 'Untitled question')}${q.required ? ' <span class="req">*</span>' : ''}</div>${q.help ? `<p class="help">${esc(q.help)}</p>` : ''}${field(q)}</div>`;
  }).join('');
  const anyRequired = (form.questions || []).some((q) => q.required);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(form.title || 'Form')}</title><style>
    body { font: 13px/1.5 system-ui, sans-serif; color: #000; margin: 28px; } h1 { font-size: 20px; margin: 0 0 4px; } .desc { margin: 0 0 6px; white-space: pre-wrap; }
    .q { margin: 0 0 18px; break-inside: avoid; } .t { font-weight: 600; } .help, .hint { color: #555; margin: 2px 0 6px; font-size: 12px; } .req { color: #b00; }
    .opt { margin: 4px 0 0 4px; } .o, .b { display: inline-block; width: 12px; height: 12px; border: 1.5px solid #000; vertical-align: -2px; } .o { border-radius: 50%; }
    .num { display: inline-block; width: 26px; border-bottom: 1px solid #000; height: 14px; vertical-align: -3px; } .fill { display: inline-block; width: 60%; border-bottom: 1px solid #000; }
    .line { border-bottom: 1px solid #000; height: 24px; } .short { margin-top: 8px; letter-spacing: 1px; }
    .scale { display: flex; gap: 14px; align-items: center; margin-top: 6px; } .cell { text-align: center; font-size: 11px; }
    table.grid { border-collapse: collapse; margin-top: 6px; } .grid th, .grid td { padding: 4px 10px; text-align: center; font-weight: normal; } .grid tr th:first-child { text-align: left; }
    h2.section { font-size: 16px; break-before: page; margin: 0 0 6px; border-bottom: 1px solid #000; } .note { color: #555; font-size: 12px; margin: 0 0 16px; }
  </style></head><body><h1>${esc(form.title || 'Form')}</h1>${form.description ? `<p class="desc">${esc(form.description)}</p>` : ''}${anyRequired ? '<p class="note"><span class="req">*</span> Required</p>' : ''}${body}</body></html>`;
}

/** The Summary as a report to print: per question, how many answered, bars with counts and shares, grids, rankings, written answers. */
export function summaryPrintHtml(form, summary, { count = 0, date = new Date() } = {}) {
  const pct = (s) => `${Math.round(s * 100)}%`;
  const bars = (list) => `<table class="bars">${list.map((b) => `<tr><td class="l">${esc(b.label)}</td><td class="bar"><span style="width:${pct(b.share)}"></span></td><td class="n">${b.count} (${pct(b.share)})</td></tr>`).join('')}</table>`;
  const block = (s) => {
    let inner = '';
    if (s.grid) inner = `<table class="grid"><tr><th></th>${(s.grid[0]?.bars || []).map((b) => `<th>${esc(b.label)}</th>`).join('')}</tr>${s.grid.map((g) => `<tr><th>${esc(g.row)}</th>${g.bars.map((b) => `<td>${b.count}</td>`).join('')}</tr>`).join('')}</table>`;
    else if (s.bars) inner = bars(s.bars);
    else if (s.ranks) inner = `<ol>${s.ranks.map((r) => `<li>${esc(r.label)} <span class="m">${r.average == null ? 'not ranked' : `average place ${r.average}`}${r.first ? ` · first for ${r.first}` : ''}</span></li>`).join('')}</ol>`;
    else if (s.signatures) inner = `<div class="sigs">${s.signatures.filter(isSignature).slice(0, 60).map((src) => `<img class="sig" src="${esc(src)}" alt="Signature">`).join('')}</div>`;
    else if (s.files) inner = `<ul>${s.files.slice(0, 200).map((f) => `<li>📎 ${esc(f.name)}</li>`).join('')}</ul>`;
    else if (s.texts) inner = `<ul>${s.texts.slice(0, 200).map((t) => `<li>${esc(t).replace(/\n/g, '<br>')}</li>`).join('')}</ul>${s.texts.length > 200 ? `<p class="m">…and ${s.texts.length - 200} more</p>` : ''}`;
    const others = s.others?.length ? `<p class="m">Other: ${s.others.slice(0, 50).map(esc).join(' · ')}</p>` : '';
    return `<section class="q"><h2>${esc(s.title || 'Untitled question')}</h2><p class="m">${s.answered === 1 ? '1 answer' : `${s.answered} answers`}${s.average !== undefined ? ` · average ${s.average}` : ''}</p>${inner}${others}</section>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(form.title || 'Form')}: summary</title><style>
    body { font: 13px/1.45 system-ui, sans-serif; color: #000; margin: 24px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h1 { font-size: 20px; margin: 0; } h2 { font-size: 14px; margin: 0; } .m { color: #555; margin: 2px 0 6px; font-size: 12px; }
    .q { margin: 0 0 18px; break-inside: avoid; } table.bars { border-collapse: collapse; width: 100%; } .bars td { padding: 2px 6px 2px 0; }
    .bars .l { width: 30%; } .bars .bar { width: 50%; } .bars .bar span { display: block; height: 12px; background: #1a73e8; min-width: 1px; } .bars .n { white-space: nowrap; color: #333; } .sigs { display: flex; flex-wrap: wrap; gap: 8px; } .sig { max-width: 160px; max-height: 60px; border-bottom: 1px solid #999; }
    table.grid { border-collapse: collapse; } .grid th, .grid td { border: 1px solid #ccc; padding: 3px 8px; text-align: center; } .grid tr th:first-child { text-align: left; }
    ul, ol { margin: 4px 0 0; padding-left: 20px; }
  </style></head><body><h1>${esc(form.title || 'Form')}</h1><p class="m">${count === 1 ? '1 response' : `${count} responses`} · ${esc(date.toLocaleDateString([], { dateStyle: 'long' }))}</p>${summary.map(block).join('')}</body></html>`;
}
