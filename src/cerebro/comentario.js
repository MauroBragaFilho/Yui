// Os COMENTÁRIOS fora da fila no CÉREBRO (etapa 7, docs/RELATORIO_ETAPA7_COMENTARIOS.md; contrato em docs/ETAPA3_DONOS_E_CONTRATO.md §10).
//
// O que é: o comentário curto (até 15 palavras) que a Yui escreve embaixo do embed dos comandos manuais /steam_jogo e /converter_moeda. Até a
// etapa 6, com o cérebro separado, ele ainda saía da cadeia de IA do PRÓPRIO bot (o último uso da IA pelo bot nesses comandos). Agora vem daqui:
//
//  chat.comentario (cérebro <- bot, só o papel bot), chave `chat.comentario:<id da interação do Discord>`:
//    parâmetros: os FATOS da interação (turn {id, at}, ctx {platform, userId, guildId, channelId, isDM, isBlocked}, call, channel: a configuração
//    do canal que o bot já monta) + `tipo` ('steam' | 'cotacao') + `dados` (os valores do embed). Nunca texto livre para a IA: o pedido é montado
//    AQUI (core/ai/promptComentario.js, o mesmo texto do processo único), só para os tipos conhecidos e com os dados conferidos;
//    resposta: { text, model, failed, recusado? } (text vazio = sem comentário; o embed sai sozinho).
//
// Garantias:
//  - PÚBLICO × PRIVADO: o comentário é uma chamada ISOLADA (sem histórico, sem memória, sem ferramentas, sem busca) e nunca grava nada (nem no
//    contexto por horas, nem no histórico em RAM, nem na memória). O contexto da pessoa é REMONTADO aqui (contextFromWire: papel, escopo); na
//    conversa privada (o Braga em DM ou canal privado, e a DM de qualquer pessoa) a chamada é sensível: nunca vai a provedor anônimo;
//  - o contexto certo de cada pessoa: o comentário é de QUEM chamou o comando (o id da interação); nada de outra pessoa entra, e nada dele fica;
//  - fora da fila e ao mesmo tempo que as mensagens: o comentário NÃO entra na fila da conversa (não lê nem grava histórico), então não espera a
//    pesquisa de ninguém nem atrapalha a ordem das conversas; comentários simultâneos têm um teto (YUI_CEREBRO_COMENTARIOS_MAX, padrão 4): acima
//    dele, sai sem comentário na hora (o embed não espera);
//  - nenhuma resposta em dobro: a chave pela interação + o cache do canal (um pedido repetido enquanto o primeiro roda espera o MESMO resultado;
//    depois, devolve o guardado). Quem entrega é o bot, uma vez (editReply da interação);
//  - as permissões e guardas continuam no BOT (Termos de Uso, banimento, motor de política do comando); aqui só a defesa em profundidade: a
//    pessoa bloqueada não recebe comentário;
//  - queda do cérebro: o bot espera a volta (a mesma janela do chat.turn) e repete com a MESMA chave; o cérebro novo gera de novo (o comentário
//    não tem efeito fora daqui: só uma chamada à IA). Queda do bot: a interação adiada vence sozinha no Discord (nada fica guardado).
// O log nunca recebe o texto do comentário, o nome do jogo nem os valores: só o tipo e contagens.
import * as defaultAi from '../core/ai/manager.js';
import { buildConversationSystemPrompt } from '../core/ai/promptConversa.js';
import { stripThinking } from '../core/ai/limpezaResposta.js';
import { promptDoComentario, dadosDoComentarioFromWire } from '../core/ai/promptComentario.js';
import { ChannelError } from '../core/channel/protocol.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { turnFactsFromWire, channelFactsFromWire, pedidoDeLimiteDoCanal } from './conversa.js';
// Perfis de IA (etapa 9): o comentário usa o perfil "rapido" (ou o "privado", na conversa privada, se o dono o declarou).
import { selecionarPerfil, campoPerfil } from './seletorPerfil.js';

