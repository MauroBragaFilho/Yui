/**
 * Prova de IDENTIDADE do servidor da Yui, do lado do app (ver docs/content_pt/YUI_API.md, rota GET /v1/identidade).
 *
 * A sonda de saúde (`/v1/health`) só prova que ALGUÉM responde. Aqui o app confere QUEM responde: gera um desafio aleatório (nonce), pede ao servidor que o
 * assine e confere a assinatura Ed25519 com a chave PÚBLICA que está no build (EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY). A chave PRIVADA só existe no servidor
 * (arquivo restrito ao dono, fora do código e fora do APK), então quem extrair o APK só obtém a chave pública: não consegue assinar nada em nome do servidor.
 *
 * Tudo em TypeScript PURO, sem pacote e sem React/Expo (testado em Node, tests/identidade-*.test.mjs): SHA-512 (FIPS 180-4), a aritmética da curva Ed25519
 * com BigInt e a verificação do RFC 8032 (§5.1.7), base64 estrito e o pedido ao servidor. O Hermes (o motor do app) suporta BigInt; evitamos `**` com BigInt
 * (o Babel o transforma em Math.pow) e literais `123n` (usamos `BigInt(...)`).
 *
 * Só VERIFICA (dado público): nada aqui precisa de tempo constante. Sem fonte de números aleatórios seguros (veja `nonceAleatorio`), a prova falha FECHADA.
 */

/** O texto que o servidor assina (prefixo + nonce). Igual ao PREFIXO_IDENTIDADE de src/core/api/identidade.js. */
export const PREFIXO_IDENTIDADE = 'yui-identidade-v1|';

// ───────────────────────── BigInt ─────────────────────────

const B = (n: number | string): bigint => BigInt(n);
const ZERO = B(0);
const ONE = B(1);
const TWO = B(2);

function potencia(base: bigint, expoente: bigint, modulo: bigint): bigint {
  let resultado = ONE;
  let b = base % modulo;
  for (const bit of expoente.toString(2).split('').reverse()) {
    if (bit === '1') resultado = (resultado * b) % modulo;
    b = (b * b) % modulo;
  }
  return resultado;
}

// ───────────────────────── bytes, hex, base64, UTF-8 ─────────────────────────

export function paraHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

/** UTF-8 sem TextEncoder (que nem todo ambiente do app tem). Surrogates soltos viram U+FFFD, como o TextEncoder faz. */
export function utf8Bytes(texto: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < texto.length; i += 1) {
    let c = texto.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < texto.length) {
      const d = texto.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i += 1; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const ALFABETO_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function codificarBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += ALFABETO_B64[(n >> 18) & 63] + ALFABETO_B64[(n >> 12) & 63];
    s += i + 1 < bytes.length ? ALFABETO_B64[(n >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? ALFABETO_B64[n & 63] : '=';
  }
  return s;
}

/**
 * Base64 ESTRITO (alfabeto padrão, com `=` no fim, forma canônica). Devolve null para qualquer texto malformado: tamanho que não fecha, caractere fora do alfabeto,
 * `=` no meio, bits sobrando diferentes de zero. Com `tamanho`, também exige esse número de bytes.
 */
export function decodificarBase64(texto: unknown, tamanho?: number): Uint8Array | null {
  if (typeof texto !== 'string' || texto.length === 0 || texto.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(texto)) return null;
  const sobra = texto.endsWith('==') ? 2 : texto.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((texto.length / 4) * 3 - sobra);
  let o = 0;
  for (let i = 0; i < texto.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j += 1) n = (n << 6) | (texto[i + j] === '=' ? 0 : ALFABETO_B64.indexOf(texto[i + j]));
    if (o < bytes.length) bytes[o++] = (n >> 16) & 255;
    if (o < bytes.length) bytes[o++] = (n >> 8) & 255;
    if (o < bytes.length) bytes[o++] = n & 255;
  }
  if (codificarBase64(bytes) !== texto) return null; // forma canônica: sem bits de sobra "escondidos"
  if (tamanho !== undefined && bytes.length !== tamanho) return null;
  return bytes;
}

// ───────────────────────── SHA-512 (FIPS 180-4) ─────────────────────────

const H0_HEX = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'];
const K_HEX = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
];

let constantesSha: { K: bigint[]; H0: bigint[] } | null = null;
const MASK64 = () => (ONE << B(64)) - ONE;

