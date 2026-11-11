/** Abas do app e quem as vê. Arquivo sem React para poder ser testado em Node. */
export type TabKey = 'home' | 'chat' | 'memory' | 'admin' | 'status';

export const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'home', label: 'Início', icon: 'dashboard' },
  { key: 'chat', label: 'Chat', icon: 'chat_bubble' },
  { key: 'memory', label: 'Memória', icon: 'psychology' },
  { key: 'admin', label: 'Admin', icon: 'admin_panel_settings' },
  { key: 'status', label: 'Status', icon: 'monitor_heart' },
];

/** A Visão Geral e o Admin só aparecem para o dono. */
export function tabVisible(key: TabKey, { showAdmin = false }: { showAdmin?: boolean }): boolean {
  if (key === 'admin' || key === 'home') return showAdmin;
  return true;
}
