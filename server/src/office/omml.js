// Equations between Docs (LaTeX, as typed in the equation box) and Word (Office Math, OMML): fractions, powers
// and subscripts, roots, sums, products and integrals with their limits, Greek letters and the usual operators,
// \text{…}, and brackets. latexToOmml writes what Word draws as a real equation; ommlToLatex reads Word's back
// (from the download or from Word itself), giving the same LaTeX for what latexToOmml wrote.

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', div: '÷', cdot: '⋅', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  infty: '∞', partial: '∂', nabla: '∇', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', leftrightarrow: '↔',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  ldots: '…', cdots: '⋯', degree: '°', circ: '∘', ast: '∗', star: '⋆', perp: '⊥', parallel: '∥', angle: '∠', prime: '′', hbar: 'ℏ', ell: 'ℓ',
};
// The first name of each symbol is the one written back (\le, not \leq).
const COMMAND_OF = {};
for (const [cmd, ch] of Object.entries(SYMBOLS)) if (!COMMAND_OF[ch]) COMMAND_OF[ch] = cmd;
const NARY = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂' };
const NARY_OF = Object.fromEntries(Object.entries(NARY).map(([k, v]) => [v, k]));
const FUNCTIONS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'det', 'gcd'];
const ACCENTS = { hat: '̂', bar: '̅', vec: '⃗', dot: '̇', ddot: '̈', tilde: '̃' };
const ACCENT_OF = Object.fromEntries(Object.entries(ACCENTS).map(([k, v]) => [v, k]));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** LaTeX → a list of pieces: { t: 'chr', c } | { t: 'text', s } | { t: 'frac', num, den } | { t: 'scr', base, sub, sup } | … */
export function parseLatex(src) {
  const s = String(src || '');
  let i = 0;
  const group = () => { // one argument: {…} or a single piece
    while (s[i] === ' ') i++;
    if (s[i] === '{') { i++; const out = seq('}'); i++; return out; }
    const one = atom();
    return one ? [one] : [];
  };
  const command = () => {
    i++; // the backslash
    const m = /^[a-zA-Z]+/.exec(s.slice(i));
    if (!m) { const c = s[i++] || ''; return { t: 'chr', c: c === ',' || c === ';' || c === ' ' ? ' ' : c }; } // \{ \} \, …
    const name = m[0]; i += name.length;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') { const num = group(); const den = group(); return { t: 'frac', num, den }; }
    if (name === 'sqrt') {
      let deg = null;
      if (s[i] === '[') { i++; deg = seq(']'); i++; }
      return { t: 'rad', deg, body: group() };
    }
    if (name === 'text' || name === 'mathrm' || name === 'textrm' || name === 'operatorname') { while (s[i] === ' ') i++; if (s[i] === '{') { const end = s.indexOf('}', i); const txt = s.slice(i + 1, end < 0 ? s.length : end); i = end < 0 ? s.length : end + 1; return name === 'operatorname' ? { t: 'func', name: txt } : { t: 'text', s: txt }; } return null; }
    if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg') { while (s[i] === ' ') i++; if (s[i] === '\\') { i++; const c = s[i++]; return { t: 'chr', c: c === '{' || c === '}' ? c : c }; } const c = s[i++]; return c === '.' ? null : { t: 'chr', c }; }
    if (NARY[name]) return { t: 'nary', chr: NARY[name], sub: null, sup: null };
    if (FUNCTIONS.includes(name)) return { t: 'func', name };
    if (ACCENTS[name]) return { t: 'acc', accent: name, body: group() };
    if (SYMBOLS[name]) return { t: 'chr', c: SYMBOLS[name] };
    if (name === 'quad' || name === 'qquad') return { t: 'chr', c: ' ' };
    return { t: 'text', s: `\\${name}` }; // something unknown: kept as written
  };
  const atom = () => {
    const c = s[i];
    if (c === undefined) return null;
    if (c === '\\') return command();
    if (c === '{') { i++; const inner = seq('}'); i++; return { t: 'grp', body: inner }; }
    i++;
    return c === ' ' ? null : { t: 'chr', c };
  };
  const seq = (stop) => {
    const out = [];
    while (i < s.length && s[i] !== stop) {
      const c = s[i];
      if (c === '^' || c === '_') {
        i++;
        const arg = group();
        let prev = out.pop() || { t: 'chr', c: '' };
        if (prev.t === 'nary') { prev = { ...prev, [c === '^' ? 'sup' : 'sub']: arg }; out.push(prev); continue; }
        if (prev.t !== 'scr') prev = { t: 'scr', base: prev.t === 'grp' ? prev.body : [prev], sub: null, sup: null };
        prev[c === '^' ? 'sup' : 'sub'] = arg;
        out.push(prev);
        continue;
      }
      const a = atom();
      if (a) out.push(a);
    }
    // A sum, product or integral takes what follows it as what it applies to (up to the next operator such as + or =).
    const merged = [];
    for (let k = 0; k < out.length; k++) {
      const a = out[k];
      if (a.t === 'nary') {
        const body = [];
        while (k + 1 < out.length && !(out[k + 1].t === 'chr' && /^[+\-=<>≤≥≠±∓]$/.test(out[k + 1].c))) body.push(out[++k]);
        merged.push({ ...a, body });
      } else merged.push(a.t === 'grp' ? { t: 'grp', body: a.body } : a);
    }
    return merged;
  };
  return seq(undefined);
}

