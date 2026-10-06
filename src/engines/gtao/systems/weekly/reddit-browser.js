import fs from 'fs';
import * as cheerio from 'cheerio';
import { logger } from '../../../../utils/logger.js';

/**
 * Acesso ao Reddit via navegador real (Puppeteer) para o Weekly do GTA Online.
 *
 * Por quê: o Reddit bloqueia (403 "blocked by network security") requisições
 * HTTP comuns (curl/fetch) e o endpoint `.json`, mesmo com cookies. Já o feed
 * RSS/Atom da busca é entregue normalmente a um Chrome real. Este módulo:
 *
 *   1. abre o navegador SOB DEMANDA e o fecha logo depois (não fica residente);
 *   2. carrega o feed Atom de busca do r/gtaonline;
 *   3. converte o HTML de cada post de volta para o markdown que o parser
 *      do Weekly já entende (`# Título`, `* [Chave](url): Valor`, `**negrito**`);
 *   4. devolve objetos no MESMO formato do `.json` do Reddit, para que o
 *      restante do sistema (reddit.js → parser → service) não mude.
 *
 * Navegador: usa o Chrome/Edge instalado no sistema (sem baixar nada). Pode ser
 * definido com REDDIT_BROWSER_PATH ou PUPPETEER_EXECUTABLE_PATH; sem nenhum
 * deles, cai no Chrome do próprio Puppeteer.
 */

export const FEED_URL =
  'https://www.reddit.com/r/gtaonline/search.rss' +
  '?q=title:%22Weekly%20Bonuses%20and%20Discounts%22' +
  '&restrict_sr=1&sort=new&limit=5';

const NAV_TIMEOUT_MS = 30000;

const SYSTEM_BROWSERS = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

