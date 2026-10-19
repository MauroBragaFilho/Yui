import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiError, createClient, type Me } from './src/api/client.ts';
import { getServerUrl } from './src/config.ts';
import { Shell } from './src/components/Shell.tsx';
import { type TabKey } from './src/components/ui.tsx';
import { AdminScreen } from './src/screens/AdminScreen.tsx';
import { ChatScreen } from './src/screens/ChatScreen.tsx';
import { CodeScreen } from './src/screens/CodeScreen.tsx';
import { ConnectScreen } from './src/screens/ConnectScreen.tsx';
import { MemoryScreen } from './src/screens/MemoryScreen.tsx';
import { StatusScreen } from './src/screens/StatusScreen.tsx';
import { clearAll, loadSettings, saveSettings, type Settings } from './src/storage.ts';
import { colors } from './src/theme.ts';

type Session = { settings: Settings; me: Me };

const EXPIRED = 'Sua sessão expirou. Entre novamente.';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Dono', TRUSTED: 'Confiável', MEMBER: 'Membro', GUEST: 'Convidado', BLOCKED: 'Bloqueado' };

export default function App() {
  const serverUrl = getServerUrl();
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('chat');
  const [codeEnabled, setCodeEnabled] = useState(false);
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
      if (saved) {
        if (saved.via === 'session' && saved.expiresAt && saved.expiresAt <= Date.now()) {
          await clearAll();
          setNotice(EXPIRED);
        } else {
          try {
            // O servidor vem da configuração do build, nunca do que ficou salvo.
            const baseUrl = serverUrl ?? saved.baseUrl;
            const client = createClient({ baseUrl, token: saved.token });
            setSession({ settings: { ...saved, baseUrl }, me: await client.me() });
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
      session
        ? createClient({ baseUrl: session.settings.baseUrl, token: session.settings.token, onUnauthorized: handleUnauthorized })
        : null,
    [session, handleUnauthorized]
  );

  // A aba "Código" só aparece para o dono e quando o módulo está ligado no servidor.
  useEffect(() => {
    let alive = true;
    setCodeEnabled(false);
    if (client && session?.me.role === 'OWNER') {
      client.dev.status().then((s) => { if (alive) setCodeEnabled(s.enabled); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [client, session]);

  async function onConnected(settings: Settings, me: Me) {
    await saveSettings(settings);
    setNotice(null);
    setSession({ settings, me });
    setTab('chat');
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
        <ConnectScreen serverUrl={serverUrl} notice={notice} onConnected={onConnected} />
      ) : (
        <Shell tab={tab} onChange={setTab} showAdmin={isOwner} showCode={isOwner && codeEnabled} roleLabel={ROLE_LABEL[session.me.role] ?? session.me.role} onLogout={logout}>
          {tab === 'chat' ? <ChatScreen client={client} /> : null}
          {tab === 'code' && isOwner && codeEnabled ? <CodeScreen client={client} /> : null}
          {tab === 'memory' ? <MemoryScreen client={client} /> : null}
          {tab === 'admin' && isOwner ? <AdminScreen client={client} /> : null}
          {tab === 'status' ? <StatusScreen client={client} me={session.me} onLogout={logout} /> : null}
        </Shell>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
});
