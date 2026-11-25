import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type ConfigItem, type ConfigOverview, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, Chip } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');

const ORIGEM: Record<ConfigItem['origem'], { label: string; color: string }> = {
  painel: { label: 'Definido no painel', color: colors.success },
  env: { label: 'Vem do .env', color: colors.accentText },
  padrao: { label: 'Padrão', color: colors.muted },
};

/** Um ajuste: mostra o valor em vigor (segredo nunca: só os 4 últimos caracteres) e deixa trocar ou voltar ao .env. */
function ConfigCard({ item, editable, client, reload }: { item: ConfigItem; editable: boolean; client: YuiClient; reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function save(valor: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await client.admin.configSet(item.chave, valor);
      setText('');
      await reload();
      setMsg({ text: r.reinicio ? 'Salvo. Vale depois de reiniciar a Yui.' : 'Salvo. Já está valendo.', ok: true });
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function removeNow() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await client.admin.configRemove(item.chave);
      await reload();
      setMsg({ text: r.reinicio ? 'Removido do painel. Vale depois de reiniciar a Yui.' : 'Removido do painel. Já está valendo.', ok: true });
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  const origem = ORIGEM[item.origem];
  const atual = item.secreto
    ? item.definido ? (item.ultimos4 ? `Chave terminada em ${item.ultimos4}` : 'Chave definida no .env') : 'Sem chave'
    : item.definido ? `Valor atual: ${item.valor === '' ? '(vazio)' : item.valor}` : `Padrão: ${item.padrao === '' || item.padrao === undefined ? '(vazio)' : item.padrao}`;

  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{item.rotulo}</Text>
        <View style={styles.badges}>
          <Badge label={origem.label} color={origem.color} />
          {item.reinicio ? <Badge label="Pede reinício" color={colors.muted} /> : null}
        </View>
      </View>
      <Text style={styles.hint}>{item.descricao}</Text>
      <Text style={styles.value} testID={`config-atual-${item.chave}`}>{atual}</Text>
      {item.alteradoEm ? <Text style={styles.hint}>Última alteração: {new Date(item.alteradoEm).toLocaleString('pt-BR')}</Text> : null}

      {editable && item.tipo === 'bool' ? (
        <View style={styles.chips}>
          <Chip label="Ligado" on={item.valor === 'true'} onPress={() => save('true')} testID={`config-${item.chave}-on`} />
          <Chip label="Desligado" on={item.valor === 'false'} onPress={() => save('false')} testID={`config-${item.chave}-off`} />
        </View>
      ) : null}
      {editable && item.tipo === 'enum' ? (
        <View style={styles.chips}>
          {(item.opcoes ?? []).map((o) => <Chip key={o} label={o} on={item.valor === o} onPress={() => save(o)} testID={`config-${item.chave}-${o}`} />)}
        </View>
      ) : null}
      {editable && (item.tipo === 'int' || item.tipo === 'texto' || item.tipo === 'segredo') ? (
        <View style={styles.formRow}>
          <TextInput
            testID={`config-input-${item.chave}`}
            style={[styles.input, { flex: 1 }]}
            value={text}
            onChangeText={setText}
            placeholder={item.tipo === 'segredo' ? 'Colar nova chave' : item.tipo === 'int' ? `Número de ${item.min} a ${item.max}` : 'Novo valor'}
            placeholderTextColor={colors.muted}
            secureTextEntry={item.tipo === 'segredo'}
            keyboardType={item.tipo === 'int' ? 'numeric' : 'default'}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            onSubmitEditing={() => text.trim() && save(text.trim())}
          />
          <Button label="Salvar" onPress={() => save(text.trim())} loading={busy} disabled={!text.trim()} style={styles.smallBtn} testID={`config-save-${item.chave}`} />
        </View>
      ) : null}
      {editable && item.origem === 'painel' ? (
        <Button label="Voltar ao .env" variant="ghost" onPress={() => confirmAction('Voltar ao .env?', `"${item.rotulo}" volta ao valor do .env (ou ao padrão); o valor salvo no painel será apagado.`, removeNow, 'Voltar')} loading={busy} style={styles.smallBtn} testID={`config-remove-${item.chave}`} />
      ) : null}
      {msg ? <Text style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null}
    </Card>
  );
}

/** Configuração e chaves da Yui pelo painel: tudo o que antes só dava para mudar editando o .env (lista fechada, segredo só entra). */
export function ConfigPainel({ client }: { client: YuiClient }) {
  const [data, setData] = useState<ConfigOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await client.admin.config());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [client]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Text testID="config-error" style={styles.error}>{error}</Text>;
  if (!data) return <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />;

  const grupos = [...new Set(data.itens.map((i) => i.grupo))];
  const editavel = data.edicaoLigada && data.problema !== 'cofre-ilegivel';
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Configuração e chaves</Text>
      {data.problema === 'cofre-ilegivel' ? (
        <Text testID="config-cofre-ilegivel" style={styles.error}>O cofre de configuração existe mas não abriu (arquivo quebrado ou protegido por outra conta). Nada será alterado até você conferir o arquivo secrets/painel-config.json e a cópia .bak.</Text>
      ) : null}
      {data.edicaoLigada ? (
        <Text style={styles.hint}>O que você salvar aqui fica só neste computador (pasta secrets/, fora do Git) e vale por cima do .env. Uma chave nunca volta do servidor: só os 4 últimos caracteres aparecem. O token do Discord, a senha do painel e as regras de segurança continuam só no .env. {data.protegido ? 'O arquivo é gravado protegido (DPAPI do Windows).' : 'O arquivo ainda NÃO é criptografado (YUI_PAINEL_CONFIG_DPAPI=true liga a proteção no Windows).'} A mudança vale na hora no cérebro; o bot (voz, semanal, avisos) só relê ao reiniciar: itens marcados "Pede reinício" só valem depois disso.</Text>
      ) : (
        <Text style={styles.hint}>A edição pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env). Só dá para consultar.</Text>
      )}
      {grupos.map((g) => (
        <View key={g} style={styles.section}>
          <Text style={styles.sectionTitle}>{g}</Text>
          {data.itens.filter((i) => i.grupo === g).map((i) => (
            <ConfigCard key={i.chave} item={i} editable={editavel} client={client} reload={reload} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: spacing.sm },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13 },
  ok: { color: colors.success, fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  smallBtn: { minHeight: 36, paddingHorizontal: spacing.md },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
  },
});
