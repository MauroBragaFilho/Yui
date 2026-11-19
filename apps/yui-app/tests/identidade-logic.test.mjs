// Testes das peças puras da PROVA DE IDENTIDADE do servidor (src/identidade.ts): SHA-512, a verificação Ed25519 do RFC 8032, base64 estrito, UTF-8, o nonce
// aleatório seguro e a leitura da chave pública do build. Sem React, sem Expo e sem rede. Execução: npm test (dentro de apps/yui-app)
//
// Os vetores do RFC 8032 (seção 7.1) estão em tests/vetores-rfc8032.json (dado público; cada um conferido contra o node:crypto). Além deles, a verificação do app é
// conferida contra assinaturas geradas pelo node:crypto (OpenSSL) com chaves aleatórias.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as I from '../src/identidade.ts';

const vetores = JSON.parse(fs.readFileSync(new URL('./vetores-rfc8032.json', import.meta.url), 'utf8')).ed25519;
const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const bytes = (s) => new TextEncoder().encode(s);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const novoPar = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publica: Uint8Array.from(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')) };
};
const assinar = (par, mensagem) => Uint8Array.from(crypto.sign(null, Buffer.from(mensagem), par.privateKey));
const trocarBit = (u8, bit) => { const c = Uint8Array.from(u8); c[bit >> 3] ^= 1 << (bit & 7); return c; };

// ───────────────────────── SHA-512 (FIPS 180-4) ─────────────────────────

