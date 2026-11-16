// Before the page draws: the theme chosen in Settings on this device (none: follow the system).
try { var t = localStorage.getItem('nw.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked */ }
// Text size, more contrast and less motion (Settings → Appearance), kept on this device too.
try {
  var d = document.documentElement, z = localStorage.getItem('nw.textSize'), c = localStorage.getItem('nw.contrast'), m = localStorage.getItem('nw.motion');
  if (z === 'larger' || z === 'largest') d.dataset.textSize = z;
  if (c === 'more') d.dataset.contrast = 'more';
  if (m === 'reduce') d.dataset.motion = 'reduce';
} catch (e) { /* storage blocked */ }
