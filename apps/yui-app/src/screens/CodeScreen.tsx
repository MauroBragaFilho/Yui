import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { ApiError, type DevEvent, type DevFile, type DevStatus, type DevTreeItem, type YuiClient } from '../api/client.ts';
import { Button, Card, Chip, Icon, IconButton, PageHeader } from '../components/ui.tsx';
import { colors, fonts, radius, spacing } from '../theme.ts';

type Item =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'yui'; text: string; meta?: string }
  | { key: string; kind: 'error'; text: string }
  | { key: string; kind: 'tool'; action: string; status: string; summary: string; preview?: string }
  | { key: string; kind: 'approval'; id: string; summary: string; preview: string; state: 'waiting' | 'approved' | 'denied' | 'expired' };

const errText = (e: unknown, fallback = 'Algo deu errado.') => (e instanceof ApiError ? e.message : fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MONO = Platform.select({ web: "ui-monospace, 'Cascadia Mono', Consolas, monospace", default: undefined });
let seq = 0;
const nextKey = () => `i${++seq}`;

/** Texto com blocos de código (```) desenhados em caixa monoespaçada. Nada vira HTML. */
function RichText({ text, color }: { text: string; color: string }) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const plain = parts[i];
    if (plain && plain.trim()) nodes.push(<Text key={`t${i}`} selectable style={[styles.bubbleText, { color }]}>{plain.trim()}</Text>);
    if (i + 2 < parts.length) {
      nodes.push(
        <View key={`c${i}`} style={styles.codeBox}>
          {parts[i + 1] ? <Text style={styles.codeLang}>{parts[i + 1]}</Text> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <Text selectable style={styles.codeText}>{parts[i + 2].replace(/\n$/, '')}</Text>
          </ScrollView>
        </View>
      );
    }
  }
  return <View style={{ gap: spacing.sm }}>{nodes}</View>;
}

