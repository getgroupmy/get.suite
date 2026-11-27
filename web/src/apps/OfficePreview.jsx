// A Word, Excel, PowerPoint or Markdown file shown read-only, as Docs, Sheets or Slides would show
// it, without making a copy (Drive previews and email attachments). `url` gives
// { kind, content, token } (or `load` does, with `picturesAt(token)` where its pictures are: a share link's page);
// its pictures are at /api/office-preview/<token>/pictures/….
import { useEffect, useState } from 'react';
import { get } from '../api.js';
import { DocPreview } from './docs/DocEditor.jsx';
import { PublishedDeck, PublishedSheet } from './PublishedPage.jsx';

export default function OfficePreview({ url, load = null, picturesAt = null }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setError('');
    (load ? load() : get(url)).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [url]);
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!data) return <p className="muted">Getting the preview ready…</p>;
  const base = picturesAt ? picturesAt(data.token) : `/api/office-preview/${data.token}`;
  return (
    <div className="office-preview" aria-label="Preview">
      {data.kind === 'doc' ? <DocPreview content={data.content} pictureBase={base} look={data.look} />
        : data.kind === 'slides' ? <PublishedDeck deck={data.content} base={base} />
        : <PublishedSheet book={data.content} base={base} />}
    </div>
  );
}
