// Equations between Docs (LaTeX, as typed in the equation box) and OpenDocument (MathML, in a formula object, as
// LibreOffice Math keeps them): fractions, powers and subscripts, roots, sums and integrals with their limits,
// functions, accents, Greek letters and the usual operators, \text{…}. latexToMathml writes the LaTeX alongside
// (an annotation), so our own come back exactly; mathmlToLatex reads anyone's MathML otherwise.
import { parseLatex, COMMAND_OF, NARY_OF, FUNCTIONS, ACCENTS, ACCENT_OF } from './omml.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mrow = (pieces) => `<mrow>${ml(pieces)}</mrow>`;
function ml(pieces = []) {
  let out = '';
  for (let k = 0; k < (pieces || []).length; k++) {
    const p = pieces[k];
    if (p.t === 'chr') {
      if (/[0-9.]/.test(p.c)) { let n = p.c; while (pieces[k + 1]?.t === 'chr' && /[0-9.]/.test(pieces[k + 1].c)) n += pieces[++k].c; out += `<mn>${esc(n)}</mn>`; }
      else if (/\p{L}/u.test(p.c)) out += `<mi>${esc(p.c)}</mi>`;
      else if (p.c === ' ') out += '<mspace width="0.5em"/>';
      else out += `<mo>${esc(p.c)}</mo>`;
    } else if (p.t === 'text') out += `<mtext>${esc(p.s)}</mtext>`;
    else if (p.t === 'grp') out += mrow(p.body);
    else if (p.t === 'frac') out += `<mfrac>${mrow(p.num)}${mrow(p.den)}</mfrac>`;
    else if (p.t === 'rad') out += p.deg ? `<mroot>${mrow(p.body)}${mrow(p.deg)}</mroot>` : `<msqrt>${ml(p.body)}</msqrt>`;
    else if (p.t === 'scr') {
      if (p.sub && p.sup) out += `<msubsup>${mrow(p.base)}${mrow(p.sub)}${mrow(p.sup)}</msubsup>`;
      else if (p.sup) out += `<msup>${mrow(p.base)}${mrow(p.sup)}</msup>`;
      else out += `<msub>${mrow(p.base)}${mrow(p.sub || [])}</msub>`;
    } else if (p.t === 'nary') {
      const op = `<mo stretchy="false">${p.chr}</mo>`, under = p.chr !== '∫' && p.chr !== '∮' && p.chr !== '∬' && p.chr !== '∭';
      const lim = p.sub && p.sup ? `<m${under ? 'underover' : 'subsup'}>${op}${mrow(p.sub)}${mrow(p.sup)}</m${under ? 'underover' : 'subsup'}>`
        : p.sub ? `<m${under ? 'under' : 'sub'}>${op}${mrow(p.sub)}</m${under ? 'under' : 'sub'}>` : p.sup ? `<m${under ? 'over' : 'sup'}>${op}${mrow(p.sup)}</m${under ? 'over' : 'sup'}>` : op;
      out += lim + ml(p.body);
    } else if (p.t === 'func') out += `<mi mathvariant="normal">${esc(p.name)}</mi>`;
    else if (p.t === 'acc') out += `<mover accent="true">${mrow(p.body)}<mo>${ACCENTS[p.accent]}</mo></mover>`;
  }
  return out;
}

