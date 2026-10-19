/**
 * Corte e divisão do texto falado (depois de normalizeForSpeech).
 *
 * A Yui nunca lê uma resposta inteira em voz alta: a fala tem teto de caracteres
 * e de frases (config.js), e o resto fica no chat. Este módulo decide o QUE falar
 * e em quantos pedaços, sempre cortando em fim de frase quando possível:
 *
 *   full       cabe tudo
 *   truncated  só as primeiras frases que cabem + "O resto está no chat."
 *   pointer    havia código, lista ou link: a 1ª frase (se for uma introdução
 *              de verdade) + "Mandei os detalhes no chat."
 *   none       não sobrou nada para falar
 *
 * Módulo puro: sem efeitos colaterais ao importar, custo linear na entrada (que é
 * cortada em MAX_SPLIT_INPUT) e nenhuma regex com backtracking catastrófico.
 */

import { getTtsConfig } from './config.js';

/** Frases fixas. Ficam em cache de áudio no engine; por isso são constantes. */
export const FIXED_PHRASES = Object.freeze({
  rest: 'O resto está no chat.',
  details: 'Mandei os detalhes no chat.',
  pass: 'Essa eu passo.',
});

/** Pedaços menores que isso são grudados no vizinho (evita falas de uma palavra e pausas à toa). */
const MIN_PIECE = 25;
/** Meta de tamanho da 1ª frase, para o primeiro som sair rápido. */
const FIRST_TARGET = 80;
/** Se a 1ª frase passar da meta, o corte aceita ir até aqui. */
const FIRST_LIMIT = 100;
/** Introdução mínima (modo pointer) para valer a pena ser falada. */
const MIN_INTRO = 15;
/** Entrada acima disso é descartada: a fala usa poucas centenas de caracteres. */
const MAX_SPLIT_INPUT = 20_000;
/** Resto omitido a partir do qual o aviso "O resto está no chat." é obrigatório. */
const REST_NOTICE_CHARS = 40;

/** Limites vindos da configuração; valor ausente ou inválido cai no padrão de config.js. */
function limits(cfg) {
  const d = getTtsConfig({});
  const pick = (v, def, min) => (Number.isFinite(v) && v >= min ? Math.floor(v) : def);
  const maxChars = pick(cfg?.maxChars, d.maxChars, 20);
  return {
    maxChars,
    maxSentences: pick(cfg?.maxSentences, d.maxSentences, 1),
    // Uma frase nunca pode ser maior que o total permitido.
    maxSentenceChars: Math.min(pick(cfg?.maxSentenceChars, d.maxSentenceChars, 20), maxChars),
  };
}

// Fim de frase: pontuação final (+ aspas de fechamento opcionais) e UM espaço, seguido de
// maiúscula, número ou abertura de aspas. Sem quantificadores: custo O(1) por posição.
// O ":" também separa: "Aqui estão as opções: Maçã. Uva." deixa "Aqui estão as opções:" sozinha,
// e é isso que o modo pointer precisa para não falar uma introdução que promete uma lista.
const RE_BOUNDARY = /[.!?…:]["”»')]? (?=[\p{Lu}\p{N}"“«(¿¡])/gu;
// "Dr." / "Sra." / "J." (inicial) antes de maiúscula NÃO encerram a frase.
const RE_ABBR_TAIL = /(?:^|[^\p{L}])(?:dra?|sra?|srta|profa?|eng|av|pág|págs|tel|obs|vs|aprox|art|cap|p\.ex|e\.g|i\.e)\.$/iu;
const RE_INITIAL_TAIL = /(?:^|[^\p{L}])\p{Lu}\.$/u;

function endsWithAbbreviation(piece) {
  const tail = piece.slice(-12);
  return tail.endsWith('.') && (RE_ABBR_TAIL.test(tail) || RE_INITIAL_TAIL.test(tail));
}

/**
 * Divide em frases SEM juntar pedaços curtos e SEM cortar frases longas.
 * Cada linha é uma fronteira. Exportada para diagnóstico e testes.
 * @param {string} text texto já normalizado (funciona com texto cru também)
 * @returns {string[]}
 */
