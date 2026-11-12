import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type AdminOverview, type GatewayStatus, type Me, type ReminderView, type YuiClient } from '../api/client.ts';
import { Badge, Button, Card, Icon, PageHeader, type TabKey } from '../components/ui.tsx';
import { buildAlerts, chartBars, formatUptime, greetingFor, groupEvents, levelForFree, percent, relativeTime, systemSummary, type Level } from '../overviewLogic.ts';
import { groupReminders, summarizeReminders } from '../remindersLogic.ts';
import { colors, fonts, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient; me: Me; onNavigate: (tab: TabKey) => void };

const REFRESH_MS = 30_000;
const LEVEL_COLOR: Record<Level, string> = { ok: colors.success, warn: colors.warning, danger: colors.danger, unknown: colors.muted };
const LEVEL_TEXT: Record<Level, string> = { ok: 'Folgado', warn: 'Apertado', danger: 'Crítico', unknown: 'Sem leitura' };

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Não consegui carregar a visão geral.');

/**
 * Visão Geral (só o dono): estado da Yui, números do dia, saúde do computador, atividade recente e atalhos.
 * Tudo vem da API; o que ela não mede (custo de IA, Yui Live) não aparece com número inventado.
 */
export function OverviewScreen({ client, onNavigate }: Props) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const [reminders, setReminders] = useState<ReminderView[] | null>(null);
  const [morningMsg, setMorningMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    const [overview, gw, rem] = await Promise.allSettled([client.admin.overview(), client.admin.gateway(), client.reminders.list()]);
    setReminders(rem.status === 'fulfilled' ? rem.value.reminders : null); // servidor antigo sem lembretes: o cartão só diz que não há dado
    if (overview.status === 'fulfilled') {
      setData(overview.value);
      setError(null);
      setUpdatedAt(Date.now());
    } else {
      setError(errText(overview.reason));
    }
    setGateway(gw.status === 'fulfilled' ? gw.value : null); // sem o gateway a tela só não afirma nada sobre a IA
    setLoading(false);
  }, [client]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const aiTargets = gateway?.providers.flatMap((p) => p.targets) ?? null;
  const aiOk = aiTargets ? aiTargets.some((t) => t.available) : null;
  const providersUp = gateway ? gateway.providers.filter((p) => p.targets.some((t) => t.available)).length : null;

  const host = data?.host;
  const ramFree = percent(host?.ramFreeMB, host?.ramTotalMB);
  const diskFree = percent(host?.diskFreeGB, host?.diskTotalGB);
  const ramLevel = levelForFree(ramFree);
  const diskLevel = levelForFree(diskFree);
  const worst: Level = [ramLevel, diskLevel].includes('danger') ? 'danger' : [ramLevel, diskLevel].includes('warn') ? 'warn' : ramLevel === 'unknown' && diskLevel === 'unknown' ? 'unknown' : 'ok';
  const bars = chartBars(data?.interactions?.series);
  const alerts = data ? buildAlerts({ discordOnline: data.discord.online, aiOk, hostLevel: worst, problems: data.problems }) : [];
  const summary = data ? systemSummary({ discordOnline: data.discord.online, aiOk, hostLevel: worst }) : null;

  return (
    <View style={styles.root}>
      <PageHeader
        title="Visão Geral"
        subtitle="Central de comando"
        right={<Button testID="overview-refresh" label="Atualizar" variant="ghost" onPress={load} loading={loading} />}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {error ? <Text testID="overview-error" style={styles.error}>{error}</Text> : null}
        {!data && !error ? <Text style={styles.hint}>Carregando…</Text> : null}

        {data && summary ? (
          <>
            <Card style={styles.hero}>
              <Image source={require('../../assets/yui-avatar.webp')} style={styles.avatar} accessibilityLabel="Yui" />
              <View style={styles.heroText}>
                <Text style={styles.greeting}>{greetingFor(new Date().getHours())}{data.ownerName ? `, ${data.ownerName}` : ''}.</Text>
                <Text testID="overview-summary" style={[styles.summary, !summary.ok && { color: colors.warning }]}>{summary.text}</Text>
                <View style={styles.badges}>
                  <Badge label={data.discord.online ? '● Discord conectado' : '● Discord desconectado'} color={data.discord.online ? colors.success : colors.danger} />
                  <Badge
                    label={aiOk === null ? '● IA sem leitura' : aiOk ? `● IA operacional${providersUp !== null ? ` (${providersUp} provedor${providersUp === 1 ? '' : 'es'})` : ''}` : '● IA indisponível'}
                    color={aiOk === null ? colors.muted : aiOk ? colors.success : colors.danger}
                  />
                </View>
              </View>
            </Card>

            <View style={styles.grid}>
              <Kpi testID="kpi-servers" icon="dns" value={String(data.discord.guilds)} label="Servidores ativos" />
              <Kpi testID="kpi-memory-users" icon="psychology" value={data.memoryUsers === null ? '—' : String(data.memoryUsers)} label="Pessoas com memória" />
              <Kpi testID="kpi-interactions" icon="forum" value={data.interactions ? String(data.interactions.total) : '—'} label="Respostas da IA (24 h)" />
              <Kpi testID="kpi-uptime" icon="schedule" value={formatUptime(data.uptimeSeconds)} label="Tempo ligada" />
              <Kpi testID="kpi-ram" icon="memory" value={`${data.memoryMB} MB`} label="Memória da Yui" />
            </View>

            <Card style={styles.card}>
              <View style={styles.rowBetween}>
                <SectionTitle icon="notifications" title="Alertas" />
                <Badge label={alerts.length === 0 ? 'Tudo certo' : `${alerts.length} aviso${alerts.length === 1 ? '' : 's'}`} color={alerts.some((a) => a.level === 'danger') ? colors.danger : alerts.length ? colors.warning : colors.success} />
              </View>
              {alerts.length === 0 ? <Text style={styles.hint}>Nada a avisar: Discord, IA e computador normais, sem problemas registrados nas últimas 24 h.</Text> : alerts.map((a, i) => (
                <View key={i} style={styles.eventRow} testID="overview-alert">
                  <Icon name={a.level === 'danger' ? 'error' : 'warning'} size={20} color={a.level === 'danger' ? colors.danger : colors.warning} />
                  <Text style={[styles.eventLabel, { flexShrink: 1 }]}>{a.text}</Text>
                </View>
              ))}
            </Card>

            <Card style={styles.card}>
              <View style={styles.rowBetween}>
                <SectionTitle icon="bar_chart" title="Respostas da IA por hora" />
                <Text style={styles.hint}>últimas 24 h</Text>
              </View>
              {data.interactions ? (
                <>
                  <View style={styles.chart}>
                    {bars.map((b) => (
                      <View key={b.hour} style={styles.barCol} accessibilityLabel={`${b.label}: ${b.count} respostas`}>
                        <View style={[styles.bar, { height: `${b.heightPercent}%` }]} />
                      </View>
                    ))}
                  </View>
                  <View style={styles.rowBetween}>
                    <Text style={styles.hint}>{bars[0]?.label}</Text>
                    <Text style={styles.hint}>{bars[bars.length - 1]?.label}</Text>
                  </View>
                  <Text style={styles.hint}>Conta as respostas do Discord e do app desde {data.interactions.since ? new Date(data.interactions.since).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'} (continua depois de reiniciar ou atualizar). Não guarda texto nem quem pediu.</Text>
                </>
              ) : <Text style={styles.hint}>Este servidor ainda não conta as respostas (atualize a Yui).</Text>}
            </Card>

            <Card style={styles.card}>
              <View style={styles.rowBetween}>
                <SectionTitle icon="monitor_heart" title="Saúde do computador" />
                <Badge label={LEVEL_TEXT[worst]} color={LEVEL_COLOR[worst]} />
              </View>
              <Meter testID="meter-ram" label="Memória RAM livre" freePercent={ramFree} level={ramLevel}
                detail={host?.ramFreeMB != null && host?.ramTotalMB != null ? `${host.ramFreeMB} MB de ${host.ramTotalMB} MB` : null} />
              <Meter testID="meter-disk" label="Disco livre" freePercent={diskFree} level={diskLevel}
                detail={host?.diskFreeGB != null && host?.diskTotalGB != null ? `${host.diskFreeGB} GB de ${host.diskTotalGB} GB` : null} />
              {!host ? <Text style={styles.hint}>Este servidor ainda não informa a saúde do computador (atualize a Yui).</Text> : null}
            </Card>

            <Card style={styles.card}>
              <SectionTitle icon="history" title="Atividade recente" />
              {data.activity && data.activity.length > 0 ? (
                groupEvents(data.activity).map((v, i) => {
                  const tone = v.tone === 'good' ? colors.success : v.tone === 'bad' ? colors.danger : colors.accentText;
                  return (
                    <View key={`${v.ts}-${i}`} style={styles.eventRow} testID="overview-event">
                      <Icon name={v.icon} size={20} color={tone} />
                      <Text style={styles.eventLabel} numberOfLines={1}>{v.label}{v.count > 1 ? ` ×${v.count}` : ''}</Text>
                      <Text style={styles.eventTime}>{relativeTime(v.ts)}</Text>
                    </View>
                  );
                })
              ) : (
                <Text style={styles.hint}>Nada registrado ainda.</Text>
              )}
              <Text style={styles.hint}>Vem do registro de auditoria. As conversas do Discord não aparecem aqui: o texto delas nunca é mostrado.</Text>
            </Card>

            <Card style={styles.card}>
              <SectionTitle icon="psychology" title="Sistema de memória" />
              <View style={styles.memRow}>
                <View style={styles.memBox}>
                  <Text style={styles.memTitle}>Proprietário</Text>
                  <Text style={styles.memValue}>Permanente</Text>
                </View>
                <View style={styles.memBox}>
                  <Text style={styles.memTitle}>Demais usuários</Text>
                  <Text style={styles.memValue}>{data.retention?.othersPermanent ? 'Permanente' : data.retention?.othersDays ? `${data.retention.othersDays} dias` : '—'}</Text>
                </View>
              </View>
              <Text style={styles.hint}>As regras de retenção valem no servidor, não só nesta tela. {data.flags.memoryEnabled ? '' : 'A memória está desligada neste momento.'}</Text>
            </Card>

            <Card style={styles.card}>
              <SectionTitle icon="bolt" title="Atalhos" />
              <View style={styles.badges}>
                <Shortcut testID="go-chat" icon="chat_bubble" label="Chat" onPress={() => onNavigate('chat')} />
                <Shortcut testID="go-files" icon="folder" label="Arquivos" onPress={() => onNavigate('files')} />
                <Shortcut testID="go-memory" icon="psychology" label="Memória" onPress={() => onNavigate('memory')} />
                <Shortcut testID="go-admin" icon="admin_panel_settings" label="Admin" onPress={() => onNavigate('admin')} />
                <Shortcut testID="go-status" icon="monitor_heart" label="Status" onPress={() => onNavigate('status')} />
              </View>
            </Card>

            <Card style={styles.card}>
              <View style={styles.rowBetween}>
                <SectionTitle icon="alarm" title="Lembretes" />
                <Badge label={reminders ? summarizeReminders(reminders) : 'sem dado'} color={reminders && groupReminders(reminders).overdue.length ? colors.warning : colors.accentText} />
              </View>
              {reminders === null ? <Text style={styles.hint}>Este servidor ainda não tem lembretes (atualize a Yui).</Text> : (
                <>
                  {[...groupReminders(reminders).overdue, ...groupReminders(reminders).today, ...groupReminders(reminders).upcoming].slice(0, 3).map((r) => (
                    <View key={r.id} style={styles.eventRow} testID="overview-reminder">
                      <Icon name={r.repeat ? 'repeat' : 'alarm'} size={20} color={colors.accentText} />
                      <Text style={styles.eventLabel} numberOfLines={1}>{r.text}</Text>
                      <Text style={styles.eventTime}>{r.repeatText ? r.repeatText : r.whenText}</Text>
                    </View>
                  ))}
                  {reminders.length === 0 ? <Text style={styles.hint}>Nada marcado. Diga à Yui: “me lembra amanhã às 9h de pagar a conta”.</Text> : null}
                </>
              )}
              <View style={styles.badges}>
                <Shortcut testID="go-reminders" icon="alarm" label="Lembretes" onPress={() => onNavigate('reminders')} />
                <Shortcut testID="morning-now" icon="wb_sunny" label="Enviar o resumo do dia agora" onPress={async () => { setMorningMsg(null); try { await client.reminders.morningSend(); setMorningMsg('Resumo enviado por mensagem privada.'); } catch (e) { setMorningMsg(errText(e)); } }} />
              </View>
              {morningMsg ? <Text testID="morning-msg" style={styles.hint}>{morningMsg}</Text> : null}
              <Text style={styles.hint}>Todo dia de manhã a Yui manda o resumo (lembretes, pendências e a saúde dela). Agenda do Google e e-mail ainda não estão ligados.</Text>
            </Card>

            {updatedAt ? <Text style={styles.hint}>Atualizado às {new Date(updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (a cada 30 s)</Text> : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Icon name={icon} size={22} color={colors.accent} />
      <Text accessibilityRole="header" style={styles.cardTitle}>{title}</Text>
    </View>
  );
}

function Kpi({ icon, value, label, testID }: { icon: string; value: string; label: string; testID?: string }) {
  return (
    <Card style={styles.kpi}>
      <Icon name={icon} size={22} color={colors.accentText} />
      <Text testID={testID} style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </Card>
  );
}

function Meter({ label, freePercent, level, detail, testID }: { label: string; freePercent: number | null; level: Level; detail: string | null; testID?: string }) {
  const color = LEVEL_COLOR[level];
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <View style={styles.rowBetween}>
        <Text style={styles.meterLabel}>{label}</Text>
        <Text style={[styles.meterValue, { color }]}>{freePercent === null ? '—' : `${freePercent}% livre`}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${freePercent ?? 0}%`, backgroundColor: color }]} />
      </View>
      {detail ? <Text style={styles.hint}>{detail}</Text> : null}
    </View>
  );
}

function Shortcut({ icon, label, onPress, testID }: { icon: string; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.shortcut}>
      <Icon name={icon} size={18} color={colors.accentText} />
      <Text style={styles.shortcutText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, gap: spacing.lg, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, flexWrap: 'wrap', padding: spacing.xl, borderRadius: radius.lg },
  avatar: { width: 84, height: 84, borderRadius: 42, borderWidth: 1, borderColor: colors.border },
  heroText: { flex: 1, minWidth: 220, gap: spacing.sm },
  greeting: { color: colors.text, fontSize: 22, fontFamily: fonts.title, fontWeight: '700' },
  summary: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  kpi: { flexGrow: 1, flexBasis: 180, gap: 6, paddingVertical: 24, paddingHorizontal: 20 },
  kpiValue: { color: colors.text, fontSize: 26, fontFamily: fonts.title, fontWeight: '700' },
  kpiLabel: { color: colors.muted, fontSize: 12 },
  card: { gap: spacing.md, padding: spacing.xl, borderRadius: radius.lg },
  cardTitle: { color: colors.text, fontSize: 18, fontFamily: fonts.title, fontWeight: '700', letterSpacing: -0.2 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  meterLabel: { color: colors.text, fontSize: 13 },
  meterValue: { fontSize: 13, fontWeight: '600' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 96 },
  barCol: { flex: 1, height: '100%', justifyContent: 'flex-end', backgroundColor: colors.surfaceAlt, borderRadius: 3, overflow: 'hidden' },
  bar: { width: '100%', backgroundColor: colors.accent, borderRadius: 3 },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  fill: { height: 8, borderRadius: radius.pill },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  eventLabel: { color: colors.text, fontSize: 13, flex: 1 },
  eventTime: { color: colors.muted, fontSize: 12 },
  memRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  memBox: { flexGrow: 1, flexBasis: 150, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, gap: 2 },
  memTitle: { color: colors.muted, fontSize: 12 },
  memValue: { color: colors.text, fontSize: 18, fontFamily: fonts.title, fontWeight: '700' },
  shortcut: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  shortcutText: { color: colors.text, fontSize: 13 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger },
});
