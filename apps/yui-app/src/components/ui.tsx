import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, fonts, radius, spacing } from '../theme.ts';
import { TABS, tabVisible, type TabKey } from '../tabs.ts';

/** Ícones Material Symbols (a mesma família do BDS) na web; no Android, um símbolo simples de texto. */
const ICON_FALLBACK: Record<string, string> = {
  chat_bubble: 'C',
  psychology: 'M',
  admin_panel_settings: 'A',
  monitor_heart: 'S',
  arrow_upward: '↑',
  menu_open: '≡',
  menu: '≡',
  light_mode: '○',
  dark_mode: '●',
  logout: '→',
  add_comment: '+',
  lock: '#',
  schedule: '·',
  delete: '×',
  warning: '!',
  error: '!',
  check_circle: '✓',
  cancel: '×',
  refresh: '⟳',
  dashboard: '▦',
  inbox: '○',
};

export function Icon({ name, size = 22, color = colors.text, style }: { name: string; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  if (Platform.OS === 'web') {
    return (
      <Text
        aria-hidden
        selectable={false}
        style={[{ fontFamily: fonts.icon, fontSize: size, lineHeight: size, color, fontWeight: '400', letterSpacing: 0 }, style]}
      >
        {name}
      </Text>
    );
  }
  return <Text style={[{ fontSize: size * 0.8, lineHeight: size, color, textAlign: 'center', width: size }, style]}>{ICON_FALLBACK[name] ?? '•'}</Text>;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'secondary' | 'danger' | 'dangerOutline';
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  /** Compacto: não estica na linha (fica do tamanho do rótulo); a altura de toque continua 44. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Botões: primário (roxo), secundário (contorno; `ghost` é o mesmo) e perigoso (vermelho). Todos com o mesmo raio e altura. */
export function Button({ label, onPress, variant: variantProp = 'primary', disabled, loading, icon, compact, style, testID }: ButtonProps) {
  const variant = variantProp === 'secondary' ? 'ghost' : variantProp;
  const off = disabled || loading;
  // Desabilitado: superfície neutra com rótulo "muted" (contraste legível), sem opacidade sobre a cor cheia.
  const fg = disabled ? colors.muted : variant === 'primary' ? colors.btnFg : variant === 'danger' ? '#ffffff' : variant === 'dangerOutline' ? colors.danger : colors.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={off}
      {...(Platform.OS === 'web' ? ({ title: label } as any) : null)}
      style={(state: any) => [
        styles.button,
        compact && styles.buttonCompact,
        variant === 'primary' && { backgroundColor: colors.btnBg, borderColor: 'transparent' },
        variant === 'danger' && { backgroundColor: colors.dangerSolid, borderColor: 'transparent' },
        variant === 'ghost' && { backgroundColor: state.hovered ? colors.surfaceAlt : 'transparent', borderColor: colors.border },
        variant === 'dangerOutline' && { backgroundColor: state.hovered ? colors.surfaceAlt : 'transparent', borderColor: colors.danger },
        disabled && { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
        { opacity: disabled ? 1 : loading ? 0.7 : state.pressed ? 0.85 : state.hovered && variant !== 'ghost' && variant !== 'dangerOutline' ? 0.9 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.buttonInner}>
          {icon ? <Icon name={icon} size={18} color={fg} /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Botão redondo só com ícone (enviar, recolher menu, trocar tema). */
export function IconButton({
  icon,
  label,
  onPress,
  filled = false,
  disabled,
  size = 40,
  testID,
  style,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
  size?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      {...(Platform.OS === 'web' ? ({ title: label } as any) : null)}
      style={(state: any) => [
        {
          width: size,
          height: size,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: filled ? (disabled ? colors.surfaceAlt : colors.btnBg) : state.hovered ? colors.surfaceAlt : 'transparent',
          opacity: disabled && !filled ? 0.45 : state.pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} color={filled && !disabled ? colors.btnFg : colors.muted} />
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Badge({ label, color = colors.accentText }: { label: string; color?: string }) {
  // Fundo levemente tingido com a própria cor (só na web, onde há color-mix).
  const tint = Platform.OS === 'web' ? { backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` } : null;
  return (
    <View style={[styles.badge, { borderColor: color }, tint]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

/** Cabeçalho de página: título da tela, subtítulo logo abaixo, linha embaixo e ações à direita. */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const narrow = width < 600;
  return (
    <View
      style={[
        styles.pageHeader,
        { paddingHorizontal: wide ? spacing.xxl : spacing.lg },
        // No celular o título ocupa a linha de cima e as ações quebram para baixo (antes o título sumia com largura 0).
        narrow && { flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: spacing.sm },
      ]}
    >
      <View style={{ flexShrink: 1, minWidth: narrow ? undefined : 120 }}>
        <Text accessibilityRole="header" numberOfLines={narrow ? 2 : 1} style={styles.pageTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={narrow ? 2 : 1} style={styles.pageSubtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={[styles.pageRight, narrow && { flexWrap: 'wrap', flexShrink: 1 }]}>{right}</View> : null}
    </View>
  );
}

/** Título de seção dentro de uma tela (hierarquia: tela > seção > rótulo de campo). */
export function SectionHeading({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeading}>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
        {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/** Rótulo de campo (acima de entradas e valores). */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

/**
 * Estado de carregamento, vazio ou erro, em português e com a mesma cara em todas as telas.
 * `onRetry` mostra o botão "Tentar de novo" (só no erro).
 */
export function StateView({
  kind,
  title,
  message,
  onRetry,
  testID,
}: {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  message?: string;
  onRetry?: () => void;
  testID?: string;
}) {
  const color = kind === 'error' ? colors.danger : colors.muted;
  const heading = title ?? (kind === 'loading' ? 'Carregando…' : kind === 'error' ? 'Não foi possível carregar' : 'Nada por aqui ainda');
  return (
    <View testID={testID} accessibilityRole={kind === 'error' ? 'alert' : undefined} style={[styles.stateBox, kind === 'error' && { borderColor: colors.danger }]}>
      {kind === 'loading' ? <ActivityIndicator color={colors.accent} /> : <Icon name={kind === 'error' ? 'error' : 'inbox'} size={28} color={color} />}
      <Text style={[styles.stateTitle, kind === 'error' && { color: colors.danger }]}>{heading}</Text>
      {message ? <Text style={styles.stateText}>{message}</Text> : null}
      {kind === 'error' && onRetry ? <Button label="Tentar de novo" variant="ghost" onPress={onRetry} compact /> : null}
    </View>
  );
}

/** Chip de seleção (seções do painel, modos de entrada). */
export function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={(state: any) => [styles.chip, on ? styles.chipOn : state.hovered ? { backgroundColor: colors.surfaceAlt } : null]}
    >
      <Text style={[styles.chipText, on && { color: colors.accentText }]}>{label}</Text>
    </Pressable>
  );
}

export { TABS, tabVisible, type TabKey } from '../tabs.ts';

/** Barra inferior (telas estreitas). Em telas largas o App usa a barra lateral. */
export function TabBar({ active, onChange, showAdmin = false }: { active: TabKey; onChange: (k: TabKey) => void; showAdmin?: boolean }) {
  return (
    <View style={styles.tabBar}>
      {TABS.filter((t) => tabVisible(t.key, { showAdmin })).map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            testID={`tab-${t.key}`}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(t.key)}
            style={styles.tab}
          >
            <View style={[styles.tabIcon, on && { backgroundColor: colors.accentLight }]}>
              <Icon name={t.icon} size={22} color={on ? colors.accent : colors.muted} />
            </View>
            <Text style={[styles.tabLabel, { color: on ? colors.accentText : colors.muted }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: { alignSelf: 'flex-start', paddingHorizontal: spacing.md },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  buttonText: { fontWeight: '600', fontSize: 14 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  badge: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  pageHeader: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  pageTitle: { color: colors.text, fontFamily: fonts.title, fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.2 },
  pageSubtitle: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  pageRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.sm },
  sectionTitle: { color: colors.text, fontFamily: fonts.title, fontSize: 16, lineHeight: 22, fontWeight: '700' },
  sectionHint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  fieldLabel: { color: colors.muted, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  stateBox: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  stateTitle: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: '600', textAlign: 'center' },
  stateText: { color: colors.muted, fontSize: 13, lineHeight: 18, textAlign: 'center', maxWidth: 420 },
  chip: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  chipText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingBottom: spacing.sm,
  },
  tab: { flex: 1, minWidth: 0, minHeight: 56, alignItems: 'center', paddingTop: spacing.sm, paddingHorizontal: 0, gap: 2 },
  tabIcon: { width: 48, maxWidth: '100%', height: 28, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 11, lineHeight: 14, fontWeight: '600', letterSpacing: -0.2, textAlign: 'center' },
});
