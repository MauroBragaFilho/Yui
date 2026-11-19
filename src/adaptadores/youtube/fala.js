// QUANDO FALAR no chat de uma live (docs/PROPOSTA_CEREBRO_UNICO_YUI.md §7.2 e §7.4; docs/CANAIS_NOVOS.md §3.3). PURO: sem rede, sem disco, sem timers (o relógio é injetado).
//
//  - classificarMensagem:  o que fazer com uma mensagem do chat (ignorar, só contar como movimento do chat ou RESPONDER porque chamaram a Yui). Mensagem com link,
//                          ofensa ou tentativa de instrução NUNCA vira resposta. É a primeira barreira (lista curta); a barreira de verdade é a lista fechada de
//                          ferramentas do cérebro para esta origem e o motor de políticas. O texto do chat é DADO não confiável, nunca instrução;
//  - criarLimiteDeMensagens: no máximo N mensagens por minuto (janela deslizante);
//  - criarGuardaDeFala:    as regras de responder e de PUXAR ASSUNTO: só com o chat ativo, nunca duas espontâneas seguidas sem alguém falar no meio, intervalo mínimo
//                          e teto por live, modo lento da live, "fica quieta" do dono e cota apertada.
// Os VALORES (intervalo entre comentários espontâneos, teto por live...) ainda estão em aberto com o dono (§10, item 2): são os padrões de LIMITES_DA_FALA e podem ser mudados.
import { sanitizeUntrusted } from '../../core/ai/llmSafety.js';
import { temLink } from '../../core/canais/contrato.js';

export const LIMITES_DA_FALA = Object.freeze({
  maxPorMinuto: 6, // no máximo 6 mensagens da Yui por minuto, somando respostas e comentários
  intervaloMinimoMs: 5000, // e pelo menos 5 s entre duas mensagens dela
  intervaloEspontaneaMs: 5 * 60_000, // entre dois comentários espontâneos
  maxEspontaneasPorLive: 12, // teto de comentários espontâneos em cada live
  chatAtivoJanelaMs: 2 * 60_000, // "outras pessoas falaram há pouco": nos últimos 2 minutos...
  chatAtivoMinMensagens: 3, // ...pelo menos 3 mensagens...
  chatAtivoMinPessoas: 2, // ...de pelo menos 2 pessoas diferentes
});
export const MENSAGEM_DO_CHAT_MAX = 300;
const NOMES_DA_YUI = Object.freeze(['yui']);

