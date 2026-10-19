/**
 * Leitor de linhas para respostas em streaming (SSE) tolerante a pedaços de rede.
 *
 * Problema (TG-11): o laço antigo do LM Studio fazia `chunk.toString().split('\n')` em cada pedaço
 * e jogava fora a linha parcial. Quando um pedaço terminava no meio de uma linha "data: {...}" os
 * dois lados falhavam no JSON.parse (dentro de um catch vazio) e o texto sumia; quando terminava no
 * meio de um caractere de 2 bytes (ç, ã, é...) o toString() trocava os bytes por "�". Pedaços de
 * 300 bytes chegaram a perder 312 palavras de 9790 caracteres, e o último pedaço (com
 * finish_reason) também podia se perder.
 *
 * Aqui:
 *  - os bytes passam por um StringDecoder UTF-8 (um caractere partido espera o pedaço seguinte);
 *  - a sobra sem quebra de linha fica guardada até a linha completar;
 *  - aceita \n, \r\n e \r como fim de linha (inclusive \r\n partido entre dois pedaços);
 *  - flush() devolve a última linha que ficou sem quebra no fim do fluxo;
 *  - uma linha gigante sem quebra (servidor quebrado) é descartada acima de `maxLineChars` em vez de
 *    crescer sem limite.
 *
 * Módulo puro: sem efeito ao importar, sem rede, sem timers.
 */
import { StringDecoder } from 'node:string_decoder';

const LF = 10;
const CR = 13;

/**
 * Cria um separador de linhas com estado (um por fluxo).
 *
 *  - push(chunk): aceita Buffer/Uint8Array (ou string) e devolve as linhas COMPLETAS (sem o fim de linha);
 *  - flush(): chame no fim do fluxo; devolve a linha final sem quebra, se houver, e zera o estado.
 */
export function createLineSplitter({ maxLineChars = 1_000_000 } = {}) {
  let decoder = new StringDecoder('utf8');
  let carry = '';
  let skipLF = false;      // o pedaço anterior terminou em \r: um \n logo no início é parte do \r\n
  let discarding = false;  // linha acima do limite: descarta até o próximo fim de linha

  function push(chunk) {
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (!text) return [];
    if (skipLF) {
      skipLF = false;
      if (text.charCodeAt(0) === LF) text = text.slice(1);
    }
    const scanFrom = carry.length; // a sobra antiga não tem fim de linha: só o texto novo precisa ser varrido
    const buf = carry + text;
    const lines = [];
    let start = 0;
    for (let i = scanFrom; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== LF && c !== CR) continue;
      if (discarding) discarding = false;
      else lines.push(buf.slice(start, i));
      if (c === CR) {
        if (i + 1 < buf.length) { if (buf.charCodeAt(i + 1) === LF) i++; } else skipLF = true;
      }
      start = i + 1;
    }
    carry = buf.slice(start);
    if (carry.length > maxLineChars) { carry = ''; discarding = true; }
    return lines;
  }

  function flush() {
    const rest = carry + (typeof decoder.end === 'function' ? decoder.end() : '');
    const out = rest && !discarding ? [rest] : [];
    carry = '';
    skipLF = false;
    discarding = false;
    decoder = new StringDecoder('utf8');
    return out;
  }

  return { push, flush };
}

/**
 * Valor de uma linha "data: ..." de SSE, ou null se a linha não for de dados
 * (vazia, comentário ":" ou outro campo como "event:"). Retira UM espaço depois dos dois pontos.
 * O texto "[DONE]" volta como dado comum: quem chama decide encerrar.
 */
export function sseDataOf(line) {
  const s = String(line ?? '').trimStart();
  if (!s.startsWith('data:')) return null;
  const value = s.slice(5);
  return (value.startsWith(' ') ? value.slice(1) : value).trimEnd();
}
