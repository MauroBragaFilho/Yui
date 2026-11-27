// ADAPTADOR DE YOUTUBE LIVE: o esqueleto, DESLIGADO (YUI_YOUTUBE_LIVE=false) e SEM EFEITO (docs/PROPOSTA_CEREBRO_UNICO_YUI.md §7; docs/CANAIS_NOVOS.md §3).
//
// O que ele faz, na ordem da §7.1:
//  1. entrar({ link, canal, papel }): SÓ o dono, SÓ pelo Discord ou pelo app. Acha o chat da live (activeLiveChatId) com o cliente injetado;
//  2. passo(): UMA rodada de leitura do chat (o chamador espera `proximoEmMs`, que NUNCA é menor que o pollingIntervalMillis da API nem que o mínimo configurado, e cresce
//     quando a cota aperta). Responde quando chamam a Yui e, com as regras da §7.2 (src/adaptadores/youtube/fala.js), puxa assunto de vez em quando;
//  3. sai sozinho quando a live acaba, quando o dono manda (`sair`), ou PARA e AVISA o dono quando é removido/silenciado/banido, a cota acaba ou o erro não passa.
// Segurança (§7.4): todo mundo no chat é PÚBLICO, inclusive o dono; o texto do chat é dado e NUNCA é comando (nenhum caminho daqui interpreta o chat como ordem ao adaptador);
// o canal só tem a capacidade `youtube.chat.enviar` (uma resposta do cérebro com ação ou confirmação é DESCARTADA inteira); nenhuma mensagem sai sem passar por
// ajustarTextoAoCanal (200 caracteres, uma ideia, sem lista nem link), pela guarda de fala (limite por minuto, intervalo, modo lento) e pela cota de unidades.
// Nada aqui abre porta, lê arquivo ou chama a API sozinho: o cliente, o relógio, o cérebro e o aviso ao dono são INJETADOS. A memória da live é só esta instância (some ao sair).
// Nenhum texto do chat vai para log: só códigos e contadores.
import { validarPedido, validarResposta } from '../../core/canais/contrato.js';
import { ajustarTextoAoCanal } from '../../core/canais/estilo.js';
import { ErroYoutube } from './api.js';
import { criarCota } from './cota.js';
import { transicao, estaAtiva } from './estado.js';
import { classificarMensagem, criarGuardaDeFala, montarContextoDeAssunto, normalizarMensagem } from './fala.js';
import { extrairIdDoVideo, podeComandarALive } from './link.js';

/** A chave que liga o adaptador. Só o texto "true" liga. */
export const youtubeLigado = (env = process.env) => String(env?.YUI_YOUTUBE_LIVE ?? 'false').trim().toLowerCase() === 'true';

export const CONFIG_PADRAO = Object.freeze({
  intervaloMinimoLeituraMs: 10_000, // nunca ler mais rápido que isto, mesmo que a API aceite (a cota é curta: veja cota.js)
  maxRespostasPorPasso: 2,
  tentativaDeAssuntoMs: 60_000, // de quanto em quanto tempo pede um assunto ao cérebro (quando as regras deixam)
  falhasSeguidasMax: 5, // erros passageiros seguidos na leitura antes de desistir e avisar o dono
  vistasMax: 2000,
  recentesMax: 20,
  pendentesMax: 3,
  pendenteValeMs: 90_000,
});

/**
 * @param {{
 *   ligado?: boolean,
 *   cliente: { buscarLive: Function, lerMensagens: Function, enviarMensagem: Function },
 *   cerebro: { responder: (pedido: object) => Promise<object>, puxarAssunto?: (contexto: object) => Promise<object|null> },
 *   agora?: () => number,
 *   avisarDono?: (aviso: { evento: string, motivo: string }) => Promise<void>,
 *   log?: (codigo: string) => void,
 *   config?: { canalDaYui?: string } & Partial<typeof CONFIG_PADRAO> & { limitesDaFala?: object, cota?: object },
 * }} o
 */
