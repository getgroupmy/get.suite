import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latexToMathml, mathmlToLatex } from '../src/office/mathml.js';

const strip = (xml) => xml.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/, '');
test('LaTeX → MathML: fractions, powers, roots, sums with limits, functions, accents, text; our LaTeX comes back exactly', () => {
  const m = latexToMathml('\\frac{a+b}{2} = \\sqrt[3]{x}');
  assert.match(m, /^<\?xml[^>]*\?>\n<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML" display="inline"><semantics>/);
  assert.match(m, /<mfrac><mrow><mi>a<\/mi><mo>\+<\/mo><mi>b<\/mi><\/mrow><mrow><mn>2<\/mn><\/mrow><\/mfrac>/);
  assert.match(m, /<mroot><mrow><mi>x<\/mi><\/mrow><mrow><mn>3<\/mn><\/mrow><\/mroot>/);
  assert.match(latexToMathml('\\sum_{i=1}^{n} i'), /<munderover><mo stretchy="false">∑<\/mo>/);
  assert.match(latexToMathml('\\int_0^1 x'), /<msubsup><mo stretchy="false">∫<\/mo>/);
  assert.match(latexToMathml('12.5 < x'), /<mn>12\.5<\/mn><mo>&lt;<\/mo><mi>x<\/mi>/);
  for (const l of ['x^2 + y^2 = r^2', '\\frac{a+b}{2}', '\\sum_{i=1}^{n} i^2', '\\alpha \\le \\beta', 'a < b & c']) assert.equal(mathmlToLatex(latexToMathml(l)), l);
});

test('MathML → LaTeX without our annotation: what LibreOffice Math writes', () => {
  const cases = [
    ['x^2 + y^2 = r^2', 'x^2+y^2=r^2'], ['\\frac{a+b}{2}', '\\frac{a+b}{2}'], ['\\sqrt{x}', '\\sqrt{x}'], ['\\sqrt[3]{x}', '\\sqrt[3]{x}'],
    ['\\sum_{i=1}^{n} i^2', '\\sum_{i=1}^ni^2'], ['\\int_0^1 f(x) dx', '\\int_0^1f(x)dx'], ['\\alpha \\le \\beta', '\\alpha \\le \\beta'],
    ['\\sin x', '\\sin x'], ['\\hat{x}', '\\hat{x}'], ['\\text{speed} = \\frac{d}{t}', '\\text{speed}=\\frac{d}{t}'],
  ];
  for (const [l, want] of cases) assert.equal(mathmlToLatex(strip(latexToMathml(l))), want, l);
  // LibreOffice's own: a math: prefix, its StarMath kept as an annotation (not LaTeX), an operator name, entities.
  const lo = '<?xml version="1.0" encoding="UTF-8"?><math:math xmlns:math="http://www.w3.org/1998/Math/MathML" display="block"><math:semantics><math:mrow><math:mi>x</math:mi><math:mo stretchy="false">=</math:mo><math:mfrac><math:mrow><math:mo>&#x2212;</math:mo><math:mi>b</math:mi></math:mrow><math:mrow><math:mn>2</math:mn><math:mi>a</math:mi></math:mrow></math:mfrac><math:mo>&#x2260;</math:mo><math:mi>arg</math:mi></math:mrow><math:annotation math:encoding="StarMath 5.0">x = {-b} over {2a} &lt;&gt; arg</math:annotation></math:semantics></math:math>';
  assert.equal(mathmlToLatex(lo), 'x=\\frac{−b}{2a}\\ne \\operatorname{arg}');
  assert.equal(mathmlToLatex('<doc/>'), '');
});
