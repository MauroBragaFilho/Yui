// O USO DO GOOGLE PELO CÉREBRO (etapa 15): a pré-rota por CÓDIGO e as linhas do relatório matinal. SOMENTE LEITURA, SÓ O DONO, SÓ EM CONVERSA PRIVADA.
//
// A pré-rota (rotear) decide, nesta ordem:
//  1. chave YUI_GOOGLE desligada: devolve null (nada muda: a conversa segue exatamente como sempre, sem tocar no Google);
//  2. a fala não é um pedido do próprio dono ao Google (intencao.js): null;
//  3. quem pede NÃO é o dono: null (o membro, o convidado e o confiável seguem o fluxo de sempre e nunca veem nada do Google);
//  4. conversa espontânea ou de terceiros: null; o dono fora de uma conversa privada (canal público, voz): uma frase curta, sem consultar o Google
//     (a agenda dele nunca aparece onde outras pessoas leem);
//  5. e-mail: só com o Gmail liberado (chave + rota privada de IA validada); senão uma frase curta e NADA é baixado (gmail.js);
//  6. agenda e tarefas: consulta o Google (somente leitura). Falha (não conectado, expirou, rede, 403): UMA frase curta na voz da Yui, sem erro técnico.
//  Com os dados: devolve o prompt com eles CERCADOS como dado não confiável e as opções que o passo do cérebro aplica (sem ferramentas, sem busca, sem provedor
//  anônimo, fora do contexto por horas); a resposta do modelo é conferida (chamada de ferramenta vira uma frase segura).
import { ROLES, MEMORY_SCOPES } from '../../core/permissions.js';
import { logger as loggerPadrao } from '../../utils/logger.js';
import { criarAutenticador } from './auth.js';
import { googleLigado, fusoDoGoogle } from './config.js';
import { listarEventos } from './agenda.js';
import { listarTarefas } from './tarefas.js';
import { listarMensagens, fraseDoGmailFechado } from './gmail.js';
import { classificarPedido } from './intencao.js';
import { blocoDeAgenda, blocoDeTarefas, blocoDeEmails, montarPromptComDados, pareceChamadaDeFerramenta, RESPOSTA_SEGURA, limparTexto } from './dados.js';
import { dataDeHoje, partesNoFuso, somarDias, formatarHora } from './fuso.js';

/** As frases curtas (na voz da Yui, sem erro técnico). */
export const FRASES = Object.freeze({
  soPrivado: 'Isso eu só mostro por mensagem privada.',
  agendaNaoConectada: 'Ainda não conectei a sua agenda do Google: falta fazer a autorização uma vez.',
  tarefasNaoConectadas: 'Ainda não conectei as suas tarefas do Google: falta fazer a autorização uma vez.',
  autorizarDeNovo: 'Preciso que você autorize o Google de novo: a autorização que eu tinha não vale mais.',
  negado: 'O Google não me deixou ler isso: acho que preciso que você autorize de novo, com todas as permissões.',
  agendaIndisponivel: 'Não consegui ler a sua agenda agora. Tenta de novo daqui a pouco.',
  tarefasIndisponiveis: 'Não consegui ler as suas tarefas agora. Tenta de novo daqui a pouco.',
  emailIndisponivel: 'Não consegui ler os seus e-mails agora. Tenta de novo daqui a pouco.',
});

/** A frase curta para uma falha de leitura do Google. */
export function fraseDaFalha(motivo, tipo) {
  const tarefas = tipo === 'tarefas';
  if (motivo === 'nao-conectado') return tarefas ? FRASES.tarefasNaoConectadas : FRASES.agendaNaoConectada;
  if (motivo === 'precisa-autorizar' || motivo === 'arquivo-invalido') return FRASES.autorizarDeNovo;
  if (motivo === 'negado') return FRASES.negado;
  if (motivo === 'chave-desligada' || motivo === 'sem-rota-privada') return fraseDoGmailFechado(motivo);
  if (tipo === 'email') return FRASES.emailIndisponivel;
  return tarefas ? FRASES.tarefasIndisponiveis : FRASES.agendaIndisponivel;
}

/** A última data ("AAAA-MM-DD") que cobre o período numa consulta de tarefas (sem período: sem limite). */
function dataLimiteDasTarefas(periodo, agora, fuso) {
  if (!periodo) return null;
  const p = partesNoFuso(agora, fuso);
  const base = { ano: p.ano, mes: p.mes, dia: p.dia };
  const n = periodo === 'amanha' ? 1 : periodo === 'semana' ? 6 : 0;
  const d = somarDias(base, n);
  return `${d.ano}-${String(d.mes).padStart(2, '0')}-${String(d.dia).padStart(2, '0')}`;
}

/**
 * @param {{ env?: object, autenticador?: object, fetchImpl?: Function, agora?: () => number, alertar?: Function, log?: object, estadoDaRota?: Function, timeoutMs?: number }} [deps]
 */
