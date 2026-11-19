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
  if (theme === 'light' || theme === 'dark') {
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
