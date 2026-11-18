import * as cheerio from 'cheerio';

/**
 * LEITURA da página HTML de resultados do DuckDuckGo (só o texto já baixado: este módulo não faz nenhum pedido e não conhece o endereço do buscador; o
 * endereço mora só em src/search/providers.js, a ÚNICA porta de saída da busca externa, com a cota por hora e o dono dela).
 *
 * Veio de src/core/dev/web-search.js (o agente de código do app), que reexporta estas funções: o providers.js e os testes seguem usando-as. Ficou num módulo
 * à parte para o agente de código poder chamar o `searchWeb` (providers.js) sem um ciclo de imports.
 *
 * Correções em relação ao Jarvis: o link vinha de `.result__url` (que quase sempre não tem href), então a "Fonte" saía como "undefined"; os links do
 * DuckDuckGo são redirecionamentos (?uddg=...) e agora são decodificados. Anúncios (`.result--ad`, links `duckduckgo.com/y.js`) são descartados: seguir um
 * deles equivale a clicar no anúncio.
 */

/** Link de anúncio do DuckDuckGo (https://duckduckgo.com/y.js?...). */
function isAdLink(link) {
  try {
    const url = new URL(link);
    return /(^|\.)duckduckgo\.com$/i.test(url.hostname) && /^\/y\.js$/i.test(url.pathname);
  } catch {
    return true;
  }
}

function decodeLink(href) {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const final = url.searchParams.get('uddg') || url.href; // searchParams já devolve o valor decodificado
    return /^https?:\/\//i.test(final) && !isAdLink(final) ? final : null;
  } catch {
    return null;
  }
}

/**
 * Lê a página de resultados: { results, markup, noResults }.
 *  - results: resultados orgânicos (sem anúncios);
 *  - markup: a página tem blocos `.result` (mesmo que só de anúncios), ou seja, parece uma página de busca de verdade;
 *  - noResults: a página diz explicitamente que não há resultados.
 */
function inspectResults(html, maxResults = 5) {
  const $ = cheerio.load(html);
  const results = [];
  const blocks = $('.result');
  blocks.each((_, el) => {
    if (results.length >= maxResults) return false;
    const block = $(el);
    if (block.is('.result--ad') || block.find('.result--ad, .badge--ad').length) return undefined;
    const anchor = block.find('a.result__a').first();
    const title = anchor.text().replace(/\s+/g, ' ').trim();
    const snippet = block.find('.result__snippet').first().text().replace(/\s+/g, ' ').trim();
    const url = decodeLink(anchor.attr('href'));
    if (title && url) results.push({ title: title.slice(0, 160), snippet: snippet.slice(0, 300), url });
    return undefined;
  });
  return { results, markup: blocks.length > 0, noResults: $('.no-results').length > 0 };
}

function parseResults(html, maxResults = 5) {
  return inspectResults(html, maxResults).results;
}

export { parseResults, inspectResults, decodeLink };