// ---- out to Word
const run = (text, plain = false) => `<m:r>${plain ? '<m:rPr><m:nor/></m:rPr>' : ''}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t xml:space="preserve">${esc(text)}</m:t></m:r>`;
const omml = (pieces = []) => {
  let out = '', chars = '';
  const flush = () => { if (chars) out += run(chars); chars = ''; };
  for (const p of pieces || []) {
    if (p.t === 'chr') { chars += p.c; continue; }
    flush();
    if (p.t === 'text') out += run(p.s, true);
    else if (p.t === 'grp') out += omml(p.body);
    else if (p.t === 'frac') out += `<m:f><m:num>${omml(p.num)}</m:num><m:den>${omml(p.den)}</m:den></m:f>`;
    else if (p.t === 'rad') out += `<m:rad><m:radPr>${p.deg ? '' : '<m:degHide m:val="1"/>'}</m:radPr><m:deg>${omml(p.deg || [])}</m:deg><m:e>${omml(p.body)}</m:e></m:rad>`;
    else if (p.t === 'scr') {
      if (p.sub && p.sup) out += `<m:sSubSup><m:e>${omml(p.base)}</m:e><m:sub>${omml(p.sub)}</m:sub><m:sup>${omml(p.sup)}</m:sup></m:sSubSup>`;
      else if (p.sup) out += `<m:sSup><m:e>${omml(p.base)}</m:e><m:sup>${omml(p.sup)}</m:sup></m:sSup>`;
      else out += `<m:sSub><m:e>${omml(p.base)}</m:e><m:sub>${omml(p.sub || [])}</m:sub></m:sSub>`;
    } else if (p.t === 'nary') {
      out += `<m:nary><m:naryPr><m:chr m:val="${p.chr}"/><m:limLoc m:val="${p.chr === '∫' || p.chr === '∮' ? 'subSup' : 'undOvr'}"/>${p.sub ? '' : '<m:subHide m:val="1"/>'}${p.sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr><m:sub>${omml(p.sub || [])}</m:sub><m:sup>${omml(p.sup || [])}</m:sup><m:e>${omml(p.body)}</m:e></m:nary>`;
    } else if (p.t === 'func') out += `<m:func><m:fName>${run(p.name, true)}</m:fName><m:e></m:e></m:func>`;
    else if (p.t === 'acc') out += `<m:acc><m:accPr><m:chr m:val="${ACCENTS[p.accent]}"/></m:accPr><m:e>${omml(p.body)}</m:e></m:acc>`;
  }
  flush();
  return out;
};
/** LaTeX → the inside of an <m:oMath> element. */
export const latexToOmml = (latex) => omml(parseLatex(latex));

