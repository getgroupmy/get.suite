import { Link } from 'react-router';
import { TEXT_LINK_RE } from './textlinks.js';
const MENTION = /(@[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi;

/** Plain text (a comment) with @mentions highlighted and links that open: other sites in a new tab, Workspace's own here. */
export default function LinkedText({ text }) {
  return String(text).split(MENTION).map((chunk, j) => (j % 2
    ? <span key={`m${j}`} className="mention">{chunk}</span>
    : chunk.split(TEXT_LINK_RE).map((part, i) => {
      if (i % 2 === 0) return part;
      return part.startsWith('/')
        ? <Link key={`${j}-${i}`} to={part}>{part}</Link>
        : <a key={`${j}-${i}`} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
    })));
}