/** Quantos comentários podem rodar ao mesmo tempo no cérebro (YUI_CEREBRO_COMENTARIOS_MAX, de 1 a 20, padrão 4). */
export function comentariosMax(env = process.env) {
  const n = Number.parseInt(String(env.YUI_CEREBRO_COMENTARIOS_MAX ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 20) : 4;
}
/** Prazo do comentário (YUI_COMENTARIO_PRAZO_MS, de 5 s a 5 min, padrão 45 s): o bot espera isto; o handler aqui, isto + folga. */
export function comentarioPrazoMs(env = process.env) {
  const n = Number(String(env.YUI_COMENTARIO_PRAZO_MS ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.min(300_000, Math.max(5_000, Math.round(n))) : 45_000;
}

/**
 * O comentário do cérebro. Tudo injetável para teste.
 * @param {{ ai?: object, env?: object, logger?: object }} [deps]
 */
export function createCommentBrain(deps = {}) {
  const ai = deps.ai ?? defaultAi;
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? defaultLogger;
  let ativos = 0;
  const counters = { pedidos: 0, respondidos: 0, semComentario: 0, falhasIa: 0, recusadosOcupado: 0, recusadosBloqueado: 0, privados: 0, porTipo: { steam: 0, cotacao: 0 } };

  async function comentario(p, meta = {}) {
    const f = turnFactsFromWire(p, meta); // o contexto da pessoa REMONTADO aqui (papel, escopo); lança BAD_PARAMS
    let tipo;
    let dados;
    try {
      tipo = String(p?.tipo ?? '');
      dados = dadosDoComentarioFromWire(tipo, p?.dados);
    } catch (err) {
      throw new ChannelError('BAD_PARAMS', String(err?.message ?? 'Comentário inválido.'));
    }
    const channel = channelFactsFromWire(p.channel);
    counters.pedidos += 1;
    counters.porTipo[tipo] = (counters.porTipo[tipo] ?? 0) + 1;
    // Defesa em profundidade (o bot já barra antes): pessoa bloqueada não recebe comentário.
    if (f.ctx.role === 'BLOCKED') { counters.recusadosBloqueado += 1; return { text: '', model: null, failed: false, recusado: 'bloqueado' }; }
    if (ativos >= comentariosMax(env)) {
      counters.recusadosOcupado += 1;
      logger.warn?.(`[Comentário] ${ativos} comentário(s) já rodando: este sai sem comentário (o embed não espera).`);
      return { text: '', model: null, failed: false, recusado: 'ocupado' };
    }
    // Público × privado: a conversa privada (sensível, ou a DM de qualquer pessoa) nunca vai a provedor anônimo.
    const sensitive = f.ctx.memoryScope === 'personal';
    const privada = sensitive || !f.ctx.guildId;
    if (privada) counters.privados += 1;
    // O prompt de sistema da conversa do Discord (o MESMO módulo do processo único), sem persona pessoal, sem memória e sem ferramentas: os dados
    // do canal que o bot mandou (prompt do servidor, persona e humor do canal, rádio).
    const system = buildConversationSystemPrompt({
      serverPrompt: channel.serverPrompt, radioBlock: channel.radioBlock, channelSettings: channel.channelSettings, noToolRule: true,
    }).withMemory;
    const prompt = promptDoComentario(tipo, dados);
    const tokensPorProvedor = pedidoDeLimiteDoCanal(channel);
    const perfil = campoPerfil((deps.selecionarPerfil ?? ((t) => selecionarPerfil(t, { env })))({ ponto: 'comentario', privada }));
    ativos += 1;
    try {
      // Chamada ISOLADA: sem histórico, sem memória, sem ferramentas, sem busca. Nada é gravado.
      const raw = typeof ai.isolatedChat === 'function'
        ? await ai.isolatedChat({ prompt, system, ctx: f.ctx, sensitive: privada, tokensPorProvedor, ...perfil })
        : await ai.chat({ prompt, system, history: [], ctx: f.ctx, memoryBlock: '', sensitive: privada, tokensPorProvedor, ...perfil });
      const text = stripThinking(String(raw ?? '')).trim();
      if (text) counters.respondidos += 1; else counters.semComentario += 1;
      const backend = (ai.listBackends?.() ?? []).find((b) => b.active)?.name ?? 'cérebro';
      return { text, model: `cérebro (${backend})`, failed: false };
    } catch (err) {
      counters.falhasIa += 1;
      logger.warn?.(`[Comentário] a IA não respondeu o comentário (${tipo}); o embed sai sem ele (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}).`);
      return { text: '', model: null, failed: true };
    } finally {
      ativos -= 1;
    }
  }

  return { comentario, stats: () => ({ ...counters, porTipo: { ...counters.porTipo }, ativos, max: comentariosMax(env) }) };
}

/**
 * Registra chat.comentario no servidor do canal (só o papel bot).
 * @returns {{ methods: string[], brain: ReturnType<typeof createCommentBrain> }}
 */
export function registerCommentMethods(server, deps = {}) {
  const env = deps.env ?? process.env;
  const brain = deps.brain ?? createCommentBrain(deps);
  server.handle('chat.comentario', (p, meta) => brain.comentario(p, meta), { roles: ['bot'], timeoutMs: comentarioPrazoMs(env) + 5_000 });
  return { methods: ['chat.comentario'], brain };
}
