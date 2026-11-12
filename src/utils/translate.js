import axios from 'axios';
import { logger } from './logger.js';

const cache = new Map();

/** Só para os testes: troca a chamada HTTP (o padrão é o axios). */
export const translateDeps = { get: (...args) => axios.get(...args) };

/** A API gratuita do MyMemory aceita no máximo 500 caracteres por pedido; ficamos abaixo para sobrar margem. */
export const TRANSLATE_CHUNK_MAX = 450;

// Mensagens que o MyMemory devolve NO LUGAR da tradução (com status 200 ou não): nunca podem virar texto do usuário.
const API_ERROR_RE = /QUERY LENGTH LIMIT|MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS|NO QUERY SPECIFIED|INVALID (?:LANGUAGE|EMAIL)|PLEASE SELECT TWO DISTINCT LANGUAGES|IS AN INVALID TARGET LANGUAGE/i;

/** O texto devolvido é uma mensagem de erro da API (e não uma tradução)? */
export function isTranslationApiError(text) {
  return API_ERROR_RE.test(String(text ?? ''));
}

/**
 * Divide o texto em pedaços de até `max` caracteres, preferindo cortar no fim de frase; uma frase maior que `max`
 * é cortada no último espaço. Nunca devolve pedaço vazio, e juntar os pedaços com espaço reconstrói o texto.
 */
export function splitForTranslation(text, max = TRANSLATE_CHUNK_MAX) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.split(/(?<=[.!?…])\s+/);
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (let sentence of sentences) {
    while (sentence.length > max) {
      let cut = sentence.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;
      if (current) push();
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (!sentence) continue;
    if ((current ? current.length + 1 : 0) + sentence.length > max) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

async function translateChunk(chunk) {
  if (cache.has(chunk)) return cache.get(chunk);
  const response = await translateDeps.get('https://api.mymemory.translated.net/get', {
    params: { q: chunk, langpair: 'en|pt-BR' },
    timeout: 8000,
  });
  const translated = response.data?.responseData?.translatedText;
  const statusOk = response.data?.responseStatus === undefined || Number(response.data.responseStatus) === 200;
  if (statusOk && typeof translated === 'string' && translated.trim().length > 0 && !isTranslationApiError(translated)) {
    cache.set(chunk, translated);
    return translated;
  }
  return chunk; // erro da API ou resposta vazia: mantém o original em inglês
}

/**
 * Traduz um texto de inglês para português (Brasil) usando a API pública e gratuita do MyMemory (não requer chave/cadastro).
 *
 * É uma tradução automática (machine translation), não a oficial da Rockstar, então pode soar estranha em termos
 * específicos do jogo. O texto é dividido em pedaços de até 450 caracteres (limite da API) e cada pedaço que falhar,
 * ou que vier como mensagem de erro da API, fica em inglês em vez de quebrar o fluxo ou virar "tradução" de erro.
 */
export async function translateToPortuguese(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return text;
  }
  const chunks = splitForTranslation(text);
  const out = [];
  for (const chunk of chunks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      out.push(await translateChunk(chunk));
    } catch (error) {
      logger.warn(`[Translate] Falha ao traduzir um trecho, mantendo o original: ${error.message}`);
      out.push(chunk);
    }
  }
  return out.join(' ');
}
