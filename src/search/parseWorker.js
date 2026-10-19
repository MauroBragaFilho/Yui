import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as cheerio from 'cheerio';

/**
 * Extração de texto de páginas HTML (cheerio) para o safeFetch.
 *
 * Por que existe: o cheerio/parse5 é SÍNCRONO. Uma página hostil (por exemplo `<div x="<">` repetido
 * 20000 vezes, ou 16000 `<div>` aninhados) trava o laço de eventos por 10 a 15 segundos e termina em
 * "Maximum call stack size exceeded". Como o bot lê páginas que aparecem nos resultados da busca (e
 * quem escolhe o assunto da busca é qualquer usuário), o parse roda numa worker thread que o safeFetch
 * cria sob demanda e ENCERRA se passar do prazo (ver extractPageTextIsolated em safeFetch.js).
 *
 * Este arquivo tem duas faces:
 *  - módulo comum (importado pelo safeFetch.js na thread principal): só exporta funções, sem efeito
 *    colateral ao importar;
 *  - ponto de entrada da worker (criada com workerData.yuiParseWorker === true): escuta mensagens
 *    { id, html, maxChars } e responde { id, text } ou { id, error }.
 */

export const NOISE = 'script, style, noscript, template, nav, footer, header, aside, .ads, .cookie-banner, .menu, .sidebar, .comments, .related, .related-posts, .social-share, .modal, .popup';

/** Corte do HTML ANTES do parse (caracteres). Padrão 300000; YUI_SEARCH_MAX_HTML_CHARS sobrepõe. */
export const DEFAULT_MAX_HTML_CHARS = 300000;
/**
 * Máximo de aberturas de tag (`<` seguido de letra, mesmo malformadas) que entram no parse; o resto do
 * HTML é descartado. Só limita o custo do parse dentro da worker (que também tem prazo). Padrão 20000;
 * YUI_SEARCH_MAX_HTML_TAGS sobrepõe.
 */
export const DEFAULT_MAX_HTML_TAGS = 20000;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Limites atuais (lidos do ambiente a cada chamada, para os testes poderem mudá-los). */
export function htmlLimits(env = process.env) {
  return {
    maxChars: positiveInt(env.YUI_SEARCH_MAX_HTML_CHARS, DEFAULT_MAX_HTML_CHARS),
    maxTags: positiveInt(env.YUI_SEARCH_MAX_HTML_TAGS, DEFAULT_MAX_HTML_TAGS),
  };
}

// Nome da tag de texto cru (script ou style) que abre em s[pos..] (logo depois do "<"), ou ''. Exige fim de nome: "<scripty>" não é script.
function rawTextTagAt(s, pos) {
  if ((s.charCodeAt(pos) | 32) !== 115) return ''; // 's': quase todo "<" acaba aqui, sem alocar nada
  const second = s.charCodeAt(pos + 1) | 32;
  const name = second === 99 ? 'script' : second === 116 ? 'style' : '';
  if (!name || s.substr(pos, name.length).toLowerCase() !== name) return '';
  const next = s.charAt(pos + name.length);
  return next === '' || next === '>' || next === '/' || /\s/.test(next) ? name : '';
}

/**
 * Tira os blocos <script>...</script> e <style>...</style> do HTML bruto. O extractTextCore já os remove (NOISE), então o texto extraído
 * não muda; a diferença é que isto roda ANTES do corte por tamanho: uma página com 800 KB de script embutido antes do artigo perdia o
 * artigo inteiro no corte de 300000 caracteres. Busca LINEAR com indexOf (nada de regex: um "<script" sem fechar tornaria uma regex
 * quadrática). Bloco que não fecha descarta até o fim: o parser HTML também trataria tudo depois dele como texto do script.
 */
export function dropRawTextBlocks(raw) {
  const s = String(raw ?? '');
  if (s.indexOf('<') < 0) return s;
  const parts = [];
  let last = 0; // início do trecho que ainda não foi copiado
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const name = rawTextTagAt(s, lt + 1);
    if (!name) {
      i = lt + 1;
      continue;
    }
    let close = -1;
    let from = lt + 1 + name.length;
    for (;;) {
      const k = s.indexOf('</', from);
      if (k < 0) break;
      if (s.substr(k + 2, name.length).toLowerCase() === name) {
        close = k;
        break;
      }
      from = k + 2;
    }
    parts.push(s.slice(last, lt));
    if (close < 0) {
      last = s.length;
      break;
    }
    const gt = s.indexOf('>', close);
    last = gt < 0 ? s.length : gt + 1;
    i = last;
  }
  parts.push(s.slice(last));
  return parts.join('');
}

/**
 * Corta o HTML bruto: sem blocos de script e style, no máximo `maxChars` caracteres e `maxTags` aberturas de tag. Custo linear
 * (indexOf e uma regex simples), seguro para qualquer entrada. Não tenta "entender" o HTML: quem decide se a página é pesada demais é o
 * prazo da worker.
 */
export function capHtml(raw, { maxChars = DEFAULT_MAX_HTML_CHARS, maxTags = DEFAULT_MAX_HTML_TAGS } = {}) {
  let s = dropRawTextBlocks(raw);
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // não deixa meio par substituto no fim
  }
  const openRe = /<[a-z]/gi;
  let count = 0;
  let m;
  while ((m = openRe.exec(s))) {
    count += 1;
    if (count > maxTags) {
      s = s.slice(0, m.index);
      break;
    }
  }
  return s;
}

/** Texto útil de uma página HTML (títulos e parágrafos do conteúdo principal), limitado a maxChars. SEM guardas: use capHtml antes. */
export function extractTextCore(html, maxChars = 2000) {
  const $ = cheerio.load(String(html ?? ''));
  $(NOISE).remove();
  let root = $('article');
  if (root.length === 0) root = $('main');
  if (root.length === 0) root = $('#content, .content, #main, .main');
  if (root.length === 0) root = $('body');
  let text = '';
  root.find('h1, h2, h3, p, li').each((_, el) => {
    if (text.length >= maxChars) return false;
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const heading = $(el).is('h1, h2, h3');
    if ((heading && t.length > 5) || t.length > 40) text += `${t}\n`;
    return undefined;
  });
  if (text.length < 100) text = root.text().replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}

// ---------------------------------------------------------------------------------------------
// Ponto de entrada da worker thread
// ---------------------------------------------------------------------------------------------

if (!isMainThread && parentPort && workerData?.yuiParseWorker === true) {
  parentPort.on('message', (msg) => {
    const id = msg?.id;
    try {
      const maxChars = Number.isFinite(msg?.maxChars) && msg.maxChars > 0 ? Math.floor(msg.maxChars) : 2000;
      parentPort.postMessage({ id, text: extractTextCore(msg?.html, maxChars) });
    } catch (err) {
      // RangeError (aninhamento profundo demais) ou qualquer falha do parser: a página vira "sem conteúdo".
      parentPort.postMessage({ id, error: String(err?.name || 'Error') });
    }
  });
  parentPort.postMessage({ ready: true });
}
