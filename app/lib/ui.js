/**
 * Settled — shared UI chrome used by both the user and solver apps.
 * Status-box logging, tab switching, and the theme toggle. Browser-only (touches
 * document/localStorage); not imported in Node tests.
 */

/** Append a line to a status box, revealing it and scrolling to the bottom. */
export function log(boxId, msg, cls) {
  const box = document.getElementById(boxId);
  box.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'line' + (cls ? ' ' + cls : '');
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

export function clearLog(boxId) {
  const box = document.getElementById(boxId);
  box.innerHTML = '';
  box.style.display = 'none';
}

/** Tab switcher: activates the tab + panel named `name`. */
export function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const tab = document.querySelector(`.tab[data-tab="${name}"]`) ||
              document.querySelector(`.tab[onclick="showTab('${name}')"]`);
  if (tab) tab.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
}

export function toggleTheme() {
  const r = document.documentElement;
  const next = r.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  r.setAttribute('data-theme', next);
  const lbl = document.getElementById('theme-label');
  if (lbl) lbl.textContent = next === 'light' ? 'Dark' : 'Light';
  try { localStorage.setItem('theme', next); } catch (e) {}
}

/** Sync the theme toggle label with the theme set before paint. */
export function initThemeLabel() {
  const lbl = document.getElementById('theme-label');
  if (lbl) lbl.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? 'Dark' : 'Light';
}
