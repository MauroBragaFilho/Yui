import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type YuiClient } from '../api/client.ts';
import { Badge, Button, Card, Chip, Icon, IconButton, PageHeader } from '../components/ui.tsx';
import {
  breadcrumbs, describeBdsAudit, describeBdsStatus, diskUsage, formatBytes, formatWhen, iconFor, joinPath, nameProblem, normalizeItems, parentPath, previewKind, sortItems,
  type FileItem, type PreviewKind,
} from '../filesLogic.ts';
import { colors, fonts, radius, spacing } from '../theme.ts';

type Props = { client: YuiClient };
type Mode = 'files' | 'recent' | 'trash' | 'server';
type Upload = { id: number; name: string; sent: number; total: number; state: 'enviando' | 'ok' | 'erro'; error?: string };

const MAX_ROWS = 300;
const web = Platform.OS === 'web';
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado. Tente de novo.');

/**
 * Arquivos (só o dono): o servidor de arquivos BDS dentro do painel da Yui. Tudo passa pela API da Yui (login do dono), que fala com o
 * BDS Server por dentro do notebook. Navegar, buscar, assistir/baixar, enviar (arrastar e soltar), criar pasta, renomear, apagar
 * (vai para a lixeira, com restauração), e a aba do servidor (estado e auditoria).
 */
