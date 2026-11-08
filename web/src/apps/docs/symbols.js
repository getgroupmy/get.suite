// Special characters for the Ω picker: [character, name], in groups. Searching matches the start
// of the names' words (every word typed), or the character itself.
export const SYMBOL_GROUPS = [
  ['Punctuation', [['—', 'em dash'], ['–', 'en dash'], ['…', 'ellipsis'], ['‘', 'left single quote'], ['’', 'right single quote apostrophe'], ['“', 'left double quote'], ['”', 'right double quote'], ['«', 'left guillemet'], ['»', 'right guillemet'], ['•', 'bullet'], ['·', 'middle dot'], ['§', 'section sign'], ['¶', 'pilcrow paragraph'], ['†', 'dagger'], ['‡', 'double dagger'], ['¿', 'inverted question mark'], ['¡', 'inverted exclamation mark']]],
  ['Signs and marks', [['©', 'copyright'], ['®', 'registered'], ['™', 'trademark'], ['°', 'degree'], ['℃', 'degree celsius'], ['℉', 'degree fahrenheit'], ['№', 'numero number sign'], ['✓', 'check mark tick'], ['✗', 'cross mark ballot x'], ['★', 'black star'], ['☆', 'white star'], ['♥', 'heart'], ['☐', 'ballot box'], ['☑', 'ballot box with check']]],
  ['Currency', [['€', 'euro'], ['£', 'pound sterling'], ['¥', 'yen yuan'], ['₹', 'rupee indian'], ['₩', 'won'], ['₽', 'ruble'], ['₺', 'lira turkish'], ['₫', 'dong'], ['₱', 'peso philippine'], ['฿', 'baht'], ['¢', 'cent'], ['₿', 'bitcoin']]],
  ['Maths', [['±', 'plus minus'], ['×', 'multiply times'], ['÷', 'divide division'], ['≈', 'approximately almost equal'], ['≠', 'not equal'], ['≤', 'less than or equal'], ['≥', 'greater than or equal'], ['∞', 'infinity'], ['√', 'square root'], ['∑', 'sum sigma'], ['∏', 'product'], ['∫', 'integral'], ['∂', 'partial'], ['∆', 'increment delta'], ['∈', 'element of in'], ['∉', 'not element of'], ['∩', 'intersection'], ['∪', 'union'], ['⊂', 'subset'], ['∀', 'for all'], ['∃', 'there exists'], ['¬', 'not'], ['‰', 'per mille'], ['′', 'prime minute'], ['″', 'double prime second']]],
  ['Fractions and powers', [['½', 'one half fraction'], ['⅓', 'one third fraction'], ['⅔', 'two thirds fraction'], ['¼', 'one quarter fraction'], ['¾', 'three quarters fraction'], ['⅛', 'one eighth fraction'], ['⁰', 'superscript zero'], ['¹', 'superscript one'], ['²', 'superscript two squared'], ['³', 'superscript three cubed'], ['ⁿ', 'superscript n'], ['₀', 'subscript zero'], ['₁', 'subscript one'], ['₂', 'subscript two']]],
  ['Arrows', [['→', 'right arrow'], ['←', 'left arrow'], ['↑', 'up arrow'], ['↓', 'down arrow'], ['↔', 'left right arrow'], ['⇒', 'right double arrow implies'], ['⇐', 'left double arrow'], ['⇔', 'left right double arrow if and only if'], ['↗', 'north east arrow'], ['↘', 'south east arrow'], ['↻', 'clockwise arrow']]],
  ['Greek', [['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma'], ['δ', 'delta'], ['ε', 'epsilon'], ['θ', 'theta'], ['λ', 'lambda'], ['μ', 'mu micro'], ['π', 'pi'], ['σ', 'sigma'], ['τ', 'tau'], ['φ', 'phi'], ['ω', 'omega'], ['Γ', 'capital gamma'], ['Δ', 'capital delta'], ['Θ', 'capital theta'], ['Λ', 'capital lambda'], ['Π', 'capital pi'], ['Σ', 'capital sigma'], ['Φ', 'capital phi'], ['Ω', 'capital omega ohm']]],
  ['Letters', [['é', 'e acute'], ['è', 'e grave'], ['ê', 'e circumflex'], ['ë', 'e diaeresis'], ['à', 'a grave'], ['á', 'a acute'], ['â', 'a circumflex'], ['ä', 'a umlaut'], ['å', 'a ring'], ['æ', 'ae ash'], ['ç', 'c cedilla'], ['ñ', 'n tilde'], ['ö', 'o umlaut'], ['ø', 'o slash'], ['œ', 'oe ligature'], ['ß', 'sharp s eszett'], ['ü', 'u umlaut'], ['ı', 'dotless i'], ['ğ', 'g breve'], ['ş', 's cedilla']]],
];

/** The characters matching what's typed: each word typed starts a word of the name, or it is the character. */
export function findSymbols(query, groups = SYMBOL_GROUPS) {
  const raw = String(query || '').trim();
  const q = raw.toLowerCase();
  const all = groups.flatMap(([group, list]) => list.map(([ch, name]) => ({ ch, name, group })));
  if (!q) return all;
  const words = q.split(/\s+/);
  return all.filter((s) => s.ch === raw || words.every((w) => s.name.split(/[\s-]+/).some((n) => n.startsWith(w))));
}
