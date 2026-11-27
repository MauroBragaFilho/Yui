import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type AdminGuildDetail, type ChannelRef, type GuildChannelType, type YoutubeLiveMode, type YuiClient } from '../api/client.ts';
import { ChannelPicker } from '../components/ChannelPicker.tsx';
import { confirmAction } from '../components/confirm.ts';
import { Button, Chip } from '../components/ui.tsx';
import { colors, radius, spacing } from '../theme.ts';
import { GuildExtras, type Secao } from './AdminGuildExtras.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const chan = (c: ChannelRef | null) => (c ? (c.name ? `#${c.name}` : `ID ${c.id}`) : 'não definido');

const CHANNEL_TYPES: { type: Exclude<GuildChannelType, 'atualizacoes'>; label: string }[] = [
  { type: 'noticias', label: 'Notícias' },
  { type: 'diario', label: 'Reset diário' },
  { type: 'semanal', label: 'Evento semanal' },
];

type Aba = 'publicacoes' | Secao;
const ABAS: { key: Aba; label: string }[] = [
  { key: 'publicacoes', label: 'Publicações' },
  { key: 'funcoes', label: 'Funções' },
  { key: 'termos', label: 'Termos de uso' },
  { key: 'canal', label: 'Conversa' },
];

function RolePicker({ roles, value, onPick }: { roles: { id: string; name: string }[]; value: string | null; onPick: (id: string | null) => void }) {
  return (
    <ScrollView style={styles.picker} nestedScrollEnabled contentContainerStyle={styles.chips}>
      <Chip label="Sem cargo" on={value === null} onPress={() => onPick(null)} />
      {roles.slice(0, 80).map((r) => (
        <Chip key={r.id} label={`@${r.name}`} on={value === r.id} onPress={() => onPick(r.id)} />
      ))}
    </ScrollView>
  );
}

const LIVE_MODE_OPTIONS: { value: YoutubeLiveMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automático', hint: 'Edita a mensagem se a live começa logo depois de agendada; se foi agendada para longe, avisa de novo no início. O fim sempre edita.' },
  { value: 'new', label: 'Mensagem nova', hint: 'Uma mensagem nova a cada etapa (agendada, ao vivo, encerrada).' },
  { value: 'edit', label: 'Editar sempre', hint: 'Uma mensagem só, editada a cada etapa. Editar não notifica ninguém.' },
];

/** Escolha de como os avisos de live saem (por canal do YouTube seguido), com a explicação da opção marcada. */
function LiveModeChips({ value, onPick, testID }: { value: YoutubeLiveMode; onPick: (mode: YoutubeLiveMode) => void; testID?: string }) {
  const current = LIVE_MODE_OPTIONS.find((o) => o.value === value) ?? LIVE_MODE_OPTIONS[1];
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.chips}>
        {LIVE_MODE_OPTIONS.map((o) => (
          <Chip key={o.value} testID={testID ? `${testID}-${o.value}` : undefined} label={o.label} on={o.value === value} onPress={() => { if (o.value !== value) onPick(o.value); }} />
        ))}
      </View>
      <Text style={styles.hint}>{current.hint}</Text>
    </View>
  );
}

