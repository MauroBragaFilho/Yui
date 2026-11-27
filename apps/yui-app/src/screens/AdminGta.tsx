import React, { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { ApiError, type GtaAlvo, type GtaPublicacao, type GtaView, type TipoDoGta, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, SectionHeading, StateView } from '../components/ui.tsx';
import {
  TEXTO_SEM_DIARIO, TEXTO_SEM_NOTICIA, TEXTO_SEM_SEMANAL, alvosDoTipo, avisoDeErros, confirmacaoDaRepublicacao, dataEHora, linhasDasFontes, ondeSaiu,
  resumoDaNoticia, resumoDoDiario, resumoDoSemanal, rotuloDoAlvo, semRepublicar, textoDaRepublicacao,
  type Bloco, type Tom,
} from '../gtaLogic.ts';
import { colors, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const COR: Record<Tom, string> = { ok: colors.success, atencao: colors.warning, critico: colors.danger, neutro: colors.muted };

function Onde({ publicado, comCanal, testID }: { publicado: GtaPublicacao[]; comCanal: number; testID: string }) {
  const o = ondeSaiu(publicado, comCanal);
  return (
    <View style={{ gap: 2 }} testID={testID}>
      <Text style={styles.label}>{o.resumo}</Text>
      {o.linhas.map((l) => <Text key={l} style={styles.hint}>• {l}</Text>)}
    </View>
  );
}

/**
 * Republicar o mais recente deste tipo (item 9 v2): só nos servidores com o canal do tipo configurado, sempre com confirmação. O servidor publica no canal
 * configurado (nunca num canal escolhido aqui) e aceita 1 republicação do mesmo tipo no mesmo servidor a cada 10 minutos.
 */
function Republicar({ client, tipo, view, onDone }: { client: YuiClient; tipo: TipoDoGta; view: GtaView; onDone: () => Promise<void> }) {
  const [aberto, setAberto] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const alvos = alvosDoTipo(view, tipo);
  const motivo = semRepublicar(view, tipo);
  if (motivo) return <Text style={styles.hint} testID={`gta-republicar-${tipo}-sem`}>{motivo}</Text>;
  if (!alvos.length) return null;

  async function publicar(a: GtaAlvo) {
    setBusy(a.servidorId);
    setErro(null);
    setInfo(null);
    try {
      await client.admin.republicarGta({ tipo, guildId: a.servidorId });
      setInfo(textoDaRepublicacao(tipo, a));
      await onDone();
    } catch (e) {
      setErro(errText(e));
    } finally {
      setBusy(null);
    }
  }
  function pedir(a: GtaAlvo) {
    const c = confirmacaoDaRepublicacao(tipo, a);
    confirmAction(c.titulo, c.mensagem, () => { publicar(a); }, 'Republicar');
  }

  return (
    <View style={{ gap: spacing.xs }}>
      <Button testID={`gta-republicar-${tipo}`} label={aberto ? 'Fechar' : 'Republicar'} variant="ghost" compact onPress={() => setAberto(!aberto)} />
      {aberto ? <Text style={styles.hint}>Escolha o servidor; sai no canal configurado dele.</Text> : null}
      {aberto ? alvos.map((a) => (
        <Button key={a.servidorId} testID={`gta-republicar-${tipo}-${a.servidorId}`} label={rotuloDoAlvo(a)} variant="ghost" compact loading={busy === a.servidorId} disabled={busy !== null && busy !== a.servidorId} onPress={() => pedir(a)} />
      )) : null}
      {info ? <Text style={styles.ok}>{info}</Text> : null}
      {erro ? <Text accessibilityRole="alert" style={styles.warn}>{erro}</Text> : null}
    </View>
  );
}

function BlocoCard({ titulo, bloco, vazio, link, publicado, comCanal, testID, rodape, acao }: {
  titulo: string; bloco: Bloco | null; vazio: string; link?: string | null; publicado?: GtaPublicacao[]; comCanal: number; testID: string; rodape?: string | null;
  acao?: React.ReactNode;
}) {
  return (
    <Card style={styles.card}>
      <Text style={styles.sectionTitle}>{titulo}</Text>
      {!bloco ? <Text style={styles.hint} testID={`${testID}-vazio`}>{vazio}</Text> : (
        <>
          <Text style={styles.cardTitle}>{bloco.titulo}</Text>
          {bloco.linhas.map((l) => (
            <View key={`${l.rotulo}-${l.valor}`} style={styles.kv}>
              <Text style={styles.label}>{l.rotulo}</Text>
              <Text style={styles.value}>{l.valor}</Text>
            </View>
          ))}
          {rodape ? <Text style={styles.hint}>{rodape}</Text> : null}
          {link ? <Button label="Abrir a fonte" variant="ghost" compact onPress={() => { Linking.openURL(link).catch(() => undefined); }} /> : null}
          <Onde publicado={publicado ?? []} comCanal={comCanal} testID={`${testID}-onde`} />
          {acao}
        </>
      )}
    </Card>
  );
}

/**
 * GTA (só o dono): o último reset diário, o último evento semanal válido e a última notícia do Newswire, onde cada um saiu e o estado das fontes, e
 * republicar o mais recente de cada um num servidor (item 9 v2, com confirmação). Os dados são do bot: com o cérebro separado e o bot fora, a tela diz que
 * está indisponível.
 */
export function Gta({ client }: { client: YuiClient }) {
  const [data, setData] = useState<GtaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await client.admin.gta());
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  const aviso = data ? avisoDeErros(data.erros) : null;
  return (
    <View style={styles.section}>
      <SectionHeading title="GTA" hint="O que saiu, onde e de onde vem" right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />} />
      <Text style={styles.hint}>Republicar manda de novo o mais recente no canal configurado do servidor escolhido. Os canais de cada servidor ficam em Servidores; ligar e desligar o semanal e as notícias, em Configuração e chaves.</Text>
      {loading && !data ? <StateView kind="loading" /> : null}
      {error ? <StateView kind="error" testID="admin-error" message={error} onRetry={reload} /> : null}
      {aviso ? <Text accessibilityRole="alert" style={styles.warn}>{aviso}</Text> : null}
      {data ? (
        <>
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>Fontes</Text>
            {linhasDasFontes(data.fontes).map((l) => (
              <View key={l.chave} testID={`gta-fonte-${l.chave}`} style={styles.fonte}>
                <View style={[styles.dot, { backgroundColor: COR[l.tom] }]} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.value}>{l.rotulo}</Text>
                  <Text style={styles.hint}>{l.texto}</Text>
                </View>
              </View>
            ))}
          </Card>
          <BlocoCard
            testID="gta-diario" titulo="Reset diário" bloco={resumoDoDiario(data.diario)} vazio={TEXTO_SEM_DIARIO}
            publicado={data.diario?.publicado} comCanal={data.canais.diario} rodape={data.diario?.coletadoEm ? `Coletado em ${dataEHora(data.diario.coletadoEm)}.` : null}
            acao={<Republicar client={client} tipo="diario" view={data} onDone={reload} />}
          />
          <BlocoCard
            testID="gta-semanal" titulo="Evento semanal" bloco={resumoDoSemanal(data.semanal)} vazio={TEXTO_SEM_SEMANAL} link={data.semanal?.link}
            publicado={data.semanal?.publicado} comCanal={data.canais.semanal} rodape={data.semanal?.salvoEm ? `Salvo em ${dataEHora(data.semanal.salvoEm)}.` : null}
            acao={<Republicar client={client} tipo="semanal" view={data} onDone={reload} />}
          />
          <BlocoCard
            testID="gta-noticia" titulo="Última notícia" bloco={resumoDaNoticia(data.noticia)} vazio={TEXTO_SEM_NOTICIA} link={data.noticia?.link}
            publicado={data.noticia?.publicado} comCanal={data.canais.noticias}
            acao={<Republicar client={client} tipo="noticia" view={data} onDone={reload} />}
          />
          <View style={styles.badges}>
            <Badge label={`Diário: ${data.canais.diario} servidor(es) com canal`} color={colors.muted} />
            <Badge label={`Semanal: ${data.canais.semanal}`} color={colors.muted} />
            <Badge label={`Notícias: ${data.canais.noticias}`} color={colors.muted} />
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '700' },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  warn: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  ok: { color: colors.success, fontSize: 13, lineHeight: 18 },
  kv: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: spacing.md, rowGap: 2 },
  fonte: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