// ---- back from Word
const tagsIn = (xml) => { // the top-level elements of an XML fragment: [{ name, body, attrs }]
  const out = [];
  const re = /<(m:[a-zA-Z]+|w:[a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [whole, name, attrs, self] = m;
    if (self) { out.push({ name, attrs, body: '' }); continue; }
    // find the matching close, counting nested ones of the same name
    let depth = 1, at = re.lastIndex;
    const open = new RegExp(`<${name}\\b[^>]*?(/?)>|</${name}>`, 'g');
    open.lastIndex = at;
    let k;
    while (depth && (k = open.exec(xml))) { if (k[0].startsWith('</')) depth--; else if (!k[1]) depth++; }
    const end = k ? k.index : xml.length;
    out.push({ name, attrs, body: xml.slice(at, end) });
    re.lastIndex = k ? open.lastIndex : xml.length;
    void whole;
  }
  return out;
};
const child = (body, name) => tagsIn(body).find((t) => t.name === name)?.body ?? '';
const val = (body, name) => new RegExp(`<${name}\\b[^>]*m:val="([^"]*)"`).exec(body)?.[1];
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const arg = (latex) => ([...latex].length === 1 ? latex : `{${latex}}`);
const textLatex = (t) => {
  let out = '';
  const chars = [...t];
  chars.forEach((ch, k) => {
    const cmd = COMMAND_OF[ch];
    if (cmd) { out += `\\${cmd}`; if (/[a-zA-Z]/.test(chars[k + 1] || '')) out += ' '; } else if (ch === '{' || ch === '}') out += `\\${ch}`; else out += ch;
  });
  return out;
};
const latexOf = (xml) => tagsIn(xml).map((t) => {
  const b = t.body;
  switch (t.name) {
    case 'm:r': { // text: plain (\text{…}, as "normal text" in Word) or maths
      const txt = unesc(tagsIn(b).filter((x) => x.name === 'm:t' || x.name === 'w:t').map((x) => x.body).join(''));
      return /<m:nor\b(?![^>]*m:val="(0|off|false)")/.test(child(b, 'm:rPr')) ? `\\text{${txt}}` : textLatex(txt);
    }
    case 'm:f': return `\\frac{${latexOf(child(b, 'm:num'))}}{${latexOf(child(b, 'm:den'))}}`;
    case 'm:sSup': return `${arg(latexOf(child(b, 'm:e')))}^${arg(latexOf(child(b, 'm:sup')))}`;
    case 'm:sSub': return `${arg(latexOf(child(b, 'm:e')))}_${arg(latexOf(child(b, 'm:sub')))}`;
    case 'm:sSubSup': return `${arg(latexOf(child(b, 'm:e')))}_${arg(latexOf(child(b, 'm:sub')))}^${arg(latexOf(child(b, 'm:sup')))}`;
    case 'm:rad': { const deg = latexOf(child(b, 'm:deg')); return `\\sqrt${deg && !/m:degHide m:val="(1|on|true)"/.test(child(b, 'm:radPr')) ? `[${deg}]` : ''}{${latexOf(child(b, 'm:e'))}}`; }
    case 'm:nary': {
      const pr = child(b, 'm:naryPr');
      const chr = val(pr, 'm:chr') || '∫';
      const sub = latexOf(child(b, 'm:sub')), sup = latexOf(child(b, 'm:sup')), e = latexOf(child(b, 'm:e'));
      return `\\${NARY_OF[chr] || 'int'}${sub ? `_${arg(sub)}` : ''}${sup ? `^${arg(sup)}` : ''}${e ? ` ${e}` : ''}`;
    }
    case 'm:func': { const name = latexOf(child(b, 'm:fName')).replace(/^\\text\{(.*)\}$/, '$1'); const e = latexOf(child(b, 'm:e')); return `${FUNCTIONS.includes(name) ? `\\${name}` : `\\operatorname{${name}}`}${/^[a-zA-Z]/.test(e) ? ' ' : ''}${e}`; }
    case 'm:acc': { const ch = val(child(b, 'm:accPr'), 'm:chr') || '̂'; return `\\${ACCENT_OF[ch] || 'hat'}{${latexOf(child(b, 'm:e'))}}`; }
    case 'm:d': { const pr = child(b, 'm:dPr'); const beg = val(pr, 'm:begChr') ?? '(', end = val(pr, 'm:endChr') ?? ')'; const parts = tagsIn(b).filter((x) => x.name === 'm:e').map((x) => latexOf(x.body)); return `${textLatex(beg)}${parts.join(val(pr, 'm:sepChr') ?? ',')}${textLatex(end)}`; }
    case 'm:bar': return `\\overline{${latexOf(child(b, 'm:e'))}}`;
    case 'm:limLow': return `${latexOf(child(b, 'm:e'))}_${arg(latexOf(child(b, 'm:lim')))}`;
    case 'm:limUpp': return `${latexOf(child(b, 'm:e'))}^${arg(latexOf(child(b, 'm:lim')))}`;
    case 'm:box': case 'm:borderBox': case 'm:e': case 'm:oMath': return latexOf(b);
    case 'm:m': return tagsIn(b).filter((x) => x.name === 'm:mr').map((r) => tagsIn(r.body).filter((x) => x.name === 'm:e').map((x) => latexOf(x.body)).join(' & ')).join(' \\\\ ');
    case 'm:eqArr': return tagsIn(b).filter((x) => x.name === 'm:e').map((x) => latexOf(x.body)).join(' \\\\ ');
    default: return /Pr$/.test(t.name) || t.name.startsWith('w:') ? '' : latexOf(b); // properties aside; anything else: what's inside
  }
}).reduce((a, b) => (/\\[a-zA-Z]+$/.test(a) && /^[a-zA-Z]/.test(b) ? `${a} ${b}` : a + b), ''); // (\sin x, not \sinx)
/** The inside of an <m:oMath> element → LaTeX. */
export const ommlToLatex = (xml) => latexOf(String(xml || '')).replace(/\s+/g, ' ').trim();
