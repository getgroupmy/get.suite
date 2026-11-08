// Dropdown chips in a document: a small coloured pill (Status: In progress, Priority: High…) that
// anyone who can edit changes with a click. The choices travel with the chip, so the document
// itself says what can be picked, and every copy, download and earlier version shows the same.
import { Node } from '@tiptap/core';

export const CHIP_COLORS = ['grey', 'blue', 'green', 'yellow', 'red', 'purple'];
export const MAX_OPTIONS = 12;
export const MAX_LABEL = 40;

/** Ready-made sets of choices, each with a colour per choice. */
export const CHIP_PRESETS = [
  { name: 'Status', options: [['Not started', 'grey'], ['In progress', 'blue'], ['Blocked', 'red'], ['Done', 'green']] },
  { name: 'Review', options: [['Draft', 'grey'], ['In review', 'yellow'], ['Changes needed', 'red'], ['Approved', 'green']] },
  { name: 'Priority', options: [['Low', 'grey'], ['Medium', 'yellow'], ['High', 'red']] },
  { name: 'Yes or no', options: [['Yes', 'green'], ['No', 'red'], ['Maybe', 'yellow']] },
].map((p) => ({ name: p.name, options: p.options.map(([label, color]) => ({ label, color })) }));

/**
 * Choices as typed (one per line, or given as a list), tidied: trimmed, no blanks or repeats
 * (ignoring case), at most MAX_OPTIONS of at most MAX_LABEL characters, each with a colour.
 * Colours already given are kept; new ones go round the palette after grey.
 */
export function cleanOptions(input) {
  const list = Array.isArray(input) ? input : String(input || '').split('\n');
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const label = String(typeof item === 'string' ? item : item?.label || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const color = CHIP_COLORS.includes(item?.color) ? item.color : CHIP_COLORS[out.length % CHIP_COLORS.length];
    out.push({ label, color });
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

/** The chip's choice, or null when nothing (or a choice that's no longer offered) is picked. */
export function chipChoice(attrs) {
  const options = Array.isArray(attrs?.options) ? attrs.options : [];
  return options.find((o) => o.label === attrs?.value) || null;
}

/** What a chip reads as in text: its choice, or the first choice in grey when none is picked yet. */
export function chipText(attrs) {
  return chipChoice(attrs)?.label || (Array.isArray(attrs?.options) && attrs.options[0]?.label) || '—';
}

const parseOptions = (el) => { try { return cleanOptions(JSON.parse(el.getAttribute('data-options') || '[]')); } catch { return []; } };

export const DropChip = Node.create({
  name: 'dropchip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    options: { default: [], parseHTML: parseOptions, renderHTML: (a) => ({ 'data-options': JSON.stringify(a.options || []) }) },
    value: { default: null, parseHTML: (el) => el.getAttribute('data-value') || null, renderHTML: (a) => (a.value ? { 'data-value': a.value } : {}) },
  }),
  parseHTML: () => [{ tag: 'span[data-dropchip]' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const choice = chipChoice(node.attrs);
    return ['span', { ...HTMLAttributes, 'data-dropchip': '', class: `doc-chip chip-${choice?.color || 'none'}`, role: 'button', 'aria-label': `Dropdown: ${chipText(node.attrs)}` }, `${chipText(node.attrs)} ▾`];
  },
  renderText: ({ node }) => chipText(node.attrs),
  addCommands() {
    return {
      insertDropChip: (options) => ({ commands }) => commands.insertContent([{ type: this.name, attrs: { options: cleanOptions(options), value: null } }, { type: 'text', text: ' ' }]),
    };
  },
});