/** LaTeX → a MathML document (a formula object's content.xml), with the LaTeX kept as an annotation. */
export function latexToMathml(latex) {
  const l = String(latex || '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><semantics>${mrow(parseLatex(l))}<annotation encoding="application/x-tex">${esc(l)}</annotation></semantics></math>`;
}

// ---- back: a small reader of MathML (namespace prefixes ignored)
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, kids: [] }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(String(xml)));) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[6] !== undefined) top.kids.push(unesc(m[6]));
    else if (m[3]) {
      const name = m[3].replace(/^.*:/, '');
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const a of (m[4] || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, '')] = unesc(a[2] ?? a[3] ?? '');
      const el = { name, attrs, kids: [] };
      top.kids.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  return root;
}
const els = (n) => n.kids.filter((k) => typeof k !== 'string');
const text = (n) => n.kids.map((k) => (typeof k === 'string' ? k : text(k))).join('');
const arg = (l) => ([...l].length === 1 ? l : `{${l}}`);
const chrLatex = (c) => (COMMAND_OF[c] ? `\\${COMMAND_OF[c]} ` : NARY_OF[c] ? `\\${NARY_OF[c]} ` : c === '{' || c === '}' ? `\\${c}` : c);
function tex(n) {
  const kids = els(n);
  const of = (k) => tex(k).trim();
  switch (n.name) {
    case 'mi': { const t = text(n).trim(); return [...t].length > 1 ? (FUNCTIONS.includes(t) ? `\\${t} ` : `\\operatorname{${t}}`) : chrLatex(t); }
    case 'mn': return text(n).trim();
    case 'mo': return [...text(n).trim()].map(chrLatex).join('');
    case 'mtext': return `\\text{${text(n)}}`;
    case 'mspace': return ' ';
    case 'mfrac': return `\\frac{${of(kids[0] || { kids: [] })}}{${of(kids[1] || { kids: [] })}}`;
    case 'msqrt': return `\\sqrt{${kids.map(tex).join('').trim()}}`;
    case 'mroot': return `\\sqrt[${of(kids[1] || { kids: [] })}]{${of(kids[0] || { kids: [] })}}`;
    case 'msub': return `${tex(kids[0] || { kids: [] }).trim()}_${arg(of(kids[1] || { kids: [] }))}`;
    case 'msup': return `${tex(kids[0] || { kids: [] }).trim()}^${arg(of(kids[1] || { kids: [] }))}`;
    case 'msubsup': case 'munderover': return `${tex(kids[0] || { kids: [] }).trim()}_${arg(of(kids[1] || { kids: [] }))}^${arg(of(kids[2] || { kids: [] }))}`;
    case 'munder': return `${tex(kids[0] || { kids: [] }).trim()}_${arg(of(kids[1] || { kids: [] }))}`;
    case 'mover': {
      const acc = text(kids[1] || { kids: [] }).trim();
      if (ACCENT_OF[acc] || { '^': 'hat', '¯': 'bar', '→': 'vec', '˙': 'dot', '¨': 'ddot', '~': 'tilde', '˜': 'tilde' }[acc]) return `\\${ACCENT_OF[acc] || { '^': 'hat', '¯': 'bar', '→': 'vec', '˙': 'dot', '¨': 'ddot', '~': 'tilde', '˜': 'tilde' }[acc]}{${of(kids[0] || { kids: [] })}}`;
      return `${tex(kids[0] || { kids: [] }).trim()}^${arg(of(kids[1] || { kids: [] }))}`;
    }
    case 'mfenced': return `(${kids.map(tex).join(',')})`;
    case 'semantics': return kids.length ? tex(kids[0]) : '';
    case 'annotation': case 'annotation-xml': return '';
    default: return kids.map(tex).join('');
  }
}
/** A formula object's MathML → LaTeX: the LaTeX annotation when it has one (ours), else read from the MathML. '' if none. */
export function mathmlToLatex(xml) {
  const root = parseXml(xml);
  const find = (n, name) => { for (const k of els(n)) { if (k.name === name) return k; const f = find(k, name); if (f) return f; } return null; };
  const math = find(root, 'math');
  if (!math) return '';
  const all = (n, acc = []) => { for (const k of els(n)) { if (k.name === 'annotation') acc.push(k); all(k, acc); } return acc; };
  const own = all(math).find((a) => /^application\/x-tex$/i.test(a.attrs.encoding || ''));
  if (own) return text(own).trim();
  return tex(math).replace(/\s+/g, ' ').replace(/\s+([_^}])/g, '$1').trim();
}