export function sha512(mensagem: Uint8Array): Uint8Array {
  if (!constantesSha) constantesSha = { K: K_HEX.map((h) => B(`0x${h}`)), H0: H0_HEX.map((h) => B(`0x${h}`)) };
  const { K, H0 } = constantesSha;
  const M = MASK64();
  const rotd = (x: bigint, n: number) => ((x >> B(n)) | (x << B(64 - n))) & M;

  // preenchimento: mensagem, bit 1, zeros e o tamanho em bits (128 bits, big-endian), até fechar blocos de 128 bytes
  const total = Math.ceil((mensagem.length + 17) / 128) * 128;
  const buf = new Uint8Array(total);
  buf.set(mensagem);
  buf[mensagem.length] = 0x80;
  const bits = B(mensagem.length) * B(8);
  for (let i = 0; i < 16; i += 1) buf[total - 1 - i] = Number((bits >> B(8 * i)) & B(255));

  const h = H0.slice();
  const w: bigint[] = new Array(80);
  for (let off = 0; off < total; off += 128) {
    for (let t = 0; t < 16; t += 1) {
      let v = ZERO;
      for (let j = 0; j < 8; j += 1) v = (v << B(8)) | B(buf[off + 8 * t + j]);
      w[t] = v;
    }
    for (let t = 16; t < 80; t += 1) {
      const s0 = rotd(w[t - 15], 1) ^ rotd(w[t - 15], 8) ^ (w[t - 15] >> B(7));
      const s1 = rotd(w[t - 2], 19) ^ rotd(w[t - 2], 61) ^ (w[t - 2] >> B(6));
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & M;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 80; t += 1) {
      const S1 = rotd(e, 14) ^ rotd(e, 18) ^ rotd(e, 41);
      const ch = (e & f) ^ ((e ^ M) & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) & M;
      const S0 = rotd(a, 28) ^ rotd(a, 34) ^ rotd(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M;
      hh = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
    }
    const novo = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + novo[i]) & M;
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) out[8 * i + j] = Number((h[i] >> B(8 * (7 - j))) & B(255));
  return out;
}

// ───────────────────────── Ed25519 (RFC 8032) ─────────────────────────

type Ponto = [bigint, bigint, bigint, bigint]; // coordenadas estendidas (X, Y, Z, T)

/** As constantes da curva (RFC 8032 §5.1), calculadas na primeira vez que forem precisas (o app não paga isso se a prova não for usada). */
interface Curva { P: bigint; L: bigint; D: bigint; I: bigint; G: Ponto; NEUTRO: Ponto }
let curvaCache: Curva | null = null;

function inverso(a: bigint, P: bigint): bigint {
  return potencia(((a % P) + P) % P, P - TWO, P);
}

/** Recupera x a partir de y e do bit de sinal (RFC 8032 §5.1.3). null se y não é canônico (>= p) ou não existe ponto com esse y. */
function pontoDeY(y: bigint, sinal: number, P: bigint, D: bigint, I: bigint): Ponto | null {
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const numerador = (y2 - ONE + P) % P;
  const denominador = (D * y2 + ONE) % P;
  const x2 = (numerador * inverso(denominador, P)) % P;
  if (x2 === ZERO) return sinal === 1 ? null : [ZERO, y, ONE, ZERO];
  let x = potencia(x2, (P + B(3)) / B(8), P);
  if ((((x * x - x2) % P) + P) % P !== ZERO) x = (x * I) % P;
  if ((((x * x - x2) % P) + P) % P !== ZERO) return null;
  if (Number(x & ONE) !== sinal) x = P - x;
  return [x, y, ONE, (x * y) % P];
}

function curva(): Curva {
  if (curvaCache) return curvaCache;
  const P = (ONE << B(255)) - B(19);
  const L = (ONE << B(252)) + B('27742317777372353535851937790883648493');
  const D = (((B(-121665) * inverso(B(121666), P)) % P) + P) % P;
  const I = potencia(TWO, (P - ONE) / B(4), P); // raiz quadrada de -1
  const G = pontoDeY((B(4) * inverso(B(5), P)) % P, 0, P, D, I); // o ponto-base tem y = 4/5 e x "par"
  if (!G) throw new Error('ponto-base inválido');
  curvaCache = { P, L, D, I, G, NEUTRO: [ZERO, ONE, ONE, ZERO] };
  return curvaCache;
}

