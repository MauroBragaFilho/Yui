/**
 * Limite de upload de arquivo (anexo) do Discord para o bot.
 *
 * O servidor do dono aceita 10 MB por anexo (tier 0/1). O código antigo assumia 25 MB e entregava
 * arquivos que o Discord recusa (erro 40005 só depois de baixar tudo). Aqui fica a conta única:
 *
 *  - base: 10 MiB (YUI_UPLOAD_LIMIT_MB troca a base, entre 1 e 100). Vale para tier 0/1, para
 *    DM e para chamadas sem guild (os produtores de MP3 não recebem a guild: usam a base);
 *  - tier 2 usa pelo menos 50 MiB e tier 3 pelo menos 100 MiB (nunca abaixo da base);
 *  - fator de segurança 0,95 sobre o total: 10 MiB * 0,95 = 9.961.472 bytes, abaixo também de
 *    10.000.000, então cobre as duas leituras possíveis de "10 MB" (MiB ou MB decimal) e a
 *    sobrecarga do corpo multipart.
 *
 * Módulo puro: sem efeito ao importar, sem rede, sem timers. O ambiente é injetável (`env`).
 */

const MIB = 1024 * 1024;

/** Fração do limite nominal realmente usada como teto do arquivo. */
export const UPLOAD_SAFETY_FACTOR = 0.95;

/** Base padrão (MiB) quando YUI_UPLOAD_LIMIT_MB não existe ou é inválida. */
export const DEFAULT_UPLOAD_LIMIT_MB = 10;

const MIN_BASE_MB = 1;
const MAX_BASE_MB = 100;
const TIER_FLOOR_MB = Object.freeze({ 2: 50, 3: 100 });

function baseMB(env) {
  const n = Number.parseFloat(String(env?.YUI_UPLOAD_LIMIT_MB ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPLOAD_LIMIT_MB;
  return Math.min(Math.max(n, MIN_BASE_MB), MAX_BASE_MB);
}

/** Limite NOMINAL do servidor em MiB (o número que o Discord anuncia): 10, 50 ou 100 por padrão. */
export function getNominalLimitMB(guild, env = process.env) {
  const base = baseMB(env);
  const tier = Number(guild?.premiumTier) || 0;
  const floor = TIER_FLOOR_MB[tier] ?? 0;
  return Math.max(base, floor);
}

/**
 * Teto de bytes para um arquivo que será anexado, já com o fator de segurança.
 * `guild` pode ser null/undefined (DM, produtores sem guild): vale a base.
 */
export function getUploadLimitBytes(guild, env = process.env) {
  return Math.floor(getNominalLimitMB(guild, env) * MIB * UPLOAD_SAFETY_FACTOR);
}

/** Limite nominal (em MiB, inteiro) a partir do teto efetivo em bytes: 9961472 -> 10. */
export function limitLabelMB(limitBytes) {
  return Math.round(Number(limitBytes) / UPLOAD_SAFETY_FACTOR / MIB);
}

/** Texto do limite para o usuário, a partir do teto efetivo: 9961472 -> "10 MB". */
export function formatUploadLimit(limitBytes) {
  return `${limitLabelMB(limitBytes)} MB`;
}

/**
 * Tamanho em texto para mensagens: 10485760 -> "10 MB"; 12900000 -> "12,3 MB"; 300 -> "menos de 0,1 MB".
 * Usa MiB (1024 * 1024) e vírgula decimal; uma casa só quando precisa; sem casas a partir de 100 MB.
 * Entrada inválida ou zero vira "0 MB".
 */
export function formatMB(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n < MIB / 10) return 'menos de 0,1 MB';
  const mb = n / MIB;
  const text = mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1).replace('.', ',').replace(/,0$/, '');
  return `${text} MB`;
}

/** Quantos minutos de áudio cabem no limite a um bitrate (kbps) constante. */
export function maxAudioMinutes(limitBytes, kbps) {
  const bytes = Number(limitBytes);
  const rate = Number(kbps);
  if (!(bytes > 0) || !(rate > 0)) return 0;
  return (bytes * 8) / (rate * 1000) / 60;
}
