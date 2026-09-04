/**
 * Gerenciador de cookies do Reddit via Puppeteer.
 *
 * O Reddit bloqueia o endpoint `.json` público para IPs de servidor (403).
 * A solução é usar um browser headless para visitar o Reddit, pegar os cookies
 * de sessão, e depois usá-los em requests `fetch()` convencionais.
 *
 * Ciclo de vida:
 *   1. Na primeira chamada, lança Puppeteer → visita reddit.com → extrai cookies.
 *   2. Cookies são cacheados em memória e persistidos em disco.
 *   3. Requests seguintes reutilizam os cookies.
 *   4. Quando um fetch retorna 403, o chamador chama `refreshCookies()` e retry.
 *   5. Cookies expiram naturalmente; TTL configurável (padrão 24h).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_CACHE_FILE = path.join(__dirname, 'reddit-cookies-cache.json');

const REDDIT_URL = 'https://www.reddit.com/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const DEFAULT_COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let browser = null;
let cachedCookies = null; // { cookies: string, fetchedAt: number }

// ─── Persistência em disco ───

function loadCookiesFromDisk() {
  try {
    if (!fs.existsSync(COOKIES_CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(COOKIES_CACHE_FILE, 'utf8'));
    if (raw?.cookies && typeof raw.fetchedAt === 'number') return raw;
    return null;
  } catch {
    return null;
  }
}

function saveCookiesToDisk(data) {
  try {
    fs.writeFileSync(COOKIES_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[Weekly][Cookies] Não foi possível salvar cache em disco: ${err.message}`);
  }
}

// ─── Puppeteer browser singleton ───

async function getBrowser() {
  if (browser) return browser;
  logger.info('[Weekly][Cookies] Iniciando Puppeteer...');
  const puppeteer = await import('puppeteer');
  browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  logger.info('[Weekly][Cookies] Puppeteer iniciado.');
  return browser;
}

/** Fecha o browser no shutdown do bot para liberar memória. */
export async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch { /* best-effort */ }
    browser = null;
    logger.info('[Weekly][Cookies] Puppeteer browser fechado.');
  }
}

/** Lança Puppeteer, visita Reddit e extrai cookies da sessão. */
async function fetchCookiesViaPuppeteer() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent(USER_AGENT);
  try {
    logger.info('[Weekly][Cookies] Navegando para reddit.com...');
    await page.goto(REDDIT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500)); // aguarda setar cookies

    const cookies = await page.cookies();
    if (!cookies?.length) throw new Error('Nenhum cookie extraído do Reddit');

    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    logger.info(`[Weekly][Cookies] ${cookies.length} cookie(s): ${cookies.map((c) => c.name).join(', ')}`);
    return cookieStr;
  } finally {
    await page.close();
  }
}

// ─── API pública ───

/**
 * Retorna string de cookies válida para requests ao Reddit.
 * Se cookies expiraram ou não existem, renova via Puppeteer.
 *
 * @param {boolean} [forceRefresh=false] — Força renovação ignorando cache.
 * @returns {Promise<string>} Cookie header value.
 */
export async function getCookies(forceRefresh = false) {
  // 1. Cache em memória ainda válido
  if (!forceRefresh && cachedCookies) {
    const age = Date.now() - cachedCookies.fetchedAt;
    if (age < DEFAULT_COOKIE_TTL_MS) return cachedCookies.cookies;
    logger.info('[Weekly][Cookies] Cookies em memória expirados; renovando...');
  }

  // 2. Tenta disco
  if (!forceRefresh && !cachedCookies) {
    const disk = loadCookiesFromDisk();
    if (disk && (Date.now() - disk.fetchedAt) < DEFAULT_COOKIE_TTL_MS) {
      cachedCookies = disk;
      const min = Math.round((Date.now() - disk.fetchedAt) / 60000);
      logger.info(`[Weekly][Cookies] Carregados do disco (${min} min).`);
      return cachedCookies.cookies;
    }
    logger.info('[Weekly][Cookies] Disco vazio/expirado; buscando via Puppeteer...');
  }

  // 3. Busca novos via Puppeteer
  try {
    const cookieStr = await fetchCookiesViaPuppeteer();
    const data = { cookies: cookieStr, fetchedAt: Date.now() };
    cachedCookies = data;
    saveCookiesToDisk(data);
    return cookieStr;
  } catch (err) {
    logger.error(`[Weekly][Cookies] Falha Puppeteer: ${err.message}`);
    if (cachedCookies?.cookies) {
      logger.warn('[Weekly][Cookies] Usando cookies antigos como fallback.');
      return cachedCookies.cookies;
    }
    throw err;
  }
}

/** Força renovação (chamar quando fetch retornar 403). */
export async function refreshCookies() {
  return getCookies(true);
}

export default { getCookies, refreshCookies, closeBrowser };

