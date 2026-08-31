import { scrapeNewswireArticles } from './scraper.js';
import { newsRepository } from '../../database/repositories/newsRepo.js';
import { translateToPortuguese } from '../../utils/translate.js';
import { logger } from '../../utils/logger.js';

let isCheckingNews = false;

export const newswireEngine = {
  /**
   * Consulta os artigos mais recentes no Newswire, compara com o banco e identifica artigos inéditos
   * Possui controle de concorrência (mutex) e parada antecipada para otimização de CPU/rede.
   * @returns {Promise<Array>} Lista de novos artigos não publicados em ordem cronológica
   */
  async checkLatestNews() {
    if (isCheckingNews) {
      logger.warn('[NewswireEngine] ⏳ Ciclo de checagem já em andamento. Ignorando chamada concorrente.');
      return [];
    }

    isCheckingNews = true;
    try {
      logger.info('[NewswireEngine] Iniciando ciclo de checagem do Rockstar Newswire...');

      // 1. Extrai os artigos mais recentes da página
      const scraped = await scrapeNewswireArticles();
      if (!scraped || scraped.length === 0) {
        logger.info('[NewswireEngine] Nenhum artigo coletado na checagem atual.');
        return [];
      }

      // 2. Filtra os artigos inéditos parando assim que encontrar artigos já conhecidos
      const unseenArticles = [];
      for (const article of scraped) {
        if (newsRepository.getByUrl(article.url)) {
          // Como os artigos vêm em ordem decrescente (mais novos primeiro),
          // ao encontrar um que já existe no banco, podemos parar a verificação dos seguintes.
          break;
        }
        unseenArticles.push(article);
      }

      if (unseenArticles.length === 0) {
        logger.info('[NewswireEngine] Nenhuma notícia nova desde a última checagem.');
        return [];
      }

      // 3. Ordena de forma cronológica (os mais antigos primeiro para publicação na ordem certa)
      const sortedUnseen = [...unseenArticles].reverse();

      // 4. Traduz para português SOMENTE os artigos inéditos
      for (const article of sortedUnseen) {
        article.title = await translateToPortuguese(article.title);
        if (article.category && article.category !== 'Rockstar Games') {
          article.category = await translateToPortuguese(article.category);
        }
      }

      // 5. Salva no banco de dados
      const newArticles = newsRepository.insertMany(sortedUnseen);

      if (newArticles.length > 0) {
        logger.info(`[NewswireEngine] 🎉 ${newArticles.length} nova(s) notícia(s) detectada(s), traduzida(s) e registrada(s)!`);
      }

      return newArticles;
    } catch (err) {
      logger.error(`[NewswireEngine] Erro no ciclo de checagem: ${err.message}`);
      return [];
    } finally {
      isCheckingNews = false;
    }
  },
};

export default newswireEngine;
