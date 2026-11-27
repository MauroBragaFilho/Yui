import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiError, type MonitorView, type MonitoresResult, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, SectionHeading, StateView } from '../components/ui.tsx';
import {
  TEXTO_MONITORES_DESLIGADOS,
  confirmacaoDeCancelamento,
  ordenarMonitores,
  resumoDosMonitores,
  vistaDoMonitor,
  type Tom,
} from '../monitoresLogic.ts';
import { colors, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const COR: Record<Tom, string> = { ok: colors.success, atencao: colors.warning, neutro: colors.muted };

function MonitorCard({ m, onCancel }: { m: MonitorView; onCancel: (m: MonitorView) => void }) {
  const v = vistaDoMonitor(m);
  return (
    <Card style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>{v.titulo}</Text>
        <Badge label={v.estado.texto} color={COR[v.estado.tom]} />
      </View>
      {v.linhas.map((l) => (
        <View key={l.rotulo} style={styles.kv}>
          <Text style={styles.label}>{l.rotulo}</Text>
          <Text style={styles.value}>{l.valor}</Text>
        </View>
      ))}
      {v.nota ? <Text style={styles.hint}>{v.nota}</Text> : null}
      <View style={styles.rowBetween}>
        <Text style={styles.hint}>Monitor #{v.id}</Text>
        {v.podeCancelar ? (
          <Button testID={`monitor-cancelar-${v.id}`} label="Cancelar" variant="dangerOutline" compact onPress={() => onCancel(m)} style={styles.smallBtn} />
        ) : null}
      </View>
    </Card>
  );
}

/** Os monitores de busca criados pela conversa ("me avisa quando..."): ver e cancelar. Só o dono; só leitura do texto dos resultados (nunca vem). */
export function Monitores({ client }: { client: YuiClient }) {
  const [data, setData] = useState<MonitoresResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ texto: string; ok: boolean } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await client.admin.monitores());
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  function cancelar(m: MonitorView) {
    const c = confirmacaoDeCancelamento(m);
    confirmAction(
      c.titulo,
      c.mensagem,
      async () => {
        setMsg(null);
        try {
          await client.admin.cancelMonitor(m.id);
          setMsg({ texto: `Monitor #${m.id} cancelado.`, ok: true });
        } catch (e) {
          setMsg({ texto: errText(e), ok: false });
        }
        await reload();
      },
      c.sim
    );
  }

  const lista = data?.ligado ? ordenarMonitores(data.monitores ?? []) : [];
  return (
    <View style={styles.section}>
      <SectionHeading
        title="Monitores"
        hint={data?.ligado ? resumoDosMonitores(lista) : undefined}
        right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />}
      />
      <Text style={styles.hint}>
        Os monitores de busca que você criou pela conversa ("me avisa quando..."). A Yui confere de tempos em tempos e avisa só você, por DM. Para criar um novo, peça na sua DM.
      </Text>
      {loading && !data ? <StateView kind="loading" /> : null}
      {error ? <StateView kind="error" testID="admin-error" message={error} onRetry={reload} /> : null}
      {msg ? <Text testID="monitores-msg" style={msg.ok ? styles.ok : styles.error}>{msg.texto}</Text> : null}
      {data && !data.ligado ? (
        <Card style={styles.card}>
          <Badge label="Desligados" color={colors.muted} />
          <Text testID="monitores-desligados" style={styles.hint}>{TEXTO_MONITORES_DESLIGADOS}</Text>
        </Card>
      ) : null}
      {data?.ligado && lista.length === 0 ? (
        <StateView testID="monitores-vazio" kind="empty" title="Nenhum monitor." message={'Diga na sua DM, por exemplo: "me avisa quando sair o patch novo".'} />
      ) : null}
      {lista.map((m) => (
        <MonitorCard key={m.id} m={m} onCancel={cancelar} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1, textAlign: 'right' },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  ok: { color: colors.success, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  smallBtn: { minHeight: 44, paddingHorizontal: spacing.md },
});
