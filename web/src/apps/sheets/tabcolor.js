// A sheet's tab colour (right-click… the tab's ▾ → Tab colour): kept on the sheet as `tabColor: '#rrggbb'`, left out
// when it has none. Shown as a bar under the tab's name; Excel and OpenDocument files keep it both ways.

/** The colours offered, as Google Sheets and Excel offer theirs: [value, name]. */
export const TAB_COLOURS = [
  ['#e53935', 'Red'], ['#fb8c00', 'Orange'], ['#fdd835', 'Yellow'], ['#43a047', 'Green'], ['#00897b', 'Teal'],
  ['#1e88e5', 'Blue'], ['#5e35b1', 'Purple'], ['#d81b60', 'Pink'], ['#6d4c41', 'Brown'], ['#757575', 'Grey'],
];

/** A tab colour as kept ('#rrggbb', lower case), or undefined when it isn't one. */
export function tabColorOf(v) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? '').trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

/** A tab colour's name, for screen readers and its tooltip: the palette's, else the colour itself. */
export const tabColorName = (v) => TAB_COLOURS.find(([c]) => c === tabColorOf(v))?.[1] || tabColorOf(v) || '';
