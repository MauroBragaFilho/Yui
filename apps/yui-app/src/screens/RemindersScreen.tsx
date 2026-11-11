import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type ReminderView, type YuiClient } from '../api/client.ts';
import { Badge, Button, Card, Chip, Icon, PageHeader } from '../components/ui.tsx';
import { groupReminders, QUICK_WHEN, reminderInputProblem } from '../remindersLogic.ts';
import { colors, fonts, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient };

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado. Tente de novo.');

/**
 * Lembretes (só o dono). A Yui avisa por mensagem privada no Discord na hora marcada. Dá para criar escrevendo o "quando" em português
 * ("amanhã às 9h", "em 2 horas", "todo dia às 8h"), adiar e apagar. O resumo do dia (relatório matinal) também sai daqui.
 * Tudo também funciona por conversa: "me lembra amanhã às 9h de pagar a conta".
 */
export function RemindersScreen({ client }: Props) {
  const [items, setItems] = useState<ReminderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await client.reminders.list()).reminders);
      setError(null);
    } catch (e) { setError(errText(e)); }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000); // a lista anda sozinha: o que já avisou sai
    return () => clearInterval(timer);
  }, [load]);

  async function create() {
    const problem = reminderInputProblem(text, when);
    if (problem) { setError(problem); setNotice(null); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await client.reminders.add(text.trim(), when.trim());
      setNotice(`Anotado: ${r.reminder.repeatText ?? r.reminder.whenText} — ${r.reminder.text}`);
      setText(''); setWhen('');
      await load();
    } catch (e) { setError(errText(e)); }
    setSaving(false);
  }

  async function act(label: string, fn: () => Promise<unknown>) {
    setError(null); setNotice(null);
    try { await fn(); setNotice(label); await load(); } catch (e) { setError(errText(e)); }
  }

  async function showPreview() {
    setError(null);
    try { setPreview((await client.reminders.morningPreview()).text); } catch (e) { setError(errText(e)); }
  }

  async function sendNow() {
    setSending(true); setError(null); setNotice(null);
    try { await client.reminders.morningSend(); setNotice('Resumo do dia enviado por mensagem privada.'); } catch (e) { setError(errText(e)); }
    setSending(false);
  }

  const groups = groupReminders(items);

  const Row = ({ r, late = false }: { r: ReminderView; late?: boolean }) => (
    <View style={styles.rowWrap} testID="reminder-row">
      <View style={styles.row}>
        <Icon name={r.repeat ? 'repeat' : 'alarm'} size={22} color={late ? colors.warning : colors.accentText} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name}>{r.text}</Text>
          <Text style={[styles.hint, late && { color: colors.warning }]}>
            #{r.id} · {r.repeatText ? `${r.repeatText} (próximo: ${r.whenText})` : r.whenText}{late ? ' · atrasado' : ''}{r.tries > 0 ? ' · a mensagem não saiu, tentando de novo' : ''}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Button label="+30 min" variant="ghost" onPress={() => act('Adiado 30 minutos.', () => client.reminders.snooze(r.id, { minutes: 30 }))} />
        <Button label="+1 h" variant="ghost" onPress={() => act('Adiado 1 hora.', () => client.reminders.snooze(r.id, { minutes: 60 }))} />
        <Button label="Amanhã 9h" variant="ghost" onPress={() => act('Adiado para amanhã às 9h.', () => client.reminders.snooze(r.id, { when: 'amanhã às 9h' }))} />
        {confirm === r.id ? (
          <>
            <Button testID="reminder-delete-ok" label="Apagar mesmo" variant="danger" onPress={() => { setConfirm(null); act('Lembrete apagado.', () => client.reminders.remove(r.id)); }} />
            <Button label="Cancelar" variant="ghost" onPress={() => setConfirm(null)} />
          </>
        ) : (
          <Button testID="reminder-delete" label="Apagar" icon="delete" variant="ghost" onPress={() => setConfirm(r.id)} />
        )}
      </View>
    </View>
  );

  return (
    <View style={styles.root}>
      <PageHeader title="Lembretes" subtitle="A Yui avisa por mensagem privada" right={<Button testID="reminders-refresh" label="Atualizar" variant="ghost" onPress={load} loading={loading} />} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {error ? <Text testID="reminders-error" style={styles.error}>{error}</Text> : null}
        {notice ? <Text testID="reminders-notice" style={styles.notice}>{notice}</Text> : null}

        <Card style={styles.card}>
          <View style={styles.title}><Icon name="add_alarm" size={22} color={colors.accent} /><Text style={styles.titleText}>Novo lembrete</Text></View>
          <TextInput testID="reminder-text" value={text} onChangeText={setText} placeholder="Do que devo te lembrar? Ex.: pagar a conta de luz" placeholderTextColor={colors.muted} style={styles.input} maxLength={300} />
          <TextInput testID="reminder-when" value={when} onChangeText={setWhen} placeholder="Quando? Ex.: amanhã às 9h · em 2 horas · sexta às 10h · todo dia às 8h" placeholderTextColor={colors.muted} style={styles.input} onSubmitEditing={create} />
          <View style={styles.chips}>
            {QUICK_WHEN.map((q) => <Chip key={q.label} label={q.label} on={when === q.when} onPress={() => setWhen(q.when)} />)}
          </View>
          <View style={styles.actions}>
            <Button testID="reminder-create" label="Criar lembrete" icon="add" onPress={create} loading={saving} />
          </View>
        </Card>

        {loading && items.length === 0 ? <ActivityIndicator color={colors.accent} /> : null}

        {groups.overdue.length > 0 ? (
          <Card style={styles.card}>
            <View style={styles.titleBetween}><Text style={styles.titleText}>Atrasados</Text><Badge label={String(groups.overdue.length)} color={colors.warning} /></View>
            <Text style={styles.hint}>A hora já passou e a mensagem ainda não saiu (o Discord pode estar fora). A Yui tenta de novo a cada minuto.</Text>
            {groups.overdue.map((r) => <Row key={r.id} r={r} late />)}
          </Card>
        ) : null}

        <Card style={styles.card}>
          <View style={styles.titleBetween}><Text style={styles.titleText}>Hoje</Text><Badge label={String(groups.today.length)} color={colors.accentText} /></View>
          {groups.today.length === 0 ? <Text style={styles.hint}>Nenhum lembrete para hoje.</Text> : groups.today.map((r) => <Row key={r.id} r={r} />)}
        </Card>

        <Card style={styles.card}>
          <View style={styles.titleBetween}><Text style={styles.titleText}>Próximos</Text><Badge label={String(groups.upcoming.length)} color={colors.accentText} /></View>
          {groups.upcoming.length === 0 ? <Text style={styles.hint}>Nada marcado para os próximos dias.</Text> : groups.upcoming.map((r) => <Row key={r.id} r={r} />)}
        </Card>

        <Card style={styles.card}>
          <View style={styles.title}><Icon name="wb_sunny" size={22} color={colors.accent} /><Text style={styles.titleText}>Resumo do dia</Text></View>
          <Text style={styles.hint}>Todo dia de manhã a Yui manda um resumo por mensagem privada: seus lembretes de hoje, pendências das listas e a saúde dela. Aqui você vê como ele está agora ou manda na hora.</Text>
          <View style={styles.actions}>
            <Button testID="morning-preview" label="Ver o resumo agora" variant="ghost" onPress={showPreview} />
            <Button testID="morning-send" label="Enviar por mensagem" icon="send" onPress={sendNow} loading={sending} />
          </View>
          {preview ? <Text testID="morning-text" style={styles.preview} selectable>{preview.replace(/\*\*/g, '').replace(/^-# /gm, '')}</Text> : null}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, gap: spacing.lg, width: '100%', maxWidth: 900, alignSelf: 'center' },
  card: { gap: spacing.md, padding: spacing.xl, borderRadius: radius.lg },
  title: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  titleBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  titleText: { color: colors.text, fontSize: 18, fontFamily: fonts.title, fontWeight: '700' },
  input: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, paddingHorizontal: spacing.md, paddingVertical: 12, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowWrap: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { color: colors.text, fontSize: 15 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  preview: { color: colors.text, fontSize: 13, lineHeight: 19, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md },
  error: { color: colors.danger, fontSize: 13 },
  notice: { color: colors.success, fontSize: 13 },
});
