/**
 * Normalização de texto para fala (pt-BR).
 *
 * Recebe o texto que a IA escreveu no chat (Markdown, menções, links, emoji,
 * números...) e devolve um texto "falável": sem marcação, sem dígitos e sem os
 * símbolos que um sintetizador leria em voz alta (* _ ~ | < > # { } [ ] @).
 *
 * Garantias (testadas em tests/test-tts-text.js):
 *  - a saída NUNCA contém dígito nem * _ ~ | < > # { } [ ] @ (o último passo é uma
 *    lista de caracteres PERMITIDOS, então nada passa por acidente);
 *  - nenhuma expressão regular tem backtracking catastrófico: as repetições têm
 *    limite, ou consomem trechos que nunca são reanalisados, e a entrada é cortada
 *    em MAX_INPUT_CHARS antes de tudo (a fala só usa ~220 caracteres mesmo);
 *  - módulo puro: sem efeito colateral ao importar (o léxico só é lido do disco na
 *    primeira chamada de loadLexicon, e nunca grava nada).
 *
 * Ordem dos passos (importa; tudo roda ANTES de dividir em frases):
 *  1 blocos (cerca de código, spoiler, rodapé, cabeçalho, citação, lista)
 *  2 menções e marcações do Discord   3 links e URLs   4 emoji e keycap
 *  5 marcações residuais              6 abreviações com ponto
 *  7 números por extenso              8 léxico, gírias e risadas   9 higiene
 */

import fs from 'node:fs';

/** Texto de entrada acima disso é cortado: a fala usa poucas centenas de caracteres. */
const MAX_INPUT_CHARS = 10_000;

// ── Números por extenso (0 a 999.999.999.999, sem dependência) ───────────

const UN_M = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez',
  'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const UN_F = UN_M.map((w, i) => (i === 1 ? 'uma' : i === 2 ? 'duas' : w));
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUND_M = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos',
  'setecentos', 'oitocentos', 'novecentos'];
const HUND_F = HUND_M.map((w) => w.replace(/entos$/, 'entas'));

const MAX_CARDINAL_DIGITS = 12;

/** 1 a 999 por extenso. */
function below1000(n, fem) {
  if (n === 100) return 'cem';
  const un = fem ? UN_F : UN_M;
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push((fem ? HUND_F : HUND_M)[h]);
  if (r) {
    if (r < 20) parts.push(un[r]);
    else {
      const u = r % 10;
      parts.push(u ? `${TENS[Math.floor(r / 10)]} e ${un[u]}` : TENS[Math.floor(r / 10)]);
    }
  }
  return parts.join(' e ');
}

/** Inteiro de 0 a 999.999.999.999 por extenso. Feminino vale para "mil" e para o último grupo. */
function cardinal(n, fem) {
  if (n === 0) return 'zero';
  const groups = [Math.floor(n / 1e9), Math.floor(n / 1e6) % 1000, Math.floor(n / 1e3) % 1000, n % 1000];
  const items = [];
  groups.forEach((g, i) => {
    if (!g) return;
    let text;
    if (i === 0) text = `${below1000(g, false)} ${g === 1 ? 'bilhão' : 'bilhões'}`;
    else if (i === 1) text = `${below1000(g, false)} ${g === 1 ? 'milhão' : 'milhões'}`;
    else if (i === 2) text = g === 1 ? 'mil' : `${below1000(g, fem)} mil`;
    else text = below1000(g, fem);
    items.push({ text, value: g });
  });
  let out = items[0].text;
  for (let k = 1; k < items.length; k++) {
    // O "e" só liga o ÚLTIMO grupo quando ele é menor que 100 ou centena redonda
    // ("mil e um", "um milhão e duzentos mil"); nos demais casos só se separa.
    const last = k === items.length - 1;
    const v = items[k].value;
    out += (last && (v < 100 || v % 100 === 0) ? ' e ' : ' ') + items[k].text;
  }
  return out;
}

/** Lê dígito a dígito ("zero um dois"); usado para o que não cabe em número (zeros à esquerda, 13+ dígitos). */
function digitsOneByOne(digits) {
  const words = [];
  for (const c of digits) {
    const d = c.charCodeAt(0) - 48;
    if (d >= 0 && d <= 9) words.push(UN_M[d]);
  }
  return words.join(' ');
}

function intStringToWords(digits, fem = false) {
  if (digits.length > MAX_CARDINAL_DIGITS || (digits.length > 1 && digits[0] === '0')) {
    return digitsOneByOne(digits);
  }
  return cardinal(Number(digits), fem);
}

/**
 * Número inteiro por extenso em português do Brasil.
 * Aceita number, bigint ou string de dígitos; a parte decimal de um number é ignorada.
 * Fora de 0 a 999.999.999.999 (ou com zeros à esquerda) lê dígito a dígito.
 * @param {number|bigint|string} n
 * @param {{ gender?: 'm'|'f' }} [opts]
 * @returns {string} '' se n não for um número válido
 */
export function numberToWordsPt(n, { gender = 'm' } = {}) {
  let negative = false;
  let digits;
  if (typeof n === 'bigint') {
    negative = n < 0n;
    digits = (negative ? -n : n).toString();
  } else if (typeof n === 'number') {
    if (!Number.isFinite(n)) return '';
    negative = n < 0;
    digits = BigInt(Math.trunc(Math.abs(n))).toString();
  } else {
    const m = /^(-)?(\d+)$/.exec(String(n ?? '').trim());
    if (!m) return '';
    negative = Boolean(m[1]);
    digits = m[2];
  }
  const words = intStringToWords(digits, gender === 'f');
  return negative && /[1-9]/.test(digits) ? `menos ${words}` : words;
}

