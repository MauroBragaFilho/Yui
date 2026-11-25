// O USO DO GOOGLE PELO CÉREBRO (etapa 15): a pré-rota por CÓDIGO e as linhas do relatório matinal. SOMENTE LEITURA, SÓ O DONO, SÓ EM CONVERSA PRIVADA.
//
// A pré-rota (rotear) decide, nesta ordem:
//  1. chave YUI_GOOGLE desligada: devolve null (nada muda: a conversa segue exatamente como sempre, sem tocar no Google);
//  2. a fala não é um pedido do próprio dono ao Google (intencao.js): null;
//  3. quem pede NÃO é o dono: null (o membro, o convidado e o confiável seguem o fluxo de sempre e nunca veem nada do Google);
//  4. conversa espontânea ou de terceiros: null; o dono fora de uma conversa privada (canal público, voz): uma frase curta, sem consultar o Google
//     (a agenda dele nunca aparece onde outras pessoas leem);
//  5. e-mail: só com o Gmail liberado (chave + rota privada de IA validada, SEM exceção); senão uma frase curta e NADA é baixado (gmail.js, portao.js);
//  6. agenda e tarefas: o PORTÃO da rota privada de IA (portao.js: `validada`, consultada a cada uso; ou, só para elas, a exceção explícita do dono YUI_GOOGLE_SEM_ROTA_PRIVADA=true)
//     vem ANTES de qualquer chamada ao Google (nem o token é renovado): fechado = uma frase curta e fixa ("Ainda não leio a sua agenda: falta a rota privada de IA."), sem a IA.
//     Aberto: consulta o Google (somente leitura). Falha (não conectado, expirou, rede, 403): UMA frase curta na voz da Yui, sem erro técnico.
//  Com os dados: devolve o prompt com eles CERCADOS como dado não confiável e as opções que o passo do cérebro aplica (sem ferramentas, sem busca, sem provedor
//  anônimo, fora do contexto por horas); a resposta do modelo é conferida (chamada de ferramenta vira uma frase segura).
import { ROLES, MEMORY_SCOPES } from '../../core/permissions.js';
import { logger as loggerPadrao } from '../../utils/logger.js';
import { criarAutenticador } from './auth.js';
import { googleLigado, fusoDoGoogle, semRotaPrivadaPelaChave } from './config.js';
import { listarEventos, listarAniversarios } from './agenda.js';
import { listarTarefas } from './tarefas.js';
import { listarMensagens, FRASE_GMAIL_DESLIGADO } from './gmail.js';
import { fraseDoPortaoFechado } from './portao.js';
import { classificarPedido, classificarContinuacao, pareceAgendaNaoReconhecida } from './intencao.js';
import { blocoDeAgenda, blocoDeAniversarios, blocoDeTarefas, blocoDeEmails, montarPromptComDados, pareceChamadaDeFerramenta, RESPOSTA_SEGURA, limparTexto } from './dados.js';
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
  aniversariosInacessiveis: 'Não consegui ler o calendário de aniversários agora: o Google não o liberou para mim ou ele não respondeu.',
  naoEntendi: 'Eu consigo ler a sua agenda, as suas tarefas e os aniversários no Google, mas só entendo pedidos curtos. Tente: “o que tenho hoje na agenda?”, “compromissos da semana”, “minhas tarefas” ou “quando é o próximo aniversário?”.',
});

