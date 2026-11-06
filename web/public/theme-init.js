// Before the page draws: the theme chosen in Settings on this device (none: follow the system).
try { var t = localStorage.getItem('nw.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked */ }
