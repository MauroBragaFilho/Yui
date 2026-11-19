// A ASSINATURA de uma busca e a limpeza dos textos que vêm da web (monitores, etapa 16).
//
// O monitor NUNCA guarda o texto dos resultados (os termos de alguns buscadores proíbem guardar os resultados, e o texto da web é dado
// não confiável): do que a busca devolveu só ficam HASHES. Novidade = um endereço que o monitor ainda não tinha visto: ele guarda o CONJUNTO dos hashes curtos dos
// endereços normalizados já vistos (`hashDoEndereco`, `resultadosComHash`), não uma assinatura em ordem (a ordem dos resultados oscila, e isso nunca é novidade).
// `assinaturaDosResultados` (hash dos 3 primeiros em ordem) fica só como informação da última busca. O aviso mostra só o título do 1º resultado NOVO e o domínio,
// passados por `tituloSeguro` (sem menção, sem link, sem formatação, sem quebra de linha, curto), e nunca contém instrução para ninguém: é só um texto para a pessoa ler.
import crypto from 'node:crypto';

const ASSINATURA_RE = /^[0-9a-f]{24}$/;
const PARAMETROS_DE_RASTREIO = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|source|src|cmpid|spm)$/i;
// controles, largura zero, formatação bidirecional e o separador de linha: nada disto entra num título
const INVISIVEIS = /[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Título normalizado para comparar: sem acento, minúsculo, só letras e números, espaços colapsados. */
export function normalizarTitulo(titulo) {
  return String(titulo ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Endereço normalizado para comparar: sem esquema, sem "www.", sem âncora, sem barra final e sem parâmetros de rastreio. */
export function normalizarUrl(url) {
  const bruto = String(url ?? '').trim();
  if (!bruto) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(bruto) ? bruto : `https://${bruto}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const caminho = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams.entries()].filter(([k]) => !PARAMETROS_DE_RASTREIO.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const consulta = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    return `${host}${caminho}${consulta}`.slice(0, 400);
  } catch {
    return bruto.toLowerCase().replace(/^https?:\/\/(?:www\.)?/, '').replace(/#.*$/, '').replace(/\/+$/, '').slice(0, 400);
  }
}

/**
 * A assinatura dos 3 primeiros resultados (título + endereço normalizados): 24 caracteres hexadecimais, ou null se não há resultado utilizável.
 * Só o hash sai daqui: o texto dos resultados nunca é guardado.
 */
export function assinaturaDosResultados(resultados) {
  const validos = (Array.isArray(resultados) ? resultados : [])
    .filter((r) => r && typeof r === 'object' && String(r.title ?? '').trim() && String(r.url ?? '').trim())
    .slice(0, 3);
  if (!validos.length) return null;
  const corpo = validos.map((r) => `${normalizarTitulo(r.title)}|${normalizarUrl(r.url)}`).join('\n');
  return crypto.createHash('sha256').update(`yui-monitor:${corpo}`).digest('hex').slice(0, 24);
}

export const assinaturaValida = (s) => typeof s === 'string' && ASSINATURA_RE.test(s);

const VISTA_RE = /^[0-9a-f]{12}$/;
export const vistaValida = (s) => typeof s === 'string' && VISTA_RE.test(s);

/** O hash curto (12 hexadecimais) do endereço normalizado de um resultado: é só isto que o monitor guarda de cada resultado já visto (nunca o endereço, nem o título). */
export function hashDoEndereco(url) {
  const u = normalizarUrl(url);
  return u ? crypto.createHash('sha256').update(`yui-monitor-url:${u}`).digest('hex').slice(0, 12) : '';
}

/**
 * Os resultados utilizáveis (título e endereço), SEM repetir o mesmo endereço, com o hash de cada um. Os monitores comparam CONJUNTOS: a ordem dos resultados oscila de
 * uma busca para outra (o buscador reordena, um deles sai do topo e volta), e isso nunca é novidade. Novidade é um endereço que o monitor ainda não tinha visto.
 * @returns {{ resultado: object, hash: string }[]}
 */
export function resultadosComHash(resultados, max = 5) {
  const vistos = new Set();
  const saida = [];
  for (const r of Array.isArray(resultados) ? resultados : []) {
    if (!r || typeof r !== 'object' || !String(r.title ?? '').trim() || !String(r.url ?? '').trim()) continue;
    const hash = hashDoEndereco(r.url);
    if (!hash || vistos.has(hash)) continue;
    vistos.add(hash);
    saida.push({ resultado: r, hash });
    if (saida.length >= max) break;
  }
  return saida;
}

/** A assinatura de UM aviso de novidade: o hash dos endereços novos (a chave de idempotência do aviso). */
export function assinaturaDoConjunto(hashes) {
  return crypto.createHash('sha256').update(`yui-monitor-novo:${[...hashes].sort().join('\n')}`).digest('hex').slice(0, 24);
}

/** O domínio de onde veio o resultado (sem "www."), curto; "fonte desconhecida" se o endereço não presta. */
export function fonteDoResultado(resultado) {
  try {
    const host = new URL(String(resultado?.url ?? '')).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]{1,80}$/.test(host) && host.includes('.') ? host : 'fonte desconhecida';
  } catch {
    return 'fonte desconhecida';
  }
}

/** Corta por pontos de código (nunca no meio de um emoji), com reticências. */
function cortar(texto, max) {
  const chars = Array.from(texto);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : texto;
}

/**
 * Um texto que veio da web (ou a consulta da própria pessoa) pronto para ir numa mensagem: uma linha só, sem controles, sem menção
 * (<@id>, @todos), sem link, sem formatação do Discord, curto. É DADO, nunca instrução.
 */
export function tituloSeguro(texto, max = 120) {
  const limpo = String(texto ?? '')
    .normalize('NFC')
    .replace(INVISIVEIS, ' ')
    .replace(/<(?:@[!&]?|#|a?:\w+:)[^>\s]*>/g, ' ')
    .replace(/@(?=everyone|here)/gi, '')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/[*_~`|>\\[\]()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cortar(limpo, max) || 'sem título';
}

/** A consulta para aparecer em mensagens: a mesma limpeza do título. */
export const consultaSegura = (consulta, max = 120) => tituloSeguro(consulta, max);
