import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Platform, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type MemoryItem, type MemoryScope, type YuiClient } from '../api/client.ts';
import { Badge, Button, Card } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient };

const TYPE_LABEL: Record<string, string> = {
  fact: 'Fato',
  preference: 'Preferência',
  project: 'Projeto',
  decision: 'Decisão',
  summary: 'Resumo',
  note: 'Nota',
};

/** Confirmação que funciona na web (window.confirm) e no celular (Alert). */
function confirmAction(title: string, message: string, onYes: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancelar', style: 'cancel' },
    { text: 'Apagar', style: 'destructive', onPress: onYes },
  ]);
}

export function MemoryScreen({ client }: Props) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [scope, setScope] = useState<MemoryScope>('public');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await client.memories();
      setItems(res.memories);
      setScope(res.scope);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar a memória.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await client.addMemory(content);
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    try {
      await client.deleteMemory(id);
      setItems((list) => list.filter((m) => m.id !== id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível apagar.');
    }
  }

  function clearAll() {
    confirmAction('Apagar toda a memória?', 'Isso remove tudo o que a Yui lembra sobre você. Não dá para desfazer.', async () => {
      try {
        await client.clearMemories();
        setItems([]);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Não foi possível apagar.');
      }
    });
  }

  const personal = scope === 'personal';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Memória</Text>
        <Badge label={personal ? '🔒 Pessoal (permanente)' : '🕒 Temporária (30 dias)'} color={personal ? colors.success : colors.warning} />
      </View>

      <FlatList
        testID="memory-list"
        data={items}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm, marginBottom: spacing.md }}>
            <Card style={{ gap: spacing.sm }}>
              <Text style={styles.label}>Pedir para a Yui lembrar</Text>
              <TextInput
                testID="input-memory"
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="Ex.: Meu projeto principal é o BDS"
                placeholderTextColor={colors.muted}
                maxLength={300}
                onSubmitEditing={add}
              />
              <Button testID="btn-add-memory" label="Salvar" onPress={add} loading={saving} disabled={!draft.trim()} />
            </Card>
            {error ? <Text testID="memory-error" style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>Nada guardado ainda. Diga “lembra que…” no chat ou use o campo acima.</Text>
          )
        }
        ListFooterComponent={
          items.length ? <Button testID="btn-clear-memory" label="Apagar toda a memória" variant="ghost" onPress={clearAll} style={{ marginTop: spacing.lg }} /> : null
        }
        renderItem={({ item }) => (
          <Card style={styles.item}>
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Badge label={TYPE_LABEL[item.type] ?? item.type} color={colors.primary} />
              <Text selectable style={styles.content}>{item.content}</Text>
              <Text style={styles.meta}>
                {new Date(item.updated_at).toLocaleDateString('pt-BR')}
                {item.expires_at ? ` • expira em ${new Date(item.expires_at).toLocaleDateString('pt-BR')}` : ' • permanente'}
              </Text>
            </View>
            <Button testID={`btn-del-${item.id}`} label="Apagar" variant="ghost" onPress={() => remove(item.id)} style={styles.delBtn} />
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  list: { padding: spacing.lg, gap: spacing.sm, width: '100%', maxWidth: 820, alignSelf: 'center' },
  label: { color: colors.muted, fontSize: 13 },
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
  error: { color: colors.danger },
  empty: { color: colors.muted, textAlign: 'center', marginTop: spacing.xl },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  content: { color: colors.text, fontSize: 15, lineHeight: 21 },
  meta: { color: colors.muted, fontSize: 12 },
  delBtn: { minHeight: 36, paddingHorizontal: spacing.md },
});
