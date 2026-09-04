import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const labelsPtPath = path.resolve(__dirname, '../data/labelsPT.json');

let labelsPT = {};
try {
  labelsPT = JSON.parse(fs.readFileSync(labelsPtPath, 'utf-8'));
} catch (error) {
  logger.warn(`[Labels] Falha ao carregar labelsPT.json: ${error.message}`);
}

/**
 * Traduz uma chave interna do jogo (ex: "WEAPON_ASSAULTRIFLE") para o nome
 * em português já mapeado em labelsPT.json. Se a chave não existir no
 * dicionário, cai de volta para uma versão "humanizada" da própria chave
 * em vez de mostrar o identificador cru pro usuário.
 */
export function getWeaponLabelPT(key) {
  if (!key) return 'Desconhecido';
  if (labelsPT[key]) return labelsPT[key];

  // Se o valor já veio traduzido/legível (não é uma chave interna crua do
  // tipo "WEAPON_ASSAULTRIFLE_MK2" nem um identificador em maiúsculas),
  // retorna como está. Evita "retraduzir" um label que o getTunable já
  // resolveu para PT-BR (ex: "Arma de Choque" viraria "Arma De Choque").
  if (typeof key === 'string' && !key.includes('_') && !/^[A-Z0-9 ]+$/.test(key)) {
    return key;
  }

  // Fallback: WEAPON_ASSAULTRIFLE_MK2 -> "Assaultrifle Mk2"
  const humanized = key
    .replace(/^WEAPON_/, '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  logger.warn(`[Labels] Chave sem tradução PT-BR encontrada: ${key} (usando fallback "${humanized}")`);
  return humanized;
}
