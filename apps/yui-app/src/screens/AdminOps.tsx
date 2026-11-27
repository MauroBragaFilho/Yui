import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type AdminGuild,
  type LogKind,
  type LogLevel,
  type LogsResult,
  type RadioAction,
  type RadioCanais,
  type RadioFaixa,
  type RadioResultado,
  type RadioSession,
  type YuiClient,
} from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, Chip, SectionHeading, StateView } from '../components/ui.tsx';
import {
  TEXTO_BUSCA_INVALIDA, buscaValida, canaisParaEscolher, linhasDaFila, podeIniciar, podePular, rotuloDaFaixa, servidoresParaIniciar, textoDoResultado,
} from '../radioLogic.ts';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');

const STATUS: Record<string, { label: string; color: string }> = {
  PLAYING: { label: 'Tocando', color: colors.success },
  PAUSED: { label: 'Pausada', color: colors.warning },
  BUFFERING: { label: 'Carregando', color: colors.warning },
  STOPPED: { label: 'Parada', color: colors.muted },
};

const MODE_LABEL: Record<string, string> = { OFF: 'desligado', DIRECT: 'direto', IA: 'IA' };

/** As opções de uma busca ambígua: o painel devolve só o NÚMERO da escolhida (as faixas ficam no servidor). */
function OpcoesDaBusca({ opcoes, onEscolher, busy, testID }: { opcoes: RadioFaixa[]; onEscolher: (i: number) => void; busy: boolean; testID: string }) {
  return (
    <View style={{ gap: spacing.xs }} testID={testID}>
      {opcoes.map((o, i) => (
        <Button key={`${i}-${o.title}`} testID={`${testID}-${i}`} label={rotuloDaFaixa(o)} variant="ghost" compact disabled={busy} onPress={() => onEscolher(i)} />
      ))}
    </View>
  );
}

/** Tocar um gênero, uma música ou um link no rádio de um servidor (com a escolha quando a busca é ambígua). */
function Tocar({ client, guildId, onDone }: { client: YuiClient; guildId: string; onDone: () => Promise<void> | void }) {
  const [q, setQ] = useState('');
  const [opcoes, setOpcoes] = useState<RadioFaixa[] | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rodar(fn: () => Promise<RadioResultado>) {
    setBusy(true);
    setErro(null);
    try {
      const r = await fn();
      setOpcoes(r.resultado === 'escolher' ? r.opcoes ?? [] : null);
      setInfo(textoDoResultado(r) || null);
      if (r.resultado !== 'escolher') {
        setQ('');
        await onDone();
      }
    } catch (e) {
      setErro(errText(e));
    } finally {
      setBusy(false);
    }
  }
  function tocar() {
    const busca = buscaValida(q);
    if (!busca) { setErro(TEXTO_BUSCA_INVALIDA); return; }
    rodar(() => client.admin.radioTocar(guildId, busca));
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.formRow}>
        <TextInput
          testID={`radio-busca-${guildId}`}
          style={[styles.input, { flex: 1, minWidth: 180 }]}
          value={q}
          onChangeText={setQ}
          placeholder="Gênero, música ou link…"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={tocar}
        />
        <Button testID={`radio-tocar-${guildId}`} label="Tocar" onPress={tocar} loading={busy} style={styles.smallBtn} />
      </View>
      {opcoes ? <OpcoesDaBusca opcoes={opcoes} busy={busy} testID={`radio-opcao-${guildId}`} onEscolher={(i) => rodar(() => client.admin.radioEscolher(guildId, i))} /> : null}
      {info ? <Text style={styles.ok}>{info}</Text> : null}
      {erro ? <Text style={styles.error}>{erro}</Text> : null}
    </View>
  );
}

