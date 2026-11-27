import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import {
  ApiError,
  type AdminBans,
  type AdminGuild,
  type AdminGuildDetail,
  type IntegrationGroup,
  type IntegrationStatus,
  type AdminMemoryList,
  type AdminMemoryMeta,
  type AdminOverview,
  type AdminTool,
  type AuditEvent,
  type AutomodMode,
  type BanType,
  type GatewayStatus,
  type YuiClient,
} from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { confirmacaoDeReinicio } from '../restartLogic.ts';
import { avisoDeRecarga } from '../guildLogic.ts';
import { AiProviders } from './AdminAi.tsx';
import { ConfigPainel } from './AdminConfig.tsx';
import { GuildEditor } from './AdminGuild.tsx';
import { Logs, Radio } from './AdminOps.tsx';
import { Badge, Button, Card, Chip, PageHeader, SectionHeading, StateView } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient };
type Section = 'config' | 'geral' | 'integracoes' | 'servidores' | 'radio' | 'logs' | 'bans' | 'memoria' | 'ia' | 'auditoria' | 'ferramentas';

const GROUPS: { title: string; sections: { key: Section; label: string }[] }[] = [
  {
    title: 'Operação',
    sections: [
      { key: 'geral', label: 'Geral' },
      { key: 'servidores', label: 'Servidores' },
      { key: 'radio', label: 'Rádio' },
      { key: 'bans', label: 'Bans' },
    ],
  },
  {
    title: 'IA e memória',
    sections: [
      { key: 'config', label: 'Configuração e chaves' },
      { key: 'ia', label: 'IA' },
      { key: 'memoria', label: 'Memória' },
      { key: 'integracoes', label: 'Integrações' },
    ],
  },
  {
    title: 'Segurança e registros',
    sections: [
      { key: 'ferramentas', label: 'Ferramentas' },
      { key: 'auditoria', label: 'Auditoria' },
      { key: 'logs', label: 'Logs' },
    ],
  },
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
  if (loading) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" testID="admin-error" message={error} />;
  return null;
}

const capital = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

