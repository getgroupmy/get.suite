// Web addresses (http/https) and this Workspace's own paths (/docs/…, /tasks/…, /notes?note=…), as in Chat.
export const TEXT_LINK_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]|(?<![\w/@.])\/(?:docs|sheets|slides|drive|calendar|mail|chat|tasks|notes|contacts|forms)(?:\/[\w-]+)*(?:\?[\w=&%-]+)?)/g;
