import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, type YuiClient } from '../api/client.ts';
import {
  errorMessage,
  expireStale,
  fromAgentReply,
  resolvePending,
  userMessage,
  type ChatMessage,
} from '../chat/messages.ts';
import { Badge, Button } from '../components/ui.tsx';
import { clearHistory, loadHistory, saveHistory } from '../storage.ts';
import { colors, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient };

export function ChatScreen({ client }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    loadHistory().then((h) => {
      setMessages(expireStale(h));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (loaded) saveHistory(messages);
  }, [messages, loaded]);

  // Confirmações antigas expiram sozinhas (a API as descarta em 2 minutos).
  useEffect(() => {
    const t = setInterval(() => setMessages((m) => expireStale(m)), 15_000);
    return () => clearInterval(t);
  }, []);

  const scrollToEnd = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, userMessage(text)]);
    setBusy(true);
    scrollToEnd();
    try {
      const reply = await client.send(text);
      setMessages((m) => [...m, fromAgentReply(reply)]);
    } catch (e) {
      setMessages((m) => [...m, errorMessage(e instanceof ApiError ? e.message : 'Algo deu errado.')]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  async function answer(pendingId: string, approve: boolean) {
    setMessages((m) => resolvePending(m, pendingId, approve ? 'approved' : 'cancelled'));
    setBusy(true);
    try {
      const reply = await client.confirm(pendingId, approve);
      setMessages((m) => [...m, fromAgentReply(reply)]);
    } catch (e) {
      setMessages((m) => [...m, errorMessage(e instanceof ApiError ? e.message : 'Algo deu errado.')]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  async function newConversation() {
    await clearHistory();
    setMessages([]);
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>Yui</Text>
        <Pressable testID="btn-new-chat" onPress={newConversation} accessibilityRole="button" accessibilityLabel="Nova conversa">
          <Text style={styles.headerAction}>Nova conversa</Text>
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        testID="message-list"
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={scrollToEnd}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Oi! Eu sou a Yui 👋</Text>
            <Text style={styles.emptyText}>
              Converse comigo, peça para eu lembrar de algo ou, se o seu PC estiver configurado, para abrir projetos.
            </Text>
          </View>
        }
        renderItem={({ item }) => <Bubble message={item} busy={busy} onAnswer={answer} />}
      />

      {busy ? (
        <View style={styles.typing} testID="typing">
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.typingText}>Yui está pensando…</Text>
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          testID="input-message"
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Escreva uma mensagem…"
          placeholderTextColor={colors.muted}
          multiline
          maxLength={4000}
          onSubmitEditing={send}
          blurOnSubmit={false}
          {...(Platform.OS === 'web'
            ? {
                // Enter envia; Shift+Enter quebra a linha.
                onKeyPress: (e: any) => {
                  if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                    e.preventDefault?.();
                    send();
                  }
                },
              }
            : {})}
        />
        <Button testID="btn-send" label="Enviar" onPress={send} disabled={!input.trim() || busy} style={styles.sendBtn} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  busy,
  onAnswer,
}: {
  message: ChatMessage;
  busy: boolean;
  onAnswer: (pendingId: string, approve: boolean) => void;
}) {
  const mine = message.role === 'user';
  const isError = message.kind === 'error' || message.kind === 'denied';
  return (
    <View style={[styles.row, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
      <View
        style={[
          styles.bubble,
          mine ? styles.bubbleMine : styles.bubbleYui,
          isError ? { borderColor: colors.danger, borderWidth: 1 } : null,
          message.kind === 'confirmation' ? { borderColor: colors.warning, borderWidth: 1 } : null,
        ]}
      >
        {message.kind === 'tool_result' ? <Badge label={`🔧 ${message.tool ?? 'ferramenta'}`} color={colors.success} /> : null}
        {message.kind === 'confirmation' ? <Badge label="⚠️ Precisa da sua confirmação" color={colors.warning} /> : null}
        <Text selectable style={[styles.bubbleText, isError ? { color: colors.danger } : null]}>
          {message.text}
        </Text>

        {message.pending ? (
          message.pending.status === 'waiting' ? (
            <View style={styles.actions}>
              <Button
                testID="btn-confirm"
                label="Confirmar"
                onPress={() => onAnswer(message.pending!.id, true)}
                disabled={busy}
                style={styles.actionBtn}
              />
              <Button
                testID="btn-cancel"
                label="Cancelar"
                variant="ghost"
                onPress={() => onAnswer(message.pending!.id, false)}
                disabled={busy}
                style={styles.actionBtn}
              />
            </View>
          ) : (
            <Text style={styles.pendingDone}>
              {message.pending.status === 'approved'
                ? '✔ Confirmado'
                : message.pending.status === 'cancelled'
                  ? '✖ Cancelado'
                  : '⏱ Expirou'}
            </Text>
          )
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  headerAction: { color: colors.primary, fontWeight: '600' },
  list: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1, width: '100%', maxWidth: 820, alignSelf: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: spacing.sm },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  emptyText: { color: colors.muted, textAlign: 'center', maxWidth: 360, lineHeight: 20 },
  row: { flexDirection: 'row' },
  bubble: { maxWidth: '85%', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  bubbleMine: { backgroundColor: colors.userBubble, borderBottomRightRadius: 6 },
  bubbleYui: { backgroundColor: colors.yuiBubble, borderBottomLeftRadius: 6 },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  actionBtn: { flex: 1, minHeight: 40 },
  pendingDone: { color: colors.muted, fontSize: 12, marginTop: spacing.xs },
  typing: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  typingText: { color: colors.muted, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 44,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendBtn: { paddingHorizontal: spacing.lg },
});
