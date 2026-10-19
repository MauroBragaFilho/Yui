import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiError,
  type AdminBans,
  type AdminGuild,
  type AdminGuildDetail,
  type IntegrationGroup,
  type IntegrationStatus,
  type AdminMemoryMeta,
  type AdminMemoryUser,
  type AdminOverview,
  type AdminTool,
  type AuditEvent,
  type AutomodMode,
  type BanType,
  type GatewayStatus,
  type YuiClient,
} from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { AiProviders } from './AdminAi.tsx';
import { GuildEditor } from './AdminGuild.tsx';
import { Logs, Radio } from './AdminOps.tsx';
import { Badge, Button, Card, Chip, PageHeader } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient };
type Section = 'geral' | 'integracoes' | 'servidores' | 'radio' | 'logs' | 'bans' | 'memoria' | 'ia' | 'auditoria' | 'ferramentas';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'geral', label: 'Geral' },
  { key: 'integracoes', label: 'Integrações' },
  { key: 'servidores', label: 'Servidores' },
  { key: 'radio', label: 'Rádio' },
  { key: 'bans', label: 'Bans' },
  { key: 'memoria', label: 'Memória' },
  { key: 'ia', label: 'IA' },
  { key: 'auditoria', label: 'Auditoria' },
  { key: 'logs', label: 'Logs' },
  { key: 'ferramentas', label: 'Ferramentas' },
];

const AUTOMOD: { mode: AutomodMode; label: string }[] = [
  { mode: 'off', label: 'Desligado' },
  { mode: 'trigger', label: 'Gatilhos' },
  { mode: 'mcp', label: 'IA' },
  { mode: 'both', label: 'Ambos' },
];

// ───────────────────────── utilidades ─────────────────────────

const errText = (e: unknown, fallback = 'Algo deu errado.') => (e instanceof ApiError ? e.message : fallback);

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

function formatWhen(value: number | string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Carrega dados de uma seção, com erro e recarga. */
function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

function Status({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.lg }} />;
  if (error) return <Text testID="admin-error" style={styles.error}>{error}</Text>;
  return null;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

// ───────────────────────── seções ─────────────────────────

/** Pede para a Yui mandar uma mensagem privada para o dono no Discord. */
function DmCard({ client }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      await client.admin.sendDiscordDm(text.trim());
      setText('');
      setMsg({ text: 'Mensagem enviada. Veja suas mensagens privadas no Discord.', ok: true });
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={styles.card}>
      <Text style={styles.cardTitle}>Mensagem no meu Discord</Text>
      <Text style={styles.hint}>A Yui te manda uma mensagem privada (fora de servidores). Deixe em branco para enviar um teste. Limite: 5 a cada 10 minutos.</Text>
      <TextInput testID="dm-text" style={styles.input} value={text} onChangeText={setText} placeholder="Mensagem (opcional)" placeholderTextColor={colors.muted} maxLength={1500} multiline />
      <Button testID="btn-dm" label="Enviar para o meu Discord" onPress={send} loading={busy} />
      {msg ? <Text style={msg.ok ? { color: colors.success, fontSize: 13 } : styles.error}>{msg.text}</Text> : null}
    </Card>
  );
}

