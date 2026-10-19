import { Platform } from 'react-native';

/**
 * Tema da Yui, no mesmo formato do Braga Digital Studio: fundo preto, superfícies
 * planas separadas por borda de 1px, botão primário em pílula branca/preta e o
 * vermelho só como acento. Tema escuro (padrão) e claro.
 *
 * Na web, cada cor é uma variável CSS (definida em web.ts), então trocar o tema
 * não exige renderizar de novo. No Android vale o tema escuro.
 */
const web = Platform.OS === 'web';
const v = (name: string, dark: string) => (web ? `var(--${name})` : dark);

export const colors = {
  bg: v('bg', '#000000'),
  surface: v('card', '#1c1c1c'),
  surfaceAlt: v('card-2', '#262626'),
  border: v('line', '#333333'),
  text: v('text', '#ffffff'),
  muted: v('muted', '#a1a1a1'),
  /** Destaque (vermelho). `accentText` é a versão legível sobre as superfícies. */
  accent: v('accent', '#ff0000'),
  accentText: v('accent-text', '#ff7373'),
  accentLight: v('accent-light', 'rgba(255,0,0,0.18)'),
  /** Botão primário em pílula: branco com texto preto (preto com texto branco no claro). */
  btnBg: v('btn-bg', '#ffffff'),
  btnFg: v('btn-fg', '#000000'),
  inputBg: v('input-bg', '#262626'),
  danger: v('danger', '#ff5252'),
  dangerBg: v('danger-bg', 'rgba(255,82,82,0.14)'),
  dangerSolid: v('danger-solid', '#c62828'),
  success: v('success', '#4caf50'),
  warning: v('warning', '#f59e0b'),
  // Nomes antigos, mantidos como alias.
  primary: v('accent', '#ff0000'),
  primaryDim: v('accent-light', 'rgba(255,0,0,0.18)'),
  userBubble: v('btn-bg', '#ffffff'),
  yuiBubble: v('card-2', '#262626'),
} as const;

export const radius = { sm: 8, md: 16, lg: 24, pill: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Montserrat nos títulos e Inter no texto (só na web; no Android usa a fonte do sistema). */
export const fonts = {
  title: web ? "Montserrat, 'Segoe UI', system-ui, sans-serif" : undefined,
  body: web ? "Inter, 'Segoe UI', system-ui, sans-serif" : undefined,
  icon: web ? "'Material Symbols Rounded'" : undefined,
} as const;
