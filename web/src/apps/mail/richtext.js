// Helpers for the rich-text compose editor (TipTap JSON <-> email text/HTML).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain text → simple HTML paragraphs (used for quoting and for text-only drafts). */
export function textToHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.map((l) => (l ? `<p>${esc(l)}</p>` : '<p></p>')).join('');
}

/** Editor JSON → readable plain text: "> " for quotes, "- " / "1. " for lists, "text (url)" for links. */
export function docToText(doc) {
  const out = [];
  const inline = (nodes = []) => nodes.map((n) => {
    if (n.type === 'hardBreak') return '\n';
    if (n.type !== 'text') return '';
    const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href;
    return link && link !== n.text ? `${n.text} (${link})` : n.text;
  }).join('');
  const block = (node, prefix = '') => {
    switch (node.type) {
      case 'paragraph':
      case 'heading': {
        const line = inline(node.content);
        // The standard signature separator is "-- " (with a trailing space, which the editor trims).
        out.push(prefix + (line.trim() === '--' ? '-- ' : line.replace(/\n/g, `\n${prefix}`)));
        break;
      }
      case 'blockquote':
        (node.content || []).forEach((c) => block(c, `${prefix}> `));
        break;
      case 'bulletList':
      case 'orderedList':
        (node.content || []).forEach((item, i) => {
          const marker = node.type === 'bulletList' ? '- ' : `${(node.attrs?.start || 1) + i}. `;
          (item.content || []).forEach((c, j) => block(c, prefix + (j === 0 ? marker : ' '.repeat(marker.length))));
        });
        break;
      case 'codeBlock':
        out.push(...inline(node.content).split('\n').map((l) => prefix + l));
        break;
      case 'horizontalRule':
        out.push(`${prefix}----`);
        break;
      default:
        (node.content || []).forEach((c) => block(c, prefix));
    }
  };
  (doc?.content || []).forEach((n) => block(n));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

/** Wrap the editor's HTML so mail apps render it consistently. */
export function emailHtml(bodyHtml) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #1f1f1f">${bodyHtml
    .replace(/<blockquote>/g, '<blockquote style="margin:0 0 0 .8ex; border-left:2px solid #ccc; padding-left:1ex; color:#555">')}</div>`;
}

export const isEmptyDoc = (doc) => !docToText(doc).trim();
