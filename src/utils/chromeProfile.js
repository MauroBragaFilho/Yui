import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Perfil temporário do Chrome sob controle da Yui.
 *
 * O Puppeteer cria sozinho `puppeteer_dev_chrome_profile-XXXX` na pasta temporária e tenta apagá-la ao fechar.
 * No Windows, se o Chrome ainda segura o `lockfile`, a remoção falha com EBUSY como "promessa rejeitada" dentro
 * do Puppeteer (não dá para capturar) e a pasta fica para sempre. Aqui a Yui cria a pasta, passa como
 * `userDataDir` e a remove com tentativas; o que sobrar é varrido depois (sweepStaleChromeProfiles).
 */

export const PROFILE_PREFIX = 'yui-chrome-';
const STALE_PATTERNS = [/^yui-chrome-/i, /^puppeteer_dev_chrome_profile-/i];
const CLEANUP_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

export function createChromeProfile({ tmp = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, PROFILE_PREFIX));
  return { dir };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apaga o perfil tentando algumas vezes (o Chrome demora a soltar os arquivos). Nunca lança; devolve true se sumiu. */
export async function removeChromeProfile(dir, { tries = 5, delayMs = 1000 } = {}) {
  if (!dir) return true;
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ainda em uso */ }
    if (!fs.existsSync(dir)) return true;
    if (i < tries - 1) await sleep(delayMs);
  }
  return !fs.existsSync(dir);
}

/** Remove perfis velhos (da Yui ou do Puppeteer) com mais de `olderThanMs`. Devolve quantas pastas apagou. */
export function sweepStaleChromeProfiles({ tmp = os.tmpdir(), olderThanMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return 0; }
  for (const name of names) {
    if (!STALE_PATTERNS.some((re) => re.test(name))) continue;
    const full = path.join(tmp, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory() || now - st.mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      if (!fs.existsSync(full)) removed++;
    } catch { /* em uso: fica para a próxima varredura */ }
  }
  return removed;
}

/** A rejeição é só a limpeza do perfil do Chrome que falhou (arquivo em uso)? Não é um erro da Yui. */
export function isChromeProfileCleanupError(reason) {
  if (!(reason instanceof Error)) return false;
  const msg = String(reason.message ?? '');
  const code = reason.code || /^(E[A-Z]+):/.exec(msg)?.[1];
  if (!CLEANUP_CODES.has(code)) return false;
  return /(puppeteer_dev_chrome_profile-|yui-chrome-)/i.test(msg);
}
