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
      case 'image':
        out.push(`${prefix}[image${node.attrs?.alt ? `: ${node.attrs.alt}` : ''}]`);
        break;
      case 'horizontalRule':
        out.push(`${prefix}----`);
        break;
      case 'table':
        // One line per row, cells separated by " | ".
        (node.content || []).forEach((row) => {
          const cells = (row.content || []).map((cell) => docToText({ content: cell.content || [] }).replace(/\s*\n\s*/g, ' ').trim());
          out.push(prefix + cells.join(' | '));
        });
        break;
      default:
        (node.content || []).forEach((c) => block(c, prefix));
    }
  };
  (doc?.content || []).forEach((n) => block(n));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

const CELL_STYLE = 'border:1px solid #ccc; padding:4px 8px; vertical-align:top; text-align:left';

/** Inline styles for a table: mail apps ignore style sheets, so borders and spacing go on each cell. */
function emailTables(html) {
  return html
    .replace(/<colgroup>[\s\S]*?<\/colgroup>/g, '') // the editor's column sizing hints
    .replace(/<table\b[^>]*>/g, '<table style="border-collapse:collapse; margin:8px 0; max-width:100%">')
    .replace(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
      const spans = [...attrs.matchAll(/\b(colspan|rowspan)="(\d+)"/g)].filter(([, , v]) => v !== '1').map(([, k, v]) => ` ${k}="${v}"`).join('');
      const style = tag === 'th' ? `${CELL_STYLE}; background:#f3f3f3; font-weight:bold` : CELL_STYLE;
      return `<${tag}${spans} style="${style}">${inner.replace(/<p>/g, '<p style="margin:0">')}</${tag}>`;
    });
}

/** Wrap the editor's HTML so mail apps render it consistently. */
export function emailHtml(bodyHtml) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #1f1f1f">${emailTables(bodyHtml)
    .replace(/<blockquote>/g, '<blockquote style="margin:0 0 0 .8ex; border-left:2px solid #ccc; padding-left:1ex; color:#555">')}</div>`;
  // (Pictures carry their own size and max-width style from the editor.)
}

export const isEmptyDoc = (doc) => !docToText(doc).trim();
