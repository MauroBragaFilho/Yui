import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type LiveView, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { Badge, Button, Card, Chip, FieldLabel, SectionHeading, StateView } from '../components/ui.tsx';
import { cartaoDaLive, textoDoErroDaLive, type TomDaConta } from '../contasLogic.ts';
import { DURACOES_SUGERIDAS, confirmacaoDeSaida, resultadoDaAcao, rotuloDaDuracao, situacaoDaLive, validarEntrada } from '../liveLogic.ts';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const COR: Record<TomDaConta, string> = { ok: colors.success, atencao: colors.warning, critico: colors.danger, neutro: colors.muted };

/**
 * Live do YouTube (só o dono; lacunas do painel, entrega E, item 4 v2): o estado da live e os botões Entrar e Sair, que passam pelo MESMO comando da conversa
 * ("entra na live <link> por N horas", "sai da live"): as mesmas validações, o mesmo ritmo pela duração, a mesma autorização do canal da Yui e a mesma cota.
 * Sair pede confirmação. A frase do resultado é a do servidor; o texto do chat e quem escreveu nunca chegam aqui.
 */
export function LiveDoYoutube({ client }: { client: YuiClient }) {
  const [live, setLive] = useState<LiveView | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [endereco, setEndereco] = useState('');
  const [horas, setHoras] = useState('');
  const [enviando, setEnviando] = useState<'entrar' | 'sair' | null>(null);
  const [resposta, setResposta] = useState<{ texto: string; tom: TomDaConta } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setLive(await client.admin.live());
      setErro(null);
    } catch (e) {
      setErro(errText(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function entrar() {
    const v = validarEntrada(endereco, horas);
    if (!v.ok) {
      setResposta({ texto: v.erro, tom: 'critico' });
      return;
    }
    setEnviando('entrar');
    setResposta(null);
    try {
      const r = await client.admin.entrarNaLive(v.corpo);
      setResposta(resultadoDaAcao(r));
      if (r.ok) setEndereco('');
    } catch (e) {
      setResposta({ texto: errText(e), tom: 'critico' });
    } finally {
      setEnviando(null);
    }
    await reload();
  }

  function sair() {
    const c = confirmacaoDeSaida(live);
    confirmAction(
      c.titulo,
      c.mensagem,
      async () => {
        setEnviando('sair');
        setResposta(null);
        try {
          setResposta(resultadoDaAcao(await client.admin.sairDaLive()));
        } catch (e) {
          setResposta({ texto: errText(e), tom: 'critico' });
        } finally {
          setEnviando(null);
        }
        await reload();
      },
      c.sim
    );
  }

  const s = live ? situacaoDaLive(live) : null;
  const cartao = cartaoDaLive(live);
  return (
    <View style={styles.section}>
      <SectionHeading
        title="Yui na live"
        hint={s?.titulo}
        right={<Button label="Atualizar" variant="ghost" icon="refresh" compact onPress={reload} loading={loading} />}
      />
      <Text style={styles.hint}>
        A Yui no chat de uma live: ela responde quando a chamam pelo nome e às vezes puxa assunto, sempre em público. Os botões fazem o mesmo que "entra na live
        &lt;link&gt;" e "sai da live" na sua DM ou no Chat.
      </Text>
      {loading && !live && !erro ? <StateView kind="loading" /> : null}
      {erro ? <StateView kind="error" testID="live-erro" message={erro} onRetry={reload} /> : null}
      {resposta ? <Text testID="live-resposta" style={[styles.resposta, { color: COR[resposta.tom] }]}>{resposta.texto}</Text> : null}

      {s ? (
        <Card style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>{cartao ? cartao.titulo : 'Situação'}</Text>
            <Badge label={s.titulo} color={COR[s.tom]} />
          </View>
          <Text testID="live-situacao" style={styles.hint}>{s.texto}</Text>
          {cartao?.linhas.map((l) => (
            <View key={l.rotulo} style={styles.kv}>
              <Text style={styles.label}>{l.rotulo}</Text>
              <Text style={styles.value}>{l.valor}</Text>
            </View>
          ))}
          {cartao?.nota ? <Text style={styles.hint}>{cartao.nota}</Text> : null}
          {!cartao && live?.ultimoErro ? <Text style={styles.hint}>Último erro: {textoDoErroDaLive(live.ultimoErro.codigo)}.</Text> : null}
          {s.podeSair ? (
            <View style={styles.acoes}>
              <Button testID="live-sair" label="Sair da live" variant="dangerOutline" icon="logout" compact onPress={sair} loading={enviando === 'sair'} />
            </View>
          ) : null}
        </Card>
      ) : null}

      {s?.podeEntrar ? (
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Entrar numa live</Text>
          <FieldLabel>Link da live</FieldLabel>
          <TextInput
            testID="live-endereco"
            style={styles.input}
            value={endereco}
            onChangeText={setEndereco}
            placeholder="https://youtube.com/live/..."
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={300}
          />
          <FieldLabel>Duração (opcional)</FieldLabel>
          <View style={styles.chips}>
            {DURACOES_SUGERIDAS.map((h) => (
              <Chip key={h || 'sem'} testID={`live-horas-${h || 'sem'}`} label={rotuloDaDuracao(h)} on={horas === h} onPress={() => setHoras(h)} />
            ))}
          </View>
          <TextInput
            testID="live-horas"
            style={styles.input}
            value={horas}
            onChangeText={(t) => setHoras(t.replace(/\D/g, '').slice(0, 2))}
            placeholder="Outra duração, em horas (1 a 99)"
            placeholderTextColor={colors.muted}
            keyboardType="number-pad"
            maxLength={2}
          />
          <Text style={styles.hint}>
            Com a duração, a Yui ajusta o ritmo de leitura do chat para a cota do dia durar (até 5 h lê a cada 15 s; mais que isso, mais devagar). A resposta diz o ritmo
            escolhido.
          </Text>
          <View style={styles.acoes}>
            <Button testID="live-entrar" label="Entrar na live" icon="login" compact onPress={entrar} loading={enviando === 'entrar'} disabled={!endereco.trim()} />
          </View>
        </Card>
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
  resposta: { fontSize: 14, fontWeight: '600' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  acoes: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, flexWrap: 'wrap', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
});
