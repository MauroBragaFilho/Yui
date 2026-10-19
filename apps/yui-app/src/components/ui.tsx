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

/** Ícones Material Symbols (a mesma família do BDS) na web; emoji no Android. */
const ICON_FALLBACK: Record<string, string> = {
  chat_bubble: '💬',
  code: '⌨️',
  psychology: '🧠',
  admin_panel_settings: '🛠️',
  monitor_heart: '⚙️',
  arrow_upward: '↑',
  menu_open: '☰',
  menu: '☰',
  light_mode: '☀️',
  dark_mode: '🌙',
  logout: '⎋',
  add_comment: '＋',
  lock: '🔒',
  schedule: '🕒',
  delete: '🗑️',
  build: '🔧',
  warning: '⚠️',
  check_circle: '✔',
  cancel: '✖',
  timer_off: '⏱',
  refresh: '⟳',
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
  return <Text style={[{ fontSize: size * 0.85, lineHeight: size, color }, style]}>{ICON_FALLBACK[name] ?? '•'}</Text>;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Botão em pílula, como no BDS: o primário é branco com texto preto (invertido no tema claro). */
export function Button({ label, onPress, variant = 'primary', disabled, loading, icon, style, testID }: ButtonProps) {
  const off = disabled || loading;
  const fg = variant === 'primary' ? colors.btnFg : variant === 'danger' ? '#ffffff' : colors.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={off}
      style={(state: any) => [
        styles.button,
        variant === 'primary' && { backgroundColor: colors.btnBg, borderColor: 'transparent' },
        variant === 'danger' && { backgroundColor: colors.dangerSolid, borderColor: 'transparent' },
        variant === 'ghost' && { backgroundColor: state.hovered ? colors.surfaceAlt : 'transparent', borderColor: colors.border },
        { opacity: off ? 0.5 : state.pressed ? 0.85 : state.hovered && variant !== 'ghost' ? 0.9 : 1 },
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
      style={(state: any) => [
        {
          width: size,
          height: size,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: filled ? colors.btnBg : state.hovered ? colors.surfaceAlt : 'transparent',
          opacity: disabled ? 0.45 : state.pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} color={filled ? colors.btnFg : colors.muted} />
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

/** Cabeçalho de página, como o do BDS: título em Montserrat, linha embaixo e ações à direita. */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  return (
    <View style={[styles.pageHeader, { paddingHorizontal: wide ? 32 : spacing.lg }]}>
      <View style={{ flexShrink: 1 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.pageTitle, { fontSize: wide ? 24 : 20 }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.pageSubtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.pageRight}>{right}</View> : null}
    </View>
  );
}

/** Chip em pílula (seções do painel, modos de entrada). */
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

export type TabKey = 'chat' | 'code' | 'memory' | 'admin' | 'status';

export const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'chat', label: 'Chat', icon: 'chat_bubble' },
  { key: 'code', label: 'Código', icon: 'code' },
  { key: 'memory', label: 'Memória', icon: 'psychology' },
  { key: 'admin', label: 'Admin', icon: 'admin_panel_settings' },
  { key: 'status', label: 'Status', icon: 'monitor_heart' },
];

/** Barra inferior (telas estreitas). Em telas largas o App usa a barra lateral. */
export function TabBar({ active, onChange, showAdmin = false, showCode = false }: { active: TabKey; onChange: (k: TabKey) => void; showAdmin?: boolean; showCode?: boolean }) {
  return (
    <View style={styles.tabBar}>
      {TABS.filter((t) => (t.key !== 'admin' || showAdmin) && (t.key !== 'code' || showCode)).map((t) => {
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
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  buttonText: { fontWeight: '600', fontSize: 14 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  pageHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  pageTitle: { color: colors.text, fontFamily: fonts.title, fontWeight: '700', letterSpacing: -0.2 },
  pageSubtitle: { color: colors.muted, fontSize: 12, marginTop: 2 },
  pageRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  chip: { paddingHorizontal: spacing.lg, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.accentLight, borderColor: 'transparent' },
  chipText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingBottom: spacing.sm,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: spacing.sm, gap: 2 },
  tabIcon: { width: 56, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 11, fontWeight: '600' },
});
