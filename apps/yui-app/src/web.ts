/**
 * Preparação da versão web: fontes (Inter, Montserrat e Material Symbols, da pasta
 * public/fonts, sem CDN), variáveis de cor dos temas e ajustes globais.
 * No Android não faz nada.
 */
import { Platform } from 'react-native';

export type ThemeMode = 'dark' | 'light';

const KEY = 'yui.theme';

const CSS = `
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/Inter-Regular.woff2') format('woff2'); }
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 500 700; font-display: swap; src: url('/fonts/Inter-SemiBold.woff2') format('woff2'); }
@font-face { font-family: 'Montserrat'; font-style: normal; font-weight: 700 900; font-display: swap; src: url('/fonts/Montserrat-Bold.woff2') format('woff2'); }
@font-face { font-family: 'Material Symbols Rounded'; font-style: normal; font-weight: 400; font-display: block; src: url('/fonts/material-symbols-rounded.woff2') format('woff2'); }

:root, [data-theme="dark"] {
  color-scheme: dark;
  --bg: #08060e; --card: #181222; --card-2: #221a30; --line: #32273f;
  --text: #f4f0fa; --muted: #9c93b3;
  --btn-bg: #8a3fe6; --btn-fg: #ffffff; --input-bg: #221a30;
  --accent: #8a3fe6; --accent-text: #c77dff; --accent-light: rgba(138,63,230,0.24);
  --danger: #ff5a5f; --danger-bg: rgba(255,90,95,0.14); --danger-solid: #b42318;
  --success: #3fb27f; --warning: #f59e0b;
}
[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f3fb; --card: #ffffff; --card-2: #efeaf8; --line: #ded6ee;
  --text: #15101f; --muted: #655d7a;
  --btn-bg: #6a28c0; --btn-fg: #ffffff; --input-bg: #ffffff;
  --accent: #7b34d6; --accent-text: #6a28c0; --accent-light: rgba(123,52,214,0.10);
  --danger: #c20000; --danger-bg: rgba(194,0,0,0.08); --danger-solid: #c62828;
  --success: #2a6f2e; --warning: #9a5b00;
}
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }
:where(#root) * { font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; }
:where(#root) input, :where(#root) textarea { font-family: inherit; }
::selection { background: var(--accent-light); }
*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[role="button"], [role="tab"] { transition: background-color .2s ease, opacity .2s ease, transform .15s ease; }
[role="button"]:active:not([aria-disabled="true"]) { transform: scale(0.98); }
* { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
@media (prefers-reduced-motion: reduce) { * { transition-duration: .001ms !important; animation-duration: .001ms !important; } }
`;

export function getTheme(): ThemeMode {
  if (Platform.OS !== 'web') return 'dark';
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function setTheme(mode: ThemeMode): void {
  if (Platform.OS !== 'web') return;
  document.documentElement.setAttribute('data-theme', mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', mode === 'light' ? '#f6f3fb' : '#08060e');
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* armazenamento bloqueado: o tema vale só nesta sessão */
  }
}

/** Chamado uma vez, antes de desenhar o app. */
export function initWeb(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-yui', 'base');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.title = 'Yui';
  setTheme(getTheme());
}
