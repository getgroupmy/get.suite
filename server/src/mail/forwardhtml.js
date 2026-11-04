// Turn a received email's HTML into a safe body for a normal forward: the text with basic
// formatting (paragraphs, line breaks, bold/italic/underline/strike, lists, quotes, links) and the
// pictures embedded in it. Everything else — scripts, styles, forms, tracking pixels and pictures
// loaded from the internet — is dropped. The result only ever contains the handful of tags the
// message editor knows, so nothing from the original can run or phone home.
import { parseDocument } from 'htmlparser2';

const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'button', 'select', 'textarea', 'input', 'video', 'audio', 'canvas', 'map']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'address', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'dl', 'dt', 'dd', 'pre', 'hr', 'fieldset', 'details', 'summary']);
const MARKS = { b: 'strong', strong: 'strong', i: 'em', em: 'em', cite: 'em', u: 'u', ins: 'u', s: 's', strike: 's', del: 's' };
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th']);
const MAX_OUT = 1_000_000;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeHref = (h) => {
  const v = String(h || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(v) && !/[\s<>"]/.test(v) ? v : null;
};

/**
 * @param {string} html  the original's HTML (parsed with cid: links kept)
 * @param {(cid: string) => string | null} pictureUrl  where the editor can show an embedded picture, or null to drop it
 * @returns {{ html: string, pictures: number }}
 */
export function forwardHtml(html, pictureUrl) {
  const doc = parseDocument(String(html || ''), { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  let pictures = 0;

  // A "flow" is the content of the body, a list item or a quote: paragraphs, pictures, lists, quotes.
  function flow(nodes) {
    const out = [];
    let para = ''; // the paragraph being built (inline HTML)
    const flush = () => {
      if (para.replace(/<br>/g, '').trim()) out.push(`<p>${para.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '')}</p>`);
      para = '';
    };

    function inline(node, marks, pre) {
      if (node.type === 'text') {
        let t = node.data;
        if (pre) t = esc(t).replace(/\r?\n/g, '<br>');
        else t = esc(t.replace(/[\s ]+/g, (w) => (w.includes(' ') ? ' ' : ' ')));
        if (!t) return;
        if (!para || /<br>$/.test(para)) t = t.replace(/^ /, '');
        let wrapped = t;
        for (const m of [...marks].reverse()) wrapped = m.open + wrapped + m.close;
        para += wrapped;
        return;
      }
      if (node.type !== 'tag') return; // comments, CDATA, directives
      const tag = node.name;
      if (SKIP.has(tag)) return;
      const a = node.attribs || {};
      if (tag === 'br') { para += '<br>'; return; }
      if (tag === 'img') {
        const src = String(a.src || '').trim();
        const url = /^cid:/i.test(src) ? pictureUrl(src.slice(4).replace(/^<|>$/g, '')) : null;
        if (!url) return; // remote and data: pictures are left out
        flush();
        const alt = String(a.alt || '').slice(0, 200);
        out.push(`<img src="${esc(url)}" alt="${esc(alt)}">`);
        pictures++;
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = (node.children || []).filter((c) => c.type === 'tag' && c.name === 'li');
        if (!items.length) { kids(node, marks, pre); return; }
        flush();
        out.push(`<${tag}>${items.map((li) => `<li>${flow(li.children || []) || '<p></p>'}</li>`).join('')}</${tag}>`);
        return;
      }
      if (tag === 'blockquote') {
        flush();
        const body = flow(node.children || []);
        if (body) out.push(`<blockquote>${body}</blockquote>`);
        return;
      }
      if (tag === 'hr') { flush(); return; }
      let next = marks;
      if (MARKS[tag]) next = [...marks, { open: `<${MARKS[tag]}>`, close: `</${MARKS[tag]}>` }];
      if (HEADINGS.has(tag)) next = [...next, { open: '<strong>', close: '</strong>' }];
      if (tag === 'a') {
        const href = safeHref(a.href);
        if (href && !marks.some((m) => m.link)) next = [...next, { open: `<a href="${esc(href)}">`, close: '</a>', link: true }];
      }
      const block = BLOCK.has(tag) || tag === 'li';
      if (block) flush();
      kids(node, next, pre || tag === 'pre');
      if (block) flush();
      else if (tag === 'td' || tag === 'th') para += ' ';
    }
    const kids = (node, marks, pre) => { for (const c of node.children || []) inline(c, marks, pre); };

    for (const n of nodes) inline(n, [], false);
    flush();
    return out.join('');
  }

  const body = doc.children.find?.((n) => n.type === 'tag' && n.name === 'html')?.children?.find((n) => n.type === 'tag' && n.name === 'body');
  let out = flow((body || doc).children || []);
  if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT).replace(/<[^>]*$/, '');
  return { html: out, pictures };
}