test('SHA-512: os vetores públicos do FIPS 180-4 ("abc", vazio, 448 bits e 896 bits)', () => {
  const sha = (texto) => Buffer.from(I.sha512(bytes(texto))).toString('hex');
  assert.equal(sha('abc'), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  assert.equal(sha(''), 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e');
  assert.equal(sha('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '204a8fc6dda82f0a0ced7beb8e08a41657c16ef468b228a8279be331a703c33596fd15c13b1b07f9aa1d3bea57789ca031ad85c7a71dd70354ec631238ca3445');
  assert.equal(sha('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'), '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909');
});

test('SHA-512: igual ao node:crypto nas bordas do preenchimento (0, 1, 55, 56, 111, 112, 113, 127, 128, 129, 239, 240, 256 e 1000 bytes)', () => {
  for (const n of [0, 1, 55, 56, 111, 112, 113, 127, 128, 129, 239, 240, 256, 1000]) {
    const m = crypto.randomBytes(n);
    assert.equal(Buffer.from(I.sha512(Uint8Array.from(m))).toString('hex'), crypto.createHash('sha512').update(m).digest('hex'), `${n} bytes`);
  }
});

// ───────────────────────── Ed25519 (RFC 8032 §7.1) ─────────────────────────

test('Ed25519: os 5 vetores do RFC 8032 §7.1 (TEST 1, TEST 2, TEST 3, TEST 1024 e TEST SHA(abc)) verificam', () => {
  assert.equal(vetores.length, 5);
  assert.deepEqual(vetores.map((v) => v.nome), ['TEST 1', 'TEST 2', 'TEST 3', 'TEST 1024', 'TEST SHA(abc)']);
  assert.equal(vetores[3].mensagem.length / 2, 1023, 'o TEST 1024 tem uma mensagem de 1023 bytes');
  for (const v of vetores) {
    assert.equal(I.verificarEd25519(hex(v.assinatura), hex(v.mensagem), hex(v.publica)), true, v.nome);
    assert.ok(I.lerChavePublica(b64(hex(v.publica))), `${v.nome}: a chave pública é aceita pelo app`);
  }
});

test('Ed25519: um bit trocado na assinatura, na mensagem ou na chave pública derruba a verificação (RFC 8032: 64 posições da assinatura, 16 da mensagem e 16 da chave)', () => {
  for (const v of vetores.slice(0, 3)) {
    const sig = hex(v.assinatura);
    const msg = hex(v.mensagem);
    const pub = hex(v.publica);
    for (let bit = 0; bit < 512; bit += 8) assert.equal(I.verificarEd25519(trocarBit(sig, bit + (bit % 5)), msg, pub), false, `${v.nome}: bit ${bit + (bit % 5)} da assinatura`);
    for (let bit = 0; bit < 256; bit += 16) assert.equal(I.verificarEd25519(sig, msg, trocarBit(pub, bit)), false, `${v.nome}: bit ${bit} da chave`);
    for (let bit = 0; bit < msg.length * 8 && bit < 16; bit += 1) assert.equal(I.verificarEd25519(sig, trocarBit(msg, bit), pub), false, `${v.nome}: bit ${bit} da mensagem`);
    assert.equal(I.verificarEd25519(sig, Uint8Array.from([...msg, 0]), pub), false, `${v.nome}: mensagem com um byte a mais`);
  }
  // a assinatura de um vetor não vale para a mensagem nem para a chave de outro
  assert.equal(I.verificarEd25519(hex(vetores[1].assinatura), hex(vetores[2].mensagem), hex(vetores[1].publica)), false);
  assert.equal(I.verificarEd25519(hex(vetores[1].assinatura), hex(vetores[1].mensagem), hex(vetores[2].publica)), false);
});

test('Ed25519: confere contra assinaturas do node:crypto (OpenSSL) com chaves e mensagens aleatórias, inclusive o texto da identidade', () => {
  for (let i = 0; i < 12; i += 1) {
    const par = novoPar();
    const nonce = crypto.randomBytes(32).toString('hex');
    for (const mensagem of [bytes(`${I.PREFIXO_IDENTIDADE}${nonce}`), crypto.randomBytes(1 + i * 37)]) {
      const sig = assinar(par, mensagem);
      assert.equal(I.verificarEd25519(sig, Uint8Array.from(mensagem), par.publica), true);
      assert.equal(I.verificarEd25519(trocarBit(sig, (i * 41) % 512), Uint8Array.from(mensagem), par.publica), false);
      assert.equal(I.verificarEd25519(sig, trocarBit(Uint8Array.from(mensagem), 0), par.publica), false);
      assert.equal(I.verificarEd25519(sig, Uint8Array.from(mensagem), novoPar().publica), false, 'a chave pública errada recusa');
    }
  }
});

test('Ed25519: tamanhos errados, S >= L (assinatura maleável), R não canônico e entradas que não são bytes são recusados, e nada lança', () => {
  const v = vetores[1];
  const sig = hex(v.assinatura);
  const msg = hex(v.mensagem);
  const pub = hex(v.publica);
  assert.equal(I.verificarEd25519(sig.subarray(0, 63), msg, pub), false);
  assert.equal(I.verificarEd25519(Uint8Array.from([...sig, 0]), msg, pub), false);
  assert.equal(I.verificarEd25519(sig, msg, pub.subarray(0, 31)), false);
  assert.equal(I.verificarEd25519(sig, msg, Uint8Array.from([...pub, 0])), false);
  assert.equal(I.verificarEd25519(null, msg, pub), false);
  assert.equal(I.verificarEd25519(sig, 'texto', pub), false);
  assert.equal(I.verificarEd25519(sig, msg, undefined), false);
  // S + L também satisfaz a equação, mas o RFC manda recusar (S precisa ser menor que L)
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let S = 0n;
  for (let i = 31; i >= 0; i -= 1) S = (S << 8n) | BigInt(sig[32 + i]);
  const maleavel = Uint8Array.from(sig);
  const novo = S + L;
  for (let i = 0; i < 32; i += 1) maleavel[32 + i] = Number((novo >> BigInt(8 * i)) & 255n);
  assert.equal(I.verificarEd25519(maleavel, msg, pub), false, 'S + L recusado');
  // R com y >= p (codificação não canônica)
  const p = (1n << 255n) - 19n;
  const rRuim = Uint8Array.from(sig);
  for (let i = 0; i < 32; i += 1) rRuim[i] = Number(((p + 1n) >> BigInt(8 * i)) & 255n);
  assert.equal(I.verificarEd25519(rRuim, msg, pub), false, 'R não canônico recusado');
});

test('chave pública de ordem pequena (o ponto neutro, o de ordem 2 e os de ordem 4) é recusada: com ela qualquer assinatura passaria', () => {
  const p = (1n << 255n) - 19n;
  const le = (n) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i += 1) b[i] = Number((n >> BigInt(8 * i)) & 255n); return b; };
  const pequenas = [le(1n), le(p - 1n), le(0n), Uint8Array.from(le(0n).map((x, i) => (i === 31 ? 0x80 : x)))];
  for (const k of pequenas) {
    assert.equal(I.lerChavePublica(b64(k)), null, `lerChavePublica recusa ${Buffer.from(k).toString('hex').slice(0, 8)}…`);
    const qualquer = Uint8Array.from(crypto.randomBytes(64));
    assert.equal(I.verificarEd25519(qualquer, bytes('x'), k), false, 'e a verificação com ela também recusa');
  }
});

// ───────────────────────── a chave pública do build ─────────────────────────

test('lerChavePublica: aceita só base64 estrito de 32 bytes que seja um ponto da curva; o resto é recusado (e a chave PRIVADA colada por engano não passa)', () => {
  const par = novoPar();
  assert.deepEqual(I.lerChavePublica(b64(par.publica)), par.publica);
  assert.deepEqual(I.lerChavePublica(`  ${b64(par.publica)}\n`), par.publica, 'espaço em volta (comum no .env) é ignorado');
  for (const ruim of [
    null, undefined, '', '   ', 'isso nao e base64!', b64(par.publica).slice(0, -1), b64(par.publica).replace(/=+$/, ''), b64(Uint8Array.from([...par.publica, 1])), b64(par.publica.subarray(0, 31)),
    b64(par.publica).replace(/\+/g, '-').replace(/\//g, '_') + '!', `${b64(par.publica)}${b64(par.publica)}`,
    crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), // o arquivo da chave privada
    b64(crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' })), // a chave privada em base64 (48 bytes)
  ]) {
    assert.equal(I.lerChavePublica(ruim), null, `deveria recusar: ${String(ruim).slice(0, 40)}`);
  }
  // metade dos 32 bytes aleatórios não é um ponto da curva: a leitura recusa essas
  let recusadas = 0;
  for (let i = 0; i < 40; i += 1) if (I.lerChavePublica(b64(Uint8Array.from(crypto.randomBytes(32)))) === null) recusadas += 1;
  assert.ok(recusadas >= 5 && recusadas <= 35, `bytes aleatórios que não são ponto são recusados (${recusadas}/40)`);
});

// ───────────────────────── base64 estrito, hex e UTF-8 ─────────────────────────

test('base64 estrito: ida e volta com qualquer tamanho; o malformado vira null', () => {
  for (let n = 0; n <= 70; n += 1) {
    const m = Uint8Array.from(crypto.randomBytes(n));
    const texto = I.codificarBase64(m);
    assert.equal(texto, Buffer.from(m).toString('base64'));
    if (n > 0) assert.deepEqual(I.decodificarBase64(texto), m);
  }
  assert.deepEqual(I.decodificarBase64('QQ=='), Uint8Array.from([0x41]));
  for (const ruim of ['', 'QQ', 'QQ=', 'QQ===', 'Q=Q=', '=QQQ', 'QQ==QQ==', 'Q Q=', 'QQ==\n', 'QR==' /* bits de sobra */, 'QUJ=' /* bits de sobra */, 'AB-_', 'ÃÃÃÃ', null, undefined, 42, {}]) {
    assert.equal(I.decodificarBase64(ruim), null, `deveria recusar: ${JSON.stringify(ruim)}`);
  }
  assert.equal(I.decodificarBase64('QUJD', 4), null, 'o tamanho esperado é conferido');
  assert.deepEqual(I.decodificarBase64('QUJD', 3), Uint8Array.from([0x41, 0x42, 0x43]));
});

test('hex e UTF-8: iguais ao Buffer e ao TextEncoder (inclusive acentos, emoji e surrogate solto)', () => {
  const m = Uint8Array.from(crypto.randomBytes(40));
  assert.equal(I.paraHex(m), Buffer.from(m).toString('hex'));
  assert.equal(I.paraHex(Uint8Array.from([0, 1, 15, 16, 255])), '00010f10ff');
  for (const t of ['', 'abc', 'yui-identidade-v1|0123abcd', 'ação ç ñ ü', '日本語', '😀 e 🎉', 'solto \ud800 no meio', 'solto \udc00', 'fim \ud83d']) {
    assert.deepEqual(I.utf8Bytes(t), new TextEncoder().encode(t), JSON.stringify(t));
  }
});

// ───────────────────────── nonce aleatório seguro ─────────────────────────

test('nonceAleatorio: 64 caracteres hexadecimais (32 bytes), NOVO a cada chamada e nunca repetido', () => {
  const vistos = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const n = I.nonceAleatorio();
    assert.match(n, /^[0-9a-f]{64}$/);
    vistos.add(n);
  }
  assert.equal(vistos.size, 2000, 'nenhum nonce se repetiu');
});

test('nonceAleatorio: usa SÓ getRandomValues (nunca Math.random) e, sem fonte segura, lança em vez de inventar um número', () => {
  const chamadas = [];
  const fonte = { getRandomValues(a) { chamadas.push(a); for (let i = 0; i < a.length; i += 1) a[i] = i; return a; } };
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random NÃO pode ser usado para o nonce'); };
  try {
    assert.equal(I.nonceAleatorio(fonte), Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex'));
    assert.equal(chamadas.length, 1);
    assert.ok(chamadas[0] instanceof Uint8Array && chamadas[0].length === 32);
    for (const semFonte of [null, undefined, {}, { getRandomValues: 'não é função' }]) {
      // `undefined` usa o padrão (globalThis.crypto do Node, que existe): só os outros três testam a ausência
      if (semFonte === undefined) continue;
      assert.throws(() => I.nonceAleatorio(semFonte), (e) => e instanceof I.SemAleatorioSeguro && e.name === 'SemAleatorioSeguro');
    }
  } finally {
    Math.random = original;
  }
});

test('nonceAleatorio: sem o globalThis.crypto (como no Hermes do Expo SDK 57) o padrão também lança', () => {
  const guardado = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.throws(() => I.nonceAleatorio(), I.SemAleatorioSeguro);
  } finally {
    if (guardado) Object.defineProperty(globalThis, 'crypto', guardado); else delete globalThis.crypto;
  }
  assert.match(I.nonceAleatorio(), /^[0-9a-f]{64}$/, 'e volta a funcionar com a fonte');
});
