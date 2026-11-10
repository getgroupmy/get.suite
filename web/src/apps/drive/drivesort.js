// How Drive orders a list: folders first, then by name, last change or size, either way round.
// Folders' sizes are what's inside them; ties fall back to the name, numbers in names counted as numbers ("File 2" before "File 10").
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const SORTS = [['name', 'Name'], ['modified', 'Modified'], ['size', 'Size']];

export function sortFiles(files, { sort = 'name', desc = false } = {}) {
  const key = { modified: (f) => f.updated_at || 0, size: (f) => (f.kind === 'folder' ? f.folder_size || 0 : f.size || 0) }[sort];
  const byName = (a, b) => collator.compare(a.name || '', b.name || '');
  return [...(files || [])].sort((a, b) => {
    const folders = (b.kind === 'folder') - (a.kind === 'folder');
    if (folders) return folders;
    const c = key ? key(a) - key(b) || byName(a, b) : byName(a, b);
    return desc ? -c : c;
  });
}

/** Is a file a picture the browser can show as a thumbnail? */
export const isPicture = (f) => f?.kind !== 'folder' && /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(f?.mime || '');
