import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type AdminGuildDetail, type ChannelConfig, type ChatterChange, type GuildTool, type GuildTosState, type TosPage, type YuiClient } from '../api/client.ts';
import { ChannelPicker } from '../components/ChannelPicker.tsx';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Chip, FieldLabel, StateView } from '../components/ui.tsx';
import {
  FREQUENCIAS, avisoDaFerramenta, lerPorcentagem, mudancaDaPersona, perguntaDaFerramenta, perguntaDoAceite,
  resultadoDoAceite, resumoDosTermos, semEmoji, textoSemMarkdown, mudancaAoAlternarFalas,
} from '../guildLogic.ts';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
type Msg = { text: string; ok: boolean } | null;

/** Carrega os dados de uma seção, com erro e nova tentativa. */
function useDados<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(errText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, error, reload };
}

/** Uma ação por vez, com a mensagem de sucesso ou de erro. */
function useAcao() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      setMsg(text ? { text, ok: true } : null);
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, run };
}

const Aviso = ({ msg }: { msg: Msg }) => (msg ? <Text accessibilityRole="alert" style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null);

/** Interruptor em linha inteira (alvo de toque de pelo menos 44). */
function Interruptor({ label, hint, aviso, on, disabled, onPress, testID }: {
  label: string; hint?: string; aviso?: string | null; on: boolean; disabled?: boolean; onPress: () => void; testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled }}
      aria-checked={on}
      disabled={disabled}
      onPress={onPress}
      style={(state: any) => [styles.switchRow, { opacity: disabled ? 0.6 : state.pressed ? 0.85 : 1 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.value}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        {aviso ? <Text style={styles.warn}>Atenção: {aviso}</Text> : null}
      </View>
      <Text style={styles.hint}>{on ? 'Ligado' : 'Desligado'}</Text>
      <View style={[styles.track, on && styles.trackOn]}>
        <View style={[styles.knob, on && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

/** Ferramentas da IA ligadas ou desligadas neste servidor (as mesmas do /yui-ferramentas). */
function Ferramentas({ client, guildId }: { client: YuiClient; guildId: string }) {
  const { data, setData, error, reload } = useDados<GuildTool[]>(async () => (await client.admin.guildTools(guildId)).ferramentas);
  const { busy, msg, run } = useAcao();

  if (!data) return error ? <StateView kind="error" message={error} onRetry={reload} /> : <StateView kind="loading" />;

  function alternar(f: GuildTool) {
    const ligar = !f.ligada;
    const p = perguntaDaFerramenta(f, ligar);
    confirmAction(p.titulo, p.texto, () => run(async () => {
      setData((await client.admin.setGuildTool(guildId, f.nome, ligar)).ferramentas);
      return `${semEmoji(f.rotulo)}: ${ligar ? 'ligada' : 'desligada'}.`;
    }), ligar ? 'Ligar' : 'Desligar');
  }

  const restaurar = () => confirmAction('Restaurar o padrão?', 'Todas as ferramentas deste servidor voltam ao padrão da Yui.', () => run(async () => {
    setData((await client.admin.resetGuildTools(guildId)).ferramentas);
    return 'Padrão restaurado.';
  }), 'Restaurar');

  return (
    <View style={styles.body}>
      {data.length === 0 ? <StateView kind="empty" title="Nenhuma ferramenta para ajustar" /> : null}
      {data.map((f) => (
        <Interruptor key={f.nome} testID={`guild-tool-${f.nome}`} label={semEmoji(f.rotulo)} hint={semEmoji(f.descricao)} aviso={avisoDaFerramenta(f.nome)} on={f.ligada} disabled={busy} onPress={() => alternar(f)} />
      ))}
      <Button testID="guild-tools-reset" label="Restaurar padrão" variant="ghost" compact loading={busy} onPress={restaurar} />
      <Aviso msg={msg} />
    </View>
  );
}

/** Termos de Uso do servidor: estado, leitura, aceite e revogação. */
function Termos({ client, guild, onChanged }: { client: YuiClient; guild: AdminGuildDetail; onChanged: (aceito: boolean) => void }) {
  const { data, setData, error, reload } = useDados<GuildTosState>(() => client.admin.guildTos(guild.id));
  const [paginas, setPaginas] = useState<TosPage[] | null>(null);
  const [lendo, setLendo] = useState(false);
  const [pagina, setPagina] = useState(0);
  const { busy, msg, run } = useAcao();
  const leitura = useAcao();

  if (!data) return error ? <StateView kind="error" message={error} onRetry={reload} /> : <StateView kind="loading" />;

  const carregarTermos = () => leitura.run(async () => {
    setPaginas((await client.admin.tosTerms()).paginas);
    return '';
  });

  function ler() {
    setLendo(!lendo);
    if (!lendo && !paginas) carregarTermos();
  }

  const aceitar = () => confirmAction('Aceitar os termos?', perguntaDoAceite(data, guild.name), () => run(async () => {
    const r = await client.admin.acceptGuildTos(guild.id, !data.donoDoServidor);
    setData({ ...data, ...r.estado });
    onChanged(r.estado.aceito);
    return resultadoDoAceite(r);
  }), 'Aceitar');

  const revogar = () => confirmAction('Revogar o aceite?', `Só o aceite de "${guild.name}" é removido. A Yui não sai do servidor.`, () => run(async () => {
    const r = await client.admin.revokeGuildTos(guild.id);
    setData({ ...data, ...r.estado });
    onChanged(r.estado.aceito);
    return 'Aceite revogado.';
  }), 'Revogar');

  const atual = paginas?.[pagina];
  return (
    <View style={styles.body}>
      <Badge label={!data.exigido ? 'Não exigidos' : data.aceito ? 'Aceitos' : 'Pendentes'} color={data.aceito ? colors.success : colors.warning} />
      <Text testID="guild-tos-estado" style={styles.value}>{resumoDosTermos(data)}</Text>
      {data.donoDoServidor ? null : <Text style={styles.warn}>Você não é o dono deste servidor: um aceite aqui é em nome de terceiros.</Text>}
      <View style={styles.row}>
        <Button testID="guild-tos-ler" label={lendo ? 'Fechar os termos' : 'Ler os termos'} variant="ghost" onPress={ler} compact />
        {data.aceito ? null : <Button testID="guild-tos-aceitar" label="Aceitar termos" onPress={aceitar} loading={busy} compact />}
        {data.aceitoEm || (data.aceito && data.exigido) ? <Button testID="guild-tos-revogar" label="Revogar aceite" variant="dangerOutline" onPress={revogar} loading={busy} compact /> : null}
      </View>
      {lendo && !paginas ? (
        leitura.msg && !leitura.msg.ok ? <StateView kind="error" message={leitura.msg.text} onRetry={carregarTermos} /> : <StateView kind="loading" />
      ) : null}
      {lendo && paginas && atual ? (
        <View style={styles.box}>
          <View style={styles.row}>
            {paginas.map((p, i) => <Chip key={p.titulo} testID={`guild-tos-pagina-${i + 1}`} label={`${i + 1}`} on={i === pagina} onPress={() => setPagina(i)} />)}
          </View>
          <Text style={styles.title}>{semEmoji(atual.titulo)}</Text>
          <Text style={styles.value}>{textoSemMarkdown(atual.texto)}</Text>
        </View>
      ) : null}
      <Aviso msg={msg} />
    </View>
  );
}

/** Persona e falas espontâneas de um canal. É remontado (key) quando o canal muda. */
function CanalEditor({ client, guildId, canalId }: { client: YuiClient; guildId: string; canalId: string }) {
  const [instrucao, setInstrucao] = useState('');
  const [humor, setHumor] = useState('');
  const [porcentagem, setPorcentagem] = useState('');
  const campos = (v: ChannelConfig) => {
    setInstrucao(v.persona.instrucao ?? '');
    setHumor(v.persona.humor ?? '');
  };
  const campoPct = (v: ChannelConfig) => setPorcentagem(v.espontaneo.porcentagem === null ? '' : String(v.espontaneo.porcentagem));
  const { data, setData, error, reload } = useDados<ChannelConfig>(async () => {
    const v = await client.admin.channelConfig(guildId, canalId);
    campos(v);
    campoPct(v);
    return v;
  });
  const persona = useAcao();
  const falas = useAcao();

  if (!data) return error ? <StateView kind="error" message={error} onRetry={reload} /> : <StateView kind="loading" />;

  const canal = `#${data.nome}`;
  const mudanca = mudancaDaPersona(data.persona, instrucao, humor);
  const longo = instrucao.length > data.limites.instrucao || humor.length > data.limites.humor;
  const pct = lerPorcentagem(porcentagem);
  const { ativo, frequencia } = data.espontaneo;

  const salvarPersona = () => {
    if (!mudanca) return;
    confirmAction('Salvar a persona?', `Muda como a Yui se comporta em ${canal}.`, () => persona.run(async () => {
      const v = await client.admin.setPersona(guildId, canalId, mudanca);
      setData(v);
      campos(v);
      return 'Persona salva.';
    }), 'Salvar');
  };

  const resetar = () => confirmAction('Restaurar a persona?', `A instrução e o humor de ${canal} serão apagados. As falas espontâneas continuam como estão.`, () => persona.run(async () => {
    const v = await client.admin.resetPersona(guildId, canalId);
    setData(v);
    campos(v);
    return 'Persona restaurada.';
  }), 'Restaurar');

  function mudarFalas(pergunta: string, mudancaFalas: ChatterChange) {
    if (falas.busy) return;
    confirmAction('Mudar as falas espontâneas?', `${pergunta} em ${canal}.`, () => falas.run(async () => {
      const v = await client.admin.setChatter(guildId, canalId, mudancaFalas);
      setData(v);
      campoPct(v);
      return 'Falas espontâneas atualizadas.';
    }));
  }

  return (
    <View style={styles.body}>
      <FieldLabel>Instrução da persona ({instrucao.length}/{data.limites.instrucao})</FieldLabel>
      <TextInput testID="canal-instrucao" accessibilityLabel="Instrução da persona" style={[styles.input, styles.multiline]} multiline value={instrucao} onChangeText={setInstrucao} placeholder="Sem instrução própria" placeholderTextColor={colors.muted} />
      <FieldLabel>Humor ({humor.length}/{data.limites.humor})</FieldLabel>
      <TextInput testID="canal-humor" accessibilityLabel="Humor" style={styles.input} value={humor} onChangeText={setHumor} placeholder="Sem humor definido" placeholderTextColor={colors.muted} />
      {longo ? <Text style={styles.error}>Texto acima do limite: encurte para salvar.</Text> : null}
      <View style={styles.row}>
        <Button testID="canal-persona-salvar" label="Salvar persona" onPress={salvarPersona} loading={persona.busy} disabled={!mudanca || longo} compact />
        <Button testID="canal-persona-reset" label="Restaurar persona" variant="ghost" onPress={resetar} loading={persona.busy} disabled={!data.persona.instrucao && !data.persona.humor} compact />
      </View>
      <Aviso msg={persona.msg} />

      <Interruptor testID="canal-espontaneo" label="Falas espontâneas" hint="A Yui entra na conversa sem ser chamada." on={ativo} disabled={falas.busy} onPress={() => { const m = mudancaAoAlternarFalas(data.espontaneo); mudarFalas(m.pergunta, m.mudanca); }} />
      {ativo && frequencia === null ? <Text style={styles.warn}>Escolha uma frequência: sem ela a Yui não fala.</Text> : null}
      <FieldLabel>Frequência{frequencia === 'custom' ? ' (vale a porcentagem)' : ''}</FieldLabel>
      <View style={styles.row}>
        {FREQUENCIAS.map((f) => (
          <Chip key={f.valor} testID={`canal-freq-${f.valor}`} label={f.rotulo} on={frequencia === f.valor} onPress={() => { if (frequencia !== f.valor) mudarFalas(`Usar frequência ${f.rotulo}`, { frequencia: f.valor }); }} />
        ))}
      </View>
      <View style={styles.row}>
        <TextInput testID="canal-porcentagem" accessibilityLabel="Porcentagem exata" style={[styles.input, { width: 170 }]} value={porcentagem} onChangeText={setPorcentagem} placeholder="% exata (0 a 100)" placeholderTextColor={colors.muted} keyboardType="numeric" maxLength={3} />
        <Button testID="canal-porcentagem-salvar" label="Usar porcentagem" variant="ghost" onPress={() => { if (pct !== null) mudarFalas(`Usar ${pct}% de chance`, { porcentagem: pct }); }} loading={falas.busy} disabled={pct === null || (frequencia === 'custom' && pct === data.espontaneo.porcentagem)} compact />
      </View>
      <Aviso msg={falas.msg} />
    </View>
  );
}

/** Persona e falas por canal, mais as opções que valem para o servidor todo (menções e canal de avisos). */
function Canal({ client, guild, reload }: { client: YuiClient; guild: AdminGuildDetail; reload: () => Promise<void> }) {
  const [canalId, setCanalId] = useState<string | null>(null);
  const [escolhendo, setEscolhendo] = useState(false);
  const { busy, msg, run } = useAcao();
  const mencoes = guild.respondToEveryone === true;
  const avisos = guild.channels.atualizacoes;
  const nomeAvisos = avisos ? (avisos.name ? `#${avisos.name}` : `ID ${avisos.id}`) : 'não definido';

  const alternarMencoes = () => confirmAction(
    mencoes ? 'Parar de responder a @everyone?' : 'Responder a @everyone?',
    mencoes ? 'A Yui deixa de responder a @everyone e @here neste servidor.' : 'A Yui passa a responder a mensagens com @everyone e @here neste servidor.',
    () => run(async () => {
      await client.admin.setMentions(guild.id, !mencoes);
      await reload();
      return 'Menções atualizadas.';
    })
  );

  function escolherAvisos(id: string | null) {
    if (busy || id === (avisos?.id ?? null)) return;
    const nome = guild.textChannels.find((c) => c.id === id)?.name;
    confirmAction('Mudar o canal de avisos?', id ? `Os avisos da Yui passam a sair em #${nome ?? id}.` : 'Sem canal escolhido, a Yui pode escolher outro sozinha na próxima conversa.', () => run(async () => {
      await client.admin.setGuildChannel(guild.id, 'atualizacoes', id);
      await reload();
      setEscolhendo(false);
      return 'Canal de avisos atualizado.';
    }));
  }

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Servidor todo</Text>
      <Interruptor testID="guild-mencoes" label="Responder a @everyone e @here" on={mencoes} disabled={busy} onPress={alternarMencoes} />
      <View style={styles.row}>
        <Text style={[styles.value, { flex: 1 }]}>Canal de avisos da Yui: {nomeAvisos}</Text>
        <Button testID="guild-channel-atualizacoes" label={escolhendo ? 'Fechar' : 'Alterar'} variant="ghost" onPress={() => setEscolhendo(!escolhendo)} loading={busy} compact />
      </View>
      {escolhendo ? <ChannelPicker testID="pick-atualizacoes" channels={guild.textChannels} value={avisos?.id ?? null} allowNone onPick={escolherAvisos} /> : null}
      <Aviso msg={msg} />

      <Text style={styles.title}>Persona e falas por canal</Text>
      <ChannelPicker testID="canal-pick" channels={guild.textChannels} value={canalId} onPick={setCanalId} />
      {canalId ? <CanalEditor key={canalId} client={client} guildId={guild.id} canalId={canalId} /> : <Text style={styles.hint}>Escolha um canal para ver e mudar.</Text>}
    </View>
  );
}

type Secao = 'ferramentas' | 'termos' | 'canal';
const SECOES: { key: Secao; label: string }[] = [
  { key: 'ferramentas', label: 'Ferramentas' },
  { key: 'termos', label: 'Termos de uso' },
  { key: 'canal', label: 'Canal' },
];

/** Configurações por servidor. Cada seção só carrega quando aberta. */
export function GuildExtras({ client, guild, reload, onTosChange }: {
  client: YuiClient; guild: AdminGuildDetail; reload: () => Promise<void>; onTosChange?: (aceito: boolean) => void;
}) {
  const [secao, setSecao] = useState<Secao | null>(null);
  return (
    <View style={styles.body}>
      <View style={styles.row}>
        {SECOES.map((s) => <Chip key={s.key} testID={`guild-secao-${s.key}`} label={s.label} on={secao === s.key} onPress={() => setSecao(secao === s.key ? null : s.key)} />)}
      </View>
      {secao === 'ferramentas' ? <Ferramentas client={client} guildId={guild.id} /> : null}
      {secao === 'termos' ? <Termos client={client} guild={guild} onChanged={(aceito) => { onTosChange?.(aceito); reload(); }} /> : null}
      {secao === 'canal' ? <Canal client={client} guild={guild} reload={reload} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  box: { gap: spacing.sm, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md },
  title: { color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: '700', marginTop: spacing.sm },
  value: { color: colors.text, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  warn: { color: colors.warning, fontSize: 12, lineHeight: 17 },
  ok: { color: colors.success, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingVertical: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border },
  track: { width: 40, height: 24, borderRadius: radius.pill, padding: 3, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  trackOn: { backgroundColor: colors.btnBg, borderColor: colors.btnBg },
  knob: { width: 16, height: 16, borderRadius: radius.pill, backgroundColor: colors.muted },
  knobOn: { backgroundColor: colors.btnFg, transform: [{ translateX: 16 }] },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 16,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
});
