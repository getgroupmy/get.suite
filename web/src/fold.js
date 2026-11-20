// Text as searches and filters compare it: accents left out and lower case ("Zoë" → "zoe"), as the server does.
export const fold = (t) => String(t ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
/** Whether `text` has `part` in it, accents and case aside. */
export const has = (text, part) => fold(text).includes(fold(part));
