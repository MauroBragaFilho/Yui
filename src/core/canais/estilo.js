// AJUSTE DO TEXTO AO CANAL (docs/CANAIS_NOVOS.md §2): leva um texto qualquer ao tamanho e ao estilo do canal, na tabela de src/core/canais/contrato.js.
// PURO (sem rede, sem disco, sem estado). PREPARADO, SEM EFEITO: nada o chama ainda.
//
// YouTube Live: uma mensagem de até 200 caracteres, uma ideia só, sem lista, sem link, sem Markdown, sem menção (@), sem hashtag e no máximo um emoji.
// Discord, app e PC: o texto fica como está (quem divide em várias mensagens é o adaptador do Discord, como hoje); acima do teto de resposta do canal, corta com reticências.
import { REGRAS_DO_CANAL, PADRAO_DE_LINK, temLink } from './contrato.js';

const RETICENCIAS = '…';

/** Corta em `max` unidades UTF-16 sem partir um par substituto (emoji). */
function fatiar(texto, max) {
  if (texto.length <= max) return texto;
  let fim = max;
  const c = texto.charCodeAt(fim - 1);
  if (c >= 0xd800 && c <= 0xdbff) fim -= 1; // metade de um par substituto no fim
  return texto.slice(0, fim);
}

/**
 * Corta `texto` em no máximo `max` caracteres (UTF-16), de preferência no fim de uma frase, senão no último espaço, e marca com reticências.
 * O resultado NUNCA passa de `max`.
 * @returns {{ texto: string, cortado: boolean }}
 */
export function cortarNoLimite(texto, max) {
  const t = String(texto ?? '');
  if (t.length <= max) return { texto: t, cortado: false };
  const janela = fatiar(t, max);
  // fim de frase dentro da janela (só vale se sobrar pelo menos uns 40% do limite: não deixa um toco de frase)
  const frase = Math.max(janela.lastIndexOf('. '), janela.lastIndexOf('! '), janela.lastIndexOf('? '));
  if (frase >= Math.floor(max * 0.4)) return { texto: janela.slice(0, frase + 1), cortado: true };
  if (janela.length >= 1 && /[.!?]$/.test(janela) && t[janela.length] === ' ') return { texto: janela, cortado: true };
  // senão, no último espaço, abrindo espaço para as reticências
  const comReserva = fatiar(t, max - RETICENCIAS.length);
  const espaco = comReserva.lastIndexOf(' ');
  const base = espaco >= Math.floor(max * 0.4) ? comReserva.slice(0, espaco) : comReserva;
  return { texto: `${base.replace(/[\s,;:.\-–—]+$/u, '')}${RETICENCIAS}`, cortado: true };
}

/** Tira as marcas de Markdown e deixa só o texto. */
export function removerMarkdown(texto) {
  return String(texto ?? '')
    .replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, '$1') // bloco de código: fica o conteúdo
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1') // [texto](endereço): fica só o texto (o endereço some)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // negrito
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2') // itálico com asterisco
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2') // itálico com sublinhado (snake_case fica intacto)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, '$1')
    .replace(/(^|\n)[ \t]*>[ \t]?/g, '$1');
}

/** Tira o marcador de lista do começo de cada linha. */
export function removerMarcadoresDeLista(texto) {
  return String(texto ?? '').replace(/(^|\n)[ \t]*(?:[-*•]|\d{1,3}[.)])[ \t]+/g, '$1');
}

/** Apaga os links (e as palavras "link"/"site" ficam: o texto continua entendível). */
export function removerLinks(texto) {
  return String(texto ?? '').replace(new RegExp(PADRAO_DE_LINK, 'giu'), '');
}

/** Deixa no máximo `max` emojis (o resto some). */
export function limitarEmojis(texto, max = 1) {
  let vistos = 0;
  return String(texto ?? '').replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, (m) => (++vistos <= max ? m : ''));
}

/** A primeira ideia: o primeiro parágrafo/linha com conteúdo. */
export function primeiraIdeia(texto) {
  for (const linha of String(texto ?? '').split(/\r?\n/)) {
    const t = linha.trim();
    if (t) return t;
  }
  return '';
}

/** Texto para o chat ao vivo do YouTube (veja o topo do arquivo). */
function paraYoutube(texto, max) {
  let t = removerMarkdown(String(texto ?? '').replace(/\r\n?/g, '\n'));
  t = removerMarcadoresDeLista(t);
  t = primeiraIdeia(t); // uma ideia por mensagem: só o primeiro parágrafo
  t = removerLinks(t);
  t = t.replace(/[@#](?=[\p{L}\p{N}_])/gu, ''); // sem menção nem hashtag: fica a palavra
  t = limitarEmojis(t, 1);
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  return cortarNoLimite(t, max);
}

/**
 * Leva o texto ao tamanho e ao estilo do canal. Nunca lança; nunca devolve texto maior que o limite do canal.
 * @param {string} canal um dos CANAIS (canal desconhecido: devolve o texto vazio, nada é enviado a um canal que não existe)
 * @param {string} texto
 * @returns {{ texto: string, cortado: boolean, alterado: boolean }} `alterado`: o texto saiu diferente do que entrou
 */
export function ajustarTextoAoCanal(canal, texto) {
  const regras = REGRAS_DO_CANAL[canal];
  const original = String(texto ?? '');
  if (!regras) return { texto: '', cortado: false, alterado: original !== '' };
  let r;
  if (regras.estilo.umaIdeiaPorMensagem) r = paraYoutube(original, regras.maxResposta);
  else r = cortarNoLimite(original, regras.maxResposta);
  // última barreira: o que o contrato recusaria não sai daqui
  if (!regras.estilo.links && temLink(r.texto)) r = { texto: removerLinks(r.texto).replace(/\s{2,}/g, ' ').trim(), cortado: r.cortado };
  return { texto: r.texto, cortado: r.cortado, alterado: r.texto !== original };
}
