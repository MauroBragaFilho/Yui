/**
 * Contador de respostas da IA por hora. Fica em memória e, depois de initInteractionStats(arquivo), também em disco
 * (database/interaction-stats.json, pasta que a atualização não toca): reiniciar ou atualizar a Yui não zera a contagem.
 * `since` diz desde quando vale.
 * Não guarda texto, usuário nem canal: só "quantas respostas em cada hora". Alimenta o gráfico de 24 h da Visão Geral.
 */
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 60 * 60 * 1000;
const HOURS = 24;

const buckets = new Map(); // início da hora (ms) -> contagem
let since = Date.now();
let file = null; // sem arquivo: só memória (testes e quem não chamou initInteractionStats)
let saveTimer = null;
const SAVE_EVERY_MS = 30_000;

function hourStart(ms) {
  return Math.floor(ms / HOUR) * HOUR;
}

function prune(now) {
  const limit = hourStart(now) - (HOURS - 1) * HOUR;
  for (const k of buckets.keys()) if (k < limit) buckets.delete(k);
}

/** Registra uma resposta da IA entregue (Discord, /yui ou app). Nunca lança. */
export function recordInteraction(now = Date.now()) {
  try {
    const k = hourStart(now);
    buckets.set(k, (buckets.get(k) || 0) + 1);
    prune(now);
    scheduleSave();
  } catch { /* contador nunca atrapalha a resposta */ }
}

/** As últimas 24 horas, da mais antiga para a atual: [{ hour: ISO, count }], mais o total e o início da contagem. */
export function interactionSeries(now = Date.now()) {
  prune(now);
  const end = hourStart(now);
  const series = [];
  let total = 0;
  for (let i = HOURS - 1; i >= 0; i--) {
    const k = end - i * HOUR;
    const count = buckets.get(k) || 0;
    total += count;
    series.push({ hour: new Date(k).toISOString(), count });
  }
  return { series, total, since: new Date(since).toISOString() };
}

/** Zera tudo (testes). */
export function resetInteractionStats(now = Date.now()) {
  buckets.clear();
  file = null;
  clearTimeout(saveTimer); saveTimer = null;
  since = now;
}

/** Grava agora (escrita atômica: arquivo temporário e renomeia). Nunca lança. */
export function saveInteractionStats() {
  if (!file) return false;
  try {
    clearTimeout(saveTimer); saveTimer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ since, buckets: [...buckets.entries()] }));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function scheduleSave() {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(saveInteractionStats, SAVE_EVERY_MS);
  saveTimer.unref?.();
}

/**
 * Liga a gravação em disco e carrega o que já havia (horas dentro da janela de 24 h). Arquivo ausente ou ilegível = começa do zero.
 * Grava também ao encerrar o processo, para não perder os últimos 30 s.
 */
export function initInteractionStats(filePath, now = Date.now()) {
  file = filePath ? path.resolve(filePath) : null;
  if (!file) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(raw?.since)) since = raw.since;
    for (const [k, v] of Array.isArray(raw?.buckets) ? raw.buckets : []) {
      if (Number.isFinite(k) && Number.isFinite(v) && v > 0) buckets.set(k, v);
    }
    prune(now);
  } catch { /* primeira vez ou arquivo ruim: segue do zero */ }
  process.once('exit', saveInteractionStats);
  return true;
}
