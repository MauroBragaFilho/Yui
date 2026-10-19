import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type AiCustomProvider, type AiKeyHint, type AiOverview, type AiProvider, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, Chip } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');

/** Linha de uma chave já cadastrada: só os 4 últimos caracteres aparecem. */
function KeyRow({ hint, onRemove }: { hint: AiKeyHint; onRemove: () => void }) {
  return (
    <View style={styles.keyRow}>
      <Text style={styles.value}>Chave {hint.hint}</Text>
      <Button label="Remover" variant="ghost" onPress={onRemove} style={styles.smallBtn} testID={`ai-key-remove-${hint.index}`} />
    </View>
  );
}

/** Campo para colar uma chave (escondida) e enviar. A chave nunca volta do servidor. */
function KeyForm({ onSubmit, testID }: { onSubmit: (key: string) => Promise<void>; testID?: string }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await onSubmit(key.trim());
      setKey('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={styles.formRow}>
      <TextInput
        testID={testID}
        style={[styles.input, { flex: 1 }]}
        value={key}
        onChangeText={setKey}
        placeholder="Colar nova chave"
        placeholderTextColor={colors.muted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        onSubmitEditing={submit}
      />
      <Button label="Adicionar" onPress={submit} loading={busy} disabled={key.trim().length < 10} style={styles.smallBtn} />
    </View>
  );
}

function ProviderCard({ p, editable, client, reload }: { p: AiProvider; editable: boolean; client: YuiClient; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [account, setAccount] = useState('');
  const [testing, setTesting] = useState(false);

  async function run(fn: () => Promise<unknown>, okText?: string) {
    setMsg(null);
    try {
      await fn();
      await reload();
      if (okText) setMsg({ text: okText, ok: true });
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    }
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const r = await client.admin.aiTest(p.id);
      setMsg(r.ok ? { text: `Funcionando (${(r.ms / 1000).toFixed(1)}s).`, ok: true } : { text: `Falhou: ${r.error ?? 'sem detalhes'}`, ok: false });
      await reload();
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setTesting(false);
    }
  }

  const total = p.envKeys + p.panelKeys.length;
  const status = !p.enabled ? { label: 'Desligado', color: colors.muted } : p.active ? { label: 'Ativo', color: colors.success } : { label: 'Falta configurar', color: colors.warning };

  return (
    <Card style={styles.card} >
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{p.label}</Text>
        <Badge label={p.toggle ? status.label : total ? 'Configurado' : 'Sem chave'} color={p.toggle ? status.color : total ? colors.success : colors.warning} />
      </View>
      {!p.keyless ? (
        <Text style={styles.hint}>
          {total === 0 ? 'Nenhuma chave.' : `${total} chave(s)`}
          {p.envKeys ? ` • ${p.envKeys} no arquivo .env (só se altera lá)` : ''}
        </Text>
      ) : (
        <Text style={styles.hint}>Gratuito, sem chave. É anônimo: nunca recebe conversas pessoais.</Text>
      )}
      {p.ignoredEnvKeys ? <Text style={styles.error}>{p.ignoredEnvKeys} chave(s) do .env curta(s) demais (parece valor de exemplo): ignorada(s).</Text> : null}
      {p.panelKeys.map((k) => (
        <KeyRow
          key={k.index}
          hint={k}
          onRemove={() =>
            confirmAction('Remover esta chave?', `${p.label} ${k.hint}`, () => run(() => client.admin.aiRemoveKey(p.id, k.index), 'Chave removida.'), 'Remover')
          }
        />
      ))}

      {editable && !p.keyless ? <KeyForm testID={`ai-key-${p.id}`} onSubmit={(key) => run(() => client.admin.aiAddKey(p.id, key), 'Chave adicionada.')} /> : null}

      {editable && p.needsAccount ? (
        <View style={styles.formRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={account}
            onChangeText={setAccount}
            placeholder={p.accountConfigured ? 'ID da conta (já configurado)' : 'ID da conta da Cloudflare (32 caracteres)'}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button label="Salvar" variant="ghost" onPress={() => run(() => client.admin.aiCloudflare(account.trim()), 'ID da conta salvo.')} disabled={!account.trim()} style={styles.smallBtn} />
        </View>
      ) : null}

      <View style={styles.formRow}>
        {p.toggle || total > 0 ? <Button label="Testar" variant="ghost" onPress={test} loading={testing} disabled={!p.active && p.toggle} style={styles.smallBtn} testID={`ai-test-${p.id}`} /> : null}
        {editable && p.toggle ? (
          <Button
            label={p.enabled ? 'Desligar' : 'Ligar'}
            variant="ghost"
            onPress={() => run(() => client.admin.aiSetEnabled(p.id, !p.enabled))}
            style={styles.smallBtn}
            testID={`ai-toggle-${p.id}`}
          />
        ) : null}
      </View>
      {p.url && editable ? <Text style={styles.hint}>Onde conseguir a chave: {p.url}</Text> : null}
      {msg ? <Text style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null}
    </Card>
  );
}

function CustomCard({ c, editable, client, reload }: { c: AiCustomProvider; editable: boolean; client: YuiClient; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState(c.models.join(', '));
  const mine = c.source === 'panel';

  async function run(fn: () => Promise<unknown>, okText?: string) {
    setMsg(null);
    try {
      await fn();
      await reload();
      if (okText) setMsg({ text: okText, ok: true });
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    }
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const r = await client.admin.aiTest(c.id);
      setMsg(r.ok ? { text: `Funcionando (${(r.ms / 1000).toFixed(1)}s).`, ok: true } : { text: `Falhou: ${r.error ?? 'sem detalhes'}`, ok: false });
      await reload();
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{c.label}</Text>
        <Badge label={!c.enabled ? 'Desligado' : c.active ? 'Ativo' : 'Inativo'} color={!c.enabled ? colors.muted : c.active ? colors.success : colors.warning} />
      </View>
      <Text style={styles.hint}>{c.baseUrl}</Text>
      <Text style={styles.hint}>Modelos: {c.models.join(', ')}</Text>
      {!mine ? <Text style={styles.hint}>Definido no arquivo .env (só se altera lá).</Text> : null}
      <View style={styles.badges}>
        {c.first ? <Badge label="Logo após o LM Studio" color={colors.accentText} /> : null}
        <Badge label={c.anonymous ? 'Sem conversas pessoais' : 'Aceita conversas pessoais'} color={c.anonymous ? colors.muted : colors.success} />
      </View>
      {c.keys.map((k) => (
        <View key={k.index} style={styles.keyRow}>
          <Text style={styles.value}>Chave {k.hint}</Text>
        </View>
      ))}
      {c.keys.length === 0 ? <Text style={styles.hint}>Sem chave (servidor da sua rede).</Text> : null}
      {editable && mine ? (
        <View style={styles.formRow}>
          <Button
            testID={`ai-first-${c.id}`}
            label={c.first ? 'Voltar para a ordem normal' : 'Colocar logo após o LM Studio'}
            variant={c.first ? 'ghost' : 'primary'}
            onPress={() => run(() => client.admin.aiCustomOptions(c.id, { first: !c.first }), c.first ? 'Voltou para a ordem normal.' : 'Agora é o primeiro provedor depois do LM Studio.')}
            style={styles.smallBtn}
          />
          <Button
            testID={`ai-private-${c.id}`}
            label={c.anonymous ? 'Permitir conversas pessoais' : 'Bloquear conversas pessoais'}
            variant="ghost"
            onPress={() => run(() => client.admin.aiCustomOptions(c.id, { anonymous: !c.anonymous }), c.anonymous ? 'Agora recebe conversas pessoais.' : 'Não receberá mais conversas pessoais.')}
            style={styles.smallBtn}
          />
        </View>
      ) : null}
      {editable && mine ? (
        <View style={styles.formRow}>
          <TextInput
            testID={`ai-models-${c.id}`}
            style={[styles.input, { flex: 1 }]}
            value={models}
            onChangeText={setModels}
            placeholder="Modelos, separados por vírgula"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button label="Salvar modelos" variant="ghost" onPress={() => run(() => client.admin.aiCustomOptions(c.id, { models }), 'Modelos atualizados.')} disabled={!models.trim()} style={styles.smallBtn} />
        </View>
      ) : null}
      {editable && mine ? <KeyForm testID={`ai-custom-key-${c.id}`} onSubmit={(key) => run(() => client.admin.aiAddCustomKey(c.id, key), 'Chave adicionada.')} /> : null}
      <View style={styles.formRow}>
        <Button label="Testar" variant="ghost" onPress={test} loading={testing} disabled={!c.active} style={styles.smallBtn} testID={`ai-test-${c.id}`} />
        {editable && mine ? (
          <>
            <Button label={c.enabled ? 'Desligar' : 'Ligar'} variant="ghost" onPress={() => run(() => client.admin.aiSetEnabled(c.id, !c.enabled))} style={styles.smallBtn} />
            <Button
              label="Excluir"
              variant="ghost"
              onPress={() => confirmAction('Excluir este provedor?', `${c.label} e as chaves dele serão apagados.`, () => run(() => client.admin.aiRemoveCustom(c.id)), 'Excluir')}
              style={styles.smallBtn}
              testID={`ai-custom-remove-${c.id}`}
            />
          </>
        ) : null}
      </View>
      {msg ? <Text style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null}
    </Card>
  );
}

function AddCustom({ data, client, reload }: { data: AiOverview; client: YuiClient; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [key, setKey] = useState('');
  const [first, setFirst] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  function useTemplate(tid: string) {
    const t = data.templates.find((x) => x.id === tid);
    if (!t) return;
    setId(t.id === 'outro' ? '' : t.id);
    setLabel(t.id === 'outro' ? '' : t.label);
    setBaseUrl(t.baseUrl);
    setModels(t.models.join(', '));
    setFirst(Boolean(t.first));
    setAnonymous(Boolean(t.anonymous));
    setMsg(null);
  }

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      await client.admin.aiAddCustom({ id: id.trim().toLowerCase(), label: label.trim(), baseUrl: baseUrl.trim(), models, key: key.trim() || undefined, first, anonymous });
      setId(''); setLabel(''); setBaseUrl(''); setModels(''); setKey('');
      setOpen(false);
      await reload();
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button testID="ai-add-custom" label="Adicionar provedor próprio" variant="ghost" icon="add_comment" onPress={() => setOpen(true)} />;

  return (
    <Card style={styles.card}>
      <Text style={styles.cardTitle}>Novo provedor (compatível com OpenAI)</Text>
      <Text style={styles.hint}>Serve para OmniRoute, LM Studio em outro PC ou qualquer serviço com endereço /v1/chat/completions. Começar por um modelo pronto:</Text>
      <View style={styles.chips}>
        {data.templates.map((t) => (
          <Chip key={t.id} label={t.label} on={id === t.id} onPress={() => useTemplate(t.id)} testID={`ai-template-${t.id}`} />
        ))}
      </View>
      <Text style={styles.label}>ID (letras minúsculas, números e hífen)</Text>
      <TextInput testID="ai-custom-id" style={styles.input} value={id} onChangeText={setId} placeholder="omniroute" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />
      <Text style={styles.label}>Nome</Text>
      <TextInput testID="ai-custom-label" style={styles.input} value={label} onChangeText={setLabel} placeholder="OmniRoute" placeholderTextColor={colors.muted} />
      <Text style={styles.label}>Endereço base</Text>
      <TextInput testID="ai-custom-url" style={styles.input} value={baseUrl} onChangeText={setBaseUrl} placeholder="http://127.0.0.1:20128/v1" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />
      <Text style={styles.label}>Modelos (separados por vírgula)</Text>
      <TextInput testID="ai-custom-models" style={styles.input} value={models} onChangeText={setModels} placeholder="free-stack" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />
      <Text style={styles.label}>Chave de acesso (opcional para servidores da sua rede)</Text>
      <TextInput testID="ai-custom-key" style={styles.input} value={key} onChangeText={setKey} placeholder="Colar chave" placeholderTextColor={colors.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" />
      <View style={styles.chips}>
        <Chip testID="ai-custom-first" label="Logo após o LM Studio" on={first} onPress={() => setFirst(!first)} />
        <Chip testID="ai-custom-anon" label="Sem conversas pessoais" on={anonymous} onPress={() => setAnonymous(!anonymous)} />
      </View>
      <Text style={styles.hint}>
        "Sem conversas pessoais" mantém suas conversas privadas (memória pessoal) fora deste provedor. Use para roteadores que repassam a serviços de terceiros, como o OmniRoute.
      </Text>
      {msg ? <Text style={styles.error}>{msg.text}</Text> : null}
      <View style={styles.formRow}>
        <Button testID="ai-custom-save" label="Adicionar" onPress={add} loading={busy} disabled={!id.trim() || !baseUrl.trim() || !models.trim()} style={{ flex: 1 }} />
        <Button label="Cancelar" variant="ghost" onPress={() => setOpen(false)} />
      </View>
    </Card>
  );
}

/** Provedores de IA: chaves, ligar/desligar, testar e adicionar provedores próprios. */
export function AiProviders({ client, onChanged }: { client: YuiClient; onChanged: () => void }) {
  const [data, setData] = useState<AiOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await client.admin.ai());
      setError(null);
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  }, [client, onChanged]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Text testID="admin-error" style={styles.error}>{error}</Text>;
  if (!data) return <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Provedores e chaves</Text>
      {data.editable ? (
        <Text style={styles.hint}>As chaves que você colar aqui ficam só neste computador (pasta secrets/, fora do Git) e valem na hora. Elas nunca voltam para a tela: só os 4 últimos caracteres aparecem.</Text>
      ) : (
        <Text style={styles.hint}>A edição pelo painel está desligada (YUI_PANEL_AI_EDIT=false no .env). Só dá para consultar e testar.</Text>
      )}
      {data.providers.map((p) => (
        <ProviderCard key={p.id} p={p} editable={data.editable} client={client} reload={reload} />
      ))}
      {data.custom.length ? <Text style={styles.sectionTitle}>Provedores próprios</Text> : null}
      {data.custom.map((c) => (
        <CustomCard key={c.id} c={c} editable={data.editable} client={client} reload={reload} />
      ))}
      {data.editable ? <AddCustom data={data} client={client} reload={reload} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: spacing.sm },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13 },
  ok: { color: colors.success, fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  keyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
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
