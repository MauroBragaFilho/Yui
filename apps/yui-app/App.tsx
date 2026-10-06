import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiError, createClient, type Me } from './src/api/client.ts';
import { TabBar, type TabKey } from './src/components/ui.tsx';
import { ChatScreen } from './src/screens/ChatScreen.tsx';
import { ConnectScreen } from './src/screens/ConnectScreen.tsx';
import { MemoryScreen } from './src/screens/MemoryScreen.tsx';
import { StatusScreen } from './src/screens/StatusScreen.tsx';
import { clearAll, loadSettings, saveSettings, type Settings } from './src/storage.ts';
import { colors } from './src/theme.ts';

type Session = { settings: Settings; me: Me };

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [lastUrl, setLastUrl] = useState('');
  const [tab, setTab] = useState<TabKey>('chat');

  // Ao abrir, tenta retomar a sessão salva; se o servidor não responder, volta
  // para a tela de conexão (com o endereço preenchido).
  useEffect(() => {
    (async () => {
      const saved = await loadSettings();
      if (saved) {
        setLastUrl(saved.baseUrl);
        try {
          const client = createClient({ baseUrl: saved.baseUrl, token: saved.token });
          setSession({ settings: saved, me: await client.me() });
        } catch (e) {
          // Token revogado: esquece a sessão. Servidor offline: mantém para tentar de novo.
          if (e instanceof ApiError && e.status === 401) await clearAll();
        }
      }
      setBooting(false);
    })();
  }, []);

  const client = useMemo(
    () => (session ? createClient({ baseUrl: session.settings.baseUrl, token: session.settings.token }) : null),
    [session]
  );

  async function onConnected(settings: Settings, me: Me) {
    await saveSettings(settings);
    setSession({ settings, me });
    setTab('chat');
  }

  async function logout() {
    await clearAll();
    setLastUrl(session?.settings.baseUrl ?? '');
    setSession(null);
  }

  if (booting) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {!session || !client ? (
        <ConnectScreen initialUrl={lastUrl} onConnected={onConnected} />
      ) : (
        <View style={styles.root}>
          <View style={styles.body}>
            {tab === 'chat' ? <ChatScreen client={client} /> : null}
            {tab === 'memory' ? <MemoryScreen client={client} /> : null}
            {tab === 'status' ? <StatusScreen client={client} me={session.me} onLogout={logout} /> : null}
          </View>
          <TabBar active={tab} onChange={setTab} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
});