function Geral({ client }: Props) {
  const { data, error, loading, reload } = useLoad<AdminOverview>(() => client.admin.overview());
  const [msg, setMsg] = useState<string | null>(null);

  function restart() {
    confirmAction(
      'Reiniciar a Yui?',
      'A Yui fica offline por alguns segundos e volta sozinha. Conversas em andamento são interrompidas.',
      async () => {
        try {
          const r = await client.admin.restart();
          setMsg(r.message);
        } catch (e) {
          setMsg(errText(e));
        }
      },
      'Reiniciar'
    );
  }

  return (
    <View style={styles.section}>
      <Status loading={loading} error={error} />
      {data ? (
        <>
          <Card style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Discord</Text>
              <Badge label={data.discord.online ? '● Online' : '● Offline'} color={data.discord.online ? colors.success : colors.danger} />
            </View>
            <Row label="Conta" value={data.discord.tag ?? '—'} />
            <Row label="Servidores" value={String(data.discord.guilds)} />
            <Row label="Tempo ligada" value={formatUptime(data.uptimeSeconds)} />
            <Row label="Memória do processo" value={`${data.memoryMB} MB`} />
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Bloqueios</Text>
            <Row label="Usuários" value={String(data.bans.users)} />
            <Row label="Servidores" value={String(data.bans.guilds)} />
            <Row label="Canais" value={String(data.bans.channels)} />
            <Row label="Usuários com memória" value={data.memoryUsers === null ? '—' : String(data.memoryUsers)} />
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Proteções</Text>
            <View style={styles.badges}>
              <Badge label={data.flags.readOnly ? '🔒 Somente leitura' : '⚠️ Leitura/escrita liberada'} color={data.flags.readOnly ? colors.success : colors.warning} />
              <Badge label={data.flags.memoryEnabled ? 'Memória ativa' : 'Memória desligada'} color={data.flags.memoryEnabled ? colors.success : colors.warning} />
              <Badge label={data.flags.pcToolsEnabled ? 'Ferramentas do PC' : 'Sem ferramentas do PC'} color={data.flags.pcToolsEnabled ? colors.success : colors.muted} />
            </View>
            <Text style={styles.hint}>O modo somente leitura e a senha de entrada só mudam no arquivo .env, nunca por este painel. As chaves de IA você gerencia na aba IA.</Text>
          </Card>

          <DmCard client={client} />

          <Button label="Atualizar" variant="ghost" onPress={reload} />
          <Button testID="btn-restart" label="Reiniciar a Yui" variant="danger" onPress={restart} />
          {msg ? <Text testID="restart-msg" style={styles.hint}>{msg}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const INTEGRATION_STATUS: Record<IntegrationStatus, { label: string; color: string }> = {
  ok: { label: 'Ativa', color: colors.success },
  off: { label: 'Desligada', color: colors.muted },
  missing: { label: 'Falta configurar', color: colors.warning },
};

/** Estado de cada integração (somente leitura: chaves e ligações só mudam no .env). */
function Integracoes({ client }: Props) {
  const { data, error, loading, reload } = useLoad<IntegrationGroup[]>(() => client.admin.integrations());
  return (
    <View style={styles.section}>
      <Status loading={loading} error={error} />
      {data ? (
        <>
          <Text style={styles.hint}>Mostra o que está configurado e ligado, sem expor chaves. Para mudar, edite o arquivo .env e reinicie a Yui.</Text>
          {data.map((g) => (
            <Card key={g.title} style={styles.card}>
              <Text style={styles.cardTitle}>{g.title}</Text>
              {g.items.map((i) => (
                <View key={i.key} testID={`integration-${i.key}`} style={styles.integration}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.value}>{i.name}</Text>
                    <Badge label={INTEGRATION_STATUS[i.status].label} color={INTEGRATION_STATUS[i.status].color} />
                  </View>
                  {i.detail ? <Text style={styles.hint}>{i.detail}</Text> : null}
                </View>
              ))}
            </Card>
          ))}
          <Button label="Atualizar" variant="ghost" onPress={reload} />
        </>
      ) : null}
    </View>
  );
}

/** Canais, avisos sociais e ferramentas de um servidor (com edição). */
function GuildDetail({ client, id }: { client: YuiClient; id: string }) {
  const { data, error, loading, reload } = useLoad<AdminGuildDetail>(() => client.admin.guildDetail(id));
  if (!data) return <Status loading={loading} error={error} />;
  return <GuildEditor client={client} data={data} reload={reload} />;
}

function Servidores({ client }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, setData } = useLoad<AdminGuild[]>(() => client.admin.guilds());
  const [err, setErr] = useState<string | null>(null);

  async function setMode(g: AdminGuild, mode: AutomodMode) {
    setErr(null);
    try {
      await client.admin.setAutomod(g.id, mode);
      setData((list) => (list ? list.map((x) => (x.id === g.id ? { ...x, automod: mode } : x)) : list));
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <View style={styles.section}>
      <Status loading={loading} error={error} />
      {err ? <Text style={styles.error}>{err}</Text> : null}
      {data?.length === 0 ? <Text style={styles.hint}>A Yui não está em nenhum servidor.</Text> : null}
      {data?.map((g) => (
        <Card key={g.id} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>{g.name}</Text>
            <Badge label={g.tosAccepted ? 'TOS aceito' : 'TOS pendente'} color={g.tosAccepted ? colors.success : colors.warning} />
          </View>
          <Text style={styles.hint}>ID {g.id}{g.members !== null ? ` • ${g.members} membros` : ''}</Text>
          <Button
            testID={`guild-detail-${g.id}`}
            label={open === g.id ? 'Ocultar detalhes' : 'Ver detalhes'}
            variant="ghost"
            onPress={() => setOpen(open === g.id ? null : g.id)}
            style={styles.smallBtn}
          />
          {open === g.id ? <GuildDetail client={client} id={g.id} /> : null}
          <Text style={styles.label}>AutoMod</Text>
          <View style={styles.chips}>
            {AUTOMOD.map((o) => (
              <Pressable
                key={o.mode}
                testID={`automod-${g.id}-${o.mode}`}
                onPress={() => setMode(g, o.mode)}
                style={[styles.chip, g.automod === o.mode && styles.chipOn]}
              >
                <Text style={[styles.chipText, g.automod === o.mode && styles.chipTextOn]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      ))}
    </View>
  );
}

const BAN_TYPES: { type: BanType; label: string }[] = [
  { type: 'user', label: 'Usuário' },
  { type: 'guild', label: 'Servidor' },
  { type: 'channel', label: 'Canal' },
];

function Bans({ client }: Props) {
  const { data, error, loading, reload } = useLoad<AdminBans>(() => client.admin.bans());
  const [type, setType] = useState<BanType>('user');
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setErr(null);
    try {
      await client.admin.addBan(type, id.trim(), reason.trim());
      setId('');
      setReason('');
      await reload();
    } catch (e) {
      setErr(errText(e));
    }
  }

  function remove(t: BanType, target: string) {
    confirmAction('Remover banimento?', `ID ${target}`, async () => {
      try {
        await client.admin.removeBan(t, target);
        await reload();
      } catch (e) {
        setErr(errText(e));
      }
    });
  }

  const lists: { type: BanType; title: string; items: AdminBans['users'] }[] = data
    ? [
        { type: 'user', title: 'Usuários', items: data.users },
        { type: 'guild', title: 'Servidores', items: data.guilds },
        { type: 'channel', title: 'Canais', items: data.channels },
      ]
    : [];

  return (
    <View style={styles.section}>
      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Novo banimento</Text>
        <View style={styles.chips}>
          {BAN_TYPES.map((o) => (
            <Pressable key={o.type} testID={`ban-type-${o.type}`} onPress={() => setType(o.type)} style={[styles.chip, type === o.type && styles.chipOn]}>
              <Text style={[styles.chipText, type === o.type && styles.chipTextOn]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput testID="ban-id" style={styles.input} value={id} onChangeText={setId} placeholder="ID (somente números)" placeholderTextColor={colors.muted} keyboardType="number-pad" />
        <TextInput testID="ban-reason" style={styles.input} value={reason} onChangeText={setReason} placeholder="Motivo (opcional)" placeholderTextColor={colors.muted} maxLength={200} />
        {err ? <Text testID="ban-error" style={styles.error}>{err}</Text> : null}
        <Button testID="btn-ban" label="Banir" variant="danger" onPress={add} disabled={!id.trim()} />
      </Card>

      <Status loading={loading} error={error} />
      {lists.map((l) => (
        <View key={l.type} style={{ gap: spacing.sm }}>
          <Text style={styles.sectionTitle}>{l.title} ({l.items.length})</Text>
          {l.items.length === 0 ? <Text style={styles.hint}>Nenhum.</Text> : null}
          {l.items.map((b) => (
            <Card key={b.id} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text selectable style={styles.value}>{b.id}</Text>
                <Button label="Remover" variant="ghost" onPress={() => remove(l.type, b.id)} style={styles.smallBtn} />
              </View>
              <Text style={styles.hint}>{b.reason || 'Sem motivo'} • {formatWhen(b.timestamp)}</Text>
            </Card>
          ))}
        </View>
      ))}
    </View>
  );
}

function Memoria({ client }: Props) {
  const { data, error, loading, reload } = useLoad<{ users: AdminMemoryUser[]; total: number }>(() => client.admin.memoryUsers());
  const [open, setOpen] = useState<string | null>(null);
  const [metas, setMetas] = useState<AdminMemoryMeta[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function inspect(userId: string) {
    setErr(null);
    if (open === userId) return setOpen(null);
    try {
      setMetas(await client.admin.memoryInspect(userId));
      setOpen(userId);
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function forgetOne(userId: string, id: number) {
    try {
      await client.admin.memoryForget(userId, id);
      setMetas((m) => m.filter((x) => x.id !== id));
      await reload();
    } catch (e) {
      setErr(errText(e));
    }
  }

  function forgetAll(userId: string) {
    confirmAction('Apagar toda a memória deste usuário?', `ID ${userId}. Não dá para desfazer.`, async () => {
      try {
        await client.admin.memoryForgetUser(userId);
        setOpen(null);
        await reload();
      } catch (e) {
        setErr(errText(e));
      }
    }, 'Apagar');
  }

  return (
    <View style={styles.section}>
      <Text style={styles.hint}>Por privacidade, o painel mostra só metadados (quantidade, datas, tamanho). O conteúdo das lembranças não é exibido.</Text>
      <Status loading={loading} error={error} />
      {err ? <Text style={styles.error}>{err}</Text> : null}
      {data?.users.length === 0 ? <Text style={styles.hint}>Nenhum usuário com memória no momento.</Text> : null}
      {data?.users.map((u) => (
        <Card key={u.userId} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text selectable style={styles.value}>{u.userId}</Text>
            <Badge label={`${u.count} lembrança(s)`} color={colors.muted} />
          </View>
          <Text style={styles.hint}>Última interação {formatWhen(u.lastSeen)} • expira {formatWhen(u.expiresAt)}</Text>
          <View style={styles.rowGap}>
            <Button testID={`mem-open-${u.userId}`} label={open === u.userId ? 'Ocultar' : 'Ver detalhes'} variant="ghost" onPress={() => inspect(u.userId)} style={styles.smallBtn} />
            <Button label="Apagar tudo" variant="ghost" onPress={() => forgetAll(u.userId)} style={styles.smallBtn} />
          </View>
          {open === u.userId
            ? metas.map((m) => (
                <View key={m.id} style={styles.metaRow}>
                  <Text style={styles.hint}>
                    #{m.id} • {m.type} • {m.chars} caracteres • origem {m.source || '—'} • expira {formatWhen(m.expiresAt)}
                  </Text>
                  <Button label="Apagar" variant="ghost" onPress={() => forgetOne(u.userId, m.id)} style={styles.smallBtn} />
                </View>
              ))
            : null}
        </Card>
      ))}
    </View>
  );
}

function Ia({ client }: Props) {
  const { data, error, loading, reload } = useLoad<GatewayStatus>(() => client.admin.gateway());
  const [msg, setMsg] = useState<string | null>(null);

  function reset() {
    confirmAction('Zerar os descansos?', 'Todos os provedores voltam a ser tentados agora, mesmo os que estavam descansando por erro ou falta de crédito.', async () => {
      try {
        await client.admin.gatewayReset();
        setMsg('Descansos zerados.');
        await reload();
      } catch (e) {
        setMsg(errText(e));
      }
    }, 'Zerar');
  }

  return (
    <View style={styles.section}>
      <AiProviders client={client} onChanged={reload} />
      <Text style={styles.sectionTitle}>Saúde do Yui Gateway</Text>
      <Text style={styles.hint}>O Yui Gateway tenta os provedores abaixo em ordem e passa para o próximo se um falhar. Aparece logo depois do LM Studio na cadeia da Yui.</Text>
      <Status loading={loading} error={error} />
      {data ? (
        <>
          <Card style={styles.card}>
            <Row label="Requisições" value={String(data.totals.requests)} />
            <Row label="Com sucesso" value={String(data.totals.ok)} />
            <Row label="Falharam" value={String(data.totals.failed)} />
          </Card>
          {data.providers.length === 0 ? <Text style={styles.hint}>Nenhum provedor configurado (chaves no .env).</Text> : null}
          {data.providers.map((p) => (
            <Card key={p.id} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{p.label}</Text>
                <Badge label={p.anonymous ? 'anônimo' : `${p.keys} chave(s)`} color={p.anonymous ? colors.warning : colors.muted} />
              </View>
              {p.cooldownSeconds > 0 ? <Text style={styles.hint}>Provedor descansando por mais {p.cooldownSeconds}s</Text> : null}
              {p.keysCoolingDown > 0 ? <Text style={styles.hint}>{p.keysCoolingDown} chave(s) em descanso</Text> : null}
              {p.targets.map((t) => (
                <View key={t.id} style={styles.metaRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.value}>{t.model}</Text>
                    <Text style={styles.hint}>{t.tier} • ok {t.ok} • falhas {t.fail}{t.lastError ? ` • ${t.lastError.replace(/\s+/g, ' ').slice(0, 70)}` : ''}</Text>
                  </View>
                  <Badge label={t.available ? 'Disponível' : `Descansa ${t.cooldownSeconds}s`} color={t.available ? colors.success : colors.warning} />
                </View>
              ))}
            </Card>
          ))}
          <Button label="Atualizar" variant="ghost" onPress={reload} />
          <Button testID="btn-gateway-reset" label="Zerar descansos" variant="ghost" onPress={reset} />
          {msg ? <Text style={styles.hint}>{msg}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

function Auditoria({ client }: Props) {
  const { data, error, loading, reload } = useLoad<AuditEvent[]>(() => client.admin.audit(100));
  return (
    <View style={styles.section}>
      <Status loading={loading} error={error} />
      <Button label="Atualizar" variant="ghost" onPress={reload} />
      {data?.length === 0 ? <Text style={styles.hint}>Sem eventos.</Text> : null}
      {data?.map((e, i) => {
        const detail = String((e.tool ?? e.target ?? e.guild ?? e.type ?? '') || '');
        return (
          <View key={`${e.ts}-${i}`} style={styles.audit}>
            <Text style={styles.auditEvent}>{e.event}{detail ? ` · ${detail}` : ''}</Text>
            <Text style={styles.hint}>{formatWhen(e.ts)}{e.userId ? ` • ${e.userId}` : ''}{e.role ? ` • ${e.role}` : ''}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Ferramentas({ client }: Props) {
  const { data, error, loading } = useLoad<{ readOnly: boolean; tools: AdminTool[] }>(() => client.admin.tools());
  return (
    <View style={styles.section}>
      <Status loading={loading} error={error} />
      {data ? (
        <>
          <Badge label={data.readOnly ? '🔒 Modo somente leitura ligado' : '⚠️ Modo somente leitura desligado'} color={data.readOnly ? colors.success : colors.warning} />
          <Text style={styles.hint}>Estas são as únicas ferramentas que a Yui pode usar. A liberação depende do arquivo .env e não pode ser alterada por aqui.</Text>
          {data.tools.length === 0 ? <Text style={styles.hint}>Nenhuma ferramenta registrada.</Text> : null}
          {data.tools.map((t) => (
            <Card key={t.name} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{t.name}</Text>
                <Badge label={t.allowed ? 'Liberada' : 'Bloqueada'} color={t.allowed ? colors.success : colors.danger} />
              </View>
              <Text style={styles.hint}>{t.description}</Text>
              <View style={styles.badges}>
                <Badge label={`acesso: ${t.access}`} color={colors.muted} />
                {t.confirm ? <Badge label="pede confirmação" color={colors.warning} /> : null}
              </View>
              {!t.allowed && t.reason ? <Text style={styles.hint}>{t.reason}</Text> : null}
            </Card>
          ))}
        </>
      ) : null}
    </View>
  );
}

// ───────────────────────── tela ─────────────────────────

export function AdminScreen({ client }: Props) {
  const [section, setSection] = useState<Section>('geral');
  return (
    <View style={styles.root}>
      <PageHeader title="Administração" subtitle="Servidores, memória, IA e auditoria" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
        {SECTIONS.map((s) => (
          <Chip key={s.key} testID={`admin-tab-${s.key}`} label={s.label} on={section === s.key} onPress={() => setSection(s.key)} />
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={styles.content}>
        {section === 'geral' ? <Geral client={client} /> : null}
        {section === 'integracoes' ? <Integracoes client={client} /> : null}
        {section === 'servidores' ? <Servidores client={client} /> : null}
        {section === 'radio' ? <Radio client={client} /> : null}
        {section === 'logs' ? <Logs client={client} /> : null}
        {section === 'bans' ? <Bans client={client} /> : null}
        {section === 'memoria' ? <Memoria client={client} /> : null}
        {section === 'ia' ? <Ia client={client} /> : null}
        {section === 'auditoria' ? <Auditoria client={client} /> : null}
        {section === 'ferramentas' ? <Ferramentas client={client} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabsScroll: { flexGrow: 0, flexShrink: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  tabs: { gap: spacing.sm, padding: spacing.md },
  content: { padding: spacing.lg, width: '100%', maxWidth: 860, alignSelf: 'center' },
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: spacing.sm },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  rowGap: { flexDirection: 'row', gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.accentLight, borderColor: 'transparent' },
  chipText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  chipTextOn: { color: colors.accentText },
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
  integration: { gap: 2, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  detail: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  smallBtn: { minHeight: 36, paddingHorizontal: spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  audit: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: spacing.sm, gap: 2 },
  auditEvent: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