/** Caminho do navegador a usar, ou undefined para o Chrome do Puppeteer. */
export function findBrowserExecutable() {
  const candidates = [
    process.env.REDDIT_BROWSER_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...(SYSTEM_BROWSERS[process.platform] || []),
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

// ───────────────────────── HTML → markdown ─────────────────────────

/**
 * Converte o HTML do post (renderizado pelo Reddit) em markdown simples.
 * Preserva títulos (#), listas (* com indentação para níveis), negrito, itálico
 * e links `[texto](url)`; descarta scripts, comentários e o rodapé "submitted by".
 */
export function htmlToMarkdown(html) {
  const $ = cheerio.load(`<div id="root">${html || ''}</div>`, { xmlMode: false }, false);
  const root = $('#root');

  // Remove o rodapé padrão do feed ("submitted by /u/... [link] [comments]").
  root.contents().each((_, el) => {
    if (el.type === 'comment') $(el).remove();
  });

  function inline(node) {
    let out = '';
    $(node).contents().each((_, child) => {
      if (child.type === 'text') { out += child.data; return; }
      if (child.type !== 'tag') return;
      const tag = child.name.toLowerCase();
      const inner = inline(child);
      if (tag === 'strong' || tag === 'b') out += inner.trim() ? `**${inner.trim()}** ` : '';
      else if (tag === 'em' || tag === 'i') out += inner.trim() ? `*${inner.trim()}* ` : '';
      else if (tag === 'del' || tag === 's') out += `~~${inner}~~`;
      else if (tag === 'code') out += `\`${inner}\``;
      else if (tag === 'br') out += '\n';
      else if (tag === 'a') {
        const href = $(child).attr('href');
        out += href && inner.trim() ? `[${inner.trim()}](${href})` : inner;
      } else if (tag === 'ul' || tag === 'ol') out += '';
      else out += inner;
    });
    return out;
  }

  const lines = [];
  function block(node, depth = 0) {
    $(node).contents().each((_, child) => {
      if (child.type === 'text') {
        const t = child.data.replace(/\s+/g, ' ').trim();
        if (t) lines.push(t);
        return;
      }
      if (child.type !== 'tag') return;
      const tag = child.name.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        lines.push('', `${'#'.repeat(Number(tag[1]))} ${inline(child).replace(/\s+/g, ' ').trim()}`, '');
      } else if (tag === 'ul' || tag === 'ol') {
        let n = 0;
        $(child).children('li').each((__, li) => {
          n++;
          const marker = tag === 'ol' ? `${n}.` : '*';
          // Texto do item sem as listas aninhadas.
          const clone = $(li).clone();
          clone.children('ul,ol').remove();
          lines.push(`${'  '.repeat(depth)}${marker} ${inline(clone).replace(/\s+/g, ' ').trim()}`);
          $(li).children('ul,ol').each((___, nested) => block($('<div/>').append($(nested).clone()), depth + 1));
        });
        if (depth === 0) lines.push('');
      } else if (tag === 'p' || tag === 'div' || tag === 'blockquote' || tag === 'section') {
        const hasBlocks = $(child).children('ul,ol,h1,h2,h3,h4,h5,h6,p,div,table').length > 0;
        if (hasBlocks) block(child, depth);
        else {
          const t = inline(child).replace(/[ \t]+/g, ' ').trim();
          if (t) lines.push(t, '');
        }
      } else if (tag === 'hr') {
        lines.push('', '---', '');
      } else if (tag === 'table') {
        $(child).find('tr').each((__, tr) => {
          const cells = $(tr).children('th,td').map((___, c) => inline(c).replace(/\s+/g, ' ').trim()).get();
          if (cells.length) lines.push(`* ${cells.join(' | ')}`);
        });
        lines.push('');
      } else {
        const t = inline(child).replace(/\s+/g, ' ').trim();
        if (t) lines.push(t);
      }
    });
  }

  // O rodapé do feed vem DEPOIS do <div class="md">: usamos só o corpo do post.
  const body = root.find('div.md').first();
  block(body.length ? body : root);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ───────────────────────── Feed Atom → posts ─────────────────────────

/** Converte o XML Atom do Reddit em objetos no formato do `.json` (data de cada post). */
export function parseAtomFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('entry').each((_, entry) => {
    const e = $(entry);
    const rawId = (e.children('id').first().text() || '').trim();
    const id = rawId.replace(/^t3_/, '');
    const title = (e.children('title').first().text() || '').trim();
    const href = e.children('link').first().attr('href') || '';
    const when = e.children('published').first().text() || e.children('updated').first().text();
    const ts = when ? Math.floor(new Date(when).getTime() / 1000) : null;
    let permalink = '';
    try { permalink = new URL(href).pathname; } catch { /* mantém vazio */ }
    if (!id || !title) return;
    items.push({
      id,
      title,
      author: (e.children('author').first().children('name').first().text() || '').replace(/^\/?u\//, '').trim(),
      created_utc: Number.isFinite(ts) ? ts : null,
      permalink,
      url: href,
      selftext: htmlToMarkdown(e.children('content').first().text()),
    });
  });
  return items;
}

// ───────────────────────── Navegador ─────────────────────────

/**
 * Abre o navegador, baixa o feed e FECHA o navegador (sempre, em `finally`).
 * @returns {Promise<Array>} posts no formato do `.json` do Reddit.
 */
export async function fetchWeeklyFeedViaBrowser() {
  const puppeteer = (await import('puppeteer')).default;
  const executablePath = findBrowserExecutable();
  logger.info(`[Weekly][Browser] Abrindo ${executablePath ? 'navegador do sistema' : 'Chrome do Puppeteer'}...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));

    const resp = await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const status = resp?.status();
    const xml = resp ? await resp.text() : '';

    if (status === 403 || !xml.includes('<feed')) {
      const err = new Error(status === 403
        ? 'Reddit bloqueou o navegador (403 / blocked by network security)'
        : `Feed do Reddit inválido (HTTP ${status})`);
      err.code = status === 403 ? 'REDDIT_FORBIDDEN' : 'REDDIT_INVALID_PAYLOAD';
      throw err;
    }

    const items = parseAtomFeed(xml);
    logger.info(`[Weekly][Browser] Feed carregado: ${items.length} post(s).`);
    return items;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best-effort */ }
    }
  }
}