const AUDIT_ACTIONS: Record<string, string> = {
  login: 'Entrou no painel', logout: 'Saiu do painel',
  'admin.guild.tool': 'Mudou uma ferramenta do servidor', 'admin.guild.tools.reset': 'Restaurou as ferramentas do servidor',
  'admin.guild.tos.accept': 'Aceitou os termos pelo painel', 'admin.guild.tos.revoke': 'Revogou o aceite dos termos',
  'admin.guild.persona': 'Mudou a persona de um canal', 'admin.guild.persona.reset': 'Restaurou a persona de um canal',
  'admin.guild.chatter': 'Mudou as falas espontâneas', 'admin.guild.mentions': 'Mudou a resposta a @everyone',
  'admin.guild.channel': 'Mudou um canal do servidor',
};
const auditAction = (event: string) => AUDIT_ACTIONS[event] ?? capital(String(event ?? '').replace(/[_.-]+/g, ' ').trim());
const ROLE_LABEL: Record<string, string> = { OWNER: 'Dono', MEMBER: 'Membro' };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? capital(String(role).toLowerCase());
const ACCESS_LABEL: Record<string, string> = { OWNER: 'Dono', MEMBER: 'Membro' };
const accessLabel = (a: string) => ACCESS_LABEL[a] ?? capital(String(a).toLowerCase());
const TIER_LABEL: Record<string, string> = { free: 'Gratuito' };
const tierLabel = (t: string) => TIER_LABEL[t] ?? t;
const toolTitle = (name: string) => capital(name.replace(/_/g, ' '));

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
function DmCard({ client, limits }: Props & { limits?: AdminOverview['limits'] }) {
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
      <Text style={styles.hint}>A Yui te manda uma mensagem privada (fora de servidores). Deixe em branco para enviar um teste.{limits ? ` Limite: ${limits.dmMax} a cada ${limits.dmWindowMinutes} minutos.` : ''}</Text>
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
    // O texto diz a verdade sobre o que reinicia: com o cérebro separado são os DOIS (cérebro e bot); no processo único, a Yui inteira.
    const c = confirmacaoDeReinicio(data);
    confirmAction(
      c.titulo,
      c.mensagem,
      async () => {
        try {
          const r = await client.admin.restart();
          setMsg(r.message);
        } catch (e) {
          // 503/409/504: o servidor diz que NADA foi reiniciado e por quê; a mensagem dele é mostrada como veio.
          setMsg(errText(e));
        }
      },
      c.sim
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
            <Row label={data.cerebro ? 'RAM do cérebro' : 'RAM da Yui'} value={`${data.memoryMB} MB`} />
            <Row label="Outras pessoas com memória" value={data.memoryUsers === null ? '—' : String(data.memoryUsers)} />
            <Text style={styles.hint}>"Outras pessoas" não conta a sua memória pessoal, que fica na aba Memória.</Text>
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Bloqueios</Text>
            <Row label="Usuários" value={String(data.bans.users)} />
            <Row label="Servidores" value={String(data.bans.guilds)} />
            <Row label="Canais" value={String(data.bans.channels)} />
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Proteções</Text>
            <View style={styles.badges}>
              <Badge label={data.flags.readOnly ? 'Somente leitura' : 'Leitura e escrita liberadas'} color={data.flags.readOnly ? colors.success : colors.warning} />
              <Badge label={data.flags.memoryEnabled ? 'Memória ativa' : 'Memória desligada'} color={data.flags.memoryEnabled ? colors.success : colors.warning} />
              <Badge label={data.flags.pcToolsEnabled ? 'Ferramentas do PC' : 'Sem ferramentas do PC'} color={data.flags.pcToolsEnabled ? colors.success : colors.muted} />
            </View>
            <Text style={styles.hint}>O modo somente leitura e a senha de entrada só mudam no arquivo .env, nunca por este painel. As chaves de IA você gerencia em Configuração e chaves.</Text>
          </Card>

          <DmCard client={client} limits={data?.limits} />

          <View style={styles.actionsRow}>
            <Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} />
            <Button testID="btn-restart" label="Reiniciar a Yui" variant="danger" onPress={restart} style={{ marginLeft: 'auto' }} />
          </View>
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
      <SectionHeading title="Integrações" right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} />} />
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
        </>
      ) : null}
    </View>
  );
}

