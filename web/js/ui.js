// Panel chrome: tabs and colour theme. Independent of the map code in main.js.

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { /* private window: settings just are not remembered */ }
  return null;
}

// Tabs
const tabs = [...document.querySelectorAll('.tabs [data-tab]')];
const panes = [...document.querySelectorAll('.pane[data-pane]')];
function showTab(name) {
  if (!tabs.some((t) => t.dataset.tab === name)) name = 'day';
  tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
  panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
  store('sbd-tab', name);
}
tabs.forEach((t) => t.addEventListener('click', () => {
  showTab(t.dataset.tab);
  document.getElementById('panel').scrollTop = 0;
}));
showTab(store('sbd-tab') || 'day');

// Theme: auto follows the system, light/dark force it.
const themeButtons = [...document.querySelectorAll('#theme [data-theme]')];
function setTheme(theme) {
  if (theme === 'light' || theme === 'dark' || theme === 'street') {
    document.documentElement.dataset.theme = theme;
    store('sbd-theme', theme);
  } else {
    theme = 'auto';
    delete document.documentElement.dataset.theme;
    store('sbd-theme', null);
  }
  themeButtons.forEach((b) => b.classList.toggle('on', b.dataset.theme === theme));
}
themeButtons.forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.theme)));
setTheme(document.documentElement.dataset.theme || 'auto');

// Bottom sheet on phones: tap the handle to step through peek / half / full, or drag it.
const SHEETS = ['peek', 'half', 'full'];
const handle = document.getElementById('sheet-handle');
const panel = document.getElementById('panel');
function setSheet(name) {
  document.documentElement.dataset.sheet = SHEETS.includes(name) ? name : 'half';
  panel.style.height = '';
}
setSheet('half');
if (handle) {
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, h: panel.getBoundingClientRect().height, moved: false };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 6) drag.moved = true;
    if (!drag.moved) return;
    panel.classList.add('dragging');
    panel.style.height = `${Math.max(110, Math.min(window.innerHeight * 0.92, drag.h + dy))}px`;
  });
  const end = () => {
    if (!drag) return;
    panel.classList.remove('dragging');
    const current = document.documentElement.dataset.sheet;
    if (drag.moved) {
      const share = panel.getBoundingClientRect().height / window.innerHeight;
      setSheet(share < 0.32 ? 'peek' : share < 0.72 ? 'half' : 'full');
    } else {
      setSheet(SHEETS[(SHEETS.indexOf(current) + 1) % SHEETS.length]);
    }
    drag = null;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
// Choosing a tab while the sheet only peeks opens it.
tabs.forEach((t) => t.addEventListener('click', () => {
  if (document.documentElement.dataset.sheet === 'peek') setSheet('half');
}));

// Installable app: the service worker keeps the app shell for offline starts.
// Map tiles and live data always come from the network.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* app works without it */ }); });
}
