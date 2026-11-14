// Did the mouse really move? Lists that open (or change) under a resting pointer get a mouse event from
// the browser as if it had moved onto an item; picking that item on hover would let Enter open something
// nobody chose. Hover highlighting uses onMouseMove with this check instead of onMouseEnter.
export const moved = (e) => !!(e?.movementX || e?.movementY);