/** A frase curta para uma falha de leitura do Google. */
export function fraseDaFalha(motivo, tipo) {
  const tarefas = tipo === 'tarefas';
  if (motivo === 'nao-conectado') return tarefas ? FRASES.tarefasNaoConectadas : FRASES.agendaNaoConectada;
  if (motivo === 'precisa-autorizar' || motivo === 'arquivo-invalido') return FRASES.autorizarDeNovo;
  if (motivo === 'negado') return FRASES.negado;
  // O portão da rota privada (portao.js): a frase é do recurso (Agenda, Tarefas ou Gmail); "Gmail desligado pela chave" só existe para o e-mail.
  if (motivo === 'sem-rota-privada') return fraseDoPortaoFechado(tipo === 'email' ? 'gmail' : tipo);
  if (motivo === 'chave-desligada') return FRASE_GMAIL_DESLIGADO;
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
  const comum = { autenticador, fetchImpl: deps.fetchImpl, env, estadoDaRota: deps.estadoDaRota, timeoutMs: deps.timeoutMs };
  const contadores = { consultas: 0, respondidasPorCodigo: 0, comDados: 0, falhas: 0, recusasPrivacidade: 0, portaoFechado: 0, viaExcecaoDoDono: 0, naoEntendidos: 0 };
  /** A última consulta bem-sucedida de cada conversa privada do dono (tipo, período e quando): só para entender "e amanhã?". Só em memória; amarrada ao dono E ao canal (nunca um relógio global). */
  const ultimasConsultas = new Map();
  const chaveDaConversa = (ctx) => `${ctx?.userId ?? ''}|${ctx?.channelId ?? ''}`;
  let avisouExcecao = false;
  /** A exceção explícita do dono foi usada (a rota privada NÃO estava validada): conta e deixa UM aviso no log por processo (sem nenhum conteúdo). */
  function notarExcecao(r) {
    if (r?.portao !== 'excecao-do-dono') return;
    contadores.viaExcecaoDoDono += 1;
    if (avisouExcecao) return;
    avisouExcecao = true;
    try { log.warn?.('[Google] YUI_GOOGLE_SEM_ROTA_PRIVADA está ligada e a rota privada de IA não está validada: o texto da agenda e das tarefas pode passar pela IA em nuvem (nunca por provedor anônimo).'); } catch { /* */ }
  }

  /** A pré-rota de um passo do cérebro. Devolve null | { resposta } | { prompt, opcoes, revisar, tipo }. */
  async function rotear({ ctx, call = {}, texto, prompt }) {
    if (!googleLigado(env)) return null;
    let pedido = classificarPedido(texto);
    // "E nesta semana?" logo depois de uma consulta: só o dono (a Yui guarda só a última consulta dele) e só com consulta recente.
    const ehDono = Boolean(ctx) && ctx.role === ROLES.OWNER && !call.chatter && !call.thirdParty;
    if (!pedido && ehDono && ctx.memoryScope === MEMORY_SCOPES.PERSONAL && !call.voice && !call.voiceItem) pedido = classificarContinuacao(texto, ultimasConsultas.get(chaveDaConversa(ctx)) ?? null, agora());
    if (!pedido) {
      if (ehDono) ultimasConsultas.delete(chaveDaConversa(ctx)); // mudança de assunto: o "e amanhã?" seguinte já não continua a consulta antiga
      // Parece pergunta sobre a própria agenda, mas não é um pedido que eu entendo: orienta, em vez de a IA inventar ou dizer "não tenho acesso".
      if (ehDono && ctx.memoryScope === MEMORY_SCOPES.PERSONAL && !call.voice && !call.voiceItem && pareceAgendaNaoReconhecida(texto)) {
        contadores.naoEntendidos += 1;
        return { resposta: FRASES.naoEntendi };
      }
      return null;
    }
    if (!ctx || ctx.role !== ROLES.OWNER) return null;
    if (call.chatter || call.thirdParty) return null;
    // Voz privada (call.somenteAgenda, posto só pelo cérebro): só a agenda; e-mail, tarefas e aniversários nunca são lidos por voz, mesmo com o dono sozinho.
    if (call.somenteAgenda === true && pedido.tipo !== 'agenda') {
      contadores.recusasPrivacidade += 1;
      return { resposta: FRASES.soPrivado };
    }
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
      const r = await listarMensagens(comum);
      if (!r.ok) { contadores.falhas += 1; if (r.motivo === 'sem-rota-privada') contadores.portaoFechado += 1; return { resposta: fraseDaFalha(r.motivo, 'email') }; }
      bloco = blocoDeEmails({ mensagens: r.mensagens, truncado: r.truncado });
      fonte = 'caixa de e-mail';
    } else if (pedido.tipo === 'aniversarios') {
      const r = await listarAniversarios({ ...comum, periodo: pedido.periodo, agora, fuso });
      if (!r.ok) { contadores.falhas += 1; if (r.motivo === 'sem-rota-privada') contadores.portaoFechado += 1; return { resposta: r.motivo === 'calendario-inacessivel' ? FRASES.aniversariosInacessiveis : fraseDaFalha(r.motivo, 'agenda') }; }
      notarExcecao(r);
      bloco = blocoDeAniversarios({ eventos: r.eventos, janela: r.janela, fuso: r.fuso, truncado: r.truncado });
      fonte = 'calendário de aniversários dos contatos';
    } else if (pedido.tipo === 'agenda') {
      const r = await listarEventos({ ...comum, periodo: pedido.periodo, agora, fuso });
      if (!r.ok) { contadores.falhas += 1; if (r.motivo === 'sem-rota-privada') contadores.portaoFechado += 1; return { resposta: fraseDaFalha(r.motivo, 'agenda') }; }
      notarExcecao(r);
      bloco = blocoDeAgenda({ eventos: r.eventos, janela: r.janela, fuso: r.fuso, truncado: r.truncado });
      fonte = 'agenda';
    } else {
      const r = await listarTarefas({ ...comum, ate: dataLimiteDasTarefas(pedido.periodo, agora(), fuso) });
      if (!r.ok) { contadores.falhas += 1; if (r.motivo === 'sem-rota-privada') contadores.portaoFechado += 1; return { resposta: fraseDaFalha(r.motivo, 'tarefas') }; }
      notarExcecao(r);
      bloco = blocoDeTarefas({ tarefas: r.tarefas, hoje: dataDeHoje(agora(), fuso), truncado: r.truncado });
      fonte = 'lista de tarefas';
    }
    contadores.comDados += 1;
    if (pedido.tipo !== 'email') {
      const chave = chaveDaConversa(ctx);
      ultimasConsultas.delete(chave);
      ultimasConsultas.set(chave, { tipo: pedido.tipo, periodo: pedido.periodo ?? null, em: agora() });
      if (ultimasConsultas.size > 20) ultimasConsultas.delete(ultimasConsultas.keys().next().value);
    } else {
      ultimasConsultas.delete(chaveDaConversa(ctx)); // a pergunta de e-mail encerra o assunto anterior
    }
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
   * As linhas da seção "Agenda e tarefas de hoje" do relatório matinal, ou null (chave desligada, portão da rota privada fechado, sem conexão ou falha: o relatório fica IDÊNTICO ao
   * de sempre). Só o texto do relatório do dono, que sai por DM. O MESMO portão da pré-rota vale aqui (nada é baixado sem a rota privada validada ou a exceção do dono).
   */
  async function linhasDoRelatorio(now = new Date()) {
    if (!googleLigado(env)) return null;
    const fuso = fusoDoGoogle(env);
    const t = new Date(now).getTime();
    const [ag, ta] = await Promise.all([
      listarEventos({ ...comum, periodo: 'hoje', agora: () => t, fuso }),
      listarTarefas({ ...comum, ate: dataLimiteDasTarefas('hoje', t, fuso) }),
    ]);
    if (!ag.ok && !ta.ok) { if (ag.motivo === 'sem-rota-privada') contadores.portaoFechado += 1; return null; }
    notarExcecao(ag.ok ? ag : ta);
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

  return { rotear, linhasDoRelatorio, autenticador, estado: () => ({ ...autenticador.estado(), ...contadores, excecaoSemRotaPrivada: semRotaPrivadaPelaChave(env) }) };
}
