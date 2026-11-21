// A document, spreadsheet or presentation inside a folder shared by link: shown read-only as a published one is,
// its pictures from the link (loaded only when someone opens one, so the link page stays small).
import { DocPreview } from './docs/DocEditor.jsx';
import { PublishedDeck, PublishedSheet } from './PublishedPage.jsx';

export default function LinkedItem({ item, base }) {
  if (item.kind === 'doc') return <div className="link-doc"><DocPreview content={item.content} pictureBase={base} /></div>;
  if (item.kind === 'slides') return <PublishedDeck deck={item.content} base={base} />;
  return <PublishedSheet book={item.content} base={base} />;
}