function TreeNode({ client, projectId, item, depth, onOpen, activePath, version }: { client: YuiClient; projectId: string; item: DevTreeItem; depth: number; onOpen: (path: string) => void; activePath: string | null; version: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DevTreeItem[] | null>(null);

  useEffect(() => {
    if (open) client.dev.tree(projectId, item.path).then(setChildren).catch(() => setChildren([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version]);

  const active = !item.isDirectory && item.path === activePath;
  return (
    <View>
      <Pressable
        testID={`tree-${item.path}`}
        accessibilityRole="button"
        onPress={() => (item.isDirectory ? setOpen(!open) : onOpen(item.path))}
        style={(state: any) => [styles.treeRow, { paddingLeft: spacing.sm + depth * 14 }, active ? { backgroundColor: colors.accentLight } : state.hovered ? { backgroundColor: colors.surfaceAlt } : null]}
      >
        <Text numberOfLines={1} style={[styles.treeText, active && { color: colors.accentText }]}>
          {item.isDirectory ? (open ? '▾ ' : '▸ ') : '· '}
          {item.name}
        </Text>
      </Pressable>
      {open && children ? children.map((c) => <TreeNode key={c.path} client={client} projectId={projectId} item={c} depth={depth + 1} onOpen={onOpen} activePath={activePath} version={version} />) : null}
    </View>
  );
}

export function CodeScreen({ client }: { client: YuiClient }) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;

  const [status, setStatus] = useState<DevStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [mode, setMode] = useState('yui');
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [stepText, setStepText] = useState('');
  const [rootItems, setRootItems] = useState<DevTreeItem[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [file, setFile] = useState<DevFile | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [projectMsg, setProjectMsg] = useState<string | null>(null);

  const runIdRef = useRef<string | null>(null);
  const alive = useRef(true);
  const listRef = useRef<FlatList<Item>>(null);
  const focusRef = useRef<string | null>(null);
  focusRef.current = focus;

  useEffect(() => () => { alive.current = false; }, []);

  const scrollToEnd = useCallback(() => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60), []);
  const push = useCallback((item: Item) => { setItems((list) => [...list, item]); scrollToEnd(); }, [scrollToEnd]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await client.dev.status();
      setStatus(s);
      setLoadError(null);
      setProjectId((cur) => cur ?? s.projects.find((p) => p.exists)?.id ?? null);
    } catch (e) {
      setLoadError(errText(e, 'Não foi possível falar com o servidor.'));
    }
  }, [client]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Ao trocar de projeto: carrega conversa guardada e a raiz da árvore.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setItems([]);
    setFile(null);
    setFocus(null);
    client.dev.history(projectId).then((msgs) => {
      if (!cancelled) setItems(msgs.map((m) => (m.role === 'user' ? { key: nextKey(), kind: 'user', text: m.content } : { key: nextKey(), kind: 'yui', text: m.content })));
    }).catch(() => {});
    client.dev.tree(projectId, '').then((t) => { if (!cancelled) setRootItems(t); }).catch(() => setRootItems([]));
    return () => { cancelled = true; };
  }, [client, projectId]);

  const refreshTree = useCallback(async () => {
    if (!projectId) return;
    setRootItems(await client.dev.tree(projectId, '').catch(() => []));
    setTreeVersion((v) => v + 1);
  }, [client, projectId]);

  const openFile = useCallback(async (path: string) => {
    if (!projectId) return;
    try {
      const f = await client.dev.file(projectId, path);
      setFile(f);
      setFocus(f.path);
    } catch (e) {
      push({ key: nextKey(), kind: 'error', text: errText(e) });
    }
  }, [client, projectId, push]);

  function apply(e: DevEvent) {
    if (e.type === 'step') setStepText(e.text);
    else if (e.type === 'thought') setStepText(`Pensando: ${e.text}`);
    else if (e.type === 'tool') {
      const key = `tool-${e.action}-${e.summary}`;
      setItems((list) => {
        const i = list.findIndex((x) => x.key === key);
        const next: Item = { key, kind: 'tool', action: e.action, status: e.status, summary: e.summary, preview: e.preview };
        if (i >= 0) { const copy = list.slice(); copy[i] = next; return copy; }
        return [...list, next];
      });
      if (e.status === 'running' || e.status === 'waiting') setStepText(e.summary);
      scrollToEnd();
    } else if (e.type === 'approval') {
      push({ key: `appr-${e.id}`, kind: 'approval', id: e.id, summary: e.summary, preview: e.preview, state: 'waiting' });
      setStepText('Aguardando a sua aprovação…');
    } else if (e.type === 'approval_done') {
      setItems((list) => list.map((x) => (x.kind === 'approval' && x.id === e.id ? { ...x, state: e.approved ? 'approved' : e.reason ? 'expired' : 'denied' } : x)));
    } else if (e.type === 'final') {
      push({ key: nextKey(), kind: 'yui', text: e.text, meta: e.model ? `${e.provider ?? 'IA'} · ${e.model}` : e.provider });
    } else if (e.type === 'done') {
      setRunning(false);
      setStepText('');
      runIdRef.current = null;
      if (!e.ok && !e.cancelled) push({ key: nextKey(), kind: 'error', text: e.error || 'A execução falhou.' });
      if (e.cancelled) push({ key: nextKey(), kind: 'error', text: 'Cancelado.' });
      if (e.changed?.length) {
        refreshTree();
        if (focusRef.current && e.changed.includes(focusRef.current)) openFile(focusRef.current);
      }
    }
  }

  async function follow(runId: string) {
    let after = 0;
    let failures = 0;
    while (alive.current) {
      try {
        const r = await client.dev.events(runId, after);
        failures = 0;
        let finished = false;
        for (const e of r.events) {
          after = e.seq;
          apply(e);
          if (e.type === 'done') finished = true;
        }
        if (finished) return;
      } catch (e) {
        failures += 1;
        if (e instanceof ApiError && e.status === 404) { setRunning(false); setStepText(''); return; }
        if (failures >= 6) {
          setRunning(false);
          setStepText('');
          push({ key: nextKey(), kind: 'error', text: errText(e, 'Perdi a conexão com a Yui durante a execução.') });
          return;
        }
      }
      await sleep(700);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || running || !projectId) return;
    setInput('');
    push({ key: nextKey(), kind: 'user', text });
    setRunning(true);
    setStepText('Enviando…');
    try {
      const { runId } = await client.dev.startRun(projectId, { message: text, mode, activeFile: focus });
      runIdRef.current = runId;
      follow(runId);
    } catch (e) {
      setRunning(false);
      setStepText('');
      push({ key: nextKey(), kind: 'error', text: errText(e) });
    }
  }

  async function cancel() {
    if (runIdRef.current) await client.dev.cancel(runIdRef.current).catch(() => {});
  }

  async function answer(item: Extract<Item, { kind: 'approval' }>, approve: boolean) {
    if (!runIdRef.current) return;
    try {
      await client.dev.approve(runIdRef.current, item.id, approve);
    } catch (e) {
      push({ key: nextKey(), kind: 'error', text: errText(e) });
    }
  }

  async function addProject() {
    setProjectMsg(null);
    try {
      const r = await client.dev.addProject(newName.trim(), newPath.trim());
      setNewName('');
      setNewPath('');
      await loadStatus();
      setProjectId(r.project.id);
      setProjectMsg('Projeto adicionado.');
    } catch (e) {
      setProjectMsg(errText(e));
    }
  }

  async function removeProject(id: string) {
    setProjectMsg(null);
    try {
      await client.dev.removeProject(id);
      if (projectId === id) setProjectId(null);
      await loadStatus();
    } catch (e) {
      setProjectMsg(errText(e));
    }
  }

  async function clearConversation() {
    if (!projectId) return;
    await client.dev.clearHistory(projectId).catch(() => {});
    setItems([]);
  }

  const desktop = Platform.OS === 'web' && typeof window !== 'undefined' ? (window as any).yuiDesktop : null;
  async function pickFolder() {
    const picked: { path: string; name: string } | null = await desktop?.pickFolder?.();
    if (picked) { setNewPath(picked.path); if (!newName.trim()) setNewName(picked.name); }
  }

  const project = useMemo(() => status?.projects.find((p) => p.id === projectId) ?? null, [status, projectId]);

  if (loadError && !status) {
    return (
      <View style={styles.root}>
        <PageHeader title="Código" />
        <Text testID="code-error" style={[styles.error, { padding: spacing.lg }]}>{loadError}</Text>
      </View>
    );
  }
  if (!status) return <View style={styles.root}><PageHeader title="Código" /><ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} /></View>;

  const sidebar = (
    <ScrollView style={wide ? styles.side : styles.sideNarrow} contentContainerStyle={{ gap: spacing.md, padding: spacing.md }}>
      <Text style={styles.sideTitle}>Projetos</Text>
      <View style={styles.chips}>
        {status.projects.map((p) => <Chip key={p.id} testID={`project-${p.id}`} label={p.name + (p.exists ? '' : ' (sem pasta)')} on={p.id === projectId} onPress={() => setProjectId(p.id)} />)}
      </View>
      {status.projects.length === 0 ? <Text style={styles.hint}>Nenhum projeto ainda. Cadastre um abaixo (no computador da Yui) ou defina YUI_PROJECTS no .env.</Text> : null}
      {project?.source === 'panel' && status.local ? <Button label="Remover este projeto da lista" variant="ghost" onPress={() => removeProject(project.id)} style={styles.smallBtn} /> : null}

      {status.local ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={styles.sideTitle}>Adicionar projeto</Text>
          <TextInput testID="new-project-name" style={styles.input} value={newName} onChangeText={setNewName} placeholder="Nome" placeholderTextColor={colors.muted} />
          <TextInput testID="new-project-path" style={styles.input} value={newPath} onChangeText={setNewPath} placeholder="Pasta (ex.: D:\Projetos\Meu)" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />
          <View style={styles.chips}>
            {desktop?.pickFolder ? <Button label="Escolher pasta…" variant="ghost" onPress={pickFolder} style={styles.smallBtn} /> : null}
            <Button testID="btn-add-project" label="Adicionar" onPress={addProject} disabled={!newName.trim() || !newPath.trim()} style={styles.smallBtn} />
          </View>
          {projectMsg ? <Text style={styles.hint}>{projectMsg}</Text> : null}
        </View>
      ) : null}

      {projectId ? (
        <>
          <Text style={styles.sideTitle}>Arquivos</Text>
          {rootItems.map((it) => <TreeNode key={it.path} client={client} projectId={projectId} item={it} depth={0} onOpen={openFile} activePath={focus} version={treeVersion} />)}
        </>
      ) : null}

      {file ? (
        <Card style={{ gap: spacing.sm, padding: spacing.md }}>
          <View style={styles.rowBetween}>
            <Text numberOfLines={1} style={[styles.sideTitle, { flexShrink: 1 }]}>{file.path}</Text>
            <IconButton icon="cancel" label="Fechar arquivo" size={28} onPress={() => { setFile(null); setFocus(null); }} />
          </View>
          <Text style={styles.hint}>Este arquivo está "em foco": a Yui o recebe como contexto.</Text>
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
            <ScrollView horizontal>
              <Text selectable style={styles.codeText}>{file.content}</Text>
            </ScrollView>
          </ScrollView>
        </Card>
      ) : null}
    </ScrollView>
  );

  const banner = !status.canWrite ? (
    <View style={styles.banner}>
      <Text style={styles.hint}>
        {status.coreReadOnly
          ? 'Somente leitura: a Yui lê o projeto e responde, mas não grava arquivos nem roda comandos (YUI_READ_ONLY=true no .env, o padrão).'
          : !status.local
            ? 'Pelo celular a Yui só lê e responde. Para gravar ou rodar comandos, use o app no computador (é lá que as aprovações são dadas).'
            : 'Somente leitura.'}
      </Text>
    </View>
  ) : (
    <View style={styles.banner}>
      <Text style={styles.hint}>
        {status.approval === 'auto' ? 'Grava arquivos sem perguntar (com backup); comandos ainda pedem aprovação.' : 'Antes de gravar um arquivo ou rodar um comando, a Yui pede a sua aprovação aqui.'}
      </Text>
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <PageHeader
        title="Código"
        subtitle={project ? `Projeto: ${project.name}` : 'Escolha um projeto'}
        right={
          <View style={styles.chips}>
            {!wide ? <IconButton testID="btn-toggle-files" icon={showFiles ? 'cancel' : 'menu'} label={showFiles ? 'Ocultar projetos e arquivos' : 'Projetos e arquivos'} onPress={() => setShowFiles(!showFiles)} /> : null}
            {projectId ? (
              wide
                ? <Button testID="btn-clear-code" label="Limpar conversa" variant="ghost" icon="delete" onPress={clearConversation} style={styles.smallBtn} />
                : <IconButton testID="btn-clear-code" icon="delete" label="Limpar conversa" onPress={clearConversation} />
            ) : null}
          </View>
        }
      />
      <View style={[styles.body, wide && { flexDirection: 'row' }]}>
        {wide || showFiles ? sidebar : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          {banner}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
            {status.modes.map((m) => <Chip key={m.id} testID={`mode-${m.id}`} label={m.label + (m.readOnly ? ' (leitura)' : '')} on={mode === m.id} onPress={() => setMode(m.id)} />)}
          </ScrollView>

          {!project ? (
            <Text style={[styles.hint, { padding: spacing.lg }]}>Selecione ou cadastre um projeto para conversar com a Yui sobre o código.</Text>
          ) : (
            <>
              <FlatList
                ref={listRef}
                testID="code-list"
                data={items}
                keyExtractor={(i) => i.key}
                contentContainerStyle={styles.list}
                onContentSizeChange={scrollToEnd}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Icon name="code" size={36} color={colors.accentText} />
                    <Text style={styles.emptyTitle}>Vamos mexer no código?</Text>
                    <Text style={styles.hint}>Pergunte sobre o projeto, peça uma revisão ou uma mudança. Clique num arquivo para deixá-lo em foco.</Text>
                  </View>
                }
                renderItem={({ item }) => <Row item={item} canApprove={Boolean(status.local)} onAnswer={answer} />}
              />
              {running ? (
                <View style={styles.typing} testID="code-typing">
                  <ActivityIndicator size="small" color={colors.accent} />
                  <Text style={styles.typingText}>{stepText || 'Trabalhando…'}</Text>
                </View>
              ) : null}
              {focus ? <Text style={[styles.hint, { paddingHorizontal: spacing.lg }]}>Em foco: {focus}</Text> : null}
              <View style={styles.composer}>
                <View style={styles.composerInner}>
                  <TextInput
                    testID="code-input"
                    style={styles.composerInput}
                    value={input}
                    onChangeText={setInput}
                    placeholder="Pergunte ou peça uma mudança no projeto…"
                    placeholderTextColor={colors.muted}
                    multiline
                    maxLength={8000}
                    {...(Platform.OS === 'web'
                      ? { onKeyPress: (e: any) => { if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) { e.preventDefault?.(); send(); } } }
                      : {})}
                  />
                  {running ? (
                    <Button testID="btn-cancel-code" label="Parar" variant="danger" onPress={cancel} style={{ minHeight: 40 }} />
                  ) : (
                    <IconButton testID="btn-send-code" icon="arrow_upward" label="Enviar" filled onPress={send} disabled={!input.trim()} />
                  )}
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Row({ item, canApprove, onAnswer }: { item: Item; canApprove: boolean; onAnswer: (item: Extract<Item, { kind: 'approval' }>, approve: boolean) => void }) {
  if (item.kind === 'user') {
    return <View style={[styles.row, { justifyContent: 'flex-end' }]}><View style={[styles.bubble, styles.bubbleMine]}><Text selectable style={[styles.bubbleText, { color: colors.btnFg }]}>{item.text}</Text></View></View>;
  }
  if (item.kind === 'yui') {
    return (
      <View style={styles.row}>
        <View style={[styles.bubble, styles.bubbleYui]}>
          <RichText text={item.text} color={colors.text} />
          {item.meta ? <Text style={styles.meta}>{item.meta}</Text> : null}
        </View>
      </View>
    );
  }
  if (item.kind === 'error') {
    return <View style={styles.row}><View style={[styles.bubble, { borderColor: colors.danger, backgroundColor: colors.dangerBg }]}><Text selectable style={[styles.bubbleText, { color: colors.danger }]}>{item.text}</Text></View></View>;
  }
  if (item.kind === 'tool') {
    const color = item.status === 'ok' ? colors.success : item.status === 'denied' || item.status === 'error' ? colors.danger : colors.muted;
    return (
      <View style={styles.tool}>
        <Text style={[styles.toolText, { color }]}>{item.status === 'ok' ? '✔ ' : item.status === 'denied' || item.status === 'error' ? '✖ ' : '… '}{item.summary}</Text>
        {item.preview && (item.status === 'denied' || item.status === 'error') ? <Text style={styles.toolPreview}>{item.preview}</Text> : null}
      </View>
    );
  }
  const waiting = item.state === 'waiting';
  return (
    <View testID={`approval-${item.id}`} style={[styles.approval, !waiting && { opacity: 0.6 }]}>
      <Text style={styles.approvalTitle}>{waiting ? 'A Yui quer fazer isto:' : item.state === 'approved' ? 'Aprovado:' : item.state === 'expired' ? 'Expirou:' : 'Negado:'} {item.summary}</Text>
      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled><Text selectable style={styles.codeText}>{item.preview}</Text></ScrollView>
      {waiting ? (
        <View style={{ gap: spacing.sm }}>
          {!canApprove ? <Text style={styles.hint}>Aprove no computador da Yui (abra o app lá). Pelo celular só dá para ler.</Text> : null}
          <View style={styles.chips}>
            <Button testID="btn-approve" label="Aprovar" onPress={() => onAnswer(item, true)} disabled={!canApprove} style={styles.smallBtn} />
            <Button testID="btn-deny" label="Negar" variant="ghost" onPress={() => onAnswer(item, false)} style={styles.smallBtn} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, minHeight: 0 },
  side: { width: 300, flexGrow: 0, flexShrink: 0, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.surface },
  sideNarrow: { maxHeight: 340, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  sideTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  chipScroll: { flexGrow: 0, flexShrink: 0 },
  chipRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  banner: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13 },
  smallBtn: { minHeight: 36, paddingHorizontal: spacing.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  input: { backgroundColor: colors.inputBg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, color: colors.text, paddingHorizontal: spacing.md, paddingVertical: 8, fontSize: 13 },
  treeRow: { paddingVertical: 4, paddingRight: spacing.sm, borderRadius: radius.sm },
  treeText: { color: colors.text, fontSize: 13 },
  list: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1, width: '100%', maxWidth: 900, alignSelf: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: spacing.sm },
  emptyTitle: { color: colors.text, fontSize: 20, fontFamily: fonts.title, fontWeight: '700' },
  row: { flexDirection: 'row' },
  bubble: { maxWidth: '88%', borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, gap: spacing.sm, borderWidth: 1 },
  bubbleMine: { backgroundColor: colors.btnBg, borderColor: 'transparent' },
  bubbleYui: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  bubbleText: { fontSize: 14, lineHeight: 21 },
  meta: { color: colors.muted, fontSize: 11 },
  codeBox: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, padding: spacing.sm, gap: 2 },
  codeLang: { color: colors.muted, fontSize: 11 },
  codeText: { color: colors.text, fontSize: 12.5, lineHeight: 18, fontFamily: MONO },
  tool: { borderColor: colors.border, borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 6, alignSelf: 'flex-start', maxWidth: '92%' },
  toolText: { fontSize: 12.5 },
  toolPreview: { color: colors.muted, fontSize: 12, marginTop: 4 },
  approval: { borderColor: colors.warning, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surface },
  approvalTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  typing: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  typingText: { color: colors.muted, fontSize: 13, fontStyle: 'italic' },
  composer: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, padding: spacing.md },
  composerInner: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, width: '100%', maxWidth: 900, alignSelf: 'center' },
  composerInput: { flex: 1, maxHeight: 140, minHeight: 40, backgroundColor: colors.inputBg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, color: colors.text, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 14 },
});
