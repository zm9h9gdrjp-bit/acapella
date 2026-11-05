// Light/dark handling. 'auto' follows the phone's setting.
const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = [];
let choice = 'auto';

function resolve() {
  const dark = choice === 'dark' || (choice === 'auto' && media && media.matches);
  const root = document.documentElement;
  root.dataset.resolved = dark ? 'dark' : 'light';
  if (choice === 'auto') delete root.dataset.theme; else root.dataset.theme = choice;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#1c1914' : '#f3eee2';
  listeners.forEach(fn => fn(dark));
}

export function applyTheme(c) { choice = c || 'auto'; resolve(); }
export function onThemeChange(fn) { listeners.push(fn); }
if (media && media.addEventListener) media.addEventListener('change', () => { if (choice === 'auto') resolve(); });

const cache = new Map();
/** Layer ink colours are dark for cream paper; lift them on the black deck so waveforms stay readable. */
export function displayColor(hex) {
  if (document.documentElement.dataset.resolved !== 'dark') return hex;
  let c = cache.get(hex);
  if (c) return c;
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(v + (255 - v) * 0.38);
  const r = mix(n >> 16), g = mix((n >> 8) & 255), b = mix(n & 255);
  c = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  cache.set(hex, c);
  return c;
}
