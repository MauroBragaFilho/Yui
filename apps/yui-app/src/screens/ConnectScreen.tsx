import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, createClient, normalizeBaseUrl, type Me } from '../api/client.ts';
import { Button, Card } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

type Props = {
  initialUrl?: string;
  onConnected: (settings: { baseUrl: string; token: string }, me: Me) => void;
};

export function ConnectScreen({ initialUrl = '', onConnected }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const baseUrl = normalizeBaseUrl(url);
      const client = createClient({ baseUrl, token });
      await client.health();
      const me = await client.me();
      onConnected({ baseUrl, token: token.trim() }, me);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao conectar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>Yui</Text>
        <Text style={styles.subtitle}>Sua assistente pessoal</Text>

        <Card style={styles.card}>
          <Text style={styles.label}>Endereço do servidor</Text>
          <TextInput
            testID="input-url"
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://seu-pc.tailnet.ts.net:3939"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.label}>Token de acesso</Text>
          <TextInput
            testID="input-token"
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="Token criado para este dispositivo"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            onSubmitEditing={connect}
          />
          {error ? <Text testID="connect-error" style={styles.error}>{error}</Text> : null}
          <Button testID="btn-connect" label="Conectar" onPress={connect} loading={busy} disabled={!url.trim() || !token.trim()} />
        </Card>

        <Text style={styles.hint}>
          O servidor é o Yui Core rodando no seu PC. Acesse pelo Tailscale e use um token exclusivo para este dispositivo.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, justifyContent: 'center', flexGrow: 1, maxWidth: 520, width: '100%', alignSelf: 'center' },
  logo: { color: colors.primary, fontSize: 44, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: colors.muted, textAlign: 'center', marginBottom: spacing.xl },
  card: { gap: spacing.sm },
  label: { color: colors.muted, fontSize: 13, marginTop: spacing.sm },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: { color: colors.danger, marginVertical: spacing.sm },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: spacing.lg, lineHeight: 18 },
});
