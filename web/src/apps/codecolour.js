// Syntax colouring for the text viewer: each line cut into pieces ({ text, k }) where k is '' (plain), 'comment',
// 'string', 'number', 'keyword' or 'key' (a YAML or JSON key). Small and forgiving rather than a full parser: it
// knows the common families of languages by the file's name, and carries block comments and multi-line strings
// from one line to the next. Rendered as text, so nothing in the file runs.

const KW = {
  js: 'await async break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  c: 'abstract bool boolean break byte case catch char class const continue default do double else enum extends false final finally float for if implements import int interface long namespace new null package private protected public return short static struct super switch this throw throws true try typedef unsigned using var void volatile while',
  sh: 'if then else elif fi for while do done case esac in function return export local echo exit',
  sql: 'select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default count sum avg min max',
  rb: 'begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
};
const FAMILY = [
  [/\.(m?js|cjs|jsx|ts|tsx|vue|svelte|json)$/i, { line: '//', block: ['/*', '*/'], strings: '"\'`', kw: 'js' }],
  [/\.py$/i, { line: '#', strings: '"\'', kw: 'py', triple: true }],
  [/\.go$/i, { line: '//', block: ['/*', '*/'], strings: '"\'`', kw: 'go' }],
  [/\.(java|kt|swift|c|h|cpp|hpp|cs|dart|gradle|scss|less|css|rs|php)$/i, { line: '//', block: ['/*', '*/'], strings: '"\'', kw: 'c' }],
  [/\.(sh|bash|env|conf|cfg|ini|properties|toml|r|pl|gitignore|dockerfile)$|^(dockerfile|makefile|gnumakefile|procfile|gemfile|rakefile|vagrantfile|brewfile)$/i, { line: '#', strings: '"\'', kw: 'sh' }],
  [/\.rb$/i, { line: '#', strings: '"\'', kw: 'rb' }],
  [/\.sql$/i, { line: '--', block: ['/*', '*/'], strings: '\'"', kw: 'sql', nocase: true }],
  [/\.ya?ml$/i, { line: '#', strings: '"\'', keys: 'yaml' }],
  [/\.(xml|html?|svg|xhtml)$/i, { block: ['<!--', '-->'], strings: '"\'' }],
  [/\.lua$/i, { line: '--', strings: '"\'' }],
];

/** The colouring rules for a file name, or null when it isn't a language this knows (plain text). */
export function languageOf(name) {
  const base = String(name || '').split('/').pop();
  const hit = FAMILY.find(([re]) => re.test(base));
  if (!hit) return null;
  const lang = { ...hit[1] };
  if (/\.json$/i.test(base)) lang.keys = 'json';
  lang.words = lang.kw ? new Set(KW[lang.kw].split(' ')) : null;
  return lang;
}

/** All lines coloured: [[{ text, k }…]…], a block comment or multi-line string carried to the next lines. */
export function colourLines(lines, lang) {
  if (!lang) return lines.map((l) => [{ text: l, k: '' }]);
  let open = null; // { end, k } still open from an earlier line
  return lines.map((line) => {
    const out = [];
    const push = (text, k) => { if (!text) return; const last = out[out.length - 1]; if (last && last.k === k) last.text += text; else out.push({ text, k }); };
    let i = 0;
    if (open) {
      const e = line.indexOf(open.end);
      if (e === -1) { push(line, open.k); return out.length ? out : [{ text: '', k: '' }]; }
      push(line.slice(0, e + open.end.length), open.k); i = e + open.end.length; open = null;
    }
    // A YAML key at the start of the line (after a dash for list items).
    if (lang.keys === 'yaml' && i === 0) { const m = /^(\s*(?:-\s+)?)([^\s#:'"][^:#]*?)(:)(\s|$)/.exec(line); if (m) { push(m[1], ''); push(m[2], 'key'); i = m[1].length + m[2].length; } }
    while (i < line.length) {
      const rest = line.slice(i);
      if (lang.block && rest.startsWith(lang.block[0])) {
        const e = line.indexOf(lang.block[1], i + lang.block[0].length);
        if (e === -1) { push(rest, 'comment'); open = { end: lang.block[1], k: 'comment' }; break; }
        push(line.slice(i, e + lang.block[1].length), 'comment'); i = e + lang.block[1].length; continue;
      }
      if (lang.line && rest.startsWith(lang.line) && (lang.line !== '#' || i === 0 || /\s/.test(line[i - 1]))) { push(rest, 'comment'); break; }
      const q = rest[0];
      if (lang.strings && lang.strings.includes(q)) {
        const triple = lang.triple && rest.startsWith(q.repeat(3)) ? q.repeat(3) : null;
        const close = triple || q;
        let j = i + close.length;
        while (j < line.length && !line.startsWith(close, j)) j += line[j] === '\\' ? 2 : 1;
        if (j >= line.length) {
          push(rest, 'string');
          if (triple || q === '`') open = { end: close, k: 'string' };
          break;
        }
        const str = line.slice(i, j + close.length);
        // A JSON key: a string followed by a colon.
        push(str, lang.keys === 'json' && /^\s*:/.test(line.slice(j + close.length)) ? 'key' : 'string'); i = j + close.length; continue;
      }
      const num = /^(0x[0-9a-f]+|\d+(\.\d+)?(e[+-]?\d+)?)\b/i.exec(rest);
      if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) { push(num[0], 'number'); i += num[0].length; continue; }
      const word = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (word) {
        const w = word[0];
        push(w, lang.words && lang.words.has(lang.nocase ? w.toLowerCase() : w) ? 'keyword' : '');
        i += w.length; continue;
      }
      push(line[i], ''); i++;
    }
    return out.length ? out : [{ text: '', k: '' }];
  });
}