function SessionCard({ s, client, reload }: { s: RadioSession; client: YuiClient; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [verFila, setVerFila] = useState(false);
  const st = STATUS[s.status] ?? { label: s.status, color: colors.muted };
  const fila = linhasDaFila(s);

  async function act(action: RadioAction) {
    setMsg(null);
    setInfo(null);
    try {
      const r = await client.admin.radioAction(s.guildId, action);
      if (action === 'skip') setInfo(textoDoResultado(r) || null);
      await reload();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{s.guildName ?? `Servidor ${s.guildId}`}</Text>
        <Badge label={st.label} color={st.color} />
      </View>
      <Text style={styles.hint}>
        {s.voiceChannel ? `Call: ${s.voiceChannel}` : 'Call desconhecida'} • {s.connected ? 'conectada' : 'sem conexão de voz'}
      </Text>
      {s.current ? (
        <View style={{ gap: 2 }}>
          <Text style={styles.value}>{s.current.title}</Text>
          <Text style={styles.hint}>{s.current.artist}{s.position ? ` • faixa ${s.position}` : ''}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>Nada na fila agora.</Text>
      )}
      {s.next ? <Text style={styles.hint}>Próxima: {s.next.title} — {s.next.artist}{s.queueLength > 1 ? ` (+${s.queueLength - 1})` : ''}</Text> : null}
      <View style={styles.badges}>
        {s.shuffle ? <Badge label="Aleatório" color={colors.muted} /> : null}
        {s.loopMode !== 'OFF' ? <Badge label={`Repetir: ${s.loopMode}`} color={colors.muted} /> : null}
        <Badge label={`Voz: ${MODE_LABEL[s.voiceMode] ?? s.voiceMode}`} color={colors.muted} />
      </View>
      {fila.linhas.length ? (
        <View style={{ gap: 2 }}>
          <Button testID={`radio-fila-${s.guildId}`} label={verFila ? 'Esconder a fila' : `Ver a fila (${s.queueLength})`} variant="ghost" compact onPress={() => setVerFila(!verFila)} />
          {verFila ? fila.linhas.map((l) => <Text key={l} style={styles.hint}>{l}</Text>) : null}
          {verFila && fila.resto ? <Text style={styles.hint}>e mais {fila.resto}.</Text> : null}
        </View>
      ) : null}
      <View style={styles.badges}>
        {s.status === 'PLAYING' ? <Button testID={`radio-pause-${s.guildId}`} label="Pausar" variant="ghost" onPress={() => act('pause')} style={styles.smallBtn} /> : null}
        {s.status === 'PAUSED' ? <Button testID={`radio-resume-${s.guildId}`} label="Retomar" variant="ghost" onPress={() => act('resume')} style={styles.smallBtn} /> : null}
        {podePular(s) ? <Button testID={`radio-skip-${s.guildId}`} label="Pular" variant="ghost" onPress={() => act('skip')} style={styles.smallBtn} /> : null}
        {s.status !== 'STOPPED' ? (
          <Button
            testID={`radio-stop-${s.guildId}`}
            label="Parar música"
            variant="ghost"
            onPress={() => confirmAction('Parar a música?', 'A fila será limpa. A Yui continua na call.', () => act('stop'), 'Parar')}
            style={styles.smallBtn}
          />
        ) : null}
        <Button
          testID={`radio-leave-${s.guildId}`}
          label="Tirar da call"
          variant="ghost"
          onPress={() => confirmAction('Tirar a Yui da call?', 'Encerra o Modo Rádio neste servidor.', () => act('leave'), 'Encerrar')}
          style={styles.smallBtn}
        />
      </View>
      {info ? <Text style={styles.ok}>{info}</Text> : null}
      {msg ? <Text style={styles.error}>{msg}</Text> : null}
      <Tocar client={client} guildId={s.guildId} onDone={reload} />
    </Card>
  );
}

/**
 * Iniciar o rádio SEM ninguém na call: escolher o servidor (os que ainda não têm rádio), o canal de voz e o de texto (só os em que a Yui pode entrar e
 * falar / escrever) e, se quiser, já um gênero ou uma música. O servidor confere tudo de novo.
 */
function IniciarRadio({ client, sessions, onStarted }: { client: YuiClient; sessions: RadioSession[]; onStarted: () => Promise<void> }) {
  const [aberto, setAberto] = useState(false);
  const [guilds, setGuilds] = useState<AdminGuild[] | null>(null);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [canais, setCanais] = useState<RadioCanais | null>(null);
  const [voz, setVoz] = useState<string | null>(null);
  const [texto, setTexto] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [opcoes, setOpcoes] = useState<RadioFaixa[] | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!aberto || guilds) return;
    client.admin.guilds().then(setGuilds).catch((e) => setErro(errText(e)));
  }, [aberto, guilds, client]);

  useEffect(() => {
    setCanais(null);
    setVoz(null);
    setTexto(null);
    setOpcoes(null);
    if (!guildId) return;
    let vivo = true;
    client.admin.radioCanais(guildId).then((c) => { if (vivo) setCanais(c); }).catch((e) => { if (vivo) setErro(errText(e)); });
    return () => { vivo = false; };
  }, [guildId, client]);

  const escolha = canaisParaEscolher(canais);
  const servidores = servidoresParaIniciar(guilds, sessions);

  async function iniciar() {
    if (!guildId || !podeIniciar(canais, voz, texto)) return;
    const busca = q.trim() ? buscaValida(q) : null;
    if (q.trim() && !busca) { setErro(TEXTO_BUSCA_INVALIDA); return; }
    setBusy(true);
    setErro(null);
    setInfo(null);
    try {
      const r = await client.admin.radioIniciar(guildId, { voiceChannelId: voz as string, textChannelId: texto as string });
      setInfo(textoDoResultado(r));
      // o gênero ou a música vão num pedido à parte (entrar na call e buscar, juntos, podem passar do prazo entre o cérebro e o bot)
      if (busca) {
        const t = await client.admin.radioTocar(guildId, busca);
        setOpcoes(t.resultado === 'escolher' ? t.opcoes ?? [] : null);
        setInfo(`${textoDoResultado(r)} ${textoDoResultado(t)}`.trim());
      }
      setQ('');
      await onStarted();
    } catch (e) {
      setErro(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function escolher(i: number) {
    if (!guildId) return;
    setBusy(true);
    setErro(null);
    try {
      const r = await client.admin.radioEscolher(guildId, i);
      setOpcoes(null);
      setInfo(textoDoResultado(r) || null);
      await onStarted();
    } catch (e) {
      setErro(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!aberto) return <Button testID="radio-iniciar-abrir" label="Iniciar o rádio num servidor" variant="ghost" icon="add" onPress={() => setAberto(true)} />;
  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>Iniciar o rádio</Text>
        <Button label="Fechar" variant="ghost" compact onPress={() => setAberto(false)} />
      </View>
      <Text style={styles.hint}>Ninguém precisa estar na call: a Yui entra no canal escolhido e espera alguém chegar por até 10 minutos.</Text>
      {!guilds && !erro ? <ActivityIndicator color={colors.accent} /> : null}
      {guilds && !servidores.length ? <Text style={styles.hint}>Todos os servidores já estão com o rádio ligado.</Text> : null}
      <View style={styles.badges}>
        {servidores.map((g) => <Chip key={g.id} testID={`radio-servidor-${g.id}`} label={g.name} on={guildId === g.id} onPress={() => setGuildId(g.id)} />)}
      </View>
      {guildId && !canais && !erro ? <ActivityIndicator color={colors.accent} /> : null}
      {canais ? (
        <>
          <Text style={styles.label}>Canal de voz</Text>
          {escolha.voz.length ? (
            <View style={styles.badges}>{escolha.voz.map((c) => <Chip key={c.id} testID={`radio-voz-${c.id}`} label={c.rotulo} on={voz === c.id} onPress={() => setVoz(c.id)} />)}</View>
          ) : <Text style={styles.hint}>Nenhum canal de voz em que a Yui possa entrar e falar.</Text>}
          <Text style={styles.label}>Canal de texto (onde fica o painel do rádio)</Text>
          {escolha.texto.length ? (
            <View style={styles.badges}>{escolha.texto.map((c) => <Chip key={c.id} testID={`radio-texto-${c.id}`} label={c.rotulo} on={texto === c.id} onPress={() => setTexto(c.id)} />)}</View>
          ) : <Text style={styles.hint}>Nenhum canal de texto em que a Yui possa escrever.</Text>}
          {escolha.indisponiveis ? <Text style={styles.hint}>{escolha.indisponiveis}</Text> : null}
          <TextInput
            testID="radio-iniciar-busca"
            style={styles.input}
            value={q}
            onChangeText={setQ}
            placeholder="Gênero, música ou link (opcional)"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button testID="radio-iniciar" label="Iniciar" onPress={iniciar} loading={busy} disabled={!podeIniciar(canais, voz, texto)} />
        </>
      ) : null}
      {opcoes ? <OpcoesDaBusca opcoes={opcoes} busy={busy} testID="radio-iniciar-opcao" onEscolher={escolher} /> : null}
      {info ? <Text style={styles.ok}>{info}</Text> : null}
      {erro ? <Text style={styles.error}>{erro}</Text> : null}
    </Card>
  );
}

/** Sessões do Modo Rádio (e iniciar, pular, tocar e ver a fila). Atualiza sozinho a cada 10 segundos. */
export function Radio({ client }: { client: YuiClient }) {
  const [data, setData] = useState<RadioSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await client.admin.radio());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [client]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (error && !data) return <Text testID="admin-error" style={styles.error}>{error}</Text>;
  if (!data) return <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />;
  return (
    <View style={styles.section}>
      <SectionHeading title="Modo Rádio" right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} />} />
      <Text style={styles.hint}>Servidores em que o Modo Rádio está ativo: pause, pule, peça um gênero ou uma música e veja a fila. Dá para iniciar mesmo sem ninguém na call. A tela atualiza sozinha.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <IniciarRadio client={client} sessions={data} onStarted={reload} />
      {data.length === 0 ? <StateView testID="radio-empty" kind="empty" title="Nenhuma sessão de rádio ativa." /> : null}
      {data.map((s) => (
        <SessionCard key={s.guildId} s={s} client={client} reload={reload} />
      ))}
    </View>
  );
}