// Tokens numéricos (com . e ,) classificados com regex ANCORADAS: custo linear.
const RE_INT = /^\d+$/;
const RE_THOUSANDS_DOT = /^\d{1,3}(?:\.\d{3})+$/;
const RE_THOUSANDS_COMMA = /^\d{1,3}(?:,\d{3})+$/;
const RE_THOUSANDS_DOT_DEC = /^(\d{1,3}(?:\.\d{3})+),(\d+)$/;
const RE_DEC_COMMA = /^(\d+),(\d+)$/;
const RE_DEC_DOT = /^(\d+)\.(\d+)$/;
const RE_US_THOUSANDS = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;
const RE_DOTTED_SEQ = /^\d+(?:\.\d+){2,}$/;

/** Parte decimal: 1-2 dígitos viram número ("14" -> catorze, "05" -> zero cinco); 3+ viram dígito a dígito. */
function readFraction(frac) {
  if (frac.length > 2) return digitsOneByOne(frac);
  let zeros = 0;
  while (zeros < frac.length && frac[zeros] === '0') zeros++;
  const words = Array(zeros).fill('zero');
  if (zeros < frac.length) words.push(cardinal(Number(frac.slice(zeros)), false));
  return words.join(' ');
}

function readDecimal(intStr, fracStr) {
  return `${intStringToWords(intStr)} vírgula ${readFraction(fracStr)}`;
}

/** Lê um token como "1.234,56", "3,14", "2026", "1.2.3". Qualquer outra forma vira lista. */
function readNumberToken(tok, gender = 'm') {
  const fem = gender === 'f';
  if (RE_INT.test(tok)) return intStringToWords(tok, fem);
  if (RE_THOUSANDS_DOT.test(tok)) return intStringToWords(tok.replace(/\./g, ''), fem);
  let m = RE_THOUSANDS_DOT_DEC.exec(tok);
  if (m) return readDecimal(m[1].replace(/\./g, ''), m[2]);
  m = RE_DEC_COMMA.exec(tok);
  if (m) return readDecimal(m[1], m[2]);
  m = RE_DEC_DOT.exec(tok);
  if (m) return readDecimal(m[1], m[2]);
  m = RE_US_THOUSANDS.exec(tok);
  if (m) {
    const whole = intStringToWords(m[1].replace(/,/g, ''), fem);
    return m[2] === undefined ? whole : `${whole} vírgula ${readFraction(m[2])}`;
  }
  if (RE_DOTTED_SEQ.test(tok)) return tok.split('.').map((p) => intStringToWords(p)).join(' ponto ');
  return tok.split(/[.,]/).map((p) => intStringToWords(p)).join(', ');
}

// ── Ordinais ────────────────────────────────────────────────────────────
const ORD_U = ['', 'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto', 'sexto', 'sétimo', 'oitavo', 'nono'];
const ORD_T = ['', 'décimo', 'vigésimo', 'trigésimo', 'quadragésimo', 'quinquagésimo', 'sexagésimo',
  'septuagésimo', 'octogésimo', 'nonagésimo'];
const ORD_H = ['', 'centésimo', 'ducentésimo', 'trecentésimo', 'quadringentésimo', 'quingentésimo',
  'sexcentésimo', 'septingentésimo', 'octingentésimo', 'nongentésimo'];

/** 1 a 999 em ordinal; feminino troca o "o" final de cada palavra por "a". */
function ordinalWords(n, fem) {
  const parts = [ORD_H[Math.floor(n / 100)], ORD_T[Math.floor((n % 100) / 10)], ORD_U[n % 10]].filter(Boolean);
  return parts.map((p) => (fem ? `${p.slice(0, -1)}a` : p)).join(' ');
}

// ── Dinheiro, unidades, meses ───────────────────────────────────────────
const CURRENCY = new Map([
  ['r$', ['real', 'reais']],
  ['us$', ['dólar', 'dólares']],
  ['$', ['dólar', 'dólares']],
  ['€', ['euro', 'euros']],
  ['£', ['libra', 'libras', true]], // true = feminino: "duas libras", "uma libra"
]);

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro',
  'outubro', 'novembro', 'dezembro'];

/** Unidades que aceitam espaço depois do número ("16 GB", "16GB"). [chave minúscula, singular, plural] */
const UNITS_SPACED = [
  ['km/h', 'quilômetro por hora', 'quilômetros por hora'],
  ['m/s', 'metro por segundo', 'metros por segundo'],
  ['kb/s', 'kilobyte por segundo', 'kilobytes por segundo'],
  ['mb/s', 'megabyte por segundo', 'megabytes por segundo'],
  ['gb/s', 'gigabyte por segundo', 'gigabytes por segundo'],
  ['kbps', 'kilobit por segundo', 'kilobits por segundo'],
  ['mbps', 'megabit por segundo', 'megabits por segundo'],
  ['gbps', 'gigabit por segundo', 'gigabits por segundo'],
  ['ghz', 'gigahertz', 'gigahertz'],
  ['mhz', 'megahertz', 'megahertz'],
  ['khz', 'quilohertz', 'quilohertz'],
  ['hz', 'hertz', 'hertz'],
  ['tb', 'terabyte', 'terabytes'],
  ['gb', 'gigabyte', 'gigabytes'],
  ['mb', 'megabyte', 'megabytes'],
  ['kb', 'kilobyte', 'kilobytes'],
  ['fps', 'quadro por segundo', 'quadros por segundo'],
  ['kg', 'quilo', 'quilos'],
  ['mg', 'miligrama', 'miligramas'],
  ['km²', 'quilômetro quadrado', 'quilômetros quadrados'],
  ['km', 'quilômetro', 'quilômetros'],
  ['cm²', 'centímetro quadrado', 'centímetros quadrados'],
  ['cm', 'centímetro', 'centímetros'],
  ['mm', 'milímetro', 'milímetros'],
  ['m²', 'metro quadrado', 'metros quadrados'],
  ['m³', 'metro cúbico', 'metros cúbicos'],
  ['ml', 'mililitro', 'mililitros'],
  ['kwh', 'quilowatt-hora', 'quilowatts-hora'],
  ['kw', 'quilowatt', 'quilowatts'],
  ['ms', 'milissegundo', 'milissegundos'],
  ['min', 'minuto', 'minutos'],
  ['°c', 'grau Celsius', 'graus Celsius'],
  ['°f', 'grau Fahrenheit', 'graus Fahrenheit'],
];