/** Minúsculas e sem acento: o que os padrões abaixo enxergam. */
const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const escaparRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** O texto chama a Yui ("Yui", "@Yui", "oi yui,")? Palavra inteira: "yuigi" não conta. */
export function mencionaAYui(texto, nomes = NOMES_DA_YUI) {
  const t = normalizar(texto);
  return nomes.some((n) => new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaparRegex(normalizar(n))}(?![\\p{L}\\p{N}_])`, 'u').test(t));
}

const INSTRUCAO_RES = [
  /\b(ignore|ignora|ignorem|esqueca|esquece|esquecam|desconsidere|desconsidera)\b.{0,40}\b(instrucoes|regras|prompt|comandos|tudo)\b/,
  /\b(ignore|forget|disregard)\b.{0,40}\b(instructions|rules|prompt|previous|above)\b/,
  /\b(voce agora e|agora voce e|finja (ser|que)|aja como|haja como|faca de conta que voce|pretend to be|act as)\b/,
  /\b(system prompt|prompt do sistema|prompt de sistema|suas instrucoes|tuas instrucoes|modo desenvolvedor|developer mode|jailbreak)\b/,
  /\b(repita|repete)\b.{0,20}\b(depois de mim|apos mim|exatamente|literalmente)\b/,
  /\b(diga|fale|escreva|digite)\b.{0,15}\b(exatamente|literalmente)\b/,
  /\b(eu sou|sou|aqui e) (o |a )?(dono|dona|admin|administrador|criador|desenvolvedor)\b/,
  /\b(como|na qualidade de) (o )?(dono|admin|administrador)\b/,
  /\b(revele|mostre|me de|me passe|vaza)\b.{0,30}\b(senha|token|chave|api key|segredo|prompt|instrucoes)\b/,
];
const OFENSA_RES = [
  /\b(idiota|imbecil|retardad[oa]|arrombad[oa]|babaca|otari[oa]|cuzao|vtnc|vsf|fdp)\b/,
  /\b(filh[oa] da puta|puta que pariu|vai se foder|vai tomar no cu|lixo humano|desgraca)\b/,
];

/** A mensagem tenta dar ordens à Yui (esquecer regras, mudar de papel, repetir texto, revelar instruções, dizer que é o dono)? */
export function pareceInstrucao(texto) {
  const t = normalizar(texto);
  return INSTRUCAO_RES.some((re) => re.test(t));
}
/** A mensagem tem uma ofensa óbvia (lista curta)? */
export function pareceOfensa(texto) {
  const t = normalizar(texto);
  return OFENSA_RES.some((re) => re.test(t));
}

/**
 * Lê um item da API (liveChatMessage) e devolve só o que a Yui usa. Nunca guarda o item inteiro. O texto passa por sanitizeUntrusted (sem caracteres invisíveis
 * nem marcas que imitem o prompt). Item que não é mensagem de texto: null.
 * @returns {{ id: string, autorId: string, nome: string, texto: string, em: number|null } | null}
 */
export function normalizarMensagem(item) {
  const snippet = item?.snippet;
  if (!item || typeof item.id !== 'string' || !snippet || snippet.type !== 'textMessageEvent') return null;
  const autorId = item.authorDetails?.channelId ?? snippet.authorChannelId;
  if (typeof autorId !== 'string' || !autorId) return null;
  const bruto = snippet.textMessageDetails?.messageText ?? snippet.displayMessage;
  if (typeof bruto !== 'string') return null;
  const publicada = Date.parse(snippet.publishedAt ?? '');
  return {
    id: item.id.slice(0, 200),
    autorId: autorId.slice(0, 64),
    nome: sanitizeUntrusted(String(item.authorDetails?.displayName ?? '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 60),
    texto: sanitizeUntrusted(bruto).replace(/\s+/g, ' ').trim().slice(0, MENSAGEM_DO_CHAT_MAX + 1),
    em: Number.isFinite(publicada) ? publicada : null,
  };
}

/**
 * O que fazer com uma mensagem do chat.
 *  - ignorar:  é da própria Yui, está vazia ou grande demais, tem link, parece ordem ou tem ofensa (nunca vira resposta);
 *  - responder: chamaram a Yui;
 *  - contar:   conversa de outras pessoas (só conta como movimento do chat; é o que dá assunto para um comentário espontâneo).
 * Todo mundo no chat é público, inclusive o dono: a mensagem NUNCA muda o papel de ninguém.
 * @returns {{ acao: 'ignorar'|'responder'|'contar', motivo: string }}
 */
export function classificarMensagem(msg, { idDaYui, nomes = NOMES_DA_YUI } = {}) {
  if (!msg) return { acao: 'ignorar', motivo: 'tipo' };
  if (idDaYui && msg.autorId === idDaYui) return { acao: 'ignorar', motivo: 'propria' };
  if (!msg.texto) return { acao: 'ignorar', motivo: 'vazia' };
  if (msg.texto.length > MENSAGEM_DO_CHAT_MAX) return { acao: 'ignorar', motivo: 'longa' };
  if (temLink(msg.texto)) return { acao: 'ignorar', motivo: 'link' };
  if (pareceInstrucao(msg.texto)) return { acao: 'ignorar', motivo: 'instrucao' };
  if (pareceOfensa(msg.texto)) return { acao: 'ignorar', motivo: 'ofensa' };
  return mencionaAYui(msg.texto, nomes) ? { acao: 'responder', motivo: 'chamada' } : { acao: 'contar', motivo: 'conversa' };
}

/**
 * Limite de mensagens por minuto (janela deslizante de 60 s). `permitir()` só consulta; `registrar()` conta o envio.
 */
export function criarLimiteDeMensagens({ maxPorMinuto = LIMITES_DA_FALA.maxPorMinuto, agora = Date.now } = {}) {
  if (!Number.isInteger(maxPorMinuto) || maxPorMinuto < 1) throw new RangeError('maxPorMinuto precisa ser um inteiro positivo');
  const envios = [];
  const podar = () => { const corte = agora() - 60_000; while (envios.length && envios[0] <= corte) envios.shift(); };
  return {
    permitir() { podar(); return envios.length < maxPorMinuto; },
    registrar() { podar(); envios.push(agora()); },
    /** Quanto falta (ms) para caber de novo; 0 se já cabe. */
    esperaMs() { podar(); return envios.length < maxPorMinuto ? 0 : Math.max(0, envios[envios.length - maxPorMinuto] + 60_000 - agora()); },
    get usadas() { podar(); return envios.length; },
  };
}

/**
 * A guarda de fala de UMA live (cria-se uma nova a cada live: o teto por live e a memória do que ela já disse somem quando ela sai).
 * @param {{ limites?: Partial<typeof LIMITES_DA_FALA>, agora?: () => number }} [o]
 */
export function criarGuardaDeFala({ limites = {}, agora = Date.now } = {}) {
  const L = { ...LIMITES_DA_FALA, ...limites };
  for (const [k, v] of Object.entries(L)) if (!Number.isInteger(v) || v < 1) throw new RangeError(`limite inválido: ${k}`);
  const porMinuto = criarLimiteDeMensagens({ maxPorMinuto: L.maxPorMinuto, agora });
  let ultimoEnvioEm = null;
  let ultimaEspontaneaEm = null;
  let espontaneas = 0;
  let espontaneaSemAlguemNoMeio = false; // a última mensagem dela foi espontânea e ninguém falou depois
  let quieta = false;
  let modoLentoMs = 0;
  const recentes = []; // { em, autor } das mensagens de OUTRAS pessoas
  const ditas = []; // o que ela já disse (normalizado), para não repetir

  const podarRecentes = () => { const corte = agora() - L.chatAtivoJanelaMs; while (recentes.length && recentes[0].em <= corte) recentes.shift(); };
  const chatAtivo = () => { podarRecentes(); return recentes.length >= L.chatAtivoMinMensagens && new Set(recentes.map((r) => r.autor)).size >= L.chatAtivoMinPessoas; };
  const negar = (motivo, esperarMs = 0) => ({ ok: false, motivo, esperarMs: Math.max(0, Math.ceil(esperarMs)) });

  return {
    /** Alguém (que não é a Yui) falou no chat: conta como movimento do chat e libera um novo comentário espontâneo. */
    registrarMensagemDeOutro({ autor }) { recentes.push({ em: agora(), autor: String(autor ?? '') }); espontaneaSemAlguemNoMeio = false; },
    /** A Yui mandou uma mensagem (respostas e comentários contam no limite por minuto e no intervalo mínimo). */
    registrarEnvio({ tipo, texto }) {
      const t = agora();
      porMinuto.registrar();
      ultimoEnvioEm = t;
      if (tipo === 'espontanea') { ultimaEspontaneaEm = t; espontaneas += 1; espontaneaSemAlguemNoMeio = true; }
      if (typeof texto === 'string') { ditas.push(normalizar(texto).replace(/\s+/g, ' ').trim()); if (ditas.length > 20) ditas.shift(); }
    },
    /** O texto repete algo que ela já disse nesta live? */
    repetido(texto) { return ditas.includes(normalizar(texto).replace(/\s+/g, ' ').trim()); },
    /** O modo lento da live (ms entre mensagens de cada pessoa; a Yui espera o mesmo entre as dela). 0 desliga. */
    definirModoLento(ms) { modoLentoMs = Number.isInteger(ms) && ms > 0 ? Math.min(ms, 300_000) : 0; },
    /** "fica quieta": desliga os comentários espontâneos e deixa só as respostas. */
    calar() { quieta = true; },
    liberar() { quieta = false; },
    /**
     * Pode falar agora? `tipo`: 'resposta' (chamaram a Yui) ou 'espontanea' (puxar assunto). `nivelDaCota`: o nível de cota/cota.js.
     * @returns {{ ok: true } | { ok: false, motivo: string, esperarMs: number }}
     */
    avaliar({ tipo, nivelDaCota = 'ok' }) {
      const t = agora();
      if (tipo === 'resposta') {
        if (nivelDaCota === 'esgotada') return negar('cota-esgotada');
      } else if (tipo === 'espontanea') {
        if (quieta) return negar('quieta');
        if (nivelDaCota !== 'ok') return negar('cota');
        if (espontaneas >= L.maxEspontaneasPorLive) return negar('teto-da-live');
        if (espontaneaSemAlguemNoMeio) return negar('duas-seguidas');
        if (ultimaEspontaneaEm !== null && t - ultimaEspontaneaEm < L.intervaloEspontaneaMs) return negar('intervalo-espontaneo', L.intervaloEspontaneaMs - (t - ultimaEspontaneaEm));
        if (!chatAtivo()) return negar('chat-parado');
      } else {
        return negar('tipo-invalido');
      }
      const intervalo = Math.max(L.intervaloMinimoMs, modoLentoMs);
      if (ultimoEnvioEm !== null && t - ultimoEnvioEm < intervalo) return negar(modoLentoMs > L.intervaloMinimoMs ? 'modo-lento' : 'intervalo-minimo', intervalo - (t - ultimoEnvioEm));
      if (!porMinuto.permitir()) return negar('limite-por-minuto', porMinuto.esperaMs());
      return { ok: true };
    },
    /** Retrato SEM texto de ninguém: só números e marcas. */
    retrato() { return { espontaneas, quieta, modoLentoMs, enviosNoUltimoMinuto: porMinuto.usadas, chatAtivo: chatAtivo(), limites: { ...L } }; },
  };
}

/**
 * O que vai ao cérebro para ele escolher um assunto: o título da live e as últimas falas do chat, como DADO não confiável (curtos, limpos, sem link).
 * @param {{ titulo: string, mensagens: { texto: string }[], max?: number }} p
 */
export function montarContextoDeAssunto({ titulo, mensagens, max = 5 }) {
  const limpo = (t, n) => sanitizeUntrusted(String(t ?? '')).replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    titulo: limpo(titulo, 120),
    recentes: (mensagens ?? []).filter((m) => m?.texto && !temLink(m.texto)).slice(-max).map((m) => limpo(m.texto, 120)),
  };
}
