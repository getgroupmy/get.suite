// Undo and redo for a shared (Yjs) document: only your own changes are taken back, never a
// colleague's, and changes made within a moment of each other are undone together.
import { useEffect, useState } from 'react';
import * as Y from 'yjs';

/** `scopeOf(ydoc)` gives the shared types to track. Returns { undo, redo, canUndo, canRedo }. */
export function useUndo(ydoc, scopeOf) {
  const [manager, setManager] = useState(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!ydoc) return undefined;
    // Changes from others arrive with the connection as their origin, so only local ones are kept.
    const m = new Y.UndoManager(scopeOf(ydoc), { captureTimeout: 600 });
    const update = () => refresh((n) => n + 1);
    m.on('stack-item-added', update);
    m.on('stack-item-popped', update);
    m.on('stack-cleared', update);
    setManager(m);
    return () => { m.destroy(); setManager(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc]);
  return {
    undo: () => { manager?.undo(); },
    redo: () => { manager?.redo(); },
    canUndo: !!manager?.canUndo(),
    canRedo: !!manager?.canRedo(),
  };
}

/** Is this key press Undo (Ctrl/Cmd+Z) or Redo (Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z)? */
export function undoKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return null;
}