/** Unidades de uma letra: só valem COLADAS no número ("5m", "2l"), senão "3 m" seria ambíguo. */
const UNITS_TIGHT = [
  ['g', 'grama', 'gramas'],
  ['m', 'metro', 'metros'],
  ['l', 'litro', 'litros'],
  ['s', 'segundo', 'segundos'],
  ['w', 'watt', 'watts'],
];

const UNIT_MAP = new Map([...UNITS_SPACED, ...UNITS_TIGHT].map(([k, s, p]) => [k, [s, p]]));

/** Substantivos femininos: o número que vem antes concorda ("duas pessoas", "uma hora"). */
const FEM_NOUNS = [
  'hora', 'horas', 'vez', 'vezes', 'pessoa', 'pessoas', 'semana', 'semanas', 'música', 'músicas', 'musica',
  'musicas', 'faixa', 'faixas', 'mensagem', 'mensagens', 'pergunta', 'perguntas', 'resposta', 'respostas',
  'partida', 'partidas', 'rodada', 'rodadas', 'fase', 'fases', 'página', 'páginas', 'pagina', 'paginas',
  'linha', 'linhas', 'moeda', 'moedas', 'tentativa', 'tentativas', 'casa', 'casas', 'palavra', 'palavras',
  'unidade', 'unidades', 'cópia', 'cópias', 'copia', 'copias', 'chance', 'chances', 'vaga', 'vagas',
  'foto', 'fotos', 'aula', 'aulas', 'parte', 'partes',
  // Mais comuns na conversa (o resto cai no padrão masculino; as terminações -ção/-dade/-gem são tratadas à parte):
  'coisa', 'coisas', 'garrafa', 'garrafas', 'caixa', 'caixas', 'cerveja', 'cervejas', 'pizza', 'pizzas', 'banana',
  'bananas', 'laranja', 'laranjas', 'mesa', 'mesas', 'cadeira', 'cadeiras', 'porta', 'portas', 'janela', 'janelas',
  'bola', 'bolas', 'carta', 'cartas', 'conta', 'contas', 'nota', 'notas', 'dica', 'dicas', 'regra', 'regras',
  'ideia', 'ideias', 'vida', 'vidas', 'mão', 'mãos', 'pasta', 'pastas', 'tela', 'telas', 'senha', 'senhas',
  'conversa', 'conversas', 'história', 'histórias', 'historia', 'historias', 'noite', 'noites', 'tarde', 'tardes',
  'manhã', 'manhãs', 'peça', 'peças', 'fila', 'filas', 'luz', 'luzes', 'voz', 'vozes', 'cor', 'cores', 'flor',
  'flores', 'dor', 'dores', 'mulher', 'mulheres', 'criança', 'crianças', 'amiga', 'amigas', 'irmã', 'irmãs',
  'mãe', 'mães', 'filha', 'filhas',
];
// Terminações que só existem em substantivos femininos: "2 versões", "3 opções", "1 viagem", "2 cidades".
const FEM_SUFFIX = String.raw`\p{L}*(?:ção|ções|dade|dades|gem|gens)`;

// ── Expressões regulares dos números (todas lineares) ────────────────────
const NUM = String.raw`\d+(?:[.,]\d+)*`;
// Impede começar um número no meio de outro: sem isto, cada posição de uma sequência
// longa de dígitos reiniciaria a busca e o custo viraria quadrático.
const NOT_IN_NUMBER = String.raw`(?<!\d|\d[.,])`;
const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const sortedKeys = (list) => list.map((u) => u[0]).sort((a, b) => b.length - a.length).map(escapeRe).join('|');