export function FilesScreen({ client }: Props) {
  const [mode, setMode] = useState<Mode>('files');
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [disk, setDisk] = useState<ReturnType<typeof diskUsage>>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FileItem[] | null>(null);
  const [recent, setRecent] = useState<FileItem[]>([]);
  const [trash, setTrash] = useState<(FileItem & { original?: string | null })[]>([]);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // item com as ações abertas
  const [rename, setRename] = useState<{ path: string; name: string } | null>(null);
  const [mk, setMk] = useState<string | null>(null); // nome da pasta nova (null = fechado)
  const [confirm, setConfirm] = useState<{ path: string; kind: 'apagar' | 'esvaziar' } | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<{ kind: Exclude<PreviewKind, null>; url: string; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<any>(null);
  const uploadId = useRef(0);

  const fail = (e: unknown) => { setError(errText(e)); setLoading(false); };

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true); setError(null); setOpen(null); setFound(null);
    try {
      const r = await client.bds.list(dir);
      const all = sortItems(normalizeItems(r, dir));
      setItems(all.slice(0, MAX_ROWS)); setTruncated(all.length > MAX_ROWS);
      setPath(String((r as any)?.caminho || dir));
      setLoading(false);
    } catch (e) { fail(e); }
  }, [client]);

  // Primeira carga: raízes e espaço do disco, depois a pasta principal.
  useEffect(() => {
    (async () => {
      try {
        const [r, u] = await Promise.allSettled([client.bds.roots(), client.bds.usage()]);
        if (u.status === 'fulfilled') setDisk(diskUsage(u.value));
        if (r.status !== 'fulfilled') throw r.reason;
        const list: string[] = (Array.isArray(r.value) ? r.value : []).filter((x: any) => x?.existe !== false).map((x: any) => String(x.caminho));
        setRoots(list);
        if (list.length === 0) { setError('O servidor de arquivos não tem nenhuma pasta configurada.'); setLoading(false); return; }
        await loadDir(list[0]);
      } catch (e) { fail(e); }
    })();
  }, [client, loadDir]);

  const loadMode = useCallback(async (m: Mode) => {
    setMode(m); setError(null); setNotice(null); setOpen(null);
    if (m === 'files') { if (path) await loadDir(path); return; }
    setLoading(true);
    try {
      if (m === 'recent') {
        const r = await client.bds.recent(40);
        setRecent(sortItems(normalizeItems(r, path)).sort(() => 0));
      } else if (m === 'trash') {
        const r: any = await client.bds.trash();
        const list = Array.isArray(r?.itens) ? r.itens : [];
        setTrash(list.map((x: any) => ({ name: String(x.nome), isDir: false, size: typeof x.tamanho === 'number' ? x.tamanho : null, modified: x.apagadoEm ?? x.modificado ?? null, path: String(x.caminho), original: x.original ?? null })));
      } else {
        const [s, a] = await Promise.allSettled([client.bds.status(), client.bds.audit(60)]);
        setStatus(s.status === 'fulfilled' ? (s.value as any) : null);
        setAudit(a.status === 'fulfilled' ? (Array.isArray((a.value as any)?.registros) ? (a.value as any).registros.slice().reverse() : []) : []);
        if (s.status === 'rejected') throw s.reason;
      }
      setLoading(false);
    } catch (e) { fail(e); }
  }, [client, path, loadDir]);

  async function runSearch() {
    const q = query.trim();
    if (q.length < 2) { setFound(null); return; }
    setLoading(true); setError(null);
    try {
      const r: any = await client.bds.search(q);
      setFound(sortItems(normalizeItems(r, path)).slice(0, MAX_ROWS));
      setLoading(false);
    } catch (e) { fail(e); }
  }

  async function refresh() { await (mode === 'files' ? loadDir(path) : loadMode(mode)); }

  async function act(label: string, fn: () => Promise<unknown>, reload = true) {
    setError(null);
    try { await fn(); setNotice(label); if (reload) await refresh(); } catch (e) { setError(errText(e)); }
  }

  async function openItem(it: FileItem) {
    if (it.isDir) { setMode('files'); setFound(null); await loadDir(it.path); return; }
    const kind = previewKind(it.name);
    try {
      if (kind && web) { setPreview({ kind, url: await client.bds.link(it.path, true), name: it.name }); return; }
      await download(it);
    } catch (e) { setError(errText(e)); }
  }

  async function download(it: FileItem) {
    try {
      const url = await client.bds.link(it.path, false);
      if (web) window.open(url, '_blank', 'noopener'); else await Linking.openURL(url);
    } catch (e) { setError(errText(e)); }
  }

  async function sendFiles(files: File[]) {
    if (!web || files.length === 0 || mode !== 'files' || !path) return;
    setNotice(null); setError(null);
    for (const file of files) {
      const id = ++uploadId.current;
      setUploads((u) => [...u, { id, name: file.name, sent: 0, total: file.size, state: 'enviando' }]);
      try {
        await client.bds.upload(joinPath(path, file.name), file, (sent, total) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, sent, total } : x))));
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, sent: x.total, state: 'ok' } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'erro', error: errText(e) } : x)));
      }
    }
    await loadDir(path);
  }

  const crumbs = path ? breadcrumbs(path, roots) : [];
  const rows: FileItem[] = mode === 'files' ? (found ?? items) : mode === 'recent' ? recent : [];
  const atRoot = roots.some((r) => r.toLowerCase() === path.replace(/[\\/]+$/, '').toLowerCase());

  const dropProps: any = web ? {
    onDragOver: (e: any) => { e.preventDefault(); if (mode === 'files') setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e: any) => { e.preventDefault(); setDragging(false); sendFiles(Array.from(e.dataTransfer?.files ?? [])); },
  } : {};

  return (
    <View style={styles.root}>
      <PageHeader
        title="Arquivos"
        subtitle="Servidor de arquivos (BDS)"
        right={(
          <>
            {web && mode === 'files' ? <Button testID="files-upload" label="Enviar" icon="upload" onPress={() => fileInput.current?.click()} /> : null}
            {mode === 'files' ? <Button testID="files-mkdir" label="Nova pasta" icon="create_new_folder" variant="ghost" onPress={() => setMk('')} /> : null}
            <Button testID="files-refresh" label="Atualizar" variant="ghost" onPress={refresh} loading={loading} />
          </>
        )}
      />
      {web ? React.createElement('input', { ref: fileInput, type: 'file', multiple: true, style: { display: 'none' }, onChange: (e: any) => { sendFiles(Array.from(e.target.files ?? [])); e.target.value = ''; } }) : null}

      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.chips}>
          <Chip testID="files-tab-files" label="Arquivos" on={mode === 'files'} onPress={() => loadMode('files')} />
          <Chip testID="files-tab-recent" label="Recentes" on={mode === 'recent'} onPress={() => loadMode('recent')} />
          <Chip testID="files-tab-trash" label="Lixeira" on={mode === 'trash'} onPress={() => loadMode('trash')} />
          <Chip testID="files-tab-server" label="Servidor" on={mode === 'server'} onPress={() => loadMode('server')} />
        </View>

        {error ? <Text testID="files-error" style={styles.error}>{error}</Text> : null}
        {notice ? <Text testID="files-notice" style={styles.notice}>{notice}</Text> : null}

        {disk && mode === 'files' ? (
          <Card style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.hint}>Espaço no disco do servidor</Text>
              <Text style={styles.hint}>{formatBytes(disk.free)} livres de {formatBytes(disk.total)}</Text>
            </View>
            <View style={styles.track}><View style={[styles.fill, { width: `${100 - disk.freePercent}%`, backgroundColor: disk.freePercent < 10 ? colors.danger : disk.freePercent < 20 ? colors.warning : colors.accent }]} /></View>
          </Card>
        ) : null}

        {mode === 'files' ? (
          <>
            <View style={styles.searchRow}>
              <Icon name="search" size={20} color={colors.muted} />
              <TextInput
                testID="files-search"
                value={query}
                onChangeText={(t) => { setQuery(t); if (!t.trim()) setFound(null); }}
                onSubmitEditing={runSearch}
                placeholder="Buscar arquivos (nome)…"
                placeholderTextColor={colors.muted}
                style={styles.search}
                returnKeyType="search"
              />
              {found ? <IconButton icon="close" label="Limpar busca" size={32} onPress={() => { setQuery(''); setFound(null); }} /> : null}
            </View>

            {!found ? (
              <View style={styles.crumbs}>
                {crumbs.map((c, i) => (
                  <React.Fragment key={c.path}>
                    {i > 0 ? <Icon name="chevron_right" size={18} color={colors.muted} /> : null}
                    <Pressable accessibilityRole="button" onPress={() => loadDir(c.path)}>
                      <Text style={[styles.crumb, i === crumbs.length - 1 && { color: colors.text, fontWeight: '700' }]}>{c.label}</Text>
                    </Pressable>
                  </React.Fragment>
                ))}
              </View>
            ) : <Text style={styles.hint}>{found.length} resultado(s) para “{query.trim()}”</Text>}

            {mk !== null ? (
              <Card style={styles.card}>
                <Text style={styles.label}>Nome da nova pasta</Text>
                <TextInput testID="files-mkdir-name" value={mk} onChangeText={setMk} autoFocus placeholder="Ex.: Filmes 2026" placeholderTextColor={colors.muted} style={styles.input} />
                {nameProblem(mk) && mk ? <Text style={styles.error}>{nameProblem(mk)}</Text> : null}
                <View style={styles.actions}>
                  <Button testID="files-mkdir-ok" label="Criar" disabled={Boolean(nameProblem(mk))} onPress={async () => { const n = mk.trim(); setMk(null); await act('Pasta criada.', () => client.bds.mkdir(joinPath(path, n))); }} />
                  <Button label="Cancelar" variant="ghost" onPress={() => setMk(null)} />
                </View>
              </Card>
            ) : null}

            {web ? (
              React.createElement('div', { ...dropProps, style: { borderRadius: 16, outline: dragging ? `2px dashed ${'var(--accent)'}` : 'none', outlineOffset: 4 } },
                <Text style={styles.drop}>{dragging ? 'Solte para enviar para esta pasta' : 'Dica: arraste arquivos para cá para enviar para esta pasta.'}</Text>)
            ) : null}

            {uploads.length > 0 ? (
              <Card style={styles.card}>
                {uploads.slice(-6).map((u) => (
                  <View key={u.id} style={{ gap: 4 }}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.name} numberOfLines={1}>{u.name}</Text>
                      <Text style={[styles.hint, u.state === 'erro' && { color: colors.danger }]}>{u.state === 'enviando' ? `${Math.round((u.sent / Math.max(1, u.total)) * 100)}%` : u.state === 'ok' ? 'enviado' : 'falhou'}</Text>
                    </View>
                    <View style={styles.track}><View style={[styles.fill, { width: `${Math.round((u.sent / Math.max(1, u.total)) * 100)}%`, backgroundColor: u.state === 'erro' ? colors.danger : colors.accent }]} /></View>
                    {u.error ? <Text style={styles.error}>{u.error}</Text> : null}
                  </View>
                ))}
                <Button label="Limpar lista" variant="ghost" onPress={() => setUploads([])} />
              </Card>
            ) : null}
          </>
        ) : null}

        {loading ? <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} /> : null}

        {(mode === 'files' || mode === 'recent') && !loading ? (
          <Card style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
            {mode === 'files' && !found && !atRoot && path ? (
              <Pressable testID="files-up" accessibilityRole="button" onPress={() => loadDir(parentPath(path))} style={styles.row}>
                <Icon name="arrow_upward" size={22} color={colors.muted} />
                <Text style={styles.name}>Subir um nível</Text>
              </Pressable>
            ) : null}
            {rows.length === 0 ? <Text style={[styles.hint, { padding: spacing.lg }]}>{found ? 'Nada encontrado.' : mode === 'recent' ? 'Nenhum arquivo recente.' : 'Esta pasta está vazia.'}</Text> : null}
            {rows.map((it) => (
              <View key={it.path} style={styles.rowWrap}>
                <Pressable testID="files-row" accessibilityRole="button" onPress={() => (it.isDir ? openItem(it) : setOpen(open === it.path ? null : it.path))} style={styles.row}>
                  <Icon name={iconFor(it.name, it.isDir ? 'dir' : 'arquivo')} size={24} color={it.isDir ? colors.warning : colors.accentText} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>{it.name}</Text>
                    {found || mode === 'recent' ? <Text style={styles.hint} numberOfLines={1}>{parentPath(it.path)}</Text> : null}
                  </View>
                  {!it.isDir ? <Text style={styles.meta}>{formatBytes(it.size)}</Text> : null}
                  <Text style={[styles.meta, styles.metaDate]}>{formatWhen(it.modified)}</Text>
                  {it.isDir ? <IconButton icon="more_vert" label={`Ações de ${it.name}`} size={32} onPress={() => setOpen(open === it.path ? null : it.path)} /> : null}
                </Pressable>

                {open === it.path ? (
                  <View style={styles.menu}>
                    {rename?.path === it.path ? (
                      <>
                        <TextInput testID="files-rename-name" value={rename.name} onChangeText={(t) => setRename({ path: it.path, name: t })} autoFocus style={styles.input} placeholderTextColor={colors.muted} />
                        {nameProblem(rename.name) ? <Text style={styles.error}>{nameProblem(rename.name)}</Text> : null}
                        <View style={styles.actions}>
                          <Button testID="files-rename-ok" label="Renomear" disabled={Boolean(nameProblem(rename.name))} onPress={async () => { const n = rename.name.trim(); setRename(null); await act('Renomeado.', () => client.bds.rename(it.path, joinPath(parentPath(it.path), n))); }} />
                          <Button label="Cancelar" variant="ghost" onPress={() => setRename(null)} />
                        </View>
                      </>
                    ) : confirm?.path === it.path ? (
                      <>
                        <Text style={styles.warn}>Apagar “{it.name}”? Ele vai para a lixeira e dá para restaurar.</Text>
                        <View style={styles.actions}>
                          <Button testID="files-delete-ok" label="Apagar" variant="danger" onPress={async () => { setConfirm(null); await act('Enviado para a lixeira.', () => client.bds.remove(it.path)); }} />
                          <Button label="Cancelar" variant="ghost" onPress={() => setConfirm(null)} />
                        </View>
                      </>
                    ) : (
                      <View style={styles.actions}>
                        {!it.isDir ? <Button testID="files-open" label={previewKind(it.name) && web ? 'Abrir' : 'Baixar'} icon={previewKind(it.name) && web ? 'play_arrow' : 'download'} onPress={() => openItem(it)} /> : null}
                        {!it.isDir && previewKind(it.name) && web ? <Button label="Baixar" icon="download" variant="ghost" onPress={() => download(it)} /> : null}
                        <Button label="Renomear" icon="edit" variant="ghost" onPress={() => setRename({ path: it.path, name: it.name })} />
                        <Button testID="files-delete" label="Apagar" icon="delete" variant="ghost" onPress={() => setConfirm({ path: it.path, kind: 'apagar' })} />
                      </View>
                    )}
                  </View>
                ) : null}
              </View>
            ))}
            {truncated && mode === 'files' ? <Text style={[styles.hint, { padding: spacing.lg }]}>Mostrando os primeiros {MAX_ROWS} itens. Use a busca para achar o resto.</Text> : null}
          </Card>
        ) : null}

        {mode === 'trash' && !loading ? (
          <Card style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
            {trash.length === 0 ? <Text style={[styles.hint, { padding: spacing.lg }]}>A lixeira está vazia.</Text> : null}
            {trash.map((it) => (
              <View key={it.path} style={styles.rowWrap}>
                <View style={styles.row}>
                  <Icon name="delete" size={24} color={colors.muted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>{it.name}</Text>
                    {it.original ? <Text style={styles.hint} numberOfLines={1}>veio de {parentPath(it.original)}</Text> : null}
                  </View>
                  <Text style={styles.meta}>{formatBytes(it.size)}</Text>
                </View>
                <View style={styles.menu}>
                  {confirm?.path === it.path && confirm.kind === 'esvaziar' ? (
                    <>
                      <Text style={styles.warn}>Apagar “{it.name}” de vez? Isso não pode ser desfeito.</Text>
                      <View style={styles.actions}>
                        <Button testID="files-purge-ok" label="Apagar de vez" variant="danger" onPress={async () => { setConfirm(null); await act('Apagado definitivamente.', () => client.bds.purge(it.path)); }} />
                        <Button label="Cancelar" variant="ghost" onPress={() => setConfirm(null)} />
                      </View>
                    </>
                  ) : (
                    <View style={styles.actions}>
                      <Button testID="files-restore" label="Restaurar" icon="restore" onPress={() => act('Restaurado.', () => client.bds.restore(it.path))} />
                      <Button label="Apagar de vez" icon="delete_forever" variant="ghost" onPress={() => setConfirm({ path: it.path, kind: 'esvaziar' })} />
                    </View>
                  )}
                </View>
              </View>
            ))}
          </Card>
        ) : null}

        {mode === 'server' && !loading ? (
          <>
            <Card style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.title}>Estado do servidor</Text>
                <Badge label={status ? '● Ligado' : '● Sem resposta'} color={status ? colors.success : colors.danger} />
              </View>
              {status ? describeBdsStatus(status).map((r) => (
                <View key={r.label} style={styles.rowBetween}><Text style={styles.hint}>{r.label}</Text><Text style={styles.name}>{r.value}</Text></View>
              )) : <Text style={styles.hint}>O BDS Server não respondeu.</Text>}
            </Card>
            <Card style={styles.card}>
              <Text style={styles.title}>Auditoria do BDS Server</Text>
              {audit.length === 0 ? <Text style={styles.hint}>Nada registrado.</Text> : audit.slice(0, 40).map((a, i) => (
                <View key={i} style={styles.rowBetween}>
                  <Text style={[styles.name, describeBdsAudit(a).failed && { color: colors.danger }]} numberOfLines={1}>{describeBdsAudit(a).text}{describeBdsAudit(a).who ? ` · ${describeBdsAudit(a).who}` : ''}{describeBdsAudit(a).failed ? ' (falhou)' : ''}</Text>
                  <Text style={styles.hint}>{formatWhen(a.ts)}</Text>
                </View>
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>

      {preview ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setPreview(null)}>
          <View style={styles.modalBack}>
            <View style={styles.modalBox}>
              <View style={styles.rowBetween}>
                <Text style={styles.title} numberOfLines={1}>{preview.name}</Text>
                <IconButton icon="close" label="Fechar" onPress={() => setPreview(null)} />
              </View>
              {preview.kind === 'video' ? React.createElement('video', { src: preview.url, controls: true, autoPlay: true, style: { width: '100%', maxHeight: '70vh', background: '#000', borderRadius: 12 } }) : null}
              {preview.kind === 'audio' ? React.createElement('audio', { src: preview.url, controls: true, autoPlay: true, style: { width: '100%' } }) : null}
              {preview.kind === 'image' ? React.createElement('img', { src: preview.url, alt: preview.name, style: { maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 12 } }) : null}
              {preview.kind === 'pdf' ? React.createElement('iframe', { src: preview.url, title: preview.name, style: { width: '100%', height: '70vh', border: 0, borderRadius: 12, background: '#fff' } }) : null}
              <Text style={styles.hint}>O link expira em 10 minutos. Vídeos MKV/AVI não tocam no navegador: baixe ou use o HomeFlix.</Text>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, gap: spacing.lg, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  card: { gap: spacing.md, padding: spacing.xl, borderRadius: radius.lg },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  fill: { height: 8, borderRadius: radius.pill },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.lg },
  search: { flex: 1, color: colors.text, paddingVertical: 12, fontSize: 14 },
  crumbs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  crumb: { color: colors.accentText, fontSize: 14, fontWeight: '600', paddingVertical: 4 },
  rowWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.lg },
  name: { color: colors.text, fontSize: 14, flexShrink: 1 },
  meta: { color: colors.muted, fontSize: 12, minWidth: 64, textAlign: 'right' },
  metaDate: { minWidth: 110 },
  menu: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 14 },
  label: { color: colors.muted, fontSize: 12 },
  title: { color: colors.text, fontSize: 18, fontFamily: fonts.title, fontWeight: '700', flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  drop: { color: colors.muted, fontSize: 12, textAlign: 'center', paddingVertical: spacing.sm },
  warn: { color: colors.warning, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  notice: { color: colors.success, fontSize: 13 },
  modalBack: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  modalBox: { width: '100%', maxWidth: 960, backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md, borderWidth: 1, borderColor: colors.border },
});
