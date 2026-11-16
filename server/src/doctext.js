// Plain text as a document (TipTap JSON): one paragraph a line, lines starting with #, ## or ### become
// headings. Used by assistants making or adding to documents.
export function docFromText(text) {
  const content = String(text || '').split(/\r?\n/).map((line) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const inner = (h ? h[2] : line) ? [{ type: 'text', text: h ? h[2] : line }] : undefined;
    return h ? { type: 'heading', attrs: { level: h[1].length }, ...(inner && { content: inner }) } : { type: 'paragraph', ...(inner && { content: inner }) };
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
