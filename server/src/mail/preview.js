// Looking at an email attachment in the browser instead of downloading it. Attachments come from
// anyone, so only types that can't run script are shown (pictures but not SVG, PDF, plain text,
// audio and video), with the type taken from the file's name rather than what the sender claims,
// served with nosniff and a locked-down Content-Security-Policy like Drive's previews.
import { mimeFor, isInlineSafe } from '../util.js';

/** The type to show an attachment as, or null when it can only be downloaded. */
export function previewMime(filename) {
  const mime = mimeFor(String(filename || ''));
  return isInlineSafe(mime) ? mime : null;
}

/** Headers for showing an attachment of that type on our origin. */
export function previewHeaders(mime, filename) {
  return {
    'Content-Type': mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime,
    'X-Content-Type-Options': 'nosniff',
    // The PDF viewer needs the default policy to work; everything else gets nothing it could run.
    ...(mime !== 'application/pdf' && { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename || 'attachment')}`,
    'Cache-Control': 'private, max-age=0',
  };
}
