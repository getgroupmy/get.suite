// A link to a line of a text file in Drive: /drive?preview=<file>&line=<n> opens the file's preview with that line in view.
/** The address of line n of a file. */
export const lineLink = (origin, fileId, n) => `${origin}/drive?preview=${encodeURIComponent(fileId)}&line=${n}`;
/** The line a link asks for (?line=12), or null when it asks for none or for something that isn't a line. */
export function lineFrom(param) {
  if (!/^[1-9][0-9]{0,6}$/.test(String(param ?? ''))) return null;
  return Number(param);
}