const LEVEL_COLOR: Record<string, string> = { error: colors.danger, warn: colors.warning, info: colors.muted, debug: colors.muted };
const LEVELS: { level: LogLevel | null; label: string }[] = [
  { level: null, label: 'Todos' },
  { level: 'error', label: 'Erros' },
  { level: 'warn', label: 'Avisos' },
  { level: 'info', label: 'Info' },
];

/** Últimas linhas dos logs, com filtros. Só leitura; segredos já vêm mascarados do servidor. */
export function Logs({ client }: { client: YuiClient }) {
  const [kind, setKind] = useState<LogKind>('app');
  const [level, setLevel] = useState<LogLevel | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<LogsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await client.admin.logs({ kind, level, date, q: search, limit: 200 });
      if (mine === seq.current) { setData(res); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError(errText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [client, kind, level, date, search]);

  useEffect(() => {
    load();
  }, [load]);

  const dates = [...new Set((data?.files ?? []).filter((f) => f.kind === kind).map((f) => f.date))].slice(0, 7);

  return (
    <View style={styles.section}>
      <Text style={styles.hint}>Últimas linhas dos logs da Yui, só para leitura. Chaves e senhas aparecem mascaradas (••••).</Text>
      <View style={styles.badges}>
        <Chip testID="logs-kind-app" label="Geral" on={kind === 'app'} onPress={() => { setKind('app'); setDate(null); }} />
        <Chip testID="logs-kind-error" label="Só erros (arquivo)" on={kind === 'error'} onPress={() => { setKind('error'); setDate(null); }} />
      </View>
      <View style={styles.badges}>
        {LEVELS.map((l) => (
          <Chip key={l.label} testID={`logs-level-${l.level ?? 'all'}`} label={l.label} on={level === l.level} onPress={() => setLevel(l.level)} />
        ))}
      </View>
      {dates.length > 1 ? (
        <View style={styles.badges}>
          {dates.map((d, i) => (
            <Chip key={d} label={i === 0 && !date ? `${d} (hoje)` : d} on={(date ?? dates[0]) === d} onPress={() => setDate(i === 0 ? null : d)} />
          ))}
        </View>
      ) : null}
      <View style={styles.formRow}>
        <TextInput
          testID="logs-search"
          style={[styles.input, { flex: 1 }]}
          value={q}
          onChangeText={setQ}
          placeholder="Buscar no texto…"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => setSearch(q.trim())}
        />
        <Button testID="logs-search-btn" label="Buscar" onPress={() => setSearch(q.trim())} style={styles.smallBtn} />
        <Button label="Atualizar" variant="ghost" compact onPress={load} loading={loading} style={styles.smallBtn} />
      </View>
      {error ? <Text testID="admin-error" style={styles.error}>{error}</Text> : null}
      {data ? (
        <>
          <Text style={styles.hint}>
            {data.file ? `${data.file} • ${data.entries.length} linha(s)${data.truncated ? ' (mostrando as mais recentes)' : ''}` : 'Nenhum arquivo de log encontrado.'}
          </Text>
          <Card style={styles.logCard}>
            {data.entries.length === 0 ? <Text style={styles.hint}>Nada para mostrar com esses filtros.</Text> : null}
            {data.entries.map((e, i) => (
              <View key={`${e.time}-${i}`} style={styles.logRow}>
                <Text style={styles.logMeta} numberOfLines={1}>
                  {horaDoLog(e.time)} <Text style={{ color: LEVEL_COLOR[e.level] ?? colors.muted, fontWeight: '700' }}>{e.level.toUpperCase()}</Text>
                </Text>
                <Text selectable style={[styles.logText, e.level === 'error' && { color: colors.danger }]}>{e.text}</Text>
              </View>
            ))}
          </Card>
        </>
      ) : loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />
      ) : null}
    </View>
  );
}

/** Só HH:MM:SS (a data já é escolhida no filtro); sem hora legível, o texto original. */
const horaDoLog = (t: string) => /(\d{2}:\d{2}:\d{2})/.exec(t)?.[1] ?? t;

const MONO = Platform.select({ web: "ui-monospace, 'Cascadia Mono', Consolas, monospace", default: undefined });

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  ok: { color: colors.success, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  smallBtn: { minHeight: 44, paddingHorizontal: spacing.md },
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
  logCard: { padding: spacing.md, gap: 0 },
  logRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 2 },
  logMeta: { color: colors.muted, fontSize: 12, fontFamily: MONO, flexShrink: 0 },
  logText: { color: colors.text, fontSize: 12, lineHeight: 17, fontFamily: MONO },
});
