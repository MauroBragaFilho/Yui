import { scrapeNewswireArticles } from './scraper.js';
import { newsRepository } from '../../database/repositories/newsRepo.js';
import { translateToPortuguese } from '../../utils/translate.js';
import { logger } from '../../utils/logger.js';

export const newswireEngine = {
  /**
   * Consulta os artigos mais recentes no Newswire, compara com o banco e identifica artigos inéditos
   * @returns {Promise<Array>} Lista de novos artigos não publicados em ordem cronológica
   */
  async checkLatestNews() {
    logger.info('[NewswireEngine] Iniciando ciclo de checagem do Rockstar Newswire...');
    
    // 1. Extrai os artigos mais recentes da página (em inglês, fonte original)
    const scraped = await scrapeNewswireArticles();
    if (!scraped || scraped.length === 0) {
      logger.info('[NewswireEngine] Nenhum artigo coletado na checagem atual.');
      return [];
    }

    // 2. Ordena de forma cronológica (os mais antigos primeiro para publicação em ordem natural)
    const sorted = [...scraped].reverse();

    // 3. Traduz para português SOMENTE os artigos que ainda não existem no banco
    // (evita gastar chamadas de tradução em artigos já vistos anteriormente).
    const unseenArticles = sorted.filter((article) => !newsRepository.getByUrl(article.url));

    for (const article of unseenArticles) {
      article.title = await translateToPortuguese(article.title);
      if (article.category && article.category !== 'Rockstar Games') {
        article.category = await translateToPortuguese(article.category);
      }
    }

    // 4. Salva no banco de dados e obtém exclusivamente os que foram inseridos agora (inéditos)
    const newArticles = newsRepository.insertMany(sorted);

    if (newArticles.length > 0) {
      logger.info(`[NewswireEngine] 🎉 ${newArticles.length} nova(s) notícia(s) detectada(s), traduzida(s) e registrada(s)!`);
    } else {
      logger.info('[NewswireEngine] Nenhuma notícia nova desde a última checagem.');
    }

    return newArticles;
  },
};