const RE_VERSUS = /(?<=\d)[vV](?=\d)/g;
const RE_TIMES = /(?<=\d)[xX×](?=\d)/g;
const RE_NEGATIVE = /(?<![\p{L}\p{N}])[-−](?=\d)/gu;
const RE_DATE_BR = /(?<![\d/.,-])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g;
const RE_DATE_ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const RE_TIME = /(?<![\p{L}\p{N}:.,])(\d{1,3})(?:[h:](\d{2})(?!\d)(?!:\d)(?:\s?min(?![\p{L}]))?|h(?![\p{L}\p{N}]))/giu;
const RE_MONEY = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(R\$|US\$|\$|€|£)\s?(${NUM})(?:\s+(mil|milh(?:ão|ao|ões|oes)|bilh(?:ão|ao|ões|oes))(?![\p{L}]))?(\/(?=\p{L}))?`,
  'giu',
);
const RE_EURO_SUFFIX = new RegExp(String.raw`${NOT_IN_NUMBER}(${NUM})\s?€`, 'gu');
const RE_PERCENT = new RegExp(String.raw`${NOT_IN_NUMBER}(${NUM})\s?%`, 'gu');
const RE_UNIT = new RegExp(
  String.raw`${NOT_IN_NUMBER}(${NUM})(?:\s?(${sortedKeys(UNITS_SPACED)})|(${sortedKeys(UNITS_TIGHT)}))(?![\p{L}\p{N}])(\/(?=\p{L}))?`,
  'giu',
);
// "2x mais rápido" = duas vezes (o "x" colado entre dígitos, como em 1920x1080, é tratado antes).
const RE_TIMES_SUFFIX = new RegExp(String.raw`${NOT_IN_NUMBER}(${NUM})[xX×](?![\p{L}\p{N}])`, 'gu');
const RE_NUMERO = /(?<![\p{L}\p{N}])n\.?[º°]\.?\s?(?=\d)/giu;
const RE_ORDINAL = new RegExp(String.raw`${NOT_IN_NUMBER}(\d{1,3})\s?([ºª°])`, 'gu');
const RE_FRACTION = /(?<!\d|\d[.,/])(\d{1,3})\/(\d{1,3})(?![\d/])/g;
const RE_NUMBER = new RegExp(`${NOT_IN_NUMBER}(${NUM})`, 'gu');
// Substantivos que indicam ordinal quando o número vem com "°" ("1° lugar"); sem eles "30°" são graus.
const ORDINAL_NOUNS_M = ['lugar', 'lugares', 'andar', 'ano', 'dia', 'lote', 'capítulo', 'capitulo', 'episódio',
  'episodio', 'colocado', 'classificado', 'jogo', 'round', 'set', 'período', 'periodo', 'mês', 'mes', 'século',
  'seculo', 'grau'];
const ORDINAL_NOUNS_F = ['vez', 'vezes', 'fase', 'temporada', 'edição', 'edicao', 'rodada', 'posição', 'posicao',
  'divisão', 'divisao', 'vaga', 'parte', 'aula', 'semana', 'série', 'serie', 'etapa', 'colocada', 'classificada',
  'feira', 'turma', 'guerra', 'geração', 'geracao', 'dama', 'companhia'];
const RE_ORDINAL_NOUN_M = new RegExp(String.raw`\s?(?:${ORDINAL_NOUNS_M.join('|')})(?![\p{L}])`, 'iuy');
const RE_ORDINAL_NOUN_F = new RegExp(String.raw`\s?(?:${ORDINAL_NOUNS_F.join('|')})(?![\p{L}])`, 'iuy');
const RE_FEM_AFTER = new RegExp(String.raw`\s{1,3}(?:${FEM_NOUNS.join('|')}|${FEM_SUFFIX})(?![\p{L}])`, 'iuy');

const FRACTIONS = new Map([
  ['1/2', 'um meio'], ['1/3', 'um terço'], ['2/3', 'dois terços'], ['1/4', 'um quarto'], ['3/4', 'três quartos'],
]);

const pad = (s) => ` ${s} `;

function parseAmount(tok) {
  // Devolve { int, cents } ou null se o formato não for um valor em dinheiro reconhecível.
  const hasDot = tok.includes('.');
  const hasComma = tok.includes(',');
  let intStr = tok;
  let fracStr = '';
  if (hasDot && hasComma) {
    const dec = tok.lastIndexOf('.') > tok.lastIndexOf(',') ? '.' : ',';
    const parts = tok.split(dec);
    if (parts.length !== 2) return null;
    const groupsRe = dec === ',' ? RE_THOUSANDS_DOT : RE_THOUSANDS_COMMA;
    if (!RE_INT.test(parts[0]) && !groupsRe.test(parts[0])) return null;
    intStr = parts[0].replace(/[.,]/g, '');
    fracStr = parts[1];
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = tok.split(sep);
    if (parts.length === 2 && parts[1].length !== 3) {
      intStr = parts[0];
      fracStr = parts[1];
    } else {
      if (!(sep === '.' ? RE_THOUSANDS_DOT : RE_THOUSANDS_COMMA).test(tok)) return null;
      intStr = parts.join('');
    }
  }
  if (!RE_INT.test(intStr) || intStr.length > MAX_CARDINAL_DIGITS) return null;
  if (fracStr && (!RE_INT.test(fracStr) || fracStr.length > 2)) return null;
  return { int: Number(intStr), cents: fracStr ? Number(fracStr.padEnd(2, '0')) : 0 };
}

function moneyWords({ int, cents }, cur) {
  const parts = [];
  if (int > 0 || cents === 0) {
    const de = int >= 1e6 && int % 1e6 === 0 ? ' de' : '';
    parts.push(`${cardinal(int, cur[2] === true)}${de} ${int === 1 ? cur[0] : cur[1]}`);
  }
  if (cents > 0) parts.push(`${cardinal(cents, false)} ${cents === 1 ? 'centavo' : 'centavos'}`);
  return parts.join(' e ');
}

function hourWords(hours) {
  return `${cardinal(hours, true)} ${hours === 1 ? 'hora' : 'horas'}`;
}

/** 'm' | 'f' se o que vem depois pede ordinal ("lugar", "fase"); null se não pede. */
function ordinalNounGender(str, pos) {
  RE_ORDINAL_NOUN_M.lastIndex = pos;
  if (RE_ORDINAL_NOUN_M.test(str)) return 'm';
  RE_ORDINAL_NOUN_F.lastIndex = pos;
  return RE_ORDINAL_NOUN_F.test(str) ? 'f' : null;
}

function genderAfter(str, pos) {
  RE_FEM_AFTER.lastIndex = pos;
  return RE_FEM_AFTER.test(str) ? 'f' : 'm';
}

/** Passo 7: todos os números viram palavras. Qualquer dígito que sobrar é lido dígito a dígito no fim. */
function expandNumbers(text) {
  if (!/\d/.test(text)) return text;
  let t = text;
  t = t.replace(RE_VERSUS, ' contra ').replace(RE_TIMES, ' por ');
  t = t.replace(RE_NEGATIVE, 'menos ');

  const dateWords = (d, mo, y, whole) => {
    const day = Number(d);
    const month = Number(mo);
    if (day < 1 || day > 31 || month < 1 || month > 12) return whole;
    const year = y.length === 2 ? (Number(y) <= 49 ? 2000 : 1900) + Number(y) : Number(y);
    return pad(`${day === 1 ? 'primeiro' : cardinal(day, false)} de ${MONTHS[month - 1]} de ${cardinal(year, false)}`);
  };
  t = t.replace(RE_DATE_ISO, (m, y, mo, d) => dateWords(d, mo, y, m));
  t = t.replace(RE_DATE_BR, (m, d, mo, y) => dateWords(d, mo, y, m));

  t = t.replace(RE_TIME, (m, h, mm) => {
    const hours = Number(h);
    if (mm === undefined) return pad(hourWords(hours));
    const minutes = Number(mm);
    if (hours > 24 || minutes > 59) return m;
    if (minutes === 0) return pad(hourWords(hours));
    return pad(`${cardinal(hours, true)} e ${cardinal(minutes, false)}`);
  });

  // "R$ 49,90/mês": a barra colada a uma palavra vira "por".
  t = t.replace(RE_MONEY, (m, sym, tok, mult, slash) => {
    const cur = CURRENCY.get(sym.toLowerCase());
    const per = slash ? ' por' : '';
    if (mult) {
      const w = mult.toLowerCase();
      const base = readNumberToken(tok);
      if (w === 'mil') return pad(`${tok === '1' ? 'mil' : `${base} mil`} ${cur[1]}${per}`);
      const big = w.startsWith('milh') ? ['milhão', 'milhões'] : ['bilhão', 'bilhões'];
      return pad(`${base} ${tok === '1' ? big[0] : big[1]} de ${cur[1]}${per}`);
    }
    const amount = parseAmount(tok);
    return amount ? pad(`${moneyWords(amount, cur)}${per}`) : m;
  });
  t = t.replace(RE_EURO_SUFFIX, (m, tok) => {
    const amount = parseAmount(tok);
    return amount ? pad(moneyWords(amount, CURRENCY.get('€'))) : m;
  });

  t = t.replace(RE_PERCENT, (m, tok) => pad(`${readNumberToken(tok)} por cento`));

  t = t.replace(RE_TIMES_SUFFIX, (m, tok) => pad(tok === '1' ? 'uma vez' : `${readNumberToken(tok, 'f')} vezes`));

  t = t.replace(RE_UNIT, (m, tok, spaced, tight, slash) => {
    const unit = UNIT_MAP.get((spaced || tight).toLowerCase());
    return unit ? pad(`${readNumberToken(tok)} ${tok === '1' ? unit[0] : unit[1]}${slash ? ' por' : ''}`) : m;
  });

  t = t.replace(RE_NUMERO, ' número ');
  t = t.replace(RE_ORDINAL, (m, n, sign, offset, str) => {
    const v = Number(n);
    let fem = sign === 'ª';
    if (sign === '°') {
      // "°" é grau ("30°") ou ordinal digitado errado ("1° lugar"): decide pelo substantivo seguinte.
      const g = ordinalNounGender(str, offset + m.length);
      if (!g) return pad(`${readNumberToken(n)} ${v === 1 ? 'grau' : 'graus'}`);
      fem = g === 'f';
    }
    return pad(v === 0 ? 'zero' : ordinalWords(v, fem));
  });

  t = t.replace(RE_FRACTION, (m, a, b) => pad(FRACTIONS.get(`${a}/${b}`) || `${readNumberToken(a)} por ${readNumberToken(b)}`));

  t = t.replace(RE_NUMBER, (m, tok, offset, str) => pad(readNumberToken(tok, genderAfter(str, offset + m.length))));
  return t;
}

// ── Léxico (pronúncias editáveis pelo dono) ──────────────────────────────

/** Usado só se lexicon.pt-BR.json faltar ou estiver quebrado: o essencial para a Yui não soletrar errado. */
const FALLBACK_LEXICON = Object.freeze({
  Yui: 'Iúi', YouTube: 'Iútube', Discord: 'Discórdi', GPU: 'gê pê u', CPU: 'cê pê u', API: 'á pê i',
  PC: 'pê cê', GTA: 'gê tê á', FPS: 'éfe pê ésse', IA: 'i á',
});

/**
 * Palavras do léxico que também são palavras comuns do português quando escritas em
 * minúsculas ("ia" = verbo, "ui" = interjeição): só são trocadas se vierem em MAIÚSCULAS.
 */
const UPPERCASE_ONLY = new Set(['ia', 'ui']);

let lexiconCache = null;

/**
 * Lê src/services/tts/lexicon.pt-BR.json (com cache). Chaves que começam com "_" são
 * comentários. Se o arquivo faltar ou estiver inválido, usa um léxico mínimo embutido.
 * Para reler depois de editar: loadLexicon({ force: true }) (ou reinicie a Yui).
 * @returns {Record<string, string>} { palavra: pronúncia }
 */
export function loadLexicon({ force = false } = {}) {
  if (lexiconCache && !force) return lexiconCache;
  let data = null;
  try {
    const raw = fs.readFileSync(new URL('./lexicon.pt-BR.json', import.meta.url), 'utf8');
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); // Notepad pode gravar BOM
  } catch {
    data = null;
  }
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : FALLBACK_LEXICON;
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('_') || typeof value !== 'string') continue;
    clean[key] = value.trim().slice(0, 120);
  }
  lexiconCache = Object.freeze(clean);
  return lexiconCache;
}

/**
 * Só para testes: usa este léxico no lugar do arquivo (null volta a ler o arquivo na próxima chamada).
 * Os testes não podem depender de pronúncias que o dono ajusta de ouvido em lexicon.pt-BR.json.
 */
export function setLexiconForTests(lexicon) {
  lexiconCache = lexicon && typeof lexicon === 'object' ? Object.freeze({ ...lexicon }) : null;
}

const RE_LEXICON_KEY = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

const compiledCache = new WeakMap();

/** { palavra: pronúncia } -> Map por palavra em minúsculas (só chaves "palavra inteira" válidas). */
function compileLexicon(lexicon) {
  // Só objetos congelados (o de loadLexicon) são guardados: um objeto comum pode ser editado depois.
  const cacheable = lexicon && typeof lexicon === 'object' && Object.isFrozen(lexicon);
  if (cacheable && compiledCache.has(lexicon)) return compiledCache.get(lexicon);
  const map = new Map();
  if (!lexicon || typeof lexicon !== 'object') return map;
  for (const [key, value] of Object.entries(lexicon)) {
    if (typeof value !== 'string' || key.startsWith('_')) continue;
    const k = key.normalize('NFC').toLowerCase();
    if (k.length > 40 || !RE_LEXICON_KEY.test(k)) continue;
    map.set(k, value);
  }
  if (cacheable) compiledCache.set(lexicon, map);
  return map;
}

const SLANG = new Map([
  ['vc', 'você'], ['vcs', 'vocês'], ['pq', 'porque'], ['tb', 'também'], ['tbm', 'também'], ['td', 'tudo'],
  ['blz', 'beleza'], ['msg', 'mensagem'], ['msgs', 'mensagens'], ['mto', 'muito'], ['vlw', 'valeu'],
  ['obg', 'obrigado'], ['pfv', 'por favor'], ['hj', 'hoje'],
]);

// Risadas: "kkk", "rsrs" (só minúsculas: "RS" é o estado), "hahaha", "hehe", "ahah".
const RE_LAUGH = /^(?:k{2,}|(?:he|hi|hu){2,}h?|(?=[ah]*h)(?=[ah]*a)[ah]{4,})$/;
const RE_LAUGH_RS = /^(?:rs)+$/;

const RE_WORD = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;

/** A troca começa frase? Então vira maiúscula (o divisor de frases só corta antes de maiúscula). */
function capitalizeIf(upper, repl) {
  if (!upper || !repl) return repl;
  const first = repl[0];
  return first === first.toLowerCase() && first !== first.toUpperCase() ? first.toUpperCase() + repl.slice(1) : repl;
}

/** O que vem antes de `pos` (ignorando espaços) encerra uma frase, ou é o começo do texto? */
function startsSentence(str, pos) {
  let p = pos - 1;
  while (p >= 0 && str[p] === ' ') p--;
  return p < 0 || '.!?…'.includes(str[p]);
}

/** Troca uma palavra (léxico, gíria ou risada). null = sem mudança. */
function mapWord(w, lex, sentenceStart) {
  const lower = w.toLowerCase();
  const caps = w.length > 1 && w === w.toUpperCase() && w !== lower;
  const hit = lex.get(lower);
  if (hit !== undefined && (caps || !UPPERCASE_ONLY.has(lower))) return capitalizeIf(sentenceStart, hit);
  if (RE_LAUGH.test(lower) || RE_LAUGH_RS.test(w)) return ' ';
  // Sigla em maiúsculas ("TB" de terabyte, "VC") não é gíria.
  if (!caps) {
    const slang = SLANG.get(lower);
    if (slang) return capitalizeIf(sentenceStart, slang);
  }
  return null;
}

function applyWords(text, lex) {
  return text.replace(RE_WORD, (w, offset, str) => {
    const start = startsSentence(str, offset);
    const whole = mapWord(w, lex, start);
    if (whole !== null) return whole;
    if (!w.includes('-')) return w;
    return w.split('-').map((part, i) => {
      const r = mapWord(part, lex, i === 0 && start);
      return r === null ? part : r;
    }).join('-');
  });
}

// ── Passos 0 a 6 ─────────────────────────────────────────────────────────

const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Caracteres invisíveis são montados por código (e não digitados) para o arquivo ficar legível e auditável.
const cc = (...parts) => parts
  .map((p) => (Array.isArray(p) ? `${String.fromCodePoint(p[0])}-${String.fromCodePoint(p[1])}` : String.fromCodePoint(p)))
  .join('');
const RE_LINE_SEP = new RegExp(`[${cc(0x2028, 0x2029)}]`, 'g');
// hífen suave, espaços de largura zero, marcas de direção, junções e BOM
const RE_INVISIBLE = new RegExp(
  `[${cc(0xad, [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], 0xfeff, [0xfff9, 0xfffb])}]`,
  'g',
);
const RE_SPACES = /[\p{Zs}\t]/gu;
const RE_FULLWIDTH = new RegExp(`[${cc([0xff01, 0xff5e])}]`, 'g');
const RE_NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
const RE_VULGAR = /[½¼¾⅓⅔]/g;
const VULGAR = new Map([['½', ' um meio '], ['¼', ' um quarto '], ['¾', ' três quartos '], ['⅓', ' um terço '], ['⅔', ' dois terços ']]);

/** Valor de um dígito Unicode não-ASCII (٣ -> 3): conta a posição dentro do bloco de dígitos. */
function digitValue(ch) {
  const cp = ch.codePointAt(0);
  let start = cp;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

function capInput(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // não corta um par substituto ao meio
  return cut;
}

/** Passo 0: tira controles e invisíveis, uniformiza espaços, largura total e dígitos de outros alfabetos. */
function foldChars(t) {
  return t
    .replace(RE_CONTROL, ' ')
    .replace(RE_LINE_SEP, '\n')
    .replace(RE_INVISIBLE, '')
    .replace(RE_SPACES, ' ')
    .replace(RE_FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(RE_NON_ASCII_DIGIT, (c) => String(digitValue(c)))
    .replace(RE_VULGAR, (c) => VULGAR.get(c));
}

/** Cerca de código ``` ... ```: some com o conteúdo. Cerca sem fechamento: o resto é código. */
function stripFences(t, flags) {
  if (!t.includes('```')) return t;
  const parts = [];
  let i = 0;
  for (;;) {
    const a = t.indexOf('```', i);
    if (a < 0) { parts.push(t.slice(i)); break; }
    parts.push(t.slice(i, a));
    flags.hadCode = true;
    const b = t.indexOf('```', a + 3);
    if (b < 0) break;
    parts.push('\n');
    i = b + 3;
  }
  return parts.join('');
}

