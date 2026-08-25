import axios from 'axios';
import { logger } from './logger.js';

const cache = new Map();

/**
 * Traduz um texto curto de inglês para português (Brasil) usando a API
 * pública e gratuita do MyMemory (não requer chave/cadastro).
 *
 * É uma tradução automática (machine translation) — não é a tradução
 * oficial da Rockstar, então pode ocasionalmente soar estranha em
 * termos muito específicos do jogo. Em caso de falha (rede, limite de
 * requisições, texto vazio), retorna o texto original em inglês em vez
 * de quebrar o fluxo.
 */
export async function translateToPortuguese(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return text;
  }

  if (cache.has(text)) {
    return cache.get(text);
  }

  try {
    const response = await axios.get('https://api.mymemory.translated.net/get', {
      params: {
        q: text,
        langpair: 'en|pt-BR',
      },
      timeout: 8000,
    });

    const translated = response.data?.responseData?.translatedText;

    if (translated && typeof translated === 'string' && translated.trim().length > 0) {
      cache.set(text, translated);
      return translated;
    }

    return text;
  } catch (error) {
    logger.warn(`[Translate] Falha ao traduzir texto, mantendo original: ${error.message}`);
    return text;
  }
}