const modP = (a: bigint, P: bigint): bigint => { const r = a % P; return r >= ZERO ? r : r + P; };

/** Soma de pontos (fórmula unificada do RFC 8032 §5.1.4; vale também para dobrar). */
function somar(c: Curva, p1: Ponto, p2: Ponto): Ponto {
  const { P, D } = c;
  const [x1, y1, z1, t1] = p1;
  const [x2, y2, z2, t2] = p2;
  const a = modP((y1 - x1) * (y2 - x2), P);
  const b = modP((y1 + x1) * (y2 + x2), P);
  const cc = modP(t1 * TWO * D * t2, P);
  const d = modP(z1 * TWO * z2, P);
  const e = b - a;
  const f = d - cc;
  const g = d + cc;
  const h = b + a;
  return [modP(e * f, P), modP(g * h, P), modP(f * g, P), modP(e * h, P)];
}

function multiplicar(c: Curva, escalar: bigint, ponto: Ponto): Ponto {
  let q = c.NEUTRO;
  if (escalar === ZERO) return q;
  for (const bit of escalar.toString(2)) {
    q = somar(c, q, q);
    if (bit === '1') q = somar(c, q, ponto);
  }
  return q;
}

function iguais(c: Curva, p1: Ponto, p2: Ponto): boolean {
  return modP(p1[0] * p2[2] - p2[0] * p1[2], c.P) === ZERO && modP(p1[1] * p2[2] - p2[1] * p1[2], c.P) === ZERO;
}

const ehNeutro = (c: Curva, p: Ponto): boolean => modP(p[0], c.P) === ZERO && modP(p[1] - p[2], c.P) === ZERO;

function lerLE(bytes: Uint8Array): bigint {
  let v = ZERO;
  for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << B(8)) | B(bytes[i]);
  return v;
}

/** Decodifica um ponto (32 bytes, RFC 8032 §5.1.3). null se o y não é canônico (>= p) ou não há ponto na curva. */
function decodificar(c: Curva, bytes: Uint8Array): Ponto | null {
  const y = lerLE(bytes);
  const sinal = Number((y >> B(255)) & ONE);
  return pontoDeY(y & ((ONE << B(255)) - ONE), sinal, c.P, c.D, c.I);
}

/** O ponto de ordem pequena (múltiplo do cofator 8 que dá o neutro) não serve como chave pública: qualquer assinatura passaria. */
const ordemPequena = (c: Curva, p: Ponto): boolean => ehNeutro(c, multiplicar(c, B(8), p));

/**
 * Lê a chave pública do build: base64 estrito de 32 bytes que seja um ponto válido da curva e de ordem não pequena. null se não servir.
 * (O build com chave inválida não conecta: falha fechada.)
 */
