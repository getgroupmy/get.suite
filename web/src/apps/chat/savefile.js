// Save to Drive: a copy of a file someone attached in Chat, in My Drive or a folder you choose, then "Show in Drive".
import { post } from '../../api.js';

export async function saveToDrive(toast, navigate, messageId, file, parentId = null) {
  try {
    const saved = await post(`/chat/messages/${messageId}/files/${file.id}/save`, parentId ? { parent_id: parentId } : {});
    toast(`Saved “${saved.name}” to ${parentId ? 'Drive' : 'My Drive'}`, 'info', { action: { label: 'Show in Drive', onClick: () => navigate(saved.parent_id ? `/drive/folder/${saved.parent_id}` : `/drive?preview=${saved.id}`) } });
    return saved;
  } catch (e) { toast(e.message, 'error'); return null; }
}

/** The menu items for saving a file: to My Drive at once, or to a folder picked in a dialog. */
export const saveItems = (toast, navigate, messageId, file, pick, named = false) => [
  { label: named ? `Save “${file.name}” to My Drive` : 'Save to My Drive', icon: 'folder', onClick: () => saveToDrive(toast, navigate, messageId, file) },
  { label: named ? `Save “${file.name}” to a folder…` : 'Save to a folder…', icon: 'folder', onClick: () => pick({ messageId, file }) },
];
