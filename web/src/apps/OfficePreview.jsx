// A Word, Excel, PowerPoint or Markdown file shown read-only, as Docs, Sheets or Slides would show
// it, without making a copy (Drive previews and email attachments). `url` gives
// { kind, content, token }; its pictures are at /api/office-preview/<token>/pictures/….
import { useEffect, useState } from 'react';
import { get } from '../api.js';
import { DocPreview } from './docs/DocEditor.jsx';
import { PublishedDeck, PublishedSheet } from './PublishedPage.jsx';

export default function OfficePreview({ url }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setError('');
    get(url).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [url]);
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!data) return <p className="muted">Getting the preview ready…</p>;
  const base = `/api/office-preview/${data.token}`;
  return (
    <div className="office-preview" aria-label="Preview">
      {data.kind === 'doc' ? <DocPreview content={data.content} pictureBase={base} />
        : data.kind === 'slides' ? <PublishedDeck deck={data.content} base={base} />
        : <PublishedSheet book={data.content} />}
    </div>
  );
}
