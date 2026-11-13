// Save to Drive: a copy of a file someone attached in Chat, in your My Drive, then "Show in Drive".
import { post } from '../../api.js';

export async function saveToDrive(toast, navigate, messageId, file) {
  try {
    const saved = await post(`/chat/messages/${messageId}/files/${file.id}/save`, {});
    toast(`Saved “${saved.name}” to My Drive`, 'info', { action: { label: 'Show in Drive', onClick: () => navigate(`/drive?preview=${saved.id}`) } });
    return saved;
  } catch (e) { toast(e.message, 'error'); return null; }
}
