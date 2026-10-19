import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './api/panelLogs.js';
import { audit } from './audit.js';

/**
 * Avisos automáticos para o dono, por mensagem privada no Discord, quando algo
 * dá errado (IA fora do ar, erro grave, provedor sem crédito, tentativas de
 * login, Discord que caiu...).
 *
 * Proteções contra enxurrada: cada tipo de aviso tem um intervalo mínimo
 * (padrão 30 min) e há um teto global (10 por hora). O texto passa pelo filtro
 * que mascara chaves e senhas. Falha ao avisar nunca derruba a Yui.
 *
 * Liga/desliga: YUI_ALERTS=false. Intervalo: YUI_ALERTS_COOLDOWN_MINUTES.
 *
 * Observação: o intervalo é "consumido" ANTES do envio (veja `last.set` em alert()).
 * Se a DM falhar (DM bloqueada, Discord fora do ar), aquele aviso não é repetido até o
 * intervalo passar. Isso é proposital: evita martelar o Discord quando ele está instável.
 *
 * Erros graves do processo (uncaughtException / unhandledRejection): a chave do aviso vem
 * da CAUSA-RAIZ (crashAlertKey), igual para exceção e rejeição, para que uma mesma causa
 * gere uma única DM. O corpo traz a primeira linha da pilha que está em `src/` da Yui
 * (formatCrashDetail), porque o corte da pilha escondia de onde o erro partiu.
 */

const HOUR = 60 * 60 * 1000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Texto legível de qualquer coisa lançada/rejeitada (Error, string, objeto, undefined). */
export function describeReason(reason) {
  if (reason instanceof Error) return reason.stack || reason.message || String(reason);
  if (typeof reason === 'string') return reason;
  try {
    const json = JSON.stringify(reason);
    return json === undefined ? String(reason) : json;
  } catch {
    return String(reason);
  }
}

/**
 * Causa-raiz normalizada: primeira linha da mensagem, sem o prefixo "Error: " (que pode
 * vir repetido, como nas mensagens que juntam vários erros) e com espaços compactados.
 */
export function crashCause(reason) {
  const raw = reason instanceof Error ? reason.message || reason.name : typeof reason === 'string' ? reason : describeReason(reason);
  const firstLine = String(raw ?? '').split(/\r?\n/).find((l) => l.trim()) || '';
  const cause = firstLine.trim().replace(/^(?:Error:\s*)+/, '').replace(/\s+/g, ' ').slice(0, 80).trim();
  return cause || 'sem mensagem';
}

/** Chave do cooldown de erro grave: a mesma causa dá a mesma chave, seja exceção ou rejeição. */
export function crashAlertKey(reason) {
  return `crash:${crashCause(reason)}`;
}

/** Normaliza um caminho para comparar (barras normais, sem file:///). */
function normalizePath(p) {
  let out = String(p).replace(/^file:\/\/\/?/i, '');
  try { out = decodeURIComponent(out); } catch { /* mantém */ }
  return out.replace(/\\/g, '/');
}

/**
 * Primeiro frame da pilha que esteja no código da Yui (`<raiz>/src/...`, fora de node_modules).
 * @returns {string|null} ex.: "src/handlers/voiceHandler.js:229:25"
 */
export function firstProjectFrame(stack, { root = PROJECT_ROOT } = {}) {
  const rootNorm = normalizePath(root).replace(/\/+$/, '').toLowerCase();
  for (const line of String(stack ?? '').split(/\r?\n/)) {
    const m = /^\s*at\s+(?:.*?\s\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const file = normalizePath(m[1]);
    const lower = file.toLowerCase();
    if (lower.includes('/node_modules/') || !lower.startsWith(`${rootNorm}/src/`)) continue;
    return `${file.slice(rootNorm.length + 1)}:${m[2]}:${m[3]}`;
  }
  return null;
}

/**
 * Corpo da DM de erro grave: origem em `src/` (se houver) + as primeiras linhas da pilha.
 * @param {*} reason o que foi lançado/rejeitado
 * @param {{ maxLines?: number, root?: string }} [o]
 */
export function formatCrashDetail(reason, { maxLines = 4, root = PROJECT_ROOT } = {}) {
  const text = describeReason(reason);
  const head = text.split('\n').slice(0, maxLines).join('\n');
  const origin = firstProjectFrame(reason instanceof Error ? reason.stack : text, { root });
  return origin ? `Origem na Yui: ${origin}\n${head}` : head;
}
const ICON = { info: 'ℹ️', warn: '⚠️', error: '🚨' };

export function createAlerter({ notify = null, ownerId = null, env = process.env, now = () => Date.now(), maxPerHour = 10 } = {}) {
  const last = new Map(); // chave -> quando foi avisado
  let sent = []; // horários dos avisos da última hora
  const defaultCooldown = Math.max(1, Number(env.YUI_ALERTS_COOLDOWN_MINUTES) || 30) * 60 * 1000;

  const enabled = () => String(env.YUI_ALERTS ?? 'true').toLowerCase() !== 'false' && Boolean(notify && ownerId);

  /**
   * @returns {Promise<boolean>} true se a mensagem foi enviada.
   */
  async function alert(key, title, detail = '', { level = 'warn', cooldownMinutes = null } = {}) {
    if (!enabled()) return false;
    const t = now();
    const wait = cooldownMinutes ? cooldownMinutes * 60 * 1000 : defaultCooldown;
    if (t - (last.get(key) ?? -Infinity) < wait) return false;
    sent = sent.filter((x) => t - x < HOUR);
    if (sent.length >= maxPerHour) return false;
    // Cooldown consumido antes do envio: uma DM que falha também "queima" o intervalo (proposital, veja o topo).
    last.set(key, t);
    sent.push(t);

    const body = redact(String(detail ?? ''), env).replace(/\s+\n/g, '\n').trim().slice(0, 500);
    const text = [`${ICON[level] ?? ICON.warn} **Yui: ${title}**`, body ? `\n${body}` : '', '\n-# Aviso automático. Para desligar: YUI_ALERTS=false no .env.']
      .filter(Boolean)
      .join('\n');
    try {
      await notify(ownerId, text);
      audit('alert.sent', null, { key });
      return true;
    } catch (err) {
      audit('alert.fail', null, { key, error: String(err?.message ?? err).slice(0, 100) });
      return false;
    }
  }

  return { alert, enabled };
}

// ── Instância do processo (configurada na inicialização) ──
let current = createAlerter();

export function configureAlerts(options) {
  current = createAlerter(options);
  return current;
}

/** Avisa o dono (sem esperar e sem nunca lançar erro). */
export function alertOwner(key, title, detail = '', options = {}) {
  current.alert(key, title, detail, options).catch(() => {});
}

export function alertsEnabled() {
  return current.enabled();
}