/** Spoiler ||...||: o conteúdo nunca é falado. Um "||" solto sobra e sai no passo 5. */
function stripSpoilers(t, flags) {
  if (!t.includes('||')) return t;
  const parts = [];
  let i = 0;
  for (;;) {
    const a = t.indexOf('||', i);
    const b = a < 0 ? -1 : t.indexOf('||', a + 2);
    if (b < 0) { parts.push(t.slice(i)); break; }
    parts.push(t.slice(i, a), ' ');
    flags.hadSpoiler = true;
    i = b + 2;
  }
  return parts.join('');
}

// Todas ancoradas no início da linha: custo linear por linha.
const RE_FOOTER = /^[ \t]*-#/;
const RE_QUOTE = /^[ \t]*>+[ \t]?/;
const RE_HEADING = /^[ \t]*#{1,6}[ \t]+/;
const RE_LIST_ITEM = /^[ \t]*(?:[-*+•][ \t]+|\d{1,2}[.)][ \t]+)/;
const LINE_ENDINGS = '.!?…:;,';

/**
 * Estrutura por linha: tira rodapé "-#", marcadores de citação, cabeçalho e lista
 * (mantendo o texto) e junta as linhas em um só parágrafo, com ponto entre elas
 * quando a linha anterior não terminou em pontuação (cada item de lista é uma frase).
 */
