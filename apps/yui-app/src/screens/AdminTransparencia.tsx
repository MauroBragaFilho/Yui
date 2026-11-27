import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiError, type ContinuidadeItem, type ContinuidadeView, type ListasView, type SkillsView, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, Chip, SectionHeading, StateView } from '../components/ui.tsx';
import {
  TEXTO_CONTINUIDADE_DESLIGADA, TEXTO_CONTINUIDADE_SEM_MEMORIA, TEXTO_CONTINUIDADE_VAZIA, TEXTO_LISTAS_DESLIGADAS, TEXTO_LISTAS_ILEGIVEIS, TEXTO_LISTAS_VAZIAS,
  confirmacaoDeApagar, filtrarContinuidade, motivoDaSkill, resumoDaContinuidade, resumoDasListas, textoDoFiltro, vistaDaLista, vistaDaSkill, vistaDoItem,
  type FiltroDaContinuidade, type Tom,
} from '../transparenciaLogic.ts';
import { colors, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const COR: Record<Tom, string> = { ok: colors.success, atencao: colors.warning, neutro: colors.muted };

/** Carrega uma leitura do painel, com erro e nova tentativa. */
function useLeitura<T>(fn: () => Promise<T>) {
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
  return { data, error, loading, reload };
}

/** As listas pessoais do dono (só ver; mexer nelas é pela conversa). */
export function Listas({ client }: { client: YuiClient }) {
  const { data, error, loading, reload } = useLeitura<ListasView>(() => client.admin.listas());
  const [aberta, setAberta] = useState<string | null>(null);
  return (
    <View style={styles.section}>
      <SectionHeading title="Listas" hint={data ? resumoDasListas(data) : undefined} right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
      <Text style={styles.hint}>As suas listas pessoais, só as suas. Só ver: para mexer, peça na sua DM ("tira o leite da lista de compras").</Text>
      {loading && !data ? <StateView kind="loading" /> : null}
      {error ? <StateView kind="error" testID="admin-error" message={error} onRetry={reload} /> : null}
      {data && !data.ligado ? <Text testID="listas-desligadas" style={styles.warn}>{TEXTO_LISTAS_DESLIGADAS}</Text> : null}
      {data?.situacao === 'ilegivel' ? <Text testID="listas-ilegiveis" style={styles.warn}>{TEXTO_LISTAS_ILEGIVEIS}</Text> : null}
      {data && data.situacao !== 'ilegivel' && data.listas.length === 0 ? <StateView testID="listas-vazio" kind="empty" title="Nenhuma lista." message={TEXTO_LISTAS_VAZIAS} /> : null}
      {data?.listas.map((l) => {
        const v = vistaDaLista(l);
        const aberto = aberta === l.nome;
        return (
          <Card key={l.nome} style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{v.titulo}</Text>
              <Badge label={v.contagem} color={colors.muted} />
            </View>
            {v.quando ? <Text style={styles.hint}>{v.quando}</Text> : null}
            {v.itens.length ? (
              <Button testID={`lista-abrir-${v.titulo}`} label={aberto ? 'Esconder itens' : 'Ver itens'} variant="ghost" compact onPress={() => setAberta(aberto ? null : l.nome)} />
            ) : null}
            {aberto ? v.itens.map((i) => (
              <Text key={i.n} style={[styles.value, i.feito && styles.feito]}>{i.n}. {i.texto}{i.feito ? ' (feito)' : ''}</Text>
            )) : null}
          </Card>
        );
      })}
    </View>
  );
}

/** As skills instaladas e quais estão permitidas (só ver; ligar e desligar cada uma fica para depois). */
export function Skills({ client }: { client: YuiClient }) {
  const { data, error, loading, reload } = useLeitura<SkillsView>(() => client.admin.skills());
  const filtro = data ? textoDoFiltro(data) : null;
  return (
    <View style={styles.section}>
      <SectionHeading title="Skills" hint={data ? `${data.total} instalada(s)` : undefined} right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
      <Text style={styles.hint}>Instruções extras que a Yui pode seguir na sua DM. Só ver: ligar, desligar e a lista de permitidas ficam em Configuração e chaves.</Text>
      {loading && !data ? <StateView kind="loading" /> : null}
      {error ? <StateView kind="error" testID="admin-error" message={error} onRetry={reload} /> : null}
      {filtro ? <Text testID="skills-filtro" style={[styles.value, { color: COR[filtro.tom] }]}>{filtro.texto}</Text> : null}
      {data?.naoInstaladas.length ? <Text style={styles.warn}>Na lista de permitidas, mas não instaladas: {data.naoInstaladas.join(', ')}.</Text> : null}
      {data && data.skills.length === 0 ? <StateView testID="skills-vazio" kind="empty" title="Nenhuma skill instalada." /> : null}
      {data?.skills.map((s) => {
        const v = vistaDaSkill(s, data.ligado);
        return (
          <Card key={s.nome} style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{v.nome}</Text>
              <Badge label={v.selo} color={COR[v.tom]} />
            </View>
            <Text style={styles.hint}>{v.origem}</Text>
            <Text style={styles.value}>{v.descricao}</Text>
            {v.nota ? <Text style={styles.hint}>{v.nota}</Text> : null}
          </Card>
        );
      })}
      {data?.avisos.length ? (
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Pastas que não carregaram ({data.avisos.length})</Text>
          {data.avisos.map((a, i) => <Text key={`${a.pasta}-${i}`} style={styles.hint}>• {a.pasta}: {motivoDaSkill(a.motivo)}</Text>)}
        </Card>
      ) : null}
    </View>
  );
}

const FILTROS: { valor: FiltroDaContinuidade; rotulo: string }[] = [
  { valor: 'todos', rotulo: 'Tudo' },
  { valor: 'projeto', rotulo: 'Projetos' },
  { valor: 'decisao', rotulo: 'Decisões' },
];

/** Projetos e decisões registrados pela conversa (continuidade): ver e apagar um item, com confirmação. */
export function Continuidade({ client }: { client: YuiClient }) {
  const { data, error, loading, reload } = useLeitura<ContinuidadeView>(() => client.admin.continuidade());
  const [filtro, setFiltro] = useState<FiltroDaContinuidade>('todos');
  const [msg, setMsg] = useState<{ texto: string; ok: boolean } | null>(null);

  function apagar(i: ContinuidadeItem) {
    const c = confirmacaoDeApagar(i);
    confirmAction(c.titulo, c.mensagem, async () => {
      setMsg(null);
      try {
        await client.admin.apagarContinuidade(i.id);
        setMsg({ texto: `#${i.id} apagado.`, ok: true });
      } catch (e) {
        setMsg({ texto: errText(e), ok: false });
      }
      await reload();
    }, c.sim);
  }

  const itens = data ? filtrarContinuidade(data.itens, filtro) : [];
  return (
    <View style={styles.section}>
      <SectionHeading title="Projetos e decisões" hint={data?.memoria ? resumoDaContinuidade(data) : undefined} right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
      <Text style={styles.hint}>O que você pediu para a Yui guardar como projeto ou decisão. Ela usa isso para lembrar do contexto nas conversas com você.</Text>
      {loading && !data ? <StateView kind="loading" /> : null}
      {error ? <StateView kind="error" testID="admin-error" message={error} onRetry={reload} /> : null}
      {msg ? <Text testID="continuidade-msg" style={msg.ok ? styles.ok : styles.error}>{msg.texto}</Text> : null}
      {data && !data.memoria ? <Text testID="continuidade-sem-memoria" style={styles.warn}>{TEXTO_CONTINUIDADE_SEM_MEMORIA}</Text> : null}
      {data?.memoria && !data.ligado ? <Text style={styles.hint}>{TEXTO_CONTINUIDADE_DESLIGADA}</Text> : null}
      {data?.memoria && data.total > 0 ? (
        <View style={styles.chips}>
          {FILTROS.map((f) => <Chip key={f.valor} testID={`continuidade-filtro-${f.valor}`} label={f.rotulo} on={filtro === f.valor} onPress={() => setFiltro(f.valor)} />)}
        </View>
      ) : null}
      {data?.memoria && data.total === 0 ? <StateView testID="continuidade-vazio" kind="empty" title="Nada registrado." message={TEXTO_CONTINUIDADE_VAZIA} /> : null}
      {itens.map((i) => {
        const v = vistaDoItem(i);
        return (
          <Card key={i.id} style={styles.card}>
            <View style={styles.rowBetween}>
              <Badge label={v.tipo} color={i.tipo === 'projeto' ? colors.accentText : colors.success} />
              <Text style={styles.hint}>{v.numero}</Text>
            </View>
            <Text style={styles.value}>{v.texto}</Text>
            <View style={styles.rowBetween}>
              <Text style={styles.hint}>{v.quando}</Text>
              <Button testID={`continuidade-apagar-${i.id}`} label="Apagar" variant="dangerOutline" compact onPress={() => apagar(i)} style={styles.smallBtn} />
            </View>
          </Card>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  value: { color: colors.text, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  warn: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  ok: { color: colors.success, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  feito: { color: colors.muted, textDecorationLine: 'line-through' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  smallBtn: { minHeight: 44, paddingHorizontal: spacing.md },
});
