import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, createClient, type LoginResult, type Me } from '../api/client.ts';
import { Button, Card, Chip } from '../components/ui.tsx';
import type { Settings } from '../storage.ts';
import { colors, fonts, radius, spacing } from '../theme.ts';

type Props = {
  /** Servidor desta instalação (vem da configuração do build; o usuário não digita). */
  serverUrl: string | null;
  /** Aviso mostrado no topo (ex.: "Sua sessão expirou"). */
  notice?: string | null;
  onConnected: (settings: Settings, me: Me) => void;
};

type Mode = 'password' | 'discord';
type AuthStatus = { passwordLogin: boolean; discordKey: boolean };

const RESEND_SECONDS = 30;

export function ConnectScreen({ serverUrl, notice = null, onConnected }: Props) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('password');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    if (!serverUrl) return;
    setStatusError(null);
    try {
      const st = await createClient({ baseUrl: serverUrl, token: '' }).authStatus();
      setStatus(st);
      setMode(st.passwordLogin ? 'password' : 'discord');
    } catch (e) {
      setStatus(null);
      setStatusError(e instanceof ApiError ? e.message : 'Não foi possível falar com o servidor.');
    }
  }, [serverUrl]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  function startCooldown() {
    setCooldown(RESEND_SECONDS);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1 && timer.current) { clearInterval(timer.current); timer.current = null; }
        return Math.max(0, c - 1);
      });
    }, 1000);
  }

  async function finish(baseUrl: string, session: LoginResult) {
    const me = await createClient({ baseUrl, token: session.token }).me();
    onConnected({ baseUrl, token: session.token, via: 'session', expiresAt: session.expiresAt }, me);
  }

  async function loginWithPassword() {
    if (!serverUrl) return;
    setError(null);
    setBusy(true);
    try {
      const session = await createClient({ baseUrl: serverUrl, token: '' }).login(user.trim(), password);
      setPassword(''); // a senha nunca fica guardada: só a sessão
      await finish(serverUrl, session);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao entrar.');
    } finally {
      setBusy(false);
    }
  }

  async function requestKey() {
    if (!serverUrl) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await createClient({ baseUrl: serverUrl, token: '' }).discordRequest();
      setSent(true);
      setCode('');
      setInfo(`Enviei uma mensagem privada no seu Discord com a chave. Ela vale por ${Math.max(1, Math.round(r.expiresInSeconds / 60))} minutos e só pode ser usada uma vez.`);
      startCooldown();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível pedir a chave.');
    } finally {
      setBusy(false);
    }
  }

  async function loginWithKey() {
    if (!serverUrl) return;
    setError(null);
    setBusy(true);
    try {
      const session = await createClient({ baseUrl: serverUrl, token: '' }).discordVerify(code);
      setCode('');
      await finish(serverUrl, session);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao entrar.');
    } finally {
      setBusy(false);
    }
  }

  const host = serverUrl ? serverUrl.replace(/^https?:\/\//, '') : null;
  const both = Boolean(status?.passwordLogin && status?.discordKey);
  const nothing = status && !status.passwordLogin && !status.discordKey;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>YUI</Text>
        <Text style={styles.subtitle}>Sua assistente pessoal</Text>

        {notice ? <Text testID="connect-notice" style={styles.notice}>{notice}</Text> : null}

        {!serverUrl ? (
          <Card style={styles.card}>
            <Text testID="no-server" style={styles.error}>Servidor não configurado neste app.</Text>
            <Text style={styles.hint}>Gere o app com a variável EXPO_PUBLIC_YUI_SERVER_URL apontando para o seu servidor da Yui (veja o README do app).</Text>
          </Card>
        ) : (
          <Card style={styles.card}>
            <Text style={styles.hint} testID="server-host">Servidor: {host}</Text>

            {statusError ? (
              <>
                <Text testID="status-error" style={styles.error}>{statusError}</Text>
                <Button testID="btn-retry" label="Tentar de novo" variant="ghost" onPress={loadStatus} />
              </>
            ) : null}

            {nothing ? (
              <Text testID="no-auth" style={styles.error}>
                Este servidor ainda não tem forma de entrada configurada. Defina o login (YUI_PANEL_USER) no .env ou deixe a Yui conectada ao Discord para receber a chave.
              </Text>
            ) : null}

            {both ? (
              <View style={styles.modes}>
                <Chip testID="mode-password" label="Usuário e senha" on={mode === 'password'} onPress={() => setMode('password')} />
                <Chip testID="mode-discord" label="Chave pelo Discord" on={mode === 'discord'} onPress={() => setMode('discord')} />
              </View>
            ) : null}

            {status?.passwordLogin && mode === 'password' ? (
              <>
                <Text style={styles.label}>Usuário</Text>
                <TextInput
                  testID="input-user"
                  style={styles.input}
                  value={user}
                  onChangeText={setUser}
                  placeholder="Seu usuário"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="username"
                  autoComplete="username"
                />
                <Text style={styles.label}>Senha</Text>
                <TextInput
                  testID="input-password"
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Sua senha"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  textContentType="password"
                  autoComplete="current-password"
                  onSubmitEditing={loginWithPassword}
                />
                {error ? <Text testID="connect-error" style={styles.error}>{error}</Text> : null}
                <Button testID="btn-connect" label="Entrar" onPress={loginWithPassword} loading={busy} disabled={!user.trim() || !password} />
              </>
            ) : null}

            {status?.discordKey && mode === 'discord' ? (
              <>
                <Text style={styles.hint}>
                  A Yui envia uma chave de uso único por mensagem privada no seu Discord (fora de qualquer servidor).
                </Text>
                {!sent ? (
                  <>
                    {error ? <Text testID="connect-error" style={styles.error}>{error}</Text> : null}
                    <Button testID="btn-send-key" label="Enviar chave para o meu Discord" onPress={requestKey} loading={busy} />
                  </>
                ) : (
                  <>
                    {info ? <Text testID="key-info" style={styles.info}>{info}</Text> : null}
                    <Text style={styles.label}>Chave recebida</Text>
                    <TextInput
                      testID="input-key"
                      style={[styles.input, styles.keyInput]}
                      value={code}
                      onChangeText={setCode}
                      placeholder="XXXXX-XXXXX"
                      placeholderTextColor={colors.muted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      maxLength={16}
                      onSubmitEditing={loginWithKey}
                    />
                    {error ? <Text testID="connect-error" style={styles.error}>{error}</Text> : null}
                    <Button testID="btn-connect" label="Entrar" onPress={loginWithKey} loading={busy} disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 10} />
                    <Button
                      testID="btn-resend-key"
                      label={cooldown > 0 ? `Enviar outra chave (${cooldown}s)` : 'Enviar outra chave'}
                      variant="ghost"
                      onPress={requestKey}
                      disabled={cooldown > 0 || busy}
                    />
                  </>
                )}
              </>
            ) : null}
          </Card>
        )}

        <Text style={styles.hint}>
          O app guarda só uma sessão temporária, nunca a sua senha nem a chave.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, justifyContent: 'center', flexGrow: 1, maxWidth: 520, width: '100%', alignSelf: 'center' },
  logo: { color: colors.accent, fontSize: 40, fontFamily: fonts.title, fontWeight: '900', letterSpacing: 4, textAlign: 'center' },
  subtitle: { color: colors.muted, textAlign: 'center', marginBottom: spacing.xl },
  notice: {
    color: colors.warning,
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  card: { gap: spacing.sm, borderRadius: radius.lg, padding: spacing.xl },
  label: { color: colors.muted, fontSize: 13, marginTop: spacing.sm },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    fontSize: 14,
  },
  keyInput: { letterSpacing: 2, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  error: { color: colors.danger, marginVertical: spacing.sm },
  info: { color: colors.success, lineHeight: 19 },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center', lineHeight: 18 },
});
