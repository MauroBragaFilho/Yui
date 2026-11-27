import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, type GoogleView, type YuiClient } from '../api/client.ts';
import { confirmAction } from '../components/confirm.ts';
import { ChaveDaDm } from '../components/ChaveDaDm.tsx';
import { TEXTOS_DA_CHAVE, erroDaChave, textoDaChaveEnviada } from '../confirmacaoLogic.ts';
import { Button, Card, FieldLabel } from '../components/ui.tsx';
import type { TomDaConta } from '../contasLogic.ts';
import {
  ENDERECO_DO_RETORNO, INSTRUCOES_DA_REAUTORIZACAO, TEXTO_GMAIL_NO_SCRIPT, confirmacaoDeInicio, podeReautorizar, resultadoDoInicio, resultadoDoRetorno, validarEnderecoColado,
  type LinkDaReautorizacao,
} from '../googleLogic.ts';
import { colors, radius, spacing } from '../theme.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado.');
const COR: Record<TomDaConta, string> = { ok: colors.success, atencao: colors.warning, critico: colors.danger, neutro: colors.muted };

/** Abre o link de consentimento numa aba nova (na web, sem dar à página do Google acesso a esta janela nem o endereço do painel). */
function abrirLink(link: string) {
  if (Platform.OS === 'web') window.open(link, '_blank', 'noopener,noreferrer');
  else Linking.openURL(link).catch(() => undefined);
}

/**
 * Reautorizar o Google pelo painel (só o dono; lacunas do painel, entrega F, item 14). Fica em Admin > Integrações, perto do item Google, e só aparece com
 * YUI_GOOGLE_REAUTORIZAR_PAINEL. Começar pede confirmação e a chave que chega pela DM (correção C2), e o servidor devolve SÓ o link de consentimento; depois de autorizar, o dono cola de volta o endereço
 * da página que não abre (127.0.0.1). O endereço é conferido aqui antes de mandar (a sessão do servidor é de uso único). Nada de token ou código fica aqui.
 */
export function ReautorizarGoogle({ client }: { client: YuiClient }) {
  const [google, setGoogle] = useState<GoogleView | null>(null);
  const [vista, setVista] = useState<LinkDaReautorizacao | null>(null);
  const [endereco, setEndereco] = useState('');
  const [enviando, setEnviando] = useState<'inicio' | 'retorno' | null>(null);
  const [resposta, setResposta] = useState<{ texto: string; tom: TomDaConta } | null>(null);
  const [chave, setChave] = useState<{ aviso: string; erro: string | null } | null>(null);

  const reload = useCallback(async () => {
    try {
      setGoogle(await client.admin.google());
    } catch {
      setGoogle(null); // sem o estado, o botão não aparece (o item Google acima continua mostrando o que o servidor disse)
    }
  }, [client]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!podeReautorizar(google)) return null;
  const gmail = Array.isArray(google?.escopos) && google!.escopos!.includes('gmail');

  // Correção C2: começar pede a chave de confirmação pela DM; o link só vem depois da chave certa.
  async function pedirChave() {
    setEnviando('inicio');
    setResposta(null);
    setVista(null);
    setEndereco('');
    try {
      const r = await client.admin.pedirConfirmacao({ acao: 'google.reautorizar' });
      setChave({ aviso: textoDaChaveEnviada(r, TEXTOS_DA_CHAVE.paraGoogle), erro: null });
    } catch (e) {
      setChave(null);
      setResposta({ texto: errText(e), tom: 'critico' });
    } finally {
      setEnviando(null);
    }
  }

  async function iniciarComChave(confirmacao: string) {
    setEnviando('inicio');
    setResposta(null);
    try {
      const r = resultadoDoInicio(await client.admin.googleReautorizarInicio(confirmacao));
      setChave(null);
      if (r?.ok) setVista(r.vista);
      else if (r) setResposta({ texto: r.erro, tom: 'critico' });
    } catch (e) {
      // erro da CHAVE (inválida, faltou, travada): o campo fica aberto com a frase do servidor
      if (e instanceof ApiError && erroDaChave(e.status)) setChave((c) => (c ? { ...c, erro: errText(e) } : c));
      else {
        setChave(null);
        setResposta({ texto: errText(e), tom: 'critico' });
      }
    } finally {
      setEnviando(null);
    }
  }

  function comecar() {
    const c = confirmacaoDeInicio(google);
    confirmAction(c.titulo, c.mensagem, () => { pedirChave(); }, c.sim);
  }

  async function enviar() {
    const v = validarEnderecoColado(endereco);
    if (!v.ok) {
      setResposta({ texto: v.erro, tom: 'critico' });
      return;
    }
    setEnviando('retorno');
    setResposta(null);
    try {
      const r = await client.admin.googleReautorizarRetorno(v.endereco);
      setResposta(resultadoDoRetorno(r));
      setVista(null); // uso único: certo ou errado, a sessão acabou
      setEndereco('');
    } catch (e) {
      setResposta({ texto: errText(e), tom: 'critico' });
    } finally {
      setEnviando(null);
    }
    await reload();
  }

  return (
    <Card style={styles.card}>
      <Text style={styles.cardTitle}>Reautorizar o Google</Text>
      <Text style={styles.hint}>Renova a autorização da Agenda e das Tarefas sem o script e sem reiniciar. Só funciona com a autorização já feita uma vez pelo script.</Text>
      {gmail ? <Text style={styles.hint}>{TEXTO_GMAIL_NO_SCRIPT}</Text> : null}
      <Button testID="google-reautorizar" label="Reautorizar o Google" variant="ghost" compact onPress={comecar} loading={enviando === 'inicio' && !chave} disabled={enviando !== null || chave !== null} />
      {chave ? (
        <ChaveDaDm
          testID="google-chave"
          aviso={chave.aviso}
          erro={chave.erro}
          ocupado={enviando === 'inicio'}
          onConfirmar={(c) => { iniciarComChave(c); }}
          onPedirOutra={() => { pedirChave(); }}
          onCancelar={() => setChave(null)}
        />
      ) : null}
      {vista ? (
        <View style={styles.passos}>
          {INSTRUCOES_DA_REAUTORIZACAO.map((t, i) => (
            <Text key={i} style={styles.hint}>{`${i + 1}. ${t}`}</Text>
          ))}
          <Button testID="google-abrir-link" label="Abrir o link do Google" compact onPress={() => abrirLink(vista.link)} />
          <Text style={styles.hint}>{vista.validade}</Text>
          {vista.gmail ? <Text style={styles.hint}>{vista.gmail}</Text> : null}
          <FieldLabel>Endereço da página que não abriu</FieldLabel>
          <TextInput
            testID="google-endereco"
            style={styles.input}
            value={endereco}
            onChangeText={setEndereco}
            placeholder={`${ENDERECO_DO_RETORNO}/?state=...&code=...`}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={4096}
          />
          <Button testID="google-enviar" label="Concluir a reautorização" compact onPress={enviar} loading={enviando === 'retorno'} disabled={enviando !== null || !endereco.trim()} />
        </View>
      ) : null}
      {resposta ? <Text accessibilityRole="alert" testID="google-resultado" style={[styles.resposta, { color: COR[resposta.tom] }]}>{resposta.texto}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  passos: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  resposta: { fontSize: 14, lineHeight: 20 },
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