function structureLines(t, flags) {
  const out = [];
  let listItems = 0;
  for (let line of t.split(/\r\n|\r|\n/)) {
    if (RE_FOOTER.test(line)) continue;
    line = line.replace(RE_QUOTE, '').replace(RE_HEADING, '');
    const item = RE_LIST_ITEM.exec(line);
    if (item) {
      listItems++;
      line = line.slice(item[0].length);
    }
    line = line.trim();
    if (line) out.push(line);
  }
  if (listItems >= 3) flags.hadList = true;
  let res = '';
  for (const piece of out) {
    if (!res) { res = piece; continue; }
    const last = res[res.length - 1];
    // Vírgula ou ponto e vírgula no fim: a linha seguinte continua a frase. Nos demais casos a
    // linha nova abre outra frase (com maiúscula: o divisor de frases só corta antes de maiúscula).
    if (last === ',' || last === ';') res += ` ${piece}`;
    else res += `${LINE_ENDINGS.includes(last) ? ' ' : '. '}${piece[0].toUpperCase()}${piece.slice(1)}`;
  }
  return res;
}

// Menções, emoji customizado e carimbo de hora do Discord. Corpos com limite de tamanho.
const RE_DISCORD = /<(?:@!?(\d{1,25})|@&(\d{1,25})|#(\d{1,25})|t:-?\d{1,15}(?::[A-Za-z])?|a?:\w{1,64}:\d{1,25})>|@(?:everyone|here)\b/g;

/**
 * Apelido/nome resolvido de uma menção é texto de TERCEIROS (hostil por definição):
 * só letras, números e espaço, no máximo 24 caracteres.
 */
function sanitizeName(raw) {
  // Caracteres invisíveis (ZWSP, hífen suave, seletores de variação) somem em vez de virar espaço:
  // "pu<ZWSP>ta" tem que ficar "puta" para a lista de bloqueio enxergar, e não "pu ta".
  const s = raw.slice(0, 200).normalize('NFC').replace(/[\p{Cf}\uFE00-\uFE0F]/gu, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/ {2,}/g, ' ').trim();
  return Array.from(s).slice(0, 24).join('').trim();
}

function resolveSafe(resolve, id, kind) {
  if (typeof resolve !== 'function') return '';
  let raw;
  try { raw = resolve(id, kind); } catch { return ''; }
  return typeof raw === 'string' ? sanitizeName(raw) : ''; // Promise, objeto ou null: ignora
}

function replaceMentions(t, resolveMention) {
  if (!t.includes('<') && !t.includes('@')) return t;
  return t.replace(RE_DISCORD, (m, user, role, channel) => {
    const id = user || role || channel;
    if (!id) return ' ';
    const name = resolveSafe(resolveMention, id, user ? 'user' : role ? 'role' : 'channel');
    return name ? pad(name) : ' ';
  });
}

const RE_MD_LINK = /!?\[([^[\]]{0,300})\]\(([^()]{0,2000})\)/g;
const RE_URL = /(?:https?:\/\/|www\.)\S+/gi;
// Sem esquema, mas com caminho: "discord.gg/abc", "bit.ly/xYz", "github.com/fulano/repo". Exigir o "/" evita
// pegar "site.com" solto em prosa; o lookbehind só deixa começar no início de um "token".
const RE_BARE_URL = /(?<![\p{L}\p{N}@./_-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/\S*/giu;
const URL_TAIL = '.,;:!?)]}>\'"*_~|';

function replaceLinks(t, flags) {
  t = t.replace(RE_MD_LINK, (m, label) => {
    flags.hadLink = true;
    return m[0] === '!' ? ' ' : pad(label); // imagem: nada a falar
  });
  const strip = (url) => {
    flags.hadLink = true;
    // A pontuação final faz parte da frase, não da URL.
    let end = url.length;
    while (end > 0 && URL_TAIL.includes(url[end - 1])) end--;
    return ` ${url.slice(end)}`;
  };
  return t.replace(RE_URL, strip).replace(RE_BARE_URL, strip);
}

const RE_KEYCAP = new RegExp(`([0-9#*])${cc(0xfe0f)}?${cc(0x20e3)}`, 'g');
const RE_EMOJI = new RegExp(
  String.raw`\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[${cc(0xfe0e, 0xfe0f, 0x200d, 0x20e3)}]|[${cc([0xe0020, 0xe007f])}]`,
  'gu',
);

/** Emoji somem; o dígito de um keycap (dígito + FE0F + 20E3) vira número solto ANTES da conversão de números. */
function stripEmoji(t) {
  return t
    .replace(RE_KEYCAP, (m, c) => (c >= '0' && c <= '9' ? ` ${c} ` : ' '))
    .replace(RE_EMOJI, ' ');
}

const RE_ARROW = /[-=]{1,3}>|[→➜➔➡⇒⟶]/g;
const RE_MARKS = /[*_~`|<>#{}[\]@]/g;

const ABBREVIATIONS = new Map([
  ['dra', 'doutora'], ['dr', 'doutor'], ['sra', 'senhora'], ['sr', 'senhor'], ['srta', 'senhorita'],
  ['profa', 'professora'], ['prof', 'professor'], ['eng', 'engenheiro'], ['etc', 'etcétera'],
  ['obs', 'observação'], ['pág', 'página'], ['págs', 'páginas'], ['tel', 'telefone'], ['av', 'avenida'],
  ['aprox', 'aproximadamente'], ['vs', 'versus'], ['p.ex', 'por exemplo'], ['e.g', 'por exemplo'],
  ['i.e', 'isto é'],
]);
const RE_ABBREV = /(?<![\p{L}\p{N}])(dra|dr|sra|sr|srta|profa|prof|eng|etc|obs|págs|pág|tel|av|aprox|vs|p\.ex|e\.g|i\.e)\./giu;

/** O ponto de "etc." também encerra a frase quando vem fim de texto ou maiúscula depois. */
function endsSentenceAt(str, pos) {
  let p = pos;
  while (str[p] === ' ') p++;
  if (p >= str.length) return true;
  const c = str[p];
  return c !== c.toLowerCase() || '"“«('.includes(c);
}

/** Passo 6: abreviações com ponto, ANTES de dividir em frases (o ponto de "Dr." não encerra frase). */
function expandAbbreviations(t) {
  if (!t.includes('.')) return t;
  return t.replace(RE_ABBREV, (m, key, offset, str) => {
    const word = ABBREVIATIONS.get(key.toLowerCase());
    let out = key[0] !== key[0].toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word;
    if (key.toLowerCase() === 'etc' && endsSentenceAt(str, offset + m.length)) out += '.';
    return out;
  });
}

// ── Passo 9: o que restar ───────────────────────────────────────────────

const SYMBOLS = new Map([
  ['R$', ' reais '], ['r$', ' reais '], ['US$', ' dólares '], ['us$', ' dólares '], ['$', ' dólares '],
  ['€', ' euros '], ['£', ' libras '], ['&', ' e '], ['+', ' mais '], ['=', ' igual a '], ['%', ' por cento '],
  ['°', ' graus '], ['²', ' ao quadrado '], ['³', ' ao cubo '], ['…', '.'],
]);
// ºª sobrando (sem número antes) são letras para o Unicode, mas soariam como lixo: viram espaço.
const RE_SYMBOLS = /R\$|US\$|[&+=%$€£°ºª²³…]/gi;
// Lista de caracteres PERMITIDOS: letras, acentos soltos, espaço e pontuação de fala.
// Tudo o mais (dígito de qualquer alfabeto, * _ ~ | < > # { } [ ] @, barra...) vira espaço.
const RE_NOT_ALLOWED = /[^\p{L}\p{Mn}\p{Mc}\p{Zs}.,;:!?'"“”‘’«»\-–—]/gu;

function tidy(text) {
  let t = text.replace(/(.)\1{3,}/gsu, '$1$1'); // "aaaaa" -> "aa"
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\.{2,}/g, '.');
  t = t.replace(/[!?]{2,}/g, (m) => (m.includes('?') ? '?' : '!'));
  t = t.replace(/[-–—]{2,}/g, ' ').replace(/\s+/g, ' ');
  t = t.replace(/ [-–—] /g, ', '); // travessão com espaços vira pausa
  t = t.replace(/(?<=\p{L})-(?= )/gu, ''); // hífen pendurado: "COVID- dezenove"
  t = t.replace(/,(?: ?,)+/g, ',');
  t = t.replace(/[,;:] ?(?=[.!?])/g, '');
  t = t.replace(/ ([,.;:!?])/g, '$1');
  t = t.replace(/^[\s,;:.!?\-–—]+/, '');
  let end = t.length;
  // O ":" final fica: é o sinal de que uma lista/código vinha a seguir (prepareSpeech olha isso).
  while (end > 0 && ' ,;-–—'.includes(t[end - 1])) end--;
  return t.slice(0, end);
}

function finalize(text) {
  let t = text.replace(/\d+/g, (d) => pad(digitsOneByOne(d))); // número fora de faixa: dígito a dígito
  t = t.replace(RE_SYMBOLS, (s) => SYMBOLS.get(s) ?? SYMBOLS.get(s.toLowerCase()) ?? ' ');
  t = t.replace(RE_NOT_ALLOWED, ' ');
  return tidy(t);
}

/**
 * Normaliza o texto de uma resposta para ser falado em pt-BR.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {(id: string, kind: 'user'|'role'|'channel') => string|null|undefined} [opts.resolveMention]
 *        Nome de exibição de uma menção (síncrono). Sem resolver, a menção é removida.
 *        O nome devolvido é sanitizado aqui (letras, números e espaço, até 24 caracteres).
 * @param {Record<string, string>} [opts.lexicon] { palavra: pronúncia }; padrão: loadLexicon().
 * @param {number} [opts.maxInputChars] Corte de segurança da entrada (padrão 10000).
 * @returns {{ text: string, flags: { hadCode: boolean, hadLink: boolean, hadList: boolean, hadSpoiler: boolean } }}
 */
export function normalizeForSpeech(text, { resolveMention, lexicon, maxInputChars } = {}) {
  const flags = { hadCode: false, hadLink: false, hadList: false, hadSpoiler: false };
  const limit = Number.isFinite(maxInputChars) && maxInputChars >= 100 ? Math.min(Math.floor(maxInputChars), 2_000_000) : MAX_INPUT_CHARS;
  let t = capInput(typeof text === 'string' ? text : text == null ? '' : String(text), limit);

  t = foldChars(t);
  t = stripFences(t, flags); // 1
  t = stripSpoilers(t, flags);
  t = structureLines(t, flags);
  t = replaceMentions(t, resolveMention); // 2
  t = replaceLinks(t, flags); // 3
  t = stripEmoji(t); // 4
  t = t.replace(RE_ARROW, ' , ').replace(RE_MARKS, ' '); // 5
  t = expandAbbreviations(t); // 6
  t = expandNumbers(t); // 7
  t = applyWords(t, compileLexicon(lexicon === undefined || lexicon === null ? loadLexicon() : lexicon)); // 8
  return { text: finalize(t), flags }; // 9
}
