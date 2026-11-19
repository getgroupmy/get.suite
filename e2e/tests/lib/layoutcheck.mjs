// What the layout tests (narrowlayout.mjs, narrowmail.mjs) look for on a screen: its main headings readable
// (not squeezed, even to no width, nor wrapped a word a line), nothing drawn over them, and no button or
// field past the window's edge that nothing scrolls to. Returns what's wrong, as sentences.
/**
 * What's wrong with the screen's main headings (h1, and the h2s of a header bar): one squeezed narrower
 * than a few letters while it has more to show, or one overlapped by a button, link, field or menu.
 */
export const layoutProblems = (page) => page.evaluate(() => {
  // Shown: with a size, not hidden, and not see-through (buttons kept invisible until a tile is pointed at).
  const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (!(r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none')) return false; for (let a = el; a; a = a.parentElement) if (Number(getComputedStyle(a).opacity) === 0) return false; return true; };
  const heads = [...document.querySelectorAll('main h1, [role="main"] h1, .chat-head h1, .page-head h1, header h1')].filter((el) => { const r = el.getBoundingClientRect(), st = getComputedStyle(el); return r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; }); // (a heading squeezed to no width still counts)
  const controls = [...document.querySelectorAll('button, a[href], select, input:not([type="hidden"]), [role="button"], [role="combobox"]')].filter(seen);
  const out = [];
  // In a dropdown, menu or dialog laid over the page (not one the heading itself is in).
  const popup = (el, h) => { const p = el.closest('.search-results, [role="listbox"], [role="menu"], [role="dialog"], .modal-backdrop'); return !!p && !p.contains(h); };
  const over = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 6 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 6;
  for (const h of heads) {
    const r = h.getBoundingClientRect();
    const text = h.textContent.trim();
    if (!text) continue;
    // Under a panel or dialog laid over the screen (a thread on a phone covers the conversation): not shown, so fine.
    const top = document.elementFromPoint(Math.min(Math.max(r.left + 4, 0), window.innerWidth - 1), r.top + r.height / 2);
    const cover = top?.closest('[role="complementary"], [role="dialog"], aside, .modal, .modal-backdrop, .search-results, [role="listbox"], [role="menu"]'); // (a dialog's dimmed backdrop, search results and menus over the page too)
    if (cover && !cover.contains(h)) continue;
    // Squeezed: a heading of several letters given less room than three of them, or wrapped to a word a line.
    const lineHeight = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.3;
    if (text.length > 3 && r.width < 48) out.push(`“${text}” squeezed to ${Math.round(r.width)}px`);
    else if (text.split(/\s+/).length > 1 && (r.height > lineHeight * 3.2 || Math.round(r.height / lineHeight) >= text.split(/\s+/).length)) out.push(`“${text}” wrapped to ${Math.round(r.height / lineHeight)} lines in ${Math.round(r.width)}px`);
    // Controls in its toolbar cut off at the window's edge (and so out of reach).
    const bar = h.parentElement;
    for (const c of [...bar.querySelectorAll('button, a[href], select, input')].filter(seen)) {
      const q = c.getBoundingClientRect();
      if (q.right > window.innerWidth + 1) { out.push(`“${(c.getAttribute('aria-label') || c.textContent || '').trim().slice(0, 30)}” beside “${text}” goes off the edge`); break; }
    }
    // Where its words actually are (a heading's box spans the whole row, its text needn't).
    const range = document.createRange(); range.selectNodeContents(h);
    // Only its visible part: a heading cut off with an ellipsis reports its full width.
    const hb = h.getBoundingClientRect(), hs = getComputedStyle(h);
    const cut = hs.overflowX !== 'visible';
    const words = [...range.getClientRects()].filter((x) => x.width > 0).map((x) => (cut ? { left: Math.max(x.left, hb.left), right: Math.min(x.right, hb.right), top: x.top, bottom: x.bottom, width: Math.min(x.right, hb.right) - Math.max(x.left, hb.left) } : x)).filter((x) => x.width > 0);
    // Other text drawn over its words (a label beside it that didn't make room).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || h.contains(n) || !seen(n.parentElement)) continue;
      if (popup(n.parentElement, h)) continue; // a dropdown or menu laid over the page
      // Text kept for screen readers only (a 1px clipped box), or invisible, isn't drawn over anything.
      const ps = getComputedStyle(n.parentElement), pr = n.parentElement.getBoundingClientRect();
      if (pr.width <= 2 || pr.height <= 2 || ps.clip !== 'auto' || ps.clipPath !== 'none' || Number(ps.opacity) === 0 || ps.color === 'transparent') continue;
      const tr = document.createRange(); tr.selectNodeContents(n);
      // Only what's visible of it: text cut off with an ellipsis (or by a scrolling box) still reports its full width.
      let clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
      for (let a = n.parentElement; a && a !== document.body; a = a.parentElement) {
        const st = getComputedStyle(a);
        if (st.overflowX !== 'visible' || st.overflowY !== 'visible') { const b = a.getBoundingClientRect(); clip = { left: Math.max(clip.left, b.left), top: Math.max(clip.top, b.top), right: Math.min(clip.right, b.right), bottom: Math.min(clip.bottom, b.bottom) }; }
      }
      const visible = [...tr.getClientRects()].map((x) => ({ left: Math.max(x.left, clip.left), top: Math.max(x.top, clip.top), right: Math.min(x.right, clip.right), bottom: Math.min(x.bottom, clip.bottom), width: Math.min(x.right, clip.right) - Math.max(x.left, clip.left) }));
      const hit = visible.find((x) => x.width > 0 && Math.abs(x.top - r.top) < r.height + 40 && words.some((t) => over(t, x)));
      if (hit) { out.push(`“${text}” under the text “${n.textContent.trim().slice(0, 30)}” (${n.parentElement.tagName.toLowerCase()}.${String(n.parentElement.className).split(' ')[0]} at ${Math.round(hit.left)},${Math.round(hit.top)})`); break; }
    }

    for (const c of controls) {
      if (h.contains(c) || c.contains(h) || popup(c, h)) continue;
      const q = c.getBoundingClientRect();
      // More than a sliver of the text under the control is an overlap.
      if (words.some((t) => over(t, q))) out.push(`“${text}” under ${c.tagName.toLowerCase()} “${(c.getAttribute('aria-label') || c.textContent || c.value || '').trim().slice(0, 30)}”`);
    }
  }
  // Anywhere on the screen: a button or field past the window's edge that nothing scrolls to (a toolbar
  // that scrolls sideways is fine).
  const W = window.innerWidth;
  for (const c of controls) {
    const q = c.getBoundingClientRect();
    if (q.right <= W + 1 && q.left >= -1) continue;
    let scrolls = false;
    for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
      const st = getComputedStyle(a);
      if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && a.scrollWidth > a.clientWidth) { scrolls = true; break; }
      // A drawer kept wholly off-screen until it's opened (the phone's app list) isn't cut off.
      if ((st.position === 'fixed' || st.position === 'absolute') && (() => { const b = a.getBoundingClientRect(); return b.right <= 0 || b.left >= W; })()) { scrolls = true; break; }
    }
    if (!scrolls && !c.closest('[aria-hidden="true"], .sr-only, .visually-hidden')) { out.push(`${c.tagName.toLowerCase()} “${(c.getAttribute('aria-label') || c.textContent || c.placeholder || '').trim().slice(0, 30)}” off the edge (${Math.round(q.left)}–${Math.round(q.right)} of ${W}; in ${[c.parentElement, c.parentElement?.parentElement, c.parentElement?.parentElement?.parentElement].filter(Boolean).map((x) => `${x.tagName.toLowerCase()}.${String(x.className).split(' ')[0]}`).join(' < ')})`); }
  }
  // A dialog: inside the window across, and either inside it top to bottom or scrollable (else its last buttons can't be reached).
  for (const d of [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter(seen)) {
    const b = d.getBoundingClientRect();
    const name = (d.getAttribute('aria-label') || d.querySelector('h2, h1')?.textContent || 'a dialog').trim().slice(0, 40);
    if (b.left < -1 || b.right > W + 1) out.push(`dialog “${name}” wider than the window (${Math.round(b.left)}–${Math.round(b.right)} of ${W})`);
    if (b.bottom > window.innerHeight + 1) {
      let scrolls = false;
      for (let a = d; a && a !== document.documentElement; a = a.parentElement) { const st = getComputedStyle(a); if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && a.scrollHeight > a.clientHeight) { scrolls = true; break; } }
      if (!scrolls && ![...d.querySelectorAll('*')].some((x) => { const st = getComputedStyle(x); return (st.overflowY === 'auto' || st.overflowY === 'scroll') && x.scrollHeight > x.clientHeight; })) out.push(`dialog “${name}” taller than the window, and nothing scrolls`);
    }
  }
  return out;
});
