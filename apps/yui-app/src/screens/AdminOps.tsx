import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type LogKind,
  type LogLevel,
  type LogsResult,
  type RadioAction,
  type RadioSession,
  type YuiClient,
} from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, Chip } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');

const STATUS: Record<string, { label: string; color: string }> = {
  PLAYING: { label: 'Tocando', color: colors.success },
  PAUSED: { label: 'Pausada', color: colors.warning },
  BUFFERING: { label: 'Carregando', color: colors.warning },
  STOPPED: { label: 'Parada', color: colors.muted },
};

const MODE_LABEL: Record<string, string> = { OFF: 'desligado', DIRECT: 'direto', IA: 'IA' };

function SessionCard({ s, client, reload }: { s: RadioSession; client: YuiClient; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState<string | null>(null);
  const st = STATUS[s.status] ?? { label: s.status, color: colors.muted };

  async function act(action: RadioAction) {
    setMsg(null);
    try {
      await client.admin.radioAction(s.guildId, action);
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
      <View style={styles.badges}>
        {s.status === 'PLAYING' ? <Button testID={`radio-pause-${s.guildId}`} label="Pausar" variant="ghost" onPress={() => act('pause')} style={styles.smallBtn} /> : null}
        {s.status === 'PAUSED' ? <Button testID={`radio-resume-${s.guildId}`} label="Retomar" variant="ghost" onPress={() => act('resume')} style={styles.smallBtn} /> : null}
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
      {msg ? <Text style={styles.error}>{msg}</Text> : null}
    </Card>
  );
}

/** Sessões do Modo Rádio. Atualiza sozinho a cada 10 segundos. */
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
      <Text style={styles.hint}>Servidores em que o Modo Rádio está ativo. Escolher música e pular faixa continuam no menu do próprio rádio no Discord. A tela atualiza sozinha.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {data.length === 0 ? <Text testID="radio-empty" style={styles.hint}>Nenhuma sessão de rádio ativa.</Text> : null}
      {data.map((s) => (
        <SessionCard key={s.guildId} s={s} client={client} reload={reload} />
      ))}
      <Button label="Atualizar" variant="ghost" onPress={reload} />
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
        <Button label="Atualizar" variant="ghost" onPress={load} loading={loading} style={styles.smallBtn} />
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
                <Text style={styles.logMeta}>
                  {e.time.slice(5)} <Text style={{ color: LEVEL_COLOR[e.level] ?? colors.muted, fontWeight: '700' }}>{e.level.toUpperCase()}</Text>
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

const MONO = Platform.select({ web: "ui-monospace, 'Cascadia Mono', Consolas, monospace", default: undefined });

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
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
  logCard: { padding: spacing.md, gap: 0 },
  logRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 2 },
  logMeta: { color: colors.muted, fontSize: 11, fontFamily: MONO },
  logText: { color: colors.text, fontSize: 12, lineHeight: 17, fontFamily: MONO },
});
