/**
 * Parser GTACars → schema normalizado de veículos da Yui.
 *
 * A API do GTACars devolve o objeto `vehicle` com campos crus (prefixo
 * `_`) e os labels de exibição NÃO vêm da API — vêm dos mapas de
 * metadados em `./labels.js` (extraídos do frontend do próprio site).
 *
 * Nenhum valor é inventado aqui: nome é composto de `_manuf` + `_fullNm`
 * (nome oficial do veículo no jogo), os labels vêm dos mapas oficiais,
 * e campos desconhecidos caem para null (nunca para valores arbitrários).
 */

import {
  GTACARS_BASE,
} from './client.js';
import {
  MANUFACTURERS,
  DLC,
  DRIVETRAINS,
  VEHICLE_TYPES,
  CLASSES,
  SEATS,
  resolveLabel,
} from './labels.js';

export const SOURCE_ID = 'gtacars';

/** Remove acentos e normaliza para caixa baixa, preservando letras/dígitos/espaços. */
export function normalizeName(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Gera um slug URL-safe determinístico a partir de um nome. */
export function slugify(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Converte o `_key` de imagem em URL completa do GTACars. */
export function imageUrlFromKey(key) {
  if (!key) return null;
  const clean = String(key).replace(/^\//, '');
  return `${GTACARS_BASE}/${clean}`;
}

/** Monta a lista de URLs de imagens (sem duplicatas, preservando ordem). */
function collectImages(raw) {
  const urls = [];
  const push = (key) => {
    const url = imageUrlFromKey(key);
    if (url && !urls.includes(url)) urls.push(url);
  };

  const imgs = raw.images || {};
  if (Array.isArray(imgs.sc)) {
    for (const sc of imgs.sc) push(sc?.image?._key);
  }
  if (Array.isArray(imgs.model)) {
    for (const m of imgs.model) push(m?._key);
  }

  const ownership = raw.ownership || {};
  if (Array.isArray(ownership.prices)) {
    for (const price of ownership.prices) {
      if (Array.isArray(price?.images)) {
        for (const img of price.images) push(img?._key);
      }
    }
  }

  return urls;
}

/** Resolve a imagem principal (preferência: screenshot mp-main; senão a primeira). */
function primaryImage(urls) {
  if (!urls || urls.length === 0) return null;
  return urls[0];
}

/** Converte o preço bruto `_priceMp` (em milhares de GTA$) para valor em GTA$. */
function parsePrice(rawPriceMp) {
  if (rawPriceMp === null || rawPriceMp === undefined) return null;
  const n = Number(rawPriceMp);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

/** Converte `_dateAdded` (epoch ms) para "YYYY-MM-DD". */
function parseReleaseDate(rawDateAdded) {
  if (!rawDateAdded) return null;
  const n = Number(rawDateAdded);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Compõe o nome oficial do veículo: fabricante + nome exibido (sem duplicar). */
export function composeOfficialName(manufacturerDisplay, rawFullNm) {
  const name = (rawFullNm || '').trim();
  if (!name) return '';
  if (!manufacturerDisplay || manufacturerDisplay === 'Unknown') return name;
  // Evita prefixo duplicado caso o nome exibido já venha com o fabricante.
  if (name.toLowerCase().startsWith(manufacturerDisplay.toLowerCase())) return name;
  return `${manufacturerDisplay} ${name}`;
}

/**
 * Normaliza UM veículo bruto do GTACars para o schema da Yui.
 * Retorna null se o objeto for inutilizável (sem id/name).
 */
export function parseVehicle(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = raw._id || raw.id || raw._modelId || null;
  const rawName = raw._fullNm || raw.gtaWiki || raw._name || raw._nm || raw._id || raw.id || null;
  if (!id || !rawName) return null;

  const manufacturerDisplay = resolveLabel(MANUFACTURERS, raw._manuf ?? null);
  const name = composeOfficialName(manufacturerDisplay, rawName);
  const shortName = rawName.trim();

  const images = collectImages(raw);

  return {
    id: String(id),
    name,
    shortName,
    normalizedName: normalizeName(name),
    slug: slugify(name),
    manufacturer: manufacturerDisplay,
    manufacturerId: raw._manuf ?? null,
    class: resolveLabel(CLASSES, raw._class ?? null),
    classId: raw._class ?? null,
    type: resolveLabel(VEHICLE_TYPES, raw._type ?? null),
    typeId: raw._type ?? null,
    seats: SEATS[raw._seats] ?? null,
    price: parsePrice(raw._priceMp),
    topSpeed: Number.isFinite(Number(raw._topSpeed)) ? Number(raw._topSpeed) : null,
    lapTime: Number.isFinite(Number(raw._lapTime)) ? Number(raw._lapTime) : null,
    drivetrain: resolveLabel(DRIVETRAINS, raw._dt ?? null),
    drivetrainId: raw._dt ?? null,
    releaseDate: parseReleaseDate(raw._dateAdded) || raw.dateAdded || null,
    year: raw._yearAdded ?? null,
    dlc: resolveLabel(DLC, raw._dlc ?? null),
    dlcId: raw._dlc ?? null,
    image: primaryImage(images),
    images,
    url: `${GTACARS_BASE}/gta5/${String(id)}`,
    source: SOURCE_ID,
    // Campos técnicos conservados para comparação futura com DurtyFree
    // (hashes/model id/handling são os identificadores estáveis no jogo).
    modelId: raw._modelId ?? null,
    handlingId: raw._handlingId ?? null,
    textureId: raw._textureId ?? null,
    hashS: raw._hashS ?? null,
    hashU: raw._hashU ?? null,
    hashH: raw._hashH ?? null,
  };
}

/** Normaliza uma lista de veículos crus, ignorando inválidos/nulos. */
export function parseVehicles(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const raw of rawList) {
    const parsed = parseVehicle(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}