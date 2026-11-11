import React, { useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { colors, fonts, radius, spacing } from '../theme.ts';
import { getTheme, setTheme, type ThemeMode } from '../web.ts';
import { Icon, IconButton, TABS, TabBar, tabVisible, type TabKey } from './ui.tsx';

type Props = {
  tab: TabKey;
  onChange: (tab: TabKey) => void;
  showAdmin: boolean;
  roleLabel: string;
  onLogout: () => void;
  children: React.ReactNode;
};

const KEY_COLLAPSED = 'yui.sidebar.collapsed';

function loadCollapsed(): boolean {
  if (Platform.OS !== 'web') return false;
  try {
    return localStorage.getItem(KEY_COLLAPSED) === '1';
  } catch {
    return false;
  }
}

/**
 * Casca do app, no formato do BDS: barra lateral (recolhível) em telas largas e
 * barra de abas embaixo em telas estreitas.
 */
export function Shell({ tab, onChange, showAdmin, roleLabel, onLogout, children }: Props) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [theme, setThemeState] = useState<ThemeMode>(getTheme);

  if (!wide) {
    return (
      <View style={styles.root}>
        <View style={styles.main}>{children}</View>
        <TabBar active={tab} onChange={onChange} showAdmin={showAdmin} />
      </View>
    );
  }

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    if (Platform.OS === 'web') {
      try {
        localStorage.setItem(KEY_COLLAPSED, next ? '1' : '0');
      } catch {
        /* sem armazenamento: vale só nesta sessão */
      }
    }
  }

  function toggleTheme() {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  return (
    <View style={[styles.root, { flexDirection: 'row' }]}>
      <View style={[styles.sidebar, { width: collapsed ? 64 : 240 }]}>
        <View style={[styles.brand, collapsed && styles.brandCollapsed]}>
          {collapsed ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Expandir menu" onPress={toggleCollapsed}>
              <Image source={require('../../assets/yui-avatar.webp')} style={styles.brandAvatar} accessibilityLabel="Yui" />
            </Pressable>
          ) : (
            <>
              <Image source={require('../../assets/yui-avatar.webp')} style={styles.brandAvatar} accessibilityLabel="Yui" />
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.brandMark}>YUI</Text>
                <Text numberOfLines={1} style={styles.brandText}>ASSISTENTE</Text>
              </View>
              <IconButton icon="menu_open" label="Recolher menu" size={28} onPress={toggleCollapsed} style={{ marginLeft: 'auto' }} />
            </>
          )}
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.nav}>
          {TABS.filter((t) => tabVisible(t.key, { showAdmin })).map((t) => (
            <NavItem
              key={t.key}
              testID={`tab-${t.key}`}
              icon={t.icon}
              label={t.label}
              active={t.key === tab}
              collapsed={collapsed}
              onPress={() => onChange(t.key)}
            />
          ))}
        </ScrollView>

        <View style={styles.footer}>
          {Platform.OS === 'web' ? (
            <NavItem
              testID="btn-theme"
              icon={theme === 'dark' ? 'light_mode' : 'dark_mode'}
              label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
              collapsed={collapsed}
              onPress={toggleTheme}
            />
          ) : null}
          <NavItem testID="btn-sidebar-logout" icon="logout" label="Sair" collapsed={collapsed} onPress={onLogout} />
          {collapsed ? null : <Text style={styles.footerText}>{roleLabel}</Text>}
        </View>
      </View>

      <View style={styles.main}>{children}</View>
    </View>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  collapsed,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={(state: any) => [
        styles.navItem,
        collapsed && styles.navItemCollapsed,
        active ? { backgroundColor: colors.accentLight } : state.hovered ? { backgroundColor: colors.surfaceAlt } : null,
      ]}
    >
      <Icon name={icon} size={24} color={active ? colors.accent : colors.muted} />
      {collapsed ? null : (
        <Text numberOfLines={1} style={[styles.navLabel, { color: active ? colors.accentText : colors.muted }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  main: { flex: 1, minWidth: 0 },
  sidebar: {
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  brand: {
    height: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandCollapsed: { justifyContent: 'center', paddingHorizontal: 0 },
  brandAvatar: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.border },
  brandMark: { color: colors.text, fontFamily: fonts.title, fontWeight: '700', fontSize: 14, letterSpacing: 0.6 },
  brandText: { color: colors.muted, fontWeight: '600', fontSize: 10, letterSpacing: 0.6 },
  nav: { padding: spacing.md, gap: 4 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 13,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
  },
  navItemCollapsed: { justifyContent: 'center', paddingHorizontal: 0 },
  navLabel: { fontWeight: '600', fontSize: 14, flexShrink: 1 },
  footer: { padding: spacing.md, gap: 4, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { color: colors.muted, fontSize: 12, textAlign: 'center', paddingTop: spacing.sm },
});