/** Canais do servidor, avisos de YouTube/Twitch e configurações do servidor, com edição. */
export function GuildEditor({ client, data, reload, onTosChange }: { client: YuiClient; data: AdminGuildDetail; reload: () => Promise<void>; onTosChange?: (aceito: boolean) => void }) {
  const id = data.id;
  const [aba, setAba] = useState<Aba>('publicacoes');
  // Aba já aberta continua montada (escondida): canal escolhido e texto não salvo não se perdem.
  const [visitadas, setVisitadas] = useState<Secao[]>([]);
  const abrir = (a: Aba) => {
    setAba(a);
    if (a !== 'publicacoes' && !visitadas.includes(a)) setVisitadas([...visitadas, a]);
  };
  const [editing, setEditing] = useState<GuildChannelType | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // novo YouTube
  const [ytInput, setYtInput] = useState('');
  const [ytChannel, setYtChannel] = useState<string | null>(null);
  const [ytRole, setYtRole] = useState<string | null>(null);
  const [ytVideos, setYtVideos] = useState(true);
  const [ytShorts, setYtShorts] = useState(true);
  const [ytLives, setYtLives] = useState(true);
  const [ytLiveMode, setYtLiveMode] = useState<YoutubeLiveMode>('auto');
  // novo Twitch
  const [twInput, setTwInput] = useState('');
  const [twChannel, setTwChannel] = useState<string | null>(null);
  const [twRole, setTwRole] = useState<string | null>(null);
  const [open, setOpen] = useState<'youtube' | 'twitch' | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, okText?: string): Promise<boolean> {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      await reload();
      if (okText) setMsg({ text: okText, ok: true });
      return true;
    } catch (e) {
      setMsg({ text: errText(e), ok: false });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pickChannel(type: GuildChannelType, channelId: string | null) {
    const ok = await run(() => client.admin.setGuildChannel(id, type, channelId), 'Canal atualizado.');
    if (ok) setEditing(null);
  }

  async function addYoutube() {
    if (!ytChannel) return;
    const ok = await run(
      () => client.admin.followYoutube(id, { channel: ytInput.trim(), discordChannelId: ytChannel, roleId: ytRole, videos: ytVideos, shorts: ytShorts, lives: ytLives, liveMode: ytLiveMode }),
      'Canal do YouTube adicionado.'
    );
    if (ok) { setYtInput(''); setYtChannel(null); setYtRole(null); setYtLiveMode('auto'); setOpen(null); }
  }

  async function addTwitch() {
    if (!twChannel) return;
    const ok = await run(() => client.admin.followTwitch(id, { streamer: twInput.trim(), discordChannelId: twChannel, roleId: twRole }), 'Streamer adicionado.');
    if (ok) { setTwInput(''); setTwChannel(null); setTwRole(null); setOpen(null); }
  }

  return (
    <View style={styles.box}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {ABAS.map((a) => (
          <Pressable key={a.key} testID={`guild-secao-${a.key}`} accessibilityRole="tab" accessibilityState={{ selected: aba === a.key }} aria-selected={aba === a.key} onPress={() => abrir(a.key)} style={[styles.tab, aba === a.key && styles.tabOn]}>
            <Text style={[styles.tabText, aba === a.key && styles.tabTextOn]}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
      {visitadas.map((s) => (
        <View key={s} style={aba === s ? null : styles.hidden}>
          <GuildExtras secao={s} client={client} guild={data} reload={reload} onTosChange={onTosChange} irParaCanais={() => abrir('publicacoes')} />
        </View>
      ))}
      <View style={aba === 'publicacoes' ? styles.publicacoes : styles.hidden}>
      <Text style={styles.label}>Canais de publicação</Text>
      {CHANNEL_TYPES.map(({ type, label }) => (
        <View key={type} style={{ gap: spacing.sm }}>
          <View style={styles.kv}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.value}>{chan(data.channels[type])}</Text>
          </View>
          <Button
            testID={`guild-channel-${type}`}
            label={editing === type ? 'Fechar' : 'Alterar'}
            variant="ghost"
            onPress={() => setEditing(editing === type ? null : type)}
            style={styles.smallBtn}
          />
          {editing === type ? (
            <ChannelPicker testID={`pick-${type}`} channels={data.textChannels} value={data.channels[type]?.id ?? null} allowNone onPick={(c) => pickChannel(type, c)} />
          ) : null}
        </View>
      ))}

      <Text style={styles.label}>YouTube ({data.youtube.length})</Text>
      {data.youtube.length === 0 ? <Text style={styles.hint}>Nenhum canal seguido.</Text> : null}
      {data.youtube.map((y) => (
        <View key={`${y.id}-${y.channel?.id}`} style={styles.followRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.value}>{y.name}</Text>
            <Text style={styles.hint}>
              {chan(y.channel)} • {[y.videos && 'vídeos', y.shorts && 'shorts', y.lives && 'lives'].filter(Boolean).join(', ') || 'nada'}
            </Text>
            {y.lives ? (
              <View style={{ gap: 4 }}>
                <Text style={styles.hint}>Avisos de live</Text>
                <LiveModeChips
                  testID={`yt-mode-${y.id}`}
                  value={y.liveMode ?? 'new'}
                  onPick={(mode) =>
                    run(() => client.admin.setYoutubeLiveMode(id, y.id, y.channel?.id ?? '', mode), 'Modo das lives atualizado.')
                  }
                />
              </View>
            ) : null}
          </View>
          <Button
            testID={`yt-remove-${y.id}`}
            label="Remover"
            variant="ghost"
            style={styles.smallBtn}
            onPress={() =>
              confirmAction('Parar de seguir?', `${y.name} em ${chan(y.channel)}`, () => run(() => client.admin.unfollowYoutube(id, y.id, y.channel?.id ?? ''), 'Removido.'), 'Remover')
            }
          />
        </View>
      ))}
      {open === 'youtube' ? (
        <View style={styles.form}>
          <Text style={styles.label}>Canal do YouTube (@handle, ID UC... ou URL)</Text>
          <TextInput testID="yt-input" style={styles.input} value={ytInput} onChangeText={setYtInput} placeholder="@NomeDoCanal" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.label}>Publicar em</Text>
          <ChannelPicker testID="yt-pick" channels={data.textChannels} value={ytChannel} onPick={setYtChannel} />
          <Text style={styles.label}>Mencionar cargo (opcional)</Text>
          <RolePicker roles={data.roles} value={ytRole} onPick={setYtRole} />
          <Text style={styles.label}>Avisar</Text>
          <View style={styles.chips}>
            <Chip label="Vídeos" on={ytVideos} onPress={() => setYtVideos(!ytVideos)} />
            <Chip label="Shorts" on={ytShorts} onPress={() => setYtShorts(!ytShorts)} />
            <Chip label="Lives" on={ytLives} onPress={() => setYtLives(!ytLives)} />
          </View>
          {ytLives ? (
            <>
              <Text style={styles.label}>Avisos de live</Text>
              <LiveModeChips testID="yt-form-mode" value={ytLiveMode} onPick={setYtLiveMode} />
            </>
          ) : null}
          <View style={styles.chips}>
            <Button testID="yt-save" label="Seguir canal" onPress={addYoutube} loading={busy} disabled={!ytInput.trim() || !ytChannel} style={styles.smallBtn} />
            <Button label="Cancelar" variant="ghost" onPress={() => setOpen(null)} style={styles.smallBtn} />
          </View>
        </View>
      ) : (
        <Button testID="yt-add" label="Seguir um canal do YouTube" variant="ghost" onPress={() => setOpen('youtube')} style={styles.smallBtn} />
      )}

      <Text style={styles.label}>Twitch ({data.twitch.length})</Text>
      {data.twitch.length === 0 ? <Text style={styles.hint}>Nenhum streamer seguido.</Text> : null}
      {data.twitch.map((t) => (
        <View key={`${t.id}-${t.channel?.id}`} style={styles.followRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.value}>{t.name}</Text>
            <Text style={styles.hint}>{chan(t.channel)}</Text>
          </View>
          <Button
            testID={`tw-remove-${t.id}`}
            label="Remover"
            variant="ghost"
            style={styles.smallBtn}
            onPress={() =>
              confirmAction('Parar de seguir?', `${t.name} em ${chan(t.channel)}`, () => run(() => client.admin.unfollowTwitch(id, t.id, t.channel?.id ?? ''), 'Removido.'), 'Remover')
            }
          />
        </View>
      ))}
      {open === 'twitch' ? (
        <View style={styles.form}>
          <Text style={styles.label}>Streamer (login ou URL de twitch.tv)</Text>
          <TextInput testID="tw-input" style={styles.input} value={twInput} onChangeText={setTwInput} placeholder="alanzoka" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.label}>Publicar em</Text>
          <ChannelPicker testID="tw-pick" channels={data.textChannels} value={twChannel} onPick={setTwChannel} />
          <Text style={styles.label}>Mencionar cargo (opcional)</Text>
          <RolePicker roles={data.roles} value={twRole} onPick={setTwRole} />
          <View style={styles.chips}>
            <Button testID="tw-save" label="Seguir streamer" onPress={addTwitch} loading={busy} disabled={!twInput.trim() || !twChannel} style={styles.smallBtn} />
            <Button label="Cancelar" variant="ghost" onPress={() => setOpen(null)} style={styles.smallBtn} />
          </View>
        </View>
      ) : (
        <Button testID="tw-add" label="Seguir um streamer da Twitch" variant="ghost" onPress={() => setOpen('twitch')} style={styles.smallBtn} />
      )}

      {msg ? <Text style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  tabTextOn: { color: colors.text },
  hidden: { display: 'none' },
  publicacoes: { gap: spacing.sm },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  ok: { color: colors.success, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  picker: { maxHeight: 150 },
  form: { gap: spacing.sm, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md },
  followRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  smallBtn: { minHeight: 44, paddingHorizontal: spacing.md, alignSelf: 'flex-start' },
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
});
