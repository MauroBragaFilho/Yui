import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../../../utils/logger.js';
import { getLatestWeekly, searchWeeklyPosts } from './reddit.js';
import { parseWeekly } from './parser.js';
import { isValidWeekly } from './validator.js';

/**
 * Serviço Weekly — orquestra o fluxo completo:
 *
 *   Reddit (consulta) → detecção de novo post → parser → validação →
 *   cache (controle de estado) → retorno dos dados estruturados.
 *
 * O cache serve APENAS para controle de estado (último post processado),
 * NUNCA como fonte primária dos dados. O Reddit é sempre a fonte.
 *
 * Ordem de atualização do cache (importante): o ID do post só é marcado
 * como processado ACIMA no fluxo, após o parser/validação e (quando
 * habilitado) após o callback de publicação ter sido acionado. Isso evita
 * marcar como processado um Weekly que falhou antes da publicação.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'cache.json');

const DEFAULT_CACHE = { postId: null, updatedAt: null };

/** Lê o cache do disco; se ausente/corrompido, retorna vazio. */
export function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return { ...DEFAULT_CACHE };
    }
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return {
      postId: raw.postId ?? null,
      updatedAt: raw.updatedAt ?? null,
    };
  } catch (err) {
    logger.warn(`[Weekly][Cache] Falha ao ler cache (${err.message}); usando estado vazio.`);
    return { ...DEFAULT_CACHE };
  }
}

/** Salva o cache no disco (best-effort; nunca derruba o processo). */
export function writeCache({ postId, updatedAt }) {
  try {
    const payload = { postId, updatedAt: updatedAt || new Date().toISOString() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    logger.info(`[Weekly][Cache] Estado atualizado: postId=${payload.postId}.`);
    return payload;
  } catch (err) {
    logger.error(`[Weekly][Cache] Falha ao salvar cache: ${err.message}`);
    return null;
  }
}

/**
 * Monta o objeto final do Weekly já com o vínculo ao post de origem
 * (id/url) e o período/resultados do parser.
 */
function buildWeeklyOutput(post, parsed) {
  return {
    id: post.id,
    url: post.url,
    title: post.title,
    // Timestamp do post (epoch UTC) usado no rodapé do embed enxuto.
    createdUtc: post.createdUtc,
    // selftext cru preservado para que a IA possa analisar o post original
    // (prompt de análise semanal em weeklyAnalysis.js usa fullText || summary).
    fullText: post.selftext || '',
    source: 'reddit',
    periodo: parsed.periodo,
    bonus: parsed.bonus,
    desafios: parsed.desafios,
    recompensas: parsed.recompensas,
    // descontos no formato do parser (array de strings como "Grotti Turismo R - 30%").
    descontos: parsed.descontos,
    // Alias "discounts" usado pelo buildWeeklyCombinedEmbeds para agrupar
    // por loja via groupDiscountsByStore(). Mesmo conteúdo, nome em inglês
    // para compatibilidade com o embed builder existente.
    discounts: parsed.descontos,
    veiculos: parsed.veiculos,
    gunVan: parsed.gunVan,
    gtaPlus: parsed.gtaPlus,
    atualizadoEm: parsed.atualizadoEm,
  };
}

export const weeklyService = {
  /** Último post processado (estado do cache). */
  getLastProcessed() {
    return readCache();
  },

  /**
   * Obtém o Weekly mais recente VÁLIDO do Reddit, independente de já ter
   * sido processado ou não. Retorna o JSON normalizado ou null.
   *
   * Trata erros de rede/Reddit (403, 429, timeout) retornando null em vez
   * de lançar exceção, para que os chamadores (engine, comando) possam
   * recorrer ao cache ou exibir uma mensagem amigável.
   */
  async getLatest() {
    let post;
    try {
      post = await getLatestWeekly();
    } catch (err) {
      logger.warn(`[Weekly] Reddit indisponível em getLatest (${err.message}); usando fallback.`);
      return null;
    }

    if (!post) {
      logger.warn('[Weekly] Nenhum post Weekly encontrado no Reddit.');
      return null;
    }

    logger.info(`[Weekly] Post encontrado: ${post.id}`);
    const parsed = parseWeekly(post.selftext, post.title);
    if (!isValidWeekly(parsed, post)) {
      return null;
    }
    return buildWeeklyOutput(post, parsed);
  },

  /**
   * Executa um ciclo de verificação. Se houver um post NOVO (diferente do
   * último processado) e VÁLIDO, dispara o processo. Retorna um objeto com
   * o resultado da execução para diagnóstico.
   *
   * @param {object} opts
   * @param {(weekly: object) => Promise<void>} [opts.onNew] — callback de
   *   publicação/acréscimo chamado para posts novos válidos.
   */
  async checkForUpdates({ onNew } = {}) {
    const cache = readCache();
    let post;
    try {
      post = await getLatestWeekly();
    } catch (err) {
      logger.error(`[Weekly] Erro ao consultar Reddit: ${err.message}`);
      // Reddit indisponível: NÃO toca no cache e não publica nada.
      return { status: 'error', reason: err.code || 'REDDIT_ERROR' };
    }

    if (!post) {
      logger.info('[Weekly] Nenhum post Weekly encontrado no Reddit; nada a fazer.');
      return { status: 'none' };
    }

    if (cache.postId === post.id) {
      logger.info(`[Weekly] Post ${post.id} já processado; nada a fazer.`);
      return { status: 'already-processed', id: post.id };
    }

    logger.info('[Weekly] Novo Weekly detectado.');
    const parsed = parseWeekly(post.selftext, post.title);
    if (!isValidWeekly(parsed, post)) {
      return { status: 'invalid', id: post.id };
    }

    const weekly = buildWeeklyOutput(post, parsed);

    // Dispara a publicação/acréscimo ANTES de atualizar o cache, conforme
    // a ordem prevista no plano (item 15).
    if (typeof onNew === 'function') {
      try {
        await onNew(weekly);
      } catch (err) {
        logger.error(`[Weekly] Falha no callback de publicação: ${err.message}`);
        // Não marca como processado, pois a publicação falhou.
        return { status: 'publish-error', id: post.id };
      }
    }

    writeCache({ postId: post.id });
    logger.info('[Weekly] Dados atualizados.');
    return { status: 'published', id: post.id };
  },

  /** Busca posts brutos (para testes/diagnóstico do Reddit). */
  async searchRaw() {
    return searchWeeklyPosts();
  },
};

export default weeklyService;
