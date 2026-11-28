import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiError, type AvisosResult, type PlanoView, type PlanosResult, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { ChaveDaDm } from '../components/ChaveDaDm.tsx';
import { TEXTOS_DA_CHAVE, erroDaChave, textoDaChaveEnviada } from '../confirmacaoLogic.ts';
import { rotuloDoValor } from '../valoresLogic.ts';
import { Badge, Button, Card, SectionHeading, StateView } from '../components/ui.tsx';
import {
  avisoDosPlanos,
  confirmacaoDeAprovacao,
  linhaDaFila,
  linhaObservada,
  nomeDaOrigem,
  ordenarObservados,
  pedidoDeDecisao,
  podeAprovar,
  podeDecidir,
  resultadoDaDecisao,
  TEXTO_APROVAR_PELA_DM,
  resumoDaContagem,
  resumoDosPlanos,
  textoDoModo,
  vistaDoPlano,
  type LinhaDeAviso,
  type Tom,
} from '../planosLogic.ts';
import { colors, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const COR: Record<Tom, string> = { ok: colors.success, atencao: colors.warning, critico: colors.danger, neutro: colors.muted };

type Decidir = (p: PlanoView, aprovar: boolean) => void;
/** Correção C2: a chave de confirmação pedida para aprovar UM plano (o campo aparece no cartão dele). */
interface EstadoDaChave { planoId: string; aviso: string; erro: string | null }
interface AcoesDaChave { confirmar: (p: PlanoView, chave: string) => void; pedirOutra: (p: PlanoView) => void; cancelar: () => void }

function PlanoCard({ p, decide, aprova, onDecidir, ocupado, chave, acoesDaChave }: {
  p: PlanoView; decide: boolean; aprova: boolean; onDecidir: Decidir; ocupado: boolean; chave: EstadoDaChave | null; acoesDaChave: AcoesDaChave;
}) {
  const v = vistaDoPlano(p);
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
      {v.passos.map((s) => (
        <View key={s.texto} style={styles.passo} testID="plano-passo">
          <View style={styles.kv}>
            <Text style={[styles.value, { flex: 1 }]}>{s.texto}</Text>
            <Text style={[styles.label, { color: COR[s.tom] }]}>{s.estado}</Text>
          </View>
          {s.detalhe ? <Text style={styles.hint}>{s.detalhe}</Text> : null}
        </View>
      ))}
      {v.nota ? <Text style={styles.hint}>{v.nota}</Text> : null}
      {decide ? (
        <View style={styles.acoes}>
          <Button testID={`plano-recusar-${p.id}`} label="Recusar" variant="dangerOutline" compact onPress={() => onDecidir(p, false)} disabled={ocupado} />
          {aprova ? <Button testID={`plano-aprovar-${p.id}`} label="Aprovar" icon="check" compact onPress={() => onDecidir(p, true)} loading={ocupado} /> : null}
        </View>
      ) : null}
      {decide && !aprova ? <Text style={styles.hint} testID={`plano-so-pela-dm-${p.id}`}>{TEXTO_APROVAR_PELA_DM}</Text> : null}
      {chave ? (
        <ChaveDaDm
          testID={`plano-chave-${p.id}`}
          aviso={chave.aviso}
          erro={chave.erro}
          ocupado={ocupado}
          onConfirmar={(c) => acoesDaChave.confirmar(p, c)}
          onPedirOutra={() => acoesDaChave.pedirOutra(p)}
          onCancelar={acoesDaChave.cancelar}
        />
      ) : null}
    </Card>
  );
}

