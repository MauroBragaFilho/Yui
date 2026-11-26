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
  bg: v('bg', '#0e0e10'),
  surface: v('card', '#161619'),
  surfaceAlt: v('card-2', '#1e1e22'),
  border: v('line', '#2b2b31'),
  text: v('text', '#f2f2f4'),
  muted: v('muted', '#a1a1aa'),
  /** Destaque (roxo). `accentText` é a versão legível sobre as superfícies. */
  accent: v('accent', '#8a3fe6'),
  accentText: v('accent-text', '#c9a0ff'),
  accentLight: v('accent-light', 'rgba(138,63,230,0.24)'),
  /** Botão primário em pílula, no roxo da Yui com texto branco. */
  btnBg: v('btn-bg', '#8a3fe6'),
  btnFg: v('btn-fg', '#ffffff'),
  inputBg: v('input-bg', '#1e1e22'),
  danger: v('danger', '#ff7a7f'),
  dangerBg: v('danger-bg', 'rgba(255,90,95,0.14)'),
  dangerSolid: v('danger-solid', '#b42318'),
  success: v('success', '#3fb27f'),
  warning: v('warning', '#f59e0b'),
  // Nomes antigos, mantidos como alias.
  primary: v('accent', '#8a3fe6'),
  primaryDim: v('accent-light', 'rgba(138,63,230,0.24)'),
  userBubble: v('btn-bg', '#ffffff'),
  yuiBubble: v('card-2', '#1e1e22'),
} as const;

/** Raio único: controles e cartões usam o mesmo (md); pill só para marcadores e barras. */
export const radius = { sm: 8, md: 10, lg: 10, pill: 999 } as const;
/** Escala única de espaçamento (múltiplos de 4). */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Escala tipográfica: título de tela, seção, corpo, rótulo de campo e apoio. */
export const type = {
  screen: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const },
  section: { fontSize: 16, lineHeight: 22, fontWeight: '700' as const },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: '400' as const },
} as const;

/** Montserrat nos títulos e Inter no texto (só na web; no Android usa a fonte do sistema). */
export const fonts = {
  title: web ? "Montserrat, 'Segoe UI', system-ui, sans-serif" : undefined,
  body: web ? "Inter, 'Segoe UI', system-ui, sans-serif" : undefined,
  icon: web ? "'Material Symbols Rounded'" : undefined,
} as const;