export function criarGoogle(deps = {}) {
  const env = deps.env ?? process.env;
  const agora = deps.agora ?? Date.now;
  const log = deps.log ?? loggerPadrao;
  const autenticador = deps.autenticador ?? criarAutenticador({ env, fetchImpl: deps.fetchImpl, agora, alertar: deps.alertar, log, timeoutMs: deps.timeoutMs, restringir: deps.restringir });
  const comum = { autenticador, fetchImpl: deps.fetchImpl, env, timeoutMs: deps.timeoutMs };
  const contadores = { consultas: 0, respondidasPorCodigo: 0, comDados: 0, falhas: 0, recusasPrivacidade: 0 };

  /** A pré-rota de um passo do cérebro. Devolve null | { resposta } | { prompt, opcoes, revisar, tipo }. */
  async function rotear({ ctx, call = {}, texto, prompt }) {
    if (!googleLigado(env)) return null;
    const pedido = classificarPedido(texto);
    if (!pedido) return null;
    if (!ctx || ctx.role !== ROLES.OWNER) return null;
    if (call.chatter || call.thirdParty) return null;
    // O dono fora de uma conversa privada (canal público, voz): a agenda dele não aparece onde outras pessoas leem.
    if (ctx.memoryScope !== MEMORY_SCOPES.PERSONAL || call.voice || call.voiceItem) {
      contadores.recusasPrivacidade += 1;
      return { resposta: FRASES.soPrivado };
    }
    contadores.consultas += 1;
    const fuso = fusoDoGoogle(env);
    let bloco;
    let fonte = 'agenda e das tarefas';
    if (pedido.tipo === 'email') {
      const r = await listarMensagens({ ...comum, estadoDaRota: deps.estadoDaRota });
      if (!r.ok) { contadores.falhas += 1; return { resposta: fraseDaFalha(r.motivo, 'email') }; }
      bloco = blocoDeEmails({ mensagens: r.mensagens, truncado: r.truncado });
      fonte = 'caixa de e-mail';
    } else if (pedido.tipo === 'agenda') {
      const r = await listarEventos({ ...comum, periodo: pedido.periodo, agora, fuso });
      if (!r.ok) { contadores.falhas += 1; return { resposta: fraseDaFalha(r.motivo, 'agenda') }; }
      bloco = blocoDeAgenda({ eventos: r.eventos, janela: r.janela, fuso: r.fuso, truncado: r.truncado });
      fonte = 'agenda';
    } else {
      const r = await listarTarefas({ ...comum, ate: dataLimiteDasTarefas(pedido.periodo, agora(), fuso) });
      if (!r.ok) { contadores.falhas += 1; return { resposta: fraseDaFalha(r.motivo, 'tarefas') }; }
      bloco = blocoDeTarefas({ tarefas: r.tarefas, hoje: dataDeHoje(agora(), fuso), truncado: r.truncado });
      fonte = 'lista de tarefas';
    }
    contadores.comDados += 1;
    return {
      tipo: pedido.tipo,
      prompt: montarPromptComDados({ bloco, pedido: prompt, fonte }),
      // Dado de terceiros no prompt: sem ferramentas, sem busca na web e nunca provedor anônimo (o passo trata "anexo" assim); sem a checagem anti-repetição
      // (ela refaria a pergunta sem os dados).
      opcoes: { noTools: true, attachment: true, allowSearch: false, main: false },
      revisar: (resposta) => (pareceChamadaDeFerramenta(resposta) ? RESPOSTA_SEGURA : resposta),
    };
  }

  /**
   * As linhas da seção "Agenda e tarefas de hoje" do relatório matinal, ou null (chave desligada, sem conexão ou falha: o relatório fica IDÊNTICO ao de sempre).
   * Só o texto do relatório do dono, que sai por DM.
   */
  async function linhasDoRelatorio(now = new Date()) {
    if (!googleLigado(env)) return null;
    const fuso = fusoDoGoogle(env);
    const t = new Date(now).getTime();
    const [ag, ta] = await Promise.all([
      listarEventos({ ...comum, periodo: 'hoje', agora: () => t, fuso }),
      listarTarefas({ ...comum, ate: dataLimiteDasTarefas('hoje', t, fuso) }),
    ]);
    if (!ag.ok && !ta.ok) return null;
    const hoje = dataDeHoje(t, fuso);
    const linhas = [];
    if (ag.ok) {
      for (const e of ag.eventos) {
        const quando = e.diaInteiro ? 'dia inteiro' : formatarHora(e.inicio, fuso);
        linhas.push(`• ${quando} — ${limparTexto(e.titulo, 100)}${e.local ? ` (${limparTexto(e.local, 60)})` : ''}`);
      }
      if (ag.truncado) linhas.push('… e mais compromissos hoje.');
    }
    if (ta.ok) {
      for (const x of ta.tarefas) linhas.push(`• tarefa: ${limparTexto(x.titulo, 100)}${x.vence && x.vence < hoje ? ' (atrasada)' : ''}`);
      if (ta.truncado) linhas.push('… e mais tarefas.');
    }
    if (!linhas.length) linhas.push(ag.ok && ta.ok ? 'Nenhum compromisso nem tarefa para hoje.' : ag.ok ? 'Nenhum compromisso para hoje.' : 'Nenhuma tarefa para hoje.');
    return linhas;
  }

  return { rotear, linhasDoRelatorio, autenticador, estado: () => ({ ...autenticador.estado(), ...contadores }) };
}