export function splitSentencesRaw(text) {
  const out = [];
  const lines = String(text ?? '').slice(0, MAX_SPLIT_INPUT).split(/\r\n|\r|\n/);
  for (const rawLine of lines) {
    // Colapsa o espaço ANTES de procurar fronteiras: assim a regex só vê espaços simples.
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    let start = 0;
    RE_BOUNDARY.lastIndex = 0;
    let m;
    while ((m = RE_BOUNDARY.exec(line)) !== null) {
      const end = m.index + m[0].length - 1; // sem o espaço final
      const piece = line.slice(start, end);
      if (endsWithAbbreviation(piece)) continue;
      out.push(piece.trim());
      start = end + 1;
    }
    const rest = line.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

function mergeShort(pieces) {
  const merged = [];
  for (const p of pieces) {
    const last = merged.length - 1;
    if (last >= 0 && merged[last].length < MIN_PIECE) merged[last] = `${merged[last]} ${p}`;
    else merged.push(p);
  }
  if (merged.length > 1 && merged[merged.length - 1].length < MIN_PIECE) {
    const tail = merged.pop();
    merged[merged.length - 1] += ` ${tail}`;
  }
  return merged;
}

/** Não corta um par substituto (emoji, letra rara) ao meio. */
function safeCut(text, pos) {
  const c = text.charCodeAt(pos - 1);
  return c >= 0xd800 && c <= 0xdbff ? pos - 1 : pos;
}

/**
 * Melhor ponto de corte em `window` (texto começando na posição 0) com no máximo
 * `limit` caracteres: depois da vírgula/ponto e vírgula/dois pontos mais perto do
 * limite, senão no último espaço, senão corte duro. Devolve o tamanho do 1º pedaço.
 */
function findCut(window, limit) {
  const minLen = Math.floor(limit * 0.4);
  let cut = -1;
  for (const ch of [',', ';', ':']) {
    const i = window.lastIndexOf(ch, limit - 1);
    if (i >= minLen) cut = Math.max(cut, i + 1);
  }
  if (cut < 0) {
    const sp = window.lastIndexOf(' ', limit);
    if (sp > 0) cut = sp;
  }
  return safeCut(window, cut > 0 ? cut : limit);
}

/**
 * Quebra uma frase maior que `max` em pedaços de até `max` caracteres. Quando o que
 * sobraria é pequeno, divide ao meio em vez de deixar uma "cauda" de poucas palavras.
 * Cada passo olha só uma janela de `max` caracteres (custo linear no total).
 */
function cutLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let pos = 0;
  while (text.length - pos > max) {
    const remaining = text.length - pos;
    const limit = remaining <= max + MIN_PIECE ? Math.ceil(remaining / 2) : max;
    const window = text.slice(pos, pos + limit + 1);
    // Sempre avança pelo menos 1: com um substituto UTF-16 solitário no começo, `safeCut` devolvia 0,
    // `pos` não andava e o laço empilhava '' para sempre (travava o processo e estourava a memória).
    const cut = Math.max(1, findCut(window, limit));
    out.push(text.slice(pos, pos + cut).trim());
    pos += cut;
    while (text[pos] === ' ') pos++;
  }
  const tail = text.slice(pos).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/**
 * 1ª frase longa: parte em vírgula (ou antes de " e ") para o primeiro som sair
 * rápido. Prefere o corte mais perto da meta de 80 sem passar dela; se só houver
 * corte entre 80 e 100, usa o menor deles. Ambos os lados ficam com 25+ caracteres.
 */
function latencyCut(first) {
  if (first.length <= FIRST_TARGET) return [first];
  const window = first.slice(0, FIRST_LIMIT + 1);
  const cuts = [];
  for (let i = 0; i < window.length; i++) {
    const ch = window[i];
    if (ch === ',' || ch === ';' || ch === ':') cuts.push(i + 1);
    else if (ch === ' ' && window.startsWith(' e ', i)) cuts.push(i);
  }
  const valid = cuts.filter((c) => c >= MIN_PIECE && c <= FIRST_LIMIT && first.length - c >= MIN_PIECE);
  const within = valid.filter((c) => c <= FIRST_TARGET);
  const cut = within.length ? Math.max(...within) : valid.length ? Math.min(...valid) : -1;
  if (cut < 0) return [first];
  return [first.slice(0, cut).trim(), first.slice(cut).trim()];
}

/**
 * Divide o texto normalizado em frases para sintetizar uma a uma:
 *  - não corta depois de abreviações ("Dr. Silva"), nem dentro de URL;
 *  - junta pedaços com menos de 25 caracteres ao vizinho;
 *  - nenhuma frase passa de cfg.maxSentenceChars (corte em vírgula, depois espaço);
 *  - a 1ª frase é partida perto de 80 caracteres, se der, para baixa latência.
 * Não aplica o teto de frases/caracteres da fala: isso é prepareSpeech.
 * @param {string} text
 * @param {{ maxSentenceChars?: number, maxChars?: number }} [cfg] getTtsConfig()
 * @returns {string[]}
 */
export function splitSentences(text, cfg) {
  const { maxSentenceChars } = limits(cfg);
  const pieces = mergeShort(splitSentencesRaw(text)).flatMap((p) => cutLong(p, maxSentenceChars));
  if (!pieces.length) return pieces;
  return [...latencyCut(pieces[0]), ...pieces.slice(1)];
}

/** Garante pontuação final (a síntese soa melhor); vírgula ou dois pontos no fim viram ponto. */
function closeSentence(s) {
  let end = s.length;
  while (end > 0 && ' ,;:-–—'.includes(s[end - 1])) end--;
  const body = s.slice(0, end);
  if (!body) return s;
  return '.!?…'.includes(body[body.length - 1]) ? body : `${body}.`;
}

/**
 * Decide o que a Yui fala.
 * @param {{ text: string, flags?: { hadCode?: boolean, hadList?: boolean, hadLink?: boolean } }} norm
 *        retorno de normalizeForSpeech (aceita também uma string simples)
 * @param {object} [cfg] getTtsConfig(): maxChars, maxSentences, maxSentenceChars
 * @returns {{ mode: 'full'|'truncated'|'pointer'|'none', sentences: string[] }}
 *          As frases fixas entram como ÚLTIMA frase.
 */
export function prepareSpeech(norm, cfg) {
  const lim = limits(cfg);
  const text = typeof norm === 'string' ? norm : String(norm?.text ?? '');
  const flags = typeof norm === 'string' ? {} : norm?.flags || {};
  const hasText = /\p{L}/u.test(text);

  // Código, lista ou link: não se lê; fala só uma introdução e manda olhar o chat.
  if (flags.hadCode || flags.hadList || flags.hadLink) {
    const first = hasText ? splitSentencesRaw(text)[0] : undefined;
    const intro = first && first.length >= MIN_INTRO && !first.endsWith(':')
      ? closeSentence(cutLong(first, lim.maxSentenceChars)[0])
      : null;
    return { mode: 'pointer', sentences: intro ? [intro, FIXED_PHRASES.details] : [FIXED_PHRASES.details] };
  }
  if (!hasText) return { mode: 'none', sentences: [] };

  const all = splitSentences(text, lim);
  if (!all.length) return { mode: 'none', sentences: [] };

  const chosen = [];
  let used = 0;
  for (const s of all) {
    if (chosen.length >= lim.maxSentences) break;
    const cost = s.length + (chosen.length ? 1 : 0);
    // +1: closeSentence pode acrescentar um ponto final à última frase escolhida.
    if (used + cost + 1 > lim.maxChars) break;
    chosen.push(s);
    used += cost;
  }
  let omittedChars = all.slice(chosen.length).reduce((sum, s) => sum + s.length, 0);
  if (!chosen.length) {
    // Nem a 1ª frase cabe inteira no teto: fala o começo dela, cortado em vírgula ou espaço.
    const head = cutLong(all[0], lim.maxChars - 1)[0];
    chosen.push(head);
    omittedChars = text.length - head.length;
  }

  if (chosen.length === all.length && omittedChars === 0) {
    return { mode: 'full', sentences: [...chosen.slice(0, -1), closeSentence(chosen[chosen.length - 1])] };
  }
  // "O resto está no chat." sempre que sobrar ao menos uma frase ou 40+ caracteres.
  const omittedSentences = all.length - chosen.length;
  const needNotice = omittedSentences >= 1 || omittedChars >= REST_NOTICE_CHARS;
  const spoken = [...chosen.slice(0, -1), closeSentence(chosen[chosen.length - 1])];
  if (needNotice) spoken.push(FIXED_PHRASES.rest);
  return { mode: 'truncated', sentences: spoken };
}