export function criarAdaptadorYoutube({ ligado = youtubeLigado(), cliente, cerebro, agora = Date.now, avisarDono = async () => {}, log = () => {}, proibido = () => false, config = {} } = {}) {
  const C = { ...CONFIG_PADRAO, ...config };
  const cota = criarCota({ agora, ...(config.cota ?? {}) });
  let estado = 'desligado';
  let live = null; // { videoId, liveChatId, titulo, conversa, guarda, vistas:Set, recentes:[], pagina, primeiraLeitura, falhas, ultimaTentativaDeAssuntoEm }
  let emPasso = false;
  const contadores = { passos: 0, lidas: 0, respondidas: 0, espontaneas: 0, ignoradas: {}, puladas: {}, descartadas: {}, falhas: {} };
  const contar = (grupo, chave) => { contadores[grupo][chave] = (contadores[grupo][chave] ?? 0) + 1; };

  if (ligado === true) estado = transicao(estado, 'ligar').para;

  function aplicar(evento) {
    const t = transicao(estado, evento);
    if (!t.ok) return t;
    estado = t.para;
    if (!estaAtiva(estado)) live = null; // a memória da live some ao sair
    return t;
  }

  async function avisar(evento, motivo) {
    try { await avisarDono({ evento, motivo }); } catch { contar('falhas', 'aviso-ao-dono'); }
  }

  /** Para a live por um evento terminal e, se o evento pede, AVISA o dono (código curto, sem detalhe técnico nem texto do chat). */
  async function parar(evento, motivo) {
    const t = aplicar(evento);
    log(`youtube:${evento}:${motivo}`);
    if (t.ok && t.avisarDono) await avisar(evento, motivo);
    return t;
  }

  // ── Comandos do dono (só pelo Discord ou pelo app) ──────────────────────────────────────────────────────────────────────────────────────

  async function entrar({ link, canal, papel, intervaloLeituraMs } = {}) {
    if (estado === 'desligado') return { ok: false, codigo: 'desligado' };
    const quem = podeComandarALive({ canal, papel });
    if (!quem.ok) return { ok: false, codigo: quem.codigo };
    if (typeof C.canalDaYui !== 'string' || !C.canalDaYui) return { ok: false, codigo: 'sem-canal-da-yui' }; // sem saber qual é o canal dela, ela responderia a si mesma
    const id = extrairIdDoVideo(link);
    if (!id.ok) return { ok: false, codigo: id.codigo };
    if (aplicar('entrar').ok !== true) return { ok: false, codigo: 'ja-esta-numa-live' };
    live = {
      // o ritmo desta live: nunca mais rápido que o mínimo do adaptador
      intervaloMs: Math.max(C.intervaloMinimoLeituraMs, Number(intervaloLeituraMs) || 0),
      videoId: id.videoId, liveChatId: null, titulo: '', conversa: `yt:${id.videoId}`, guarda: criarGuardaDeFala({ limites: C.limitesDaFala, agora }),
      vistas: new Set(), recentes: [], pendentes: [], pagina: null, primeiraLeitura: true, falhas: 0, ultimaTentativaDeAssuntoEm: null,
    };
    if (!cota.podeGastar('videos.list')) { aplicar('erro_permanente'); return { ok: false, codigo: 'cota-esgotada' }; }
    let achada;
    try {
      achada = await cliente.buscarLive(id.videoId);
      cota.gastar('videos.list');
    } catch (e) {
      const codigo = e instanceof ErroYoutube ? e.code : 'ERRO';
      if (e instanceof ErroYoutube && e.permanente) { aplicar('erro_permanente'); return { ok: false, codigo: codigo.toLowerCase().replaceAll('_', '-') }; }
      aplicar('sem_chat');
      return { ok: false, codigo: codigo === 'VIDEO_NAO_ENCONTRADO' ? 'video-nao-encontrado' : 'falha-temporaria' };
    }
    if (estado !== 'procurando' || !live) return { ok: false, codigo: 'cancelada' }; // o dono mandou sair (ou desligaram) enquanto a Yui procurava o chat
    if (!achada.eLive) { aplicar('sem_chat'); return { ok: false, codigo: 'nao-e-live' }; }
    if (achada.terminou) { aplicar('live_acabou'); return { ok: false, codigo: 'live-acabou' }; }
    if (!achada.liveChatId) { aplicar('sem_chat'); return { ok: false, codigo: 'sem-chat' }; } // ainda não começou, ou o chat está desligado
    live.liveChatId = achada.liveChatId;
    live.titulo = achada.titulo;
    aplicar('chat_encontrado');
    return { ok: true, titulo: achada.titulo };
  }

  /** A fala de chegada, escolhida pelo código (nunca pela IA): uma por entrada, contando na cota e nos limites. Falhar não tira a Yui do chat. */
  async function saudar(texto) {
    const minha = live;
    if (!minha || estado !== 'ouvindo' || proibido(texto) || !cota.podeGastar('liveChatMessages.insert')) return false;
    try {
      await cliente.enviarMensagem({ liveChatId: minha.liveChatId, texto });
    } catch (e) {
      if (live === minha) await reagirAoErro(e, 'enviar');
      return false;
    }
    cota.gastar('liveChatMessages.insert');
    if (live === minha) minha.guarda.registrarEnvio({ tipo: 'resposta', texto });
    return true;
  }

  function sair({ canal, papel } = {}) {
    const quem = podeComandarALive({ canal, papel });
    if (!quem.ok) return { ok: false, codigo: quem.codigo };
    if (!estaAtiva(estado)) return { ok: false, codigo: 'nao-esta-numa-live' };
    aplicar('sair');
    return { ok: true };
  }

  /** "Fica quieta": desliga os comentários espontâneos (as respostas a quem chama continuam). */
  function calar({ canal, papel } = {}) {
    const quem = podeComandarALive({ canal, papel });
    if (!quem.ok) return { ok: false, codigo: quem.codigo };
    if (!live) return { ok: false, codigo: 'nao-esta-numa-live' };
    live.guarda.calar();
    return { ok: true };
  }
  function liberarComentarios({ canal, papel } = {}) {
    const quem = podeComandarALive({ canal, papel });
    if (!quem.ok) return { ok: false, codigo: quem.codigo };
    if (!live) return { ok: false, codigo: 'nao-esta-numa-live' };
    live.guarda.liberar();
    return { ok: true };
  }

  function desligar() { aplicar('desligar'); return { ok: true }; }

  // ── Falhas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** O que fazer com um erro da API: para a live (e avisa o dono, quando for o caso) ou deixa seguir. @returns {Promise<'parou'|'segue'>} */
  async function reagirAoErro(e, onde) {
    const codigo = e instanceof ErroYoutube ? e.code : 'ERRO';
    contar('falhas', `${onde}:${codigo}`);
    if (codigo === 'LIVE_ACABOU' || codigo === 'CHAT_NAO_ENCONTRADO') { await parar('live_acabou', codigo); return 'parou'; }
    if (codigo === 'SEM_PERMISSAO') { await parar('removida', codigo); return 'parou'; } // removida, silenciada ou banida
    if (codigo === 'COTA_ESGOTADA') { await parar('cota_esgotada', codigo); return 'parou'; }
    if (codigo === 'NAO_AUTENTICADO' || codigo === 'CHAT_DESLIGADO' || codigo === 'DESLIGADO' || codigo === 'BASE_INVALIDA' || codigo === 'SEM_CREDENCIAL') { await parar('erro_permanente', codigo); return 'parou'; }
    if (codigo === 'LIMITE_DE_TAXA' && onde === 'enviar' && live) {
      // o chat pediu calma (modo lento ou limite de envio): a Yui espera mais entre as mensagens dela
      live.guarda.definirModoLento(Math.max(15_000, (live.guarda.retrato().modoLentoMs || 0) * 2));
    }
    return 'segue';
  }

  // ── Envio ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Ajusta, confere e envia a resposta do cérebro. A resposta com ação ou confirmação NÃO sai: este canal só escreve texto. */
  async function entregar(resposta, tipo, minha) {
    if (!live || live !== minha || estado !== 'ouvindo') return false;
    if (!resposta || typeof resposta !== 'object' || typeof resposta.texto !== 'string') { contar('descartadas', 'resposta-invalida'); return false; }
    if ((Array.isArray(resposta.acoes) && resposta.acoes.length) || (resposta.confirmacao !== undefined && resposta.confirmacao !== null)) { contar('descartadas', 'acoes-no-youtube'); return false; }
    const ajustado = ajustarTextoAoCanal('youtube_live', resposta.texto);
    if (!ajustado.texto) { contar('descartadas', 'texto-vazio'); return false; }
    if (proibido(ajustado.texto)) { contar('descartadas', 'proibida'); return false; } // no texto FINAL: o ajuste pode remontar a palavra
    if (!validarResposta('youtube_live', { texto: ajustado.texto }).ok) { contar('descartadas', 'fora-do-contrato'); return false; }
    if (live.guarda.repetido(ajustado.texto)) { contar('descartadas', 'repetida'); return false; }
    // a guarda e a cota são conferidas de novo aqui: entre pedir ao cérebro e enviar o tempo passou
    const av = live.guarda.avaliar({ tipo, nivelDaCota: cota.nivel() });
    if (!av.ok) { contar('puladas', av.motivo); return false; }
    if (!cota.podeGastar('liveChatMessages.insert')) { contar('puladas', 'cota'); return false; }
    try {
      await cliente.enviarMensagem({ liveChatId: minha.liveChatId, texto: ajustado.texto });
    } catch (e) {
      if (live === minha) await reagirAoErro(e, 'enviar');
      return false;
    }
    cota.gastar('liveChatMessages.insert');
    if (live !== minha) return true; // o dono mandou sair enquanto a mensagem ia: ela saiu, mas a live já é outra (ou acabou)
    minha.guarda.registrarEnvio({ tipo, texto: ajustado.texto });
    contadores[tipo === 'espontanea' ? 'espontaneas' : 'respondidas'] += 1;
    return true;
  }

  /** Quem chamou cedo demais (intervalo entre mensagens) espera a próxima rodada, por pouco tempo. */
  function adiar(msg, em = agora()) { if (live && live.pendentes.length < C.pendentesMax) live.pendentes.push({ msg, em }); }

  async function responderA(msg, em) {
    const minha = live;
    const av = live.guarda.avaliar({ tipo: 'resposta', nivelDaCota: cota.nivel(), autor: msg.autorId });
    if (!av.ok) {
      if (av.motivo === 'intervalo-minimo') adiar(msg, em);
      else contar('puladas', av.motivo);
      return;
    }
    if (!cota.podeGastar('liveChatMessages.insert')) { contar('puladas', 'cota'); return; }
    // O papel NÃO vai no pedido: o cérebro decide (e no YouTube todo mundo é público).
    const pedido = validarPedido({ canal: 'youtube_live', pessoa: msg.autorId, conversa: live.conversa, texto: msg.texto, anexos: [], capacidades: ['youtube.chat.enviar'] });
    if (!pedido.ok) { contar('descartadas', 'pedido-invalido'); return; }
    live.guarda.registrarPedido(msg.autorId); // conta a chamada à IA, mesmo que a resposta seja descartada
    let resposta;
    try { resposta = await cerebro.responder(pedido.pedido); } catch { contar('falhas', 'cerebro'); return; }
    await entregar(resposta, 'resposta', minha);
  }

  async function puxarAssunto() {
    if (typeof cerebro.puxarAssunto !== 'function' || !live || estado !== 'ouvindo') return;
    const minha = live;
    const t = agora();
    if (live.ultimaTentativaDeAssuntoEm !== null && t - live.ultimaTentativaDeAssuntoEm < C.tentativaDeAssuntoMs) return;
    const av = live.guarda.avaliar({ tipo: 'espontanea', nivelDaCota: cota.nivel() });
    if (!av.ok) { contar('puladas', av.motivo); return; }
    if (!cota.podeGastar('liveChatMessages.insert')) { contar('puladas', 'cota'); return; }
    live.ultimaTentativaDeAssuntoEm = t;
    let resposta;
    live.guarda.registrarPedido();
    try { resposta = await cerebro.puxarAssunto({ conversa: live.conversa, ...montarContextoDeAssunto({ titulo: live.titulo, mensagens: live.recentes }) }); } catch { contar('falhas', 'cerebro'); return; }
    if (resposta) await entregar(resposta, 'espontanea', minha);
  }

  // ── Uma rodada de leitura ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lê uma página do chat e age. Devolve `proximoEmMs` (quando chamar de novo) ou null se não há mais nada a fazer (live encerrada, parada ou desligada).
   * @returns {Promise<{ ok: boolean, ativo: boolean, proximoEmMs: number|null, codigo?: string }>}
   */
  async function passo() {
    if (estado !== 'ouvindo' || !live) return { ok: true, ativo: false, proximoEmMs: null };
    if (emPasso) return { ok: false, ativo: true, proximoEmMs: 1000, codigo: 'passo-em-andamento' };
    emPasso = true;
    try {
      contadores.passos += 1;
      if (cota.nivel() === 'esgotada') { await parar('cota_esgotada', 'cota'); return { ok: true, ativo: false, proximoEmMs: null }; }
      const minha = live; // o dono pode mandar sair (e até entrar em outra live) enquanto esta rodada espera a API: depois de cada espera, confere que a live ainda é esta
      const aindaAqui = () => estado === 'ouvindo' && live === minha;
      let pagina;
      try {
        pagina = await cliente.lerMensagens({ liveChatId: minha.liveChatId, pageToken: minha.pagina });
        if (!aindaAqui()) return { ok: true, ativo: false, proximoEmMs: null };
        cota.gastar('liveChatMessages.list');
        live.falhas = 0;
      } catch (e) {
        if (!aindaAqui()) return { ok: true, ativo: false, proximoEmMs: null };
        if (await reagirAoErro(e, 'ler') === 'parou') return { ok: true, ativo: false, proximoEmMs: null };
        live.falhas += 1;
        if (live.falhas >= C.falhasSeguidasMax) { await parar('erro_permanente', 'falhas-seguidas'); return { ok: false, ativo: false, proximoEmMs: null, codigo: 'falhas-seguidas' }; }
        return { ok: false, ativo: true, proximoEmMs: Math.min(60_000, live.intervaloMs * 2 ** live.falhas), codigo: 'falha-temporaria' };
      }
      live.pagina = pagina.proximaPagina ?? live.pagina;

      let respostas = 0;
      minha.pendentes = minha.pendentes.filter((p) => agora() - p.em <= C.pendenteValeMs);
      const atrasada = minha.pendentes.shift();
      if (atrasada) {
        respostas += 1;
        await responderA(atrasada.msg, atrasada.em);
        if (!aindaAqui()) return { ok: true, ativo: false, proximoEmMs: null };
      }
      for (const item of pagina.mensagens) {
        const id = typeof item?.id === 'string' ? item.id : null;
        if (!id || live.vistas.has(id)) continue;
        live.vistas.add(id);
        if (live.vistas.size > C.vistasMax) live.vistas.delete(live.vistas.values().next().value);
        if (live.primeiraLeitura) continue; // o que já estava no chat quando ela entrou (o histórico) não vira resposta nem movimento
        contadores.lidas += 1;
        const msg = normalizarMensagem(item);
        const cls = classificarMensagem(msg, { idDaYui: C.canalDaYui });
        if (cls.acao === 'ignorar') { contar('ignoradas', cls.motivo); continue; }
        live.guarda.registrarMensagemDeOutro({ autor: msg.autorId });
        live.recentes.push({ texto: msg.texto });
        if (live.recentes.length > C.recentesMax) live.recentes.shift();
        if (cls.acao === 'responder') {
          if (respostas >= C.maxRespostasPorPasso) { adiar(msg); continue; }
          respostas += 1;
          await responderA(msg);
          if (!aindaAqui()) return { ok: true, ativo: false, proximoEmMs: null };
        }
      }
      live.primeiraLeitura = false;
      await puxarAssunto();
      if (!aindaAqui()) return { ok: true, ativo: false, proximoEmMs: null };
      // o ritmo respeita o que a API mandou (pollingIntervalMillis), o mínimo configurado e a cota (que, apertada, deixa a leitura mais lenta)
      const proximoEmMs = Math.min(300_000, Math.max(pagina.intervaloMs, minha.intervaloMs) * cota.fatorDeLeitura());
      return { ok: true, ativo: true, proximoEmMs };
    } finally {
      emPasso = false;
    }
  }

  /** Retrato SEM texto de ninguém (só estado, números e códigos): serve ao diagnóstico. */
  function retrato() {
    return {
      estado, ativo: estaAtiva(estado), videoId: live?.videoId ?? null, cota: cota.retrato(), guarda: live ? live.guarda.retrato() : null,
      contadores: { ...contadores, ignoradas: { ...contadores.ignoradas }, puladas: { ...contadores.puladas }, descartadas: { ...contadores.descartadas }, falhas: { ...contadores.falhas } },
    };
  }

  return { entrar, saudar, sair, calar, liberarComentarios, passo, desligar, retrato, get estado() { return estado; } };
}