export function lerChavePublica(base64: string | null | undefined): Uint8Array | null {
  try {
    const bytes = decodificarBase64(String(base64 ?? '').trim(), 32);
    if (!bytes) return null;
    const c = curva();
    const a = decodificar(c, bytes);
    if (!a || ordemPequena(c, a)) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Confere uma assinatura Ed25519 (RFC 8032 §5.1.7, equação sem cofator). Nunca lança: qualquer entrada ruim é `false`. */
export function verificarEd25519(assinatura: Uint8Array, mensagem: Uint8Array, publica: Uint8Array): boolean {
  try {
    if (!(assinatura instanceof Uint8Array) || !(mensagem instanceof Uint8Array) || !(publica instanceof Uint8Array)) return false;
    if (assinatura.length !== 64 || publica.length !== 32) return false;
    const c = curva();
    const { L, G } = c;
    const A = decodificar(c, publica);
    const R = decodificar(c, assinatura.subarray(0, 32));
    if (!A || !R || ordemPequena(c, A)) return false;
    const S = lerLE(assinatura.subarray(32, 64));
    if (S >= L) return false;
    const entrada = new Uint8Array(32 + 32 + mensagem.length);
    entrada.set(assinatura.subarray(0, 32), 0);
    entrada.set(publica, 32);
    entrada.set(mensagem, 64);
    const k = lerLE(sha512(entrada)) % L;
    return iguais(c, multiplicar(c, S, G), somar(c, R, multiplicar(c, k, A)));
  } catch {
    return false;
  }
}

// ───────────────────────── Nonce aleatório seguro ─────────────────────────

/** O que `nonceAleatorio` precisa de uma fonte de números aleatórios: a Web Crypto (`globalThis.crypto`) ou o `expo-crypto`. */
export interface FonteAleatoria { getRandomValues(array: Uint8Array): unknown }

/** Não há fonte de números aleatórios seguros neste ambiente: a prova de identidade não pode ser feita (e o app não conecta). */
export class SemAleatorioSeguro extends Error {
  constructor() {
    super('Sem fonte de números aleatórios seguros neste app.');
    this.name = 'SemAleatorioSeguro';
  }
}

/**
 * Um nonce NOVO a cada chamada: 32 bytes aleatórios em hexadecimal (64 caracteres). Só usa fonte CRIPTOGRÁFICA (`getRandomValues`); NUNCA `Math.random`.
 * No Expo SDK 57 / Hermes (RN 0.86) o `globalThis.crypto` NÃO existe por padrão: para o app nativo é preciso uma fonte (ex.: `expo-crypto`, `getRandomValues`) passada
 * em `gerarNonce`. Sem fonte, lança SemAleatorioSeguro (a prova falha fechada).
 */
export function nonceAleatorio(fonte: FonteAleatoria | null | undefined = (globalThis as { crypto?: FonteAleatoria }).crypto): string {
  if (!fonte || typeof fonte.getRandomValues !== 'function') throw new SemAleatorioSeguro();
  const bytes = new Uint8Array(32);
  fonte.getRandomValues(bytes);
  return paraHex(bytes);
}

// ───────────────────────── O pedido ao servidor ─────────────────────────

export type ResultadoDaIdentidade = 'ok' | 'recusada' | 'sem-aleatorio';

export interface OpcoesDaIdentidade {
  /** A chave pública do servidor (32 bytes, já validada por `lerChavePublica`). */
  chavePublica: Uint8Array;
  fetchImpl?: typeof fetch;
  prazoMs: number;
  /** O relógio (setTimeout). Só os testes trocam. */
  agendar?: typeof setTimeout;
  /** Gera o nonce (padrão: `nonceAleatorio`). Um NOVO por chamada. */
  gerarNonce?: () => string;
}

const NONCE_VALIDO = /^[0-9a-f]{32,64}$/;

/**
 * `GET <endereço>/v1/identidade?nonce=<novo>`: sem NENHUM cabeçalho de login. 'ok' só com HTTP 2xx, `{ ok: true, assinatura }` e uma assinatura Ed25519 VÁLIDA, desta chave
 * pública, do texto `yui-identidade-v1|<este nonce>`. Qualquer outra coisa (404, atraso, JSON estranho, base64 malformado, tamanho errado, assinatura de outro nonce ou de outra
 * chave, um bit trocado) é 'recusada'. Sem fonte de números aleatórios seguros: 'sem-aleatorio' (e nenhuma rede é usada). Nunca lança.
 */
export async function verificarIdentidade(url: string, opcoes: OpcoesDaIdentidade): Promise<ResultadoDaIdentidade> {
  let nonce: string;
  try {
    nonce = (opcoes.gerarNonce ?? (() => nonceAleatorio()))();
  } catch {
    return 'sem-aleatorio';
  }
  if (typeof nonce !== 'string' || !NONCE_VALIDO.test(nonce)) return 'sem-aleatorio'; // um nonce que o servidor recusaria: a fonte está quebrada

  const doFetch: typeof fetch = opcoes.fetchImpl ?? ((...args) => fetch(...args));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<ResultadoDaIdentidade>((resolve) => {
    timer = (opcoes.agendar ?? setTimeout)(() => { controller.abort(); resolve('recusada'); }, opcoes.prazoMs);
  });
  const consulta = (async (): Promise<ResultadoDaIdentidade> => {
    try {
      const res = await doFetch(`${url}/v1/identidade?nonce=${nonce}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* sem corpo para soltar */ }
        return 'recusada';
      }
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object') return 'recusada';
      const { ok, assinatura: texto } = data as { ok?: unknown; assinatura?: unknown };
      if (ok !== true) return 'recusada';
      const assinatura = decodificarBase64(texto, 64);
      if (!assinatura) return 'recusada';
      return verificarEd25519(assinatura, utf8Bytes(PREFIXO_IDENTIDADE + nonce), opcoes.chavePublica) ? 'ok' : 'recusada';
    } catch {
      return 'recusada';
    }
  })();
  try {
    return await Promise.race([consulta, prazo]);
  } finally {
    clearTimeout(timer);
  }
}
