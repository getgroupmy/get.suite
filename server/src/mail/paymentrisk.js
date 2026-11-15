// Emails that ask for money to go somewhere new: changed bank details, a different account for an invoice,
// an urgent transfer, gift cards. That's how invoice and "CEO" fraud works (often from a lookalike or a
// first-time address, or with replies going elsewhere), so Mail suggests confirming by phone, on a number
// you already have, before paying. English and Malay phrasings. → what it's about, or null.
const RULES = [
  ['bank', [
    /\b(new|updated?|changed?|different|correct(?:ed)?|revised)\s+(bank(?:ing)?\s+(details|account|information|info)|account\s+(details|number)|remittance\s+details|payment\s+(details|instructions|information))\b/i,
    /\b(bank(?:ing)?\s+(details|account)|account\s+details|payment\s+(details|instructions))\s+(have|has)\s+(been\s+)?(changed|updated)\b/i,
    /\b(change|update)\s+(of|to|in)\s+(our|the|my)?\s*(bank(?:ing)?|account|payment)\s+(details|account|information|instructions)\b/i,
    /\bpay(?:ment)?s?\s+(?:to|into)\s+(?:our|the|this)\s+new\s+account\b/i,
    /\b(change|update|amend)\s+(?:the|our|my)\s+(bank(?:ing)?|account|payment)\s+(details|account|information|instructions)\b/i,
    /\b(akaun|butiran)\s+bank\s+(baru|yang\s+baru|telah\s+(?:ditukar|dikemas\s*kini))\b/i,
    /\b(tukar|pertukaran)\s+(akaun|butiran)\s+bank\b/i,
  ]],
  ['transfer', [
    /\b(urgent(?:ly)?|immediate(?:ly)?|today|asap)\b[^.!?\n]{0,60}\b(wire|bank|telegraphic|swift)\s+transfer\b/i,
    /\b(wire|bank|telegraphic|swift)\s+transfer\b[^.!?\n]{0,60}\b(urgent(?:ly)?|immediately|today|asap|before\s+(?:the\s+)?end\s+of\s+(?:the\s+)?day)\b/i,
    /\b(segera|hari\s+ini)\b[^.!?\n]{0,60}\b(pindahan|pemindahan)\s+(wang|dana)\b/i,
  ]],
  ['giftcards', [
    /\b(buy|purchase|get|pick\s+up)\b[^.!?\n]{0,40}\b(gift\s*cards?|itunes\s+cards?|google\s+play\s+cards?|steam\s+cards?|vouchers?)\b/i,
    /\bscratch\b[^.!?\n]{0,40}\b(codes?|cards?)\b[^.!?\n]{0,40}\b(send|photo|picture)\b/i,
  ]],
];

/** What an email asks about money (subject and text): 'bank', 'transfer' or 'giftcards', or null. */
export function paymentRisk({ subject = '', text = '' } = {}) {
  const t = `${subject}\n${String(text).slice(0, 20000)}`.replace(/\s+/g, ' ');
  for (const [kind, res] of RULES) if (res.some((re) => re.test(t))) return kind;
  return null;
}
