import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type Health, type Me, type YuiClient } from '../api/client.ts';
import { Badge, Button, Card } from '../components/ui.tsx';
import { colors, spacing } from '../theme.ts';

type Props = { client: YuiClient; me: Me; onLogout: () => void };

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Dono',
  TRUSTED: 'Confiável',
  MEMBER: 'Membro',
  GUEST: 'Convidado',
  BLOCKED: 'Bloqueado',
};

export function StatusScreen({ client, me, onLogout }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await client.health());
    } catch (e) {
      setHealth(null);
      setError(e instanceof ApiError ? e.message : 'Falha ao consultar o servidor.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const online = Boolean(health?.ok);
  const active = health?.backends.find((b) => b.active);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Status</Text>

      <Card style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Servidor</Text>
          <Badge label={online ? '● Online' : '● Offline'} color={online ? colors.success : colors.danger} />
        </View>
        <Text selectable style={styles.value}>{client.baseUrl}</Text>
        {error ? <Text testID="status-error" style={styles.error}>{error}</Text> : null}
        <Button label="Atualizar" variant="ghost" onPress={refresh} loading={loading} />
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>Você</Text>
        <Text style={styles.value}>ID {me.userId}</Text>
        <View style={styles.row}>
          <Badge label={ROLE_LABEL[me.role] ?? me.role} color={colors.primary} />
          <Badge
            label={me.memoryScope === 'personal' ? '🔒 Memória pessoal' : '🕒 Memória temporária'}
            color={me.memoryScope === 'personal' ? colors.success : colors.warning}
          />
        </View>
        <Text style={styles.hint}>
          O papel e o tipo de memória são decididos pelo servidor, não por este app.
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>Inteligência artificial</Text>
        <Text style={styles.value}>{active ? active.name : '—'}</Text>
        {active ? (
          <Badge label={active.local ? 'Local' : 'Nuvem'} color={active.local ? colors.success : colors.warning} />
        ) : null}
        <Text style={styles.hint}>
          Memória: {health ? (health.memory ? 'ativada' : 'desativada') : '—'}
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>Segurança no computador</Text>
        {health?.readOnly === false ? (
          <Badge label="⚠️ Modo somente leitura desligado" color={colors.warning} />
        ) : (
          <Badge label="🔒 Somente leitura" color={colors.success} />
        )}
        <Text style={styles.hint}>
          {health?.readOnly === false
            ? 'Ferramentas que executam programas ou alteram arquivos podem estar liberadas.'
            : 'A Yui só consulta e abre pastas: não apaga, grava nem move arquivos e não executa programas.'}
        </Text>
      </Card>

      <Button testID="btn-logout" label="Sair deste dispositivo" variant="danger" onPress={onLogout} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 820, alignSelf: 'center' },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  card: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 15 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger },
});
