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
  bg: v('bg', '#08060e'),
  surface: v('card', '#181222'),
  surfaceAlt: v('card-2', '#221a30'),
  border: v('line', '#32273f'),
  text: v('text', '#f4f0fa'),
  muted: v('muted', '#9c93b3'),
  /** Destaque (vermelho). `accentText` é a versão legível sobre as superfícies. */
  accent: v('accent', '#8a3fe6'),
  accentText: v('accent-text', '#c77dff'),
  accentLight: v('accent-light', 'rgba(138,63,230,0.24)'),
  /** Botão primário em pílula, no roxo da Yui com texto branco. */
  btnBg: v('btn-bg', '#8a3fe6'),
  btnFg: v('btn-fg', '#ffffff'),
  inputBg: v('input-bg', '#221a30'),
  danger: v('danger', '#ff5a5f'),
  dangerBg: v('danger-bg', 'rgba(255,90,95,0.14)'),
  dangerSolid: v('danger-solid', '#b42318'),
  success: v('success', '#3fb27f'),
  warning: v('warning', '#f59e0b'),
  // Nomes antigos, mantidos como alias.
  primary: v('accent', '#8a3fe6'),
  primaryDim: v('accent-light', 'rgba(138,63,230,0.24)'),
  userBubble: v('btn-bg', '#ffffff'),
  yuiBubble: v('card-2', '#221a30'),
} as const;

export const radius = { sm: 8, md: 16, lg: 24, pill: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Montserrat nos títulos e Inter no texto (só na web; no Android usa a fonte do sistema). */
export const fonts = {
  title: web ? "Montserrat, 'Segoe UI', system-ui, sans-serif" : undefined,
  body: web ? "Inter, 'Segoe UI', system-ui, sans-serif" : undefined,
  icon: web ? "'Material Symbols Rounded'" : undefined,
} as const;
