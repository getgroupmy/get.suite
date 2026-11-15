/** A file shared to be viewed only (no download, print or copy), for someone who isn't its owner or an editor. */
export const viewOnly = (f) => !!f?.no_download && !['editor', 'owner'].includes(f.role);
