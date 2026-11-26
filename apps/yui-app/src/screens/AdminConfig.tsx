import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type ConfigItem, type ConfigOverview, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { perguntaDoAjuste } from '../guildLogic.ts';
import { Badge, Button, Card, Chip, FieldLabel, Icon, SectionHeading, StateView } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');

/** Valor para mostrar: booleanos viram Ligado/Desligado. */
const mostra = (item: ConfigItem, v: unknown) => (item.tipo === 'bool' ? (String(v) === 'true' ? 'Ligado' : String(v) === 'false' ? 'Desligado' : String(v)) : v === '' || v === undefined ? '(vazio)' : String(v));

/** "Pede reinício" já aparece como selo: só na exibição, tira a repetição do fim da descrição. */
const semReinicio = (texto: string) => texto.replace(/[\s.;,(\-–—]*\(?\s*pede\s+rein[ií]cio\s*\)?\s*\.?\s*$/i, '').trim();

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

  /** Valor que afrouxa privacidade ou segurança pede confirmação antes; os outros gravam direto. */
  function save(valor: string) {
    const pergunta = perguntaDoAjuste(item, valor);
    if (pergunta) confirmAction('Tem certeza?', pergunta, () => gravar(valor, true), 'Confirmar');
    else gravar(valor, false);
  }

  async function gravar(valor: string, confirm: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await client.admin.configSet(item.chave, valor, confirm);
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
      const r = await client.admin.configRemove(item.chave, Boolean(item.confirmar));
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
    : item.definido ? `Valor atual: ${mostra(item, item.valor)}` : `Padrão: ${mostra(item, item.padrao)}`;
  // Booleano/opção com edição: o valor atual já está marcado nos botões, não repete a linha "Valor atual".
  const escolhaVisivel = editable && (item.tipo === 'bool' || item.tipo === 'enum') && item.definido;
  const estado = item.secreto && !item.definido ? { label: 'Não definida', color: colors.warning } : origem;
  const campoTexto = item.tipo === 'int' || item.tipo === 'texto' || item.tipo === 'segredo';
  const voltar = editable && item.origem === 'painel' ? (
    <Button label="Voltar ao .env" variant="ghost" compact onPress={() => confirmAction('Voltar ao .env?', `"${item.rotulo}" volta ao valor do .env (ou ao padrão); o valor salvo no painel será apagado.`, removeNow, 'Voltar')} loading={busy} style={styles.smallBtn} testID={`config-remove-${item.chave}`} />
  ) : null;

  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{item.rotulo}</Text>
        <View style={styles.badges}>
          <Badge label={estado.label} color={estado.color} />
          {item.reinicio ? <Badge label="Pede reinício" color={colors.warning} /> : null}
        </View>
      </View>
      <Text style={styles.hint}>{item.reinicio ? semReinicio(item.descricao) : item.descricao}</Text>
      {escolhaVisivel ? null : (
        <View style={styles.valueBox}>
          <Icon name={item.secreto ? 'lock' : 'tune'} size={18} color={colors.muted} />
          <Text style={styles.value} testID={`config-atual-${item.chave}`}>{atual}</Text>
        </View>
      )}
      {item.alteradoEm ? <Text style={styles.hint}>Última alteração: {new Date(item.alteradoEm).toLocaleString('pt-BR')}</Text> : null}

      {editable && item.tipo === 'bool' ? (
        <View style={styles.chips}>
          <Chip label="Ligado" on={item.valor === 'true'} onPress={() => save('true')} testID={`config-${item.chave}-on`} />
          <Chip label="Desligado" on={item.valor === 'false'} onPress={() => save('false')} testID={`config-${item.chave}-off`} />
          {voltar}
        </View>
      ) : null}
      {editable && item.tipo === 'enum' ? (
        <View style={styles.chips}>
          {(item.opcoes ?? []).map((o) => <Chip key={o} label={o} on={item.valor === o} onPress={() => save(o)} testID={`config-${item.chave}-${o}`} />)}
          {voltar}
        </View>
      ) : null}
      {editable && campoTexto ? (
        <View style={{ gap: spacing.xs }}>
          <FieldLabel>{item.tipo === 'segredo' ? 'Nova chave (o valor nunca é mostrado)' : 'Novo valor'}</FieldLabel>
          <View style={styles.formRow}>
            <TextInput
              testID={`config-input-${item.chave}`}
              accessibilityLabel={`${item.rotulo}: ${item.tipo === 'segredo' ? 'nova chave' : 'novo valor'}`}
              style={[styles.input, { flex: 1, minWidth: 180 }]}
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
            {voltar}
          </View>
        </View>
      ) : null}
      {!campoTexto && !(editable && (item.tipo === 'bool' || item.tipo === 'enum')) ? voltar : null}
      {msg ? <Text accessibilityRole="alert" style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null}
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

  if (error) return <StateView kind="error" testID="config-error" title="Não consegui abrir a configuração" message={error} onRetry={reload} />;
  if (!data) return <StateView kind="loading" title="Abrindo a configuração…" />;

  const grupos = [...new Set(data.itens.map((i) => i.grupo))];
  const editavel = data.edicaoLigada && data.problema !== 'cofre-ilegivel';
  return (
    <View style={styles.section}>
      <SectionHeading title="Configuração e chaves" hint="Ajustes e chaves da Yui, guardados no cofre do painel." />
      {data.problema === 'cofre-ilegivel' ? (
        <View style={styles.alertBox}>
          <Icon name="error" size={20} color={colors.danger} />
          <Text testID="config-cofre-ilegivel" style={[styles.error, { flex: 1 }]}>O cofre de configuração existe mas não abriu (arquivo quebrado ou protegido por outra conta). Nada será alterado até você conferir o arquivo secrets/painel-config.json e a cópia .bak.</Text>
        </View>
      ) : null}
      {data.edicaoLigada ? (
        <Card style={styles.intro}>
          <View style={{ gap: spacing.sm }}>
            {[
              'O que você salvar aqui fica só neste computador (pasta secrets/, fora do Git) e vale por cima do .env. Uma chave nunca volta do servidor: só os 4 últimos caracteres aparecem.',
              'O token do Discord, a senha do painel e as regras de segurança continuam só no .env.',
              'A mudança vale na hora no cérebro; o bot (voz, semanal, avisos) só relê ao reiniciar: itens marcados "Pede reinício" só valem depois disso.',
              data.protegido ? 'O arquivo é gravado protegido (DPAPI do Windows).' : 'O arquivo ainda NÃO é criptografado (YUI_PAINEL_CONFIG_DPAPI=true liga a proteção no Windows).',
            ].map((t) => (
              <View key={t} style={styles.bulletRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.introText}>{t}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : (
        <Card style={styles.intro}>
          <Text style={styles.hint}>A edição pelo painel está desligada (YUI_PAINEL_CONFIG_EDIT=false no .env). Só dá para consultar.</Text>
        </Card>
      )}
      {data.itens.length === 0 ? <StateView kind="empty" title="Nenhum ajuste disponível" message="Este servidor não listou ajustes para o painel." /> : null}
      {grupos.map((g) => (
        <View key={g} style={styles.section}>
          <SectionHeading title={g} />
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
  intro: { backgroundColor: colors.surfaceAlt },
  valueBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  alertBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.dangerBg },
  cardTitle: { color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: '700', flexShrink: 1 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  ok: { color: colors.success, fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  smallBtn: { minHeight: 44, paddingHorizontal: spacing.md },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bullet: { color: colors.accentText, fontSize: 14, lineHeight: 20 },
  introText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 13, lineHeight: 19 },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.sm,
    fontSize: 14,
  },
});
