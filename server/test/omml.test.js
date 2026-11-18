import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const { latexToOmml, ommlToLatex, parseLatex } = await import('../src/office/omml.js');
const { wordFromDoc, docFromWord } = await import('../src/office/word.js');

test('equations: LaTeX → Word’s equations → the same LaTeX', () => {
  for (const x of ['\\frac{a}{b}+x^2', 'E=mc^2', '\\sqrt{x^2+y^2}', '\\sqrt[3]{8}=2', 'x_i^2', 'x_{12}', 'e^{i\\pi}+1=0', '\\sum_{i=1}^n x_i', '\\int_0^1 f(x)dx',
    '\\alpha+\\beta\\le\\pi', 'a\\times b', '\\sin x', '\\cos\\theta', '\\hat{x}', '\\text{speed}=\\frac{d}{t}', '\\prod_{k=1}^{10} k', '\\{a,b\\}']) {
    assert.equal(ommlToLatex(latexToOmml(x)), x, x);
  }
  // Written differently, drawn the same: back in one way of writing it.
  assert.equal(ommlToLatex(latexToOmml('x_{i}^{2}')), 'x_i^2');
  assert.equal(ommlToLatex(latexToOmml('\\left( a \\right)')), '(a)');
  assert.equal(ommlToLatex(latexToOmml('a \\leq b')), 'a\\le b');
});

test('equations: what Word draws', () => {
  const o = latexToOmml('\\frac{1}{2}');
  assert.match(o, /^<m:f><m:num><m:r>.*<m:t xml:space="preserve">1<\/m:t><\/m:r><\/m:num><m:den>.*>2<\/m:t><\/m:r><\/m:den><\/m:f>$/);
  assert.match(latexToOmml('\\sum_{i=1}^n i'), /<m:nary><m:naryPr><m:chr m:val="∑"\/><m:limLoc m:val="undOvr"\/><\/m:naryPr><m:sub>.*i=1.*<\/m:sub><m:sup>.*n.*<\/m:sup><m:e>.*i.*<\/m:e><\/m:nary>/);
  assert.match(latexToOmml('\\sqrt{2}'), /<m:rad><m:radPr><m:degHide m:val="1"\/><\/m:radPr><m:deg><\/m:deg><m:e>/);
  assert.match(latexToOmml('\\text{if } x'), /<m:rPr><m:nor\/><\/m:rPr>.*>if <\/m:t>/, 'words as normal text');
  assert.match(latexToOmml('a<b'), /a&lt;b/);
  assert.deepEqual(parseLatex('\\unknown{x}').map((p) => p.t), ['text', 'grp'], 'a command it doesn’t know: kept as written');
});

test('equations: as Word itself writes them (brackets, functions, integrals without a symbol, matrices)', () => {
  const r = (t, sty) => `<m:r>${sty ? `<m:rPr><m:sty m:val="${sty}"/></m:rPr>` : ''}<w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t>${t}</m:t></m:r>`;
  assert.equal(ommlToLatex(`<m:d><m:dPr><m:ctrlPr><w:rPr/></m:ctrlPr></m:dPr><m:e>${r('a+b')}</m:e></m:d>${r('=')}${r('c')}`), '(a+b)=c');
  assert.equal(ommlToLatex(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${r('x')}</m:e></m:d>`), '[x]');
  assert.equal(ommlToLatex(`<m:func><m:funcPr/><m:fName>${r('sin', 'p')}</m:fName><m:e>${r('θ')}</m:e></m:func>`), '\\sin\\theta');
  assert.equal(ommlToLatex(`<m:nary><m:naryPr><m:limLoc m:val="subSup"/></m:naryPr><m:sub>${r('0')}</m:sub><m:sup>${r('∞')}</m:sup><m:e>${r('f')}</m:e></m:nary>`), '\\int_0^{\\infty} f', 'no symbol: Word’s integral');
  assert.equal(ommlToLatex(`<m:m><m:mr><m:e>${r('1')}</m:e><m:e>${r('0')}</m:e></m:mr><m:mr><m:e>${r('0')}</m:e><m:e>${r('1')}</m:e></m:mr></m:m>`), '1 & 0 \\\\ 0 & 1');
  assert.equal(ommlToLatex(`<m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr><m:e>${r('x')}</m:e><m:sup>${r('n+1')}</m:sup></m:sSup>`), 'x^{n+1}');
});

test('equations go out to Word as Word’s own and come back as equations', async () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Area: ' }, { type: 'math', attrs: { latex: '\\pi r^2' } }, { type: 'text', text: ' and ' }, { type: 'math', attrs: { latex: '\\frac{a+b}{2}' } }] }] };
  const docx = await wordFromDoc(doc, 'T');
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml').async('string');
  assert.match(xml, /<m:oMath><m:r>.*π.*<\/m:r><m:sSup><m:e>.*r.*<\/m:e><m:sup>.*2.*<\/m:sup><\/m:sSup><\/m:oMath>/);
  assert.match(xml, /<m:oMath><m:f>/);
  assert.doesNotMatch(xml, /\\frac|/, 'no LaTeX left in the file');
  const back = (await docFromWord(docx)).doc.content[0].content;
  assert.deepEqual(back.filter((n) => n.type === 'math').map((n) => n.attrs.latex), ['\\pi r^2', '\\frac{a+b}{2}']);
  assert.deepEqual(back.filter((n) => n.type === 'text').map((n) => n.text), ['Area: ', ' and ']);
  // A display equation on its own line (m:oMathPara), as Word writes one.
  const zip = await JSZip.loadAsync(docx);
  zip.file('word/document.xml', xml.replace(/<w:p>(<w:pPr>[\s\S]*?<\/w:pPr>)?<w:r>[\s\S]*?<\/w:p>/, '<w:p><m:oMathPara><m:oMath><m:r><m:t>y=2x</m:t></m:r></m:oMath></m:oMathPara></w:p>'));
  const para = (await docFromWord(await zip.generateAsync({ type: 'nodebuffer' }))).doc.content[0].content;
  assert.deepEqual(para.map((n) => n.type === 'math' ? n.attrs.latex : n.text), ['y=2x']);
});
