// Email a share link (Drive → Share → Link sharing → ✉): a new message with the link and what it's for.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** { subject, html } for a link to `file` ({ name, kind }), `link` ({ mode, expires_at, has_password }), at `url`. */
export function linkEmail(file, link, url, { locale } = {}) {
  const until = link.expires_at ? new Date(link.expires_at).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const a = `<a href="${esc(url)}">${esc(url)}</a>`;
  const lines = link.mode === 'upload'
    ? [`<p>Hello,</p>`, `<p>Please send me your files for <strong>${esc(file.name)}</strong> here: ${a}</p>`, `<p>The page asks for your name, then you can drop the files on it. You won’t see anyone else’s files, and you don’t need an account.</p>`]
    : [`<p>Hello,</p>`, `<p>Here’s ${file.kind === 'folder' ? 'the folder' : ''} <strong>${esc(file.name)}</strong>: ${a}</p>`, `<p>You can ${file.kind === 'folder' ? 'open the files in it and download them' : 'view it and download it'} without an account.</p>`];
  if (until) lines.push(`<p>The link works until ${esc(until)}.</p>`);
  if (link.has_password) lines.push('<p>It needs a password, which I’ll send you separately.</p>');
  return { subject: link.mode === 'upload' ? `Please send me files: ${file.name}` : file.name, html: lines.join('').replace('Here’s  <strong>', 'Here’s <strong>') };
}