function LinhaAviso({ l, testID }: { l: LinhaDeAviso; testID: string }) {
  return (
    <View style={styles.linha} testID={testID}>
      <View style={[styles.dot, { backgroundColor: COR[l.tom] }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.value}>{l.titulo}</Text>
        <Text style={styles.hint}>{l.detalhe}</Text>
      </View>
    </View>
  );
}

/**
 * Planos e avisos (só o dono): os últimos planos com aprovação e o que a fila de avisos guardou ou, no modo observar, teria adiado.
 * Com YUI_PLANOS_PAINEL (entrega E), o plano aguardando e dentro da validade ganha Aprovar (com confirmação) e Recusar, que chamam a MESMA decisão dos botões
 * da DM; sem a chave, só leitura. O servidor nunca manda os argumentos nem os resultados de um plano, nem o texto de um aviso.
 */
export function PlanosEAvisos({ client }: { client: YuiClient }) {
  const [planos, setPlanos] = useState<PlanosResult | null>(null);
  const [avisos, setAvisos] = useState<AvisosResult | null>(null);
  const [erroPlanos, setErroPlanos] = useState<string | null>(null);
  const [erroAvisos, setErroAvisos] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidindo, setDecidindo] = useState<string | null>(null);
  const [resposta, setResposta] = useState<{ texto: string; tom: Tom } | null>(null);
  const [chave, setChave] = useState<EstadoDaChave | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [p, a] = await Promise.allSettled([client.admin.planos(), client.admin.avisos()]);
    if (p.status === 'fulfilled') { setPlanos(p.value); setErroPlanos(null); } else setErroPlanos(errText(p.reason));
    if (a.status === 'fulfilled') { setAvisos(a.value); setErroAvisos(null); } else setErroAvisos(errText(a.reason));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Aprovar pede confirmação e depois a chave que chega pela DM (correção C2); recusar não pede nenhuma das duas. Depois da resposta, a frase do servidor
  // aparece e a lista recarrega (os botões somem quando o plano sai de "aguardando").
  const enviarDecisao = async (p: PlanoView, aprovar: boolean, confirmacao?: string) => {
    setDecidindo(p.id);
    setResposta(null);
    try {
      setResposta(resultadoDaDecisao(await client.admin.decidirPlano(p.id, { ...pedidoDeDecisao(p, aprovar), ...(confirmacao ? { confirmacao } : {}) })));
      setChave(null);
    } catch (e) {
      // erro da CHAVE (inválida, faltou, travada): o campo fica aberto com a frase do servidor; o resto fecha o campo
      if (confirmacao && e instanceof ApiError && erroDaChave(e.status)) {
        setChave((c) => (c ? { ...c, erro: errText(e) } : c));
        setDecidindo(null);
        return;
      }
      setChave(null);
      setResposta({ texto: errText(e), tom: 'critico' });
    } finally {
      setDecidindo(null);
    }
    await reload();
  };
  const pedirChave = async (p: PlanoView) => {
    setDecidindo(p.id);
    setResposta(null);
    try {
      const r = await client.admin.pedirConfirmacao({ acao: 'plano.aprovar', plano: { id: p.id, versao: p.versao, hash: String(p.hash ?? '') } });
      setChave({ planoId: p.id, aviso: textoDaChaveEnviada(r, TEXTOS_DA_CHAVE.paraAprovar), erro: null });
    } catch (e) {
      setChave(null);
      setResposta({ texto: errText(e), tom: 'critico' });
    } finally {
      setDecidindo(null);
    }
  };
  const acoesDaChave: AcoesDaChave = {
    confirmar: (p, c) => { enviarDecisao(p, true, c); },
    pedirOutra: (p) => { pedirChave(p); },
    cancelar: () => setChave(null),
  };
  const decidir: Decidir = (p, aprovar) => {
    if (!aprovar) {
      setChave(null);
      enviarDecisao(p, false);
      return;
    }
    const c = confirmacaoDeAprovacao(p);
    confirmAction(c.titulo, c.mensagem, () => { pedirChave(p); }, c.sim);
  };

  const aviso = avisoDosPlanos(planos);
  const modo = avisos ? textoDoModo(avisos.modo) : null;
  const fila = avisos?.fila.itens ?? [];
  return (
    <View style={styles.section}>
      <SectionHeading
        title="Planos"
        hint={planos ? resumoDosPlanos(planos.planos) : undefined}
        right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />}
      />
      <Text style={styles.hint}>
        Os planos que você pede na DM ("monta um plano: ..."): só leituras, com no máximo 5 passos. Aqui aparecem os últimos 20, com o que cada passo faz e o
        estado dele. O que você escreveu (o nome buscado, a pesquisa, o nome da lista) e os resultados nunca saem do servidor: aqui aparece só o tamanho.
      </Text>
      {loading && !planos && !erroPlanos ? <StateView kind="loading" /> : null}
      {erroPlanos ? <StateView kind="error" testID="planos-erro" message={erroPlanos} onRetry={reload} /> : null}
      {aviso ? <Text testID="planos-aviso" style={styles.hint}>{aviso}</Text> : null}
      {resposta ? <Text testID="planos-resposta" style={[styles.resposta, { color: COR[resposta.tom] }]}>{resposta.texto}</Text> : null}
      {planos && planos.planos.length === 0 ? (
        <StateView testID="planos-vazio" kind="empty" title="Nenhum plano." message={'Na sua DM, diga por exemplo: "monta um plano: o que tenho hoje e o que chegou na biblioteca".'} />
      ) : null}
      {planos?.planos.map((p) => (
        <PlanoCard
          key={`${p.id}-${p.versao}`}
          p={p}
          decide={podeDecidir(p, planos)}
          aprova={podeAprovar(p, planos)}
          onDecidir={decidir}
          ocupado={decidindo === p.id}
          chave={chave?.planoId === p.id && podeAprovar(p, planos) ? chave : null}
          acoesDaChave={acoesDaChave}
        />
      ))}

      <SectionHeading title="Filtro de avisos" hint={modo?.titulo} />
      {loading && !avisos && !erroAvisos ? <StateView kind="loading" /> : null}
      {erroAvisos ? <StateView kind="error" testID="avisos-erro" message={erroAvisos} onRetry={reload} /> : null}
      {avisos && modo ? (
        <>
          <Card style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{modo.titulo}</Text>
              <Badge label={rotuloDoValor('YUI_AVISOS_FILTRO', avisos.modo)} color={COR[modo.tom]} />
            </View>
            <Text testID="avisos-modo" style={styles.hint}>{modo.texto}</Text>
          </Card>
          <Card style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Guardados na fila</Text>
              <Badge label={String(avisos.fila.total)} color={avisos.fila.total ? colors.warning : colors.muted} />
            </View>
            {avisos.fila.ilegivel ? <Text style={styles.error}>Não consegui ler a fila de avisos: enquanto isso, os avisos saem na hora.</Text> : null}
            {avisos.fila.resumoPendente ? <Text style={styles.hint}>O resumo da manhã está esperando para sair.</Text> : null}
            {fila.length === 0 && !avisos.fila.ilegivel ? <Text testID="avisos-fila-vazia" style={styles.hint}>Nada guardado agora.</Text> : null}
            {fila.map((a, i) => <LinhaAviso key={`f${i}`} testID="aviso-fila" l={linhaDaFila(a)} />)}
          </Card>
          {avisos.observados.map((o) => (
            <Card key={o.origem} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>Só observando: {nomeDaOrigem(o.origem)}</Text>
                {o.indisponivel ? <Badge label="Sem leitura" color={colors.muted} /> : null}
              </View>
              {o.indisponivel ? (
                <Text style={styles.hint}>O bot do Discord não respondeu agora; o que ele registrou aparece quando ele voltar.</Text>
              ) : (
                <>
                  <Text style={styles.hint}>{resumoDaContagem(o.contagem)} desde que ligou. Fica só na memória e recomeça a cada reinício.</Text>
                  {ordenarObservados(o.registros).map((r, i) => <LinhaAviso key={`o${i}`} testID="aviso-observado" l={linhaObservada(r)} />)}
                  {!o.registros?.length ? <Text style={styles.hint}>Nada teria sido adiado.</Text> : null}
                </>
              )}
            </Card>
          ))}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  resposta: { fontSize: 14, fontWeight: '600' },
  acoes: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, flexWrap: 'wrap', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  passo: { gap: 2 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  linha: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
});
