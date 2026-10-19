import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../../../utils/logger.js';
import { alertOwner } from '../../../../core/alerts.js';
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

// Falhas SEGUIDAS de publicação do mesmo post (TG-18). Fica só em memória: reiniciar zera a conta, o
// que é aceitável (o objetivo é não repetir o mesmo erro para sempre dentro de uma execução).
const MAX_PUBLISH_FAILURES = 3;
let publishFailures = { id: null, count: 0 };

/** Lê o cache do disco; se ausente/corrompido, retorna vazio. */
export function readCache(file = CACHE_FILE) {
  try {
    if (!fs.existsSync(file)) {
      return { ...DEFAULT_CACHE };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
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
export function writeCache({ postId, updatedAt }, file = CACHE_FILE) {
  try {
    const payload = { postId, updatedAt: updatedAt || new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
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

/**
 * 3ª falha seguida de publicação do mesmo post: avisa o dono, tenta UMA vez publicar só o título e o
 * link (versão mínima) e marca o post como processado, para o mesmo erro não se repetir a cada ciclo.
 */
async function giveUpPublishing(weekly, onNew, { alert, cacheFile, lastError }) {
  publishFailures = { id: null, count: 0 };

  let minimal = false;
  try {
    await onNew({ ...weekly, minimal: true });
    minimal = true;
  } catch (err) {
    logger.error(`[Weekly] A versão mínima também falhou: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  writeCache({ postId: weekly.id }, cacheFile);
  logger.warn(
    `[Weekly] Post ${weekly.id}: ${MAX_PUBLISH_FAILURES} falhas seguidas de publicação; ` +
      (minimal ? 'publicado só com título e link' : 'desisti desta semana') +
      ' e marcado como processado.'
  );
  try {
    alert(
      'weekly-publish',
      'Não consegui publicar o Weekly',
      `O post ${weekly.id} falhou ${MAX_PUBLISH_FAILURES} vezes seguidas (${lastError}). ` +
        (minimal ? 'Publiquei só o título e o link.' : 'Desisti desta semana para não repetir o erro.'),
      { level: 'error', cooldownMinutes: 360 }
    );
  } catch {
    /* aviso nunca derruba o ciclo */
  }
  return { status: minimal ? 'published-minimal' : 'publish-abandoned', id: weekly.id };
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
   * @param {Function} [opts.alert] — aviso ao dono (padrão: alertOwner). Injetável para teste.
   * @param {string} [opts.cacheFile] — arquivo do cache (padrão: cache.json). Injetável para teste.
   * @param {Function} [opts.fetchLatest] — busca do post mais recente (padrão: Reddit). Injetável para teste.
   */
  async checkForUpdates({ onNew, alert = alertOwner, cacheFile = CACHE_FILE, fetchLatest = getLatestWeekly } = {}) {
    const cache = readCache(cacheFile);
    let post;
    try {
      post = await fetchLatest();
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
        publishFailures = { id: null, count: 0 };
      } catch (err) {
        // Conta as falhas seguidas do MESMO post. Falhar sempre igual, ciclo após ciclo, deixaria o
        // Weekly sem sair para sempre e sem ninguém saber (TG-18).
        const count = publishFailures.id === post.id ? publishFailures.count + 1 : 1;
        publishFailures = { id: post.id, count };
        const lastError = String(err?.message ?? err).slice(0, 160);
        logger.error(`[Weekly] Falha no callback de publicação (${count} de ${MAX_PUBLISH_FAILURES}): ${lastError}`);
        if (count >= MAX_PUBLISH_FAILURES) {
          return giveUpPublishing(weekly, onNew, { alert, cacheFile, lastError });
        }
        // Não marca como processado, pois a publicação falhou.
        return { status: 'publish-error', id: post.id, failures: count };
      }
    }

    writeCache({ postId: post.id }, cacheFile);
    logger.info('[Weekly] Dados atualizados.');
    return { status: 'published', id: post.id };
  },

  /** Busca posts brutos (para testes/diagnóstico do Reddit). */
  async searchRaw() {
    return searchWeeklyPosts();
  },
};

export default weeklyService;