/** Canais, avisos sociais e configurações de um servidor (com edição). */
function GuildDetail({ client, id, onTosChange }: { client: YuiClient; id: string; onTosChange: (aceito: boolean) => void }) {
  const { data, error, loading, reload } = useLoad<AdminGuildDetail>(() => client.admin.guildDetail(id));
  if (!data) return <Status loading={loading} error={error} />;
  const aviso = avisoDeRecarga(true, error);
  return (
    <>
      {aviso ? <Text accessibilityRole="alert" style={styles.error}>{aviso}</Text> : null}
      <GuildEditor client={client} data={data} reload={reload} onTosChange={onTosChange} />
    </>
  );
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
            <Badge label={g.tosAccepted ? 'Termos aceitos' : 'Termos pendentes'} color={g.tosAccepted ? colors.success : colors.warning} />
          </View>
          <Text style={styles.hint}>ID {g.id}{g.members !== null ? ` • ${g.members} membros` : ''}</Text>
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
          <Button
            testID={`guild-detail-${g.id}`}
            label={open === g.id ? 'Ocultar detalhes' : 'Ver detalhes'}
            variant="ghost"
            onPress={() => setOpen(open === g.id ? null : g.id)}
            style={styles.smallBtn}
          />
          {open === g.id ? (
            <GuildDetail client={client} id={g.id} onTosChange={(aceito) => setData((list) => (list ? list.map((x) => (x.id === g.id ? { ...x, tosAccepted: aceito } : x)) : list))} />
          ) : null}
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
      <SectionHeading title="Bans" right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
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
        <Button testID="btn-ban" label="Banir" variant="danger" compact onPress={add} disabled={!id.trim()} />
      </Card>

      <Status loading={loading} error={error} />
      {lists.map((l) => (
        <View key={l.type} style={{ gap: spacing.sm }}>
          <Text style={styles.sectionTitle}>{l.title} ({l.items.length})</Text>
          {l.items.length === 0 ? <StateView kind="empty" title="Nenhum." /> : null}
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
  const { data, error, loading, reload } = useLoad<AdminMemoryList>(() => client.admin.memoryUsers());
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
      <SectionHeading title="Memória dos usuários" right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
      <Text style={styles.hint}>
        {data?.permanent ? 'A memória dos usuários é permanente: só some se você apagar aqui ou se a própria pessoa pedir para a Yui esquecer.' : 'A memória dos usuários expira por inatividade (MEMORY_RETENTION_DAYS; 0 deixa permanente).'}{' '}
        Como dono, você vê o conteúdo de cada lembrança e pode apagar uma a uma. Cada consulta fica na auditoria.
      </Text>
      <Status loading={loading} error={error} />
      {err ? <Text style={styles.error}>{err}</Text> : null}
      {data?.users.length === 0 ? <Text style={styles.hint}>Nenhum usuário com memória no momento.</Text> : null}
      {data?.users.map((u) => (
        <Card key={u.userId} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text selectable style={styles.value}>{u.name ? `${u.name} · ${u.userId}` : u.userId}</Text>
            <Badge label={`${u.count} lembrança(s)`} color={colors.muted} />
          </View>
          <Text style={styles.hint}>Última interação {formatWhen(u.lastSeen)} • {u.expiresAt ? `expira ${formatWhen(u.expiresAt)}` : 'permanente'}</Text>
          <View style={styles.rowGap}>
            <Button testID={`mem-open-${u.userId}`} label={open === u.userId ? 'Ocultar' : 'Ver detalhes'} variant="ghost" onPress={() => inspect(u.userId)} style={styles.smallBtn} />
            <Button label="Apagar tudo" variant="dangerOutline" compact onPress={() => forgetAll(u.userId)} style={styles.smallBtn} />
          </View>
          {open === u.userId
            ? metas.map((m) => (
                <View key={m.id} style={styles.metaRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text selectable style={styles.value}>{m.content}</Text>
                    <Text style={styles.hint}>
                      #{m.id} • {m.type} • origem {m.source || '—'} • salva {formatWhen(m.createdAt)} • {m.expiresAt ? `expira ${formatWhen(m.expiresAt)}` : 'permanente'}
                    </Text>
                  </View>
                  <Button label="Apagar" variant="ghost" onPress={() => forgetOne(u.userId, m.id)} style={styles.smallBtn} testID={`mem-forget-${m.id}`} />
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
                    <Text style={styles.hint}>{tierLabel(t.tier)} • sucessos {t.ok} · falhas {t.fail}{t.lastError ? ` • ${t.lastError.replace(/\s+/g, ' ').slice(0, 70)}` : ''}</Text>
                  </View>
                  <Badge label={t.available ? 'Disponível' : `Descansa ${t.cooldownSeconds}s`} color={t.available ? colors.success : colors.warning} />
                </View>
              ))}
            </Card>
          ))}
          <Button label="Atualizar" variant="ghost" compact onPress={reload} />
          <Button testID="btn-gateway-reset" label="Zerar descansos" variant="ghost" compact onPress={reset} />
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
      <SectionHeading title="Auditoria" right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
      <Status loading={loading} error={error} />
      {data?.length === 0 ? <StateView kind="empty" title="Sem eventos." /> : null}
      {data?.map((e, i) => {
        const detail = String((e.tool ?? e.target ?? e.guild ?? e.type ?? '') || '');
        return (
          <View key={`${e.ts}-${i}`} style={styles.audit}>
            <Text style={styles.auditEvent}>{auditAction(e.event)}{detail ? ` · ${detail}` : ''}</Text>
            <Text style={styles.hint}>{formatWhen(e.ts)}{e.userId ? ` • ${e.userId}` : ''}{e.role ? ` • ${roleLabel(e.role)}` : ''}</Text>
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
          <Badge label={data.readOnly ? 'Modo somente leitura ligado' : 'Modo somente leitura desligado'} color={data.readOnly ? colors.success : colors.warning} />
          <Text style={styles.hint}>Estas são as únicas ferramentas que a Yui pode usar. A liberação depende do arquivo .env e não pode ser alterada por aqui.</Text>
          {data.tools.length === 0 ? <Text style={styles.hint}>Nenhuma ferramenta registrada.</Text> : null}
          {data.tools.map((t) => (
            <Card key={t.name} style={styles.card}>
              <View style={styles.rowBetween}>
                <View style={styles.toolName}>
                  <Text style={styles.cardTitle}>{toolTitle(t.name)}</Text>
                  <Text style={styles.toolId}>{t.name}</Text>
                </View>
                <Badge label={t.allowed ? 'Liberada' : 'Bloqueada'} color={t.allowed ? colors.success : colors.danger} />
              </View>
              <Text style={styles.hint}>{t.description}</Text>
              <View style={styles.badges}>
                <Badge label={`Acesso: ${accessLabel(t.access)}`} color={colors.muted} />
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
  const { width } = useWindowDimensions();
  const narrow = width < 700;
  const grupoAtual = GROUPS.find((g) => g.sections.some((x) => x.key === section)) ?? GROUPS[0];
  return (
    <View style={styles.root}>
      <PageHeader title="Administração" subtitle="Servidores, memória, IA e auditoria" />
      {narrow ? (
        // Celular: primeiro os três grupos (Operação, IA e memória, Segurança e registros), depois as seções do grupo escolhido.
        // Tudo quebra linha em vez de rolar de lado, então nenhuma seção fica escondida fora da tela.
        <View style={styles.navNarrow}>
          <View style={styles.chips}>
            {GROUPS.map((g) => (
              <Chip key={g.title} testID={`admin-grupo-${g.sections[0].key}`} label={g.title} on={grupoAtual.title === g.title} onPress={() => setSection(g.sections[0].key)} />
            ))}
          </View>
          <View style={styles.navLine} />
          <View style={styles.chips}>
            {grupoAtual.sections.map((x) => (
              <Chip key={x.key} testID={`admin-tab-${x.key}`} label={x.label} on={section === x.key} onPress={() => setSection(x.key)} />
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.nav}>
          {GROUPS.map((g) => (
            <View key={g.title} style={styles.navGroup}>
              <Text style={styles.navTitle}>{g.title}</Text>
              <View style={styles.chips}>
                {g.sections.map((x) => (
                  <Chip key={x.key} testID={`admin-tab-${x.key}`} label={x.label} on={section === x.key} onPress={() => setSection(x.key)} />
                ))}
              </View>
            </View>
          ))}
        </View>
      )}
      <ScrollView contentContainerStyle={styles.content}>
        {section === 'config' ? <ConfigPainel client={client} /> : null}
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
  nav: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.xl, rowGap: spacing.md, padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  navNarrow: { gap: spacing.sm, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  navLine: { height: 1, backgroundColor: colors.border },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  navGroup: { gap: spacing.xs, maxWidth: '100%' },
  navTitle: { color: colors.muted, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, width: '100%', maxWidth: 860, alignSelf: 'center' },
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  sectionTitle: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '700', marginTop: spacing.sm },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  rowGap: { flexDirection: 'row', gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  chipText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  chipTextOn: { color: colors.accentText },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
  toolName: { flexShrink: 1, flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: spacing.sm },
  toolId: { color: colors.muted, fontSize: 11 },
  integration: { gap: 2, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  detail: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  smallBtn: { minHeight: 44, paddingHorizontal: spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  audit: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: spacing.sm, gap: 2 },
  auditEvent: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
