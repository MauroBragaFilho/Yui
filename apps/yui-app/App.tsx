import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiError, createClient, type Me } from './src/api/client.ts';
import { getConfigServidores } from './src/config.ts';
import { criarGerenciadorDeServidor } from './src/servidores.ts';
import { Shell } from './src/components/Shell.tsx';
import { type TabKey } from './src/components/ui.tsx';
import { AdminScreen } from './src/screens/AdminScreen.tsx';
import { ChatScreen } from './src/screens/ChatScreen.tsx';
import { ConnectScreen } from './src/screens/ConnectScreen.tsx';
import { FilesScreen } from './src/screens/FilesScreen.tsx';
import { RemindersScreen } from './src/screens/RemindersScreen.tsx';
import { MemoryScreen } from './src/screens/MemoryScreen.tsx';
import { OverviewScreen } from './src/screens/OverviewScreen.tsx';
import { StatusScreen } from './src/screens/StatusScreen.tsx';
import { armazemDoServidorLembrado, clearAll, loadSettings, saveSettings, type Settings } from './src/storage.ts';
import { colors } from './src/theme.ts';

type Session = { settings: Settings; me: Me };

const EXPIRED = 'Sua sessão expirou. Entre novamente.';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Dono', TRUSTED: 'Confiável', MEMBER: 'Membro', GUEST: 'Convidado', BLOCKED: 'Bloqueado' };

export default function App() {
  // Os endereços do servidor vêm do build (lista: rede local e Tailscale; ou um só). Com mais de um, o app sonda e usa o primeiro que responde.
  const config = useMemo(() => getConfigServidores(), []);
  const servidor = useMemo(
    () => (config.enderecos.length > 0 ? criarGerenciadorDeServidor({ enderecos: config.enderecos, lembrado: armazemDoServidorLembrado }) : null),
    [config]
  );
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('chat');
  const expiring = useRef(false);

  /** Sessão/token recusado pelo servidor: esquece a sessão e volta ao login. */
  const handleUnauthorized = useCallback(async () => {
    if (expiring.current) return;
    expiring.current = true;
    await clearAll();
    setSession(null);
    setNotice(EXPIRED);
    expiring.current = false;
  }, []);

  // Ao abrir, tenta retomar a sessão salva; se o servidor não responder, volta
  // para a tela de conexão (com o endereço preenchido).
  useEffect(() => {
    (async () => {
      const saved = await loadSettings();
      if (saved && servidor) {
        if (saved.via === 'session' && saved.expiresAt && saved.expiresAt <= Date.now()) {
          await clearAll();
          setNotice(EXPIRED);
        } else {
          try {
            // O servidor vem da configuração do build, nunca do que ficou salvo. Com vários endereços, o primeiro pedido sonda antes (sem token).
            const client = createClient({ servidor, token: saved.token });
            const me = await client.me();
            setSession({ settings: { ...saved, baseUrl: servidor.atual() }, me });
            if (me.role === 'OWNER') setTab('home'); // o dono abre na Visão Geral
          } catch (e) {
            // Token/sessão recusado: esquece. Servidor offline: mantém para tentar de novo.
            if (e instanceof ApiError && e.status === 401) {
              await clearAll();
              if (saved.via === 'session') setNotice(EXPIRED);
            }
          }
        }
      }
      setBooting(false);
    })();
  }, []);

  const client = useMemo(
    () =>
      session && servidor
        ? createClient({ servidor, token: session.settings.token, onUnauthorized: handleUnauthorized })
        : null,
    [session, servidor, handleUnauthorized]
  );

  async function onConnected(settings: Settings, me: Me) {
    await saveSettings(settings);
    setNotice(null);
    setSession({ settings, me });
    setTab(me.role === 'OWNER' ? 'home' : 'chat');
  }

  async function logout() {
    // Sessão de login: revoga no servidor (melhor esforço) antes de esquecer.
    if (client && session?.settings.via === 'session') {
      try {
        await client.logout();
      } catch {
        /* sem rede: a sessão expira sozinha no servidor */
      }
    }
    await clearAll();
    setNotice(null);
    setSession(null);
  }

  if (booting) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const isOwner = session?.me.role === 'OWNER';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {!session || !client ? (
        <ConnectScreen servidor={servidor} aviso={config.aviso} notice={notice} onConnected={onConnected} />
      ) : (
        <Shell tab={tab} onChange={setTab} showAdmin={isOwner} roleLabel={ROLE_LABEL[session.me.role] ?? session.me.role} onLogout={logout}>
          {tab === 'home' && isOwner ? <OverviewScreen client={client} me={session.me} onNavigate={setTab} /> : null}
          {tab === 'chat' ? <ChatScreen client={client} /> : null}
          {tab === 'reminders' && isOwner ? <RemindersScreen client={client} /> : null}
          {tab === 'files' && isOwner ? <FilesScreen client={client} /> : null}
          {tab === 'memory' ? <MemoryScreen client={client} /> : null}
          {tab === 'admin' && isOwner ? <AdminScreen client={client} /> : null}
          {tab === 'status' ? <StatusScreen client={client} me={session.me} servidor={servidor} onLogout={logout} /> : null}
        </Shell>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
});
