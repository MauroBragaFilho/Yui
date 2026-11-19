// Testes da PROVA DE IDENTIDADE do servidor no app: o app só envia senha, token ou qualquer pedido autenticado a um endereço que provar, com uma assinatura Ed25519 sobre um
// desafio novo, ser o servidor da Yui (a chave PRIVADA só existe nele). Servidores FALSOS em 127.0.0.1 abertos pelo próprio teste: um legítimo (assina com o par gerado aqui) e
// IMPOSTORES que respondem /v1/health perfeitamente mas não têm a chave. Sem serviço real. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ApiError, createClient } from '../src/api/client.ts';
import * as S from '../src/servidores.ts';
import * as I from '../src/identidade.ts';

const TOKEN = 'token-do-teste-0123456789';
const SENHA = 'senha-secreta-do-teste-9876';
const semHost = (url) => url.replace(/^https?:\/\//, '');
const b64 = (u8) => Buffer.from(u8).toString('base64');

// ───────────────────────── as chaves do teste (geradas aqui, só para esta execução) ─────────────────────────
const gerarPar = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publica: Uint8Array.from(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')) };
};
const LEGIT = gerarPar();
const OUTRO = gerarPar(); // a chave de um impostor que tem uma chave PRÓPRIA
const CHAVE = I.lerChavePublica(b64(LEGIT.publica)); // o que o build do app leva: SÓ a chave pública
assert.ok(CHAVE);
const assinarTexto = (par, texto) => crypto.sign(null, Buffer.from(texto), par.privateKey);
// O texto assinado é escrito AQUI, por extenso (e não lido do módulo do app), para o teste não seguir uma mudança do prefixo por engano: o servidor e o app combinam este texto.
const PREFIXO = 'yui-identidade-v1|';
const assinaturaDo = (par, nonce) => assinarTexto(par, PREFIXO + nonce).toString('base64');
const ANTIGO = crypto.randomBytes(32).toString('hex'); // um desafio de uma sessão antiga: o impostor guardou a resposta LEGÍTIMA dele
const trocarUmCaractere = (n) => `${n[0] === 'a' ? 'b' : 'a'}${n.slice(1)}`;

const ok = (assinatura) => ({ status: 200, body: { ok: true, assinatura } });
/** Como cada servidor falso responde ao /v1/identidade (função do nonce recebido). 'pendurar' = aceita e nunca responde. */
const MODOS = {
  legitimo: (n) => ok(assinaturaDo(LEGIT, n)),
  'outra-chave': (n) => ok(assinaturaDo(OUTRO, n)),
  'sem-assinatura': () => ({ status: 200, body: { ok: true } }),
  repetida: () => ok(assinaturaDo(LEGIT, ANTIGO)),
  adulterada: (n) => { const s = assinarTexto(LEGIT, PREFIXO + n); s[10] ^= 1; return ok(s.toString('base64')); },
  'nonce-adulterado': (n) => ok(assinaturaDo(LEGIT, trocarUmCaractere(n))),
  'sem-prefixo': (n) => ok(assinarTexto(LEGIT, n).toString('base64')),
  404: () => ({ status: 404, body: { error: 'rota não encontrada' } }),
  'erro-500-com-assinatura-certa': (n) => ({ status: 500, body: { ok: true, assinatura: assinaturaDo(LEGIT, n) } }),
  'sem-ok': (n) => ({ status: 200, body: { assinatura: assinaturaDo(LEGIT, n) } }),
  'ok-falso': (n) => ({ status: 200, body: { ok: false, assinatura: assinaturaDo(LEGIT, n) } }),
  'base64-ruim': () => ok('isto não é base64!'),
  'tamanho-errado': () => ok(b64(crypto.randomBytes(32))),
  html: () => ({ status: 200, html: '<html>portal cativo</html>' }),
  lento: 'pendurar',
};
const MODOS_IMPOSTOR = Object.keys(MODOS).filter((m) => m !== 'legitimo');

// ───────────────────────── servidores falsos ─────────────────────────
const abertos = [];
test.after(async () => { for (const s of abertos) await s.parar(); });

/** Um servidor falso da Yui em 127.0.0.1. `modo` (mutável: `servidor.modo = '...'`) decide a resposta do /v1/identidade; o /v1/health é sempre perfeito. */
async function abrirServidor(nome, { modo = 'legitimo', log, meStatus = 200 } = {}) {
  const sockets = new Set();
  const obj = { nome, modo, url: '' };
  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const entrada = { servidor: nome, metodo: req.method, caminho: u.pathname, consulta: u.search, nonce: u.searchParams.get('nonce'), auth: req.headers.authorization ?? null, corpo: Buffer.concat(partes).toString('utf8'), cabecalhos: req.headers, assinou: false };
      log.push(entrada);
      const json = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/v1/health') return json(200, { ok: true, memory: true, readOnly: true, backends: [] });
      if (u.pathname === '/v1/identidade') {
        const resposta = MODOS[obj.modo];
        if (resposta === 'pendurar') return; // o app desiste no prazo
        const r = resposta(entrada.nonce ?? '');
        entrada.assinou = obj.modo === 'legitimo';
        if (r.html) { res.writeHead(r.status, { 'Content-Type': 'text/html' }); return res.end(r.html); }
        return json(r.status, r.body);
      }
      if (u.pathname === '/v1/auth/status') return json(200, { passwordLogin: true, discordKey: false });
      if (u.pathname === '/v1/auth/login' && req.method === 'POST') {
        const b = JSON.parse(entrada.corpo || '{}');
        return b.password === SENHA ? json(200, { token: TOKEN, expiresAt: Date.now() + 3600_000, userId: '111' }) : json(401, { error: 'Usuário ou senha inválidos.' });
      }
      if (u.pathname === '/v1/me') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'não autorizado' });
        if (meStatus !== 200) return json(meStatus, { error: 'erro do servidor' });
        return json(200, { userId: '111', role: 'OWNER', memoryScope: 'personal' });
      }
      if (u.pathname === '/v1/agent') return json(200, { type: 'reply', reply: 'oi' });
      return json(404, { error: 'não achei' });
    });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  obj.url = `http://127.0.0.1:${srv.address().port}`;
  obj.parar = async () => {
    if (!srv.listening) return;
    srv.closeAllConnections?.();
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => srv.close(resolve));
  };
  abertos.push(obj);
  return obj;
}

function armazemEmMemoria(inicial = null) {
  return { valor: inicial, salvos: [], async carregar() { return this.valor; }, async salvar(url) { this.valor = url; this.salvos.push(url); } };
}

/** O que um impostor pode ter recebido: SÓ GET /v1/health e GET /v1/identidade?nonce=..., sem Authorization, sem Cookie e sem corpo. */
function conferirQueNadaVazou(log, nome) {
  const dele = log.filter((e) => e.servidor === nome);
  for (const e of dele) {
    assert.ok(e.caminho === '/v1/health' || e.caminho === '/v1/identidade', `${nome} recebeu um pedido a ${e.caminho}`);
    assert.equal(e.metodo, 'GET', `${nome}: ${e.caminho} não foi GET`);
    assert.equal(e.auth, null, `${nome} recebeu um Authorization`);
    assert.equal(e.cabecalhos.cookie, undefined, `${nome} recebeu um cookie`);
    assert.equal(e.corpo, '', `${nome} recebeu um corpo de pedido`);
  }
  assert.equal(JSON.stringify(dele).includes(SENHA), false, `${nome} recebeu a senha`);
  assert.equal(JSON.stringify(dele).includes(TOKEN), false, `${nome} recebeu o token`);
}

/** Todo pedido com token (ou corpo) a um servidor vem DEPOIS de uma prova de identidade assinada por ele, e a prova vem depois da sonda de saúde. */
function conferirTokenSoDepoisDaProva(log) {
  const sondados = new Set();
  const provados = new Set();
  for (const e of log) {
    if (e.caminho === '/v1/health') { assert.equal(e.auth, null); sondados.add(e.servidor); }
    else if (e.caminho === '/v1/identidade') {
      assert.equal(e.auth, null, 'a prova não pode levar token');
      assert.ok(sondados.has(e.servidor), `a prova de ${e.servidor} veio antes da sonda de saúde`);
      if (e.assinou) provados.add(e.servidor);
    } else if (e.auth || e.corpo) assert.ok(provados.has(e.servidor), `credencial enviada a ${e.servidor} antes da prova de identidade`);
  }
}

const manager = (enderecos, extra = {}) => S.criarGerenciadorDeServidor({ enderecos, identidade: { chavePublica: CHAVE }, prazoPrimeiroMs: 2000, prazoDemaisMs: 2000, ...extra });
const caminhos = (log, nome) => log.filter((e) => !nome || e.servidor === nome).map((e) => `${e.caminho}${e.auth ? '+token' : ''}`);

// ───────────────────────── o servidor legítimo ─────────────────────────

test('o texto assinado é o combinado com o servidor: yui-identidade-v1| + o nonce', () => {
  assert.equal(I.PREFIXO_IDENTIDADE, 'yui-identidade-v1|');
});

test('servidor legítimo (com a chave privada) é aceito: sonda de saúde, depois a prova, e só então o token', { timeout: 20000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const g = manager([a.url]);
  const c = createClient({ servidor: g, token: TOKEN });
  assert.equal((await c.me()).role, 'OWNER');
  assert.deepEqual(caminhos(log), ['/v1/health', '/v1/identidade', '/v1/me+token']);
  const prova = log[1];
  assert.equal(prova.metodo, 'GET');
  assert.match(prova.nonce, /^[0-9a-f]{64}$/, 'o desafio é um nonce hexadecimal de 64 caracteres');
  assert.equal(prova.consulta, `?nonce=${prova.nonce}`, 'só o nonce vai na consulta');
  assert.deepEqual(Object.keys(prova.cabecalhos).filter((k) => /authorization|cookie/i.test(k)), [], 'a prova não leva credencial nenhuma');
  conferirTokenSoDepoisDaProva(log);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(a.url)} (confirmado)`);
  assert.equal(g.escolha().confirmado, true);
  // o login com senha também só vai depois da prova
  const c2 = createClient({ servidor: g, token: '' });
  assert.equal((await c2.login('braga', SENHA)).token, TOKEN);
  conferirTokenSoDepoisDaProva(log);
});

test('pedidos SIMULTÂNEOS esperam a prova em andamento: nenhum leva senha ou token a um endereço que ainda não provou nada', { timeout: 30000 }, async () => {
  const log = [];
  const imp = await abrirServidor('I', { modo: 'lento', log }); // não responde à prova: a verificação demora até o prazo
  const g = manager([imp.url], { prazoPrimeiroMs: 300 });
  const c = createClient({ servidor: g, token: TOKEN });
  const primeiro = c.me();
  await new Promise((resolve) => { const espera = () => (log.some((e) => e.caminho === '/v1/identidade') ? resolve() : setTimeout(espera, 5)); espera(); }); // a prova já está em andamento
  const segundo = c.send('oi');
  const terceiro = createClient({ servidor: g, token: '' }).login('braga', SENHA);
  const recusado = (e) => e instanceof ApiError && e.message === S.MSG_IDENTIDADE_NAO_CONFIRMADA;
  await assert.rejects(primeiro, recusado);
  await assert.rejects(segundo, recusado);
  await assert.rejects(terceiro, recusado);
  conferirQueNadaVazou(log, 'I');
});

test('os dois endereços legítimos: o preferido é o escolhido e o reserva nem é consultado', { timeout: 20000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  const g = manager([a.url, b.url]);
  const e = await g.escolher();
  assert.deepEqual([e.url, e.indice, e.confirmado], [a.url, 0, true]);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(a.url)} (rede local, confirmado)`);
  assert.equal(log.filter((x) => x.servidor === 'B').length, 0);
});

// ───────────────────────── o impostor ─────────────────────────

for (const modo of MODOS_IMPOSTOR) {
  test(`IMPOSTOR "${modo}": responde /v1/health perfeitamente mas não prova ser a Yui: é rejeitado e não recebe senha, token nem pedido nenhum além da sonda e da prova`, { timeout: 30000 }, async () => {
    const log = [];
    const imp = await abrirServidor('I', { modo, log });
    const g = manager([imp.url], { prazoPrimeiroMs: modo === 'lento' ? 250 : 2000 });
    const c = createClient({ servidor: g, token: TOKEN });
    const recusado = (e) => e instanceof ApiError && e.status === 0 && e.message === S.MSG_IDENTIDADE_NAO_CONFIRMADA;
    await assert.rejects(c.me(), recusado);
    await assert.rejects(createClient({ servidor: g, token: '' }).login('braga', SENHA), recusado);
    await assert.rejects(createClient({ servidor: g, token: '' }).authStatus(), recusado);
    await assert.rejects(c.send('oi'), recusado);
    assert.equal(g.escolha(), null);
    assert.equal(g.naoConfirmado(), true);
    assert.equal(S.textoDoServidor(g.escolha(), false, g.naoConfirmado()), 'Servidor: não confirmado');
    assert.ok(log.some((e) => e.caminho === '/v1/identidade'), 'a prova foi pedida');
    conferirQueNadaVazou(log, 'I');
  });
}

test('impostor primeiro e legítimo depois: o app escolhe o legítimo, e o impostor só vê a sonda e a prova (nada autenticado)', { timeout: 30000 }, async () => {
  for (const modo of MODOS_IMPOSTOR) {
    const log = [];
    const imp = await abrirServidor('I', { modo, log });
    const leg = await abrirServidor('L', { log });
    const g = manager([imp.url, leg.url], { prazoPrimeiroMs: modo === 'lento' ? 250 : 2000 });
    const c = createClient({ servidor: g, token: TOKEN });
    assert.equal((await c.me()).role, 'OWNER', modo);
    assert.deepEqual([g.escolha().url, g.escolha().indice], [leg.url, 1], modo);
    assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(leg.url)} (reserva, confirmado)`);
    assert.equal((await createClient({ servidor: g, token: '' }).login('braga', SENHA)).token, TOKEN);
    conferirQueNadaVazou(log, 'I');
    conferirTokenSoDepoisDaProva(log);
    assert.deepEqual(caminhos(log, 'L').slice(0, 3), ['/v1/health', '/v1/identidade', '/v1/me+token'], modo);
    await imp.parar();
    await leg.parar();
  }
});

test('legítimo primeiro e impostor depois: o impostor nem é consultado', { timeout: 20000 }, async () => {
  const log = [];
  const leg = await abrirServidor('L', { log });
  const imp = await abrirServidor('I', { modo: 'outra-chave', log });
  const g = manager([leg.url, imp.url]);
  await createClient({ servidor: g, token: TOKEN }).me();
  assert.equal(log.filter((x) => x.servidor === 'I').length, 0);
});

test('todos os endereços são impostores: erro "Não consegui confirmar que este servidor é a sua Yui." e NADA é enviado a nenhum', { timeout: 30000 }, async () => {
  const log = [];
  const i1 = await abrirServidor('I1', { modo: 'outra-chave', log });
  const i2 = await abrirServidor('I2', { modo: 'sem-assinatura', log });
  const g = manager([i1.url, i2.url]);
  assert.equal(S.MSG_IDENTIDADE_NAO_CONFIRMADA, 'Não consegui confirmar que este servidor é a sua Yui.');
  const c = createClient({ servidor: g, token: TOKEN });
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 0 && e.message === 'Não consegui confirmar que este servidor é a sua Yui.');
  await assert.rejects(createClient({ servidor: g, token: '' }).login('braga', SENHA), (e) => e instanceof ApiError && e.message === S.MSG_IDENTIDADE_NAO_CONFIRMADA);
  assert.equal(await g.escolher(), null);
  conferirQueNadaVazou(log, 'I1');
  conferirQueNadaVazou(log, 'I2');
  assert.equal(log.some((e) => e.caminho !== '/v1/health' && e.caminho !== '/v1/identidade'), false);
});

test('um endereço não responde e o outro é impostor: a mensagem fala de identidade (e não "ninguém respondeu"); sem resposta nenhuma, a de sempre', { timeout: 30000 }, async () => {
  const log = [];
  const morto = await abrirServidor('M', { log });
  await morto.parar();
  const imp = await abrirServidor('I', { modo: 'sem-assinatura', log });
  const g = manager([morto.url, imp.url]);
  await assert.rejects(createClient({ servidor: g, token: TOKEN }).me(), (e) => e.message === S.MSG_IDENTIDADE_NAO_CONFIRMADA);
  const g2 = manager([morto.url]);
  await assert.rejects(createClient({ servidor: g2, token: TOKEN }).me(), (e) => e.message === S.MSG_NENHUM_RESPONDEU);
  assert.equal(S.textoDoServidor(g2.escolha(), false, g2.naoConfirmado()), 'Servidor: sem resposta');
  conferirQueNadaVazou(log, 'I');
});

test('o endereço "lembrado" também precisa provar a identidade: um lembrado que virou impostor é rejeitado e o legítimo é escolhido', { timeout: 20000 }, async () => {
  const log = [];
  const leg = await abrirServidor('L', { log });
  const imp = await abrirServidor('I', { modo: 'repetida', log });
  const armazem = armazemEmMemoria(imp.url); // da última vez, o app usou este endereço (que então era a Yui)
  const g = manager([leg.url, imp.url], { lembrado: armazem });
  const c = createClient({ servidor: g, token: TOKEN });
  assert.equal((await c.me()).role, 'OWNER');
  assert.equal(g.escolha().url, leg.url);
  assert.deepEqual(caminhos(log).slice(0, 2), ['/v1/health', '/v1/identidade'], 'o lembrado foi sondado primeiro');
  assert.equal(log[0].servidor, 'I');
  conferirQueNadaVazou(log, 'I');
  assert.deepEqual(armazem.salvos, [leg.url]);
});

// ───────────────────────── o desafio: novo a cada vez, e a resposta de um não vale para o outro ─────────────────────────

test('o nonce é NOVO a cada verificação (abertura, validade vencida e queda) e nunca se repete', { timeout: 30000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  let agora = 1_000_000;
  const g = manager([a.url, b.url], { agora: () => agora });
  const c = createClient({ servidor: g, token: TOKEN });
  await c.me(); // abertura
  agora += S.VALIDADE_DA_PROVA_MS;
  await c.me(); // prova vencida
  await a.parar(); // queda: refaz a escolha no reserva
  await c.me();
  const nonces = log.filter((e) => e.caminho === '/v1/identidade').map((e) => e.nonce);
  assert.equal(nonces.length, 3);
  assert.equal(new Set(nonces).size, 3, 'três verificações, três nonces diferentes');
  for (const n of nonces) assert.match(n, /^[0-9a-f]{64}$/);
});

test('a resposta de um servidor para um nonce não vale para outro nonce: uma resposta ANTIGA repetida por um impostor é rejeitada', async () => {
  const ouvidos = [];
  const legitimoQueGrava = async (url) => {
    const nonce = new URL(url).searchParams.get('nonce');
    ouvidos.push(nonce);
    return new Response(JSON.stringify({ ok: true, assinatura: assinaturaDo(LEGIT, nonce) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const opcoes = (fetchImpl) => ({ chavePublica: CHAVE, fetchImpl, prazoMs: 1000 });
  assert.equal(await I.verificarIdentidade('http://x.invalid:3939', opcoes(legitimoQueGrava)), 'ok');
  // um impostor que gravou a resposta legítima da vez anterior e a repete para o desafio novo
  const gravada = JSON.stringify({ ok: true, assinatura: assinaturaDo(LEGIT, ouvidos[0]) });
  const repetidor = async () => new Response(gravada, { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal(await I.verificarIdentidade('http://y.invalid:3939', opcoes(repetidor)), 'recusada');
  assert.equal(await I.verificarIdentidade('http://y.invalid:3939', opcoes(repetidor)), 'recusada', 'também na terceira vez');
});

test('um nonce fixo seria derrotado pela repetição: o app usa um nonce novo e a repetição da resposta do mesmo nonce só vale para esse nonce', async () => {
  const fixo = 'ab'.repeat(32);
  const resposta = JSON.stringify({ ok: true, assinatura: assinaturaDo(LEGIT, fixo) });
  const f = async () => new Response(resposta, { status: 200, headers: { 'Content-Type': 'application/json' } });
  // com o nonce que a resposta gravada assinou, vale (é o que um app com nonce fixo aceitaria para sempre)...
  assert.equal(await I.verificarIdentidade('http://z.invalid:3939', { chavePublica: CHAVE, fetchImpl: f, prazoMs: 1000, gerarNonce: () => fixo }), 'ok');
  // ...e com o gerador de verdade (nonce novo) a mesma resposta é recusada
  assert.equal(await I.verificarIdentidade('http://z.invalid:3939', { chavePublica: CHAVE, fetchImpl: f, prazoMs: 1000 }), 'recusada');
});

test('verificarIdentidade: HTTP não 2xx, ok ausente ou falso, JSON estranho e prazo esgotado recusam; sem fonte de aleatório não toca na rede', { timeout: 20000 }, async () => {
  const chamadas = [];
  const com = (fn) => async (url, init) => { chamadas.push({ url, init }); return fn(new URL(url).searchParams.get('nonce')); };
  const resp = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
  const base = { chavePublica: CHAVE, prazoMs: 300 };
  assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: com((n) => resp(200, { ok: true, assinatura: assinaturaDo(LEGIT, n) })) }), 'ok');
  for (const [nome, fn] of Object.entries({
    '500 com assinatura certa': (n) => resp(500, { ok: true, assinatura: assinaturaDo(LEGIT, n) }),
    '404': () => resp(404, { error: 'x' }),
    'ok ausente': (n) => resp(200, { assinatura: assinaturaDo(LEGIT, n) }),
    'ok "true" (texto)': (n) => resp(200, { ok: 'true', assinatura: assinaturaDo(LEGIT, n) }),
    'assinatura número': () => resp(200, { ok: true, assinatura: 12345 }),
    'assinatura de outra chave': (n) => resp(200, { ok: true, assinatura: assinaturaDo(OUTRO, n) }),
    'JSON nulo': () => resp(200, 'null'),
    'texto que não é JSON': () => resp(200, 'não sou json'),
    'lista': () => resp(200, '[]'),
  })) {
    assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: com(fn) }), 'recusada', nome);
  }
  const quedaDeRede = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: quedaDeRede }), 'recusada', 'falha de rede');
  const penduraAteAbortar = (_u, init) => new Promise((_, rejeita) => init.signal.addEventListener('abort', () => rejeita(Object.assign(new Error('abortado'), { name: 'AbortError' }))));
  assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: penduraAteAbortar, prazoMs: 80 }), 'recusada', 'atrasada');
  const ignoraOAborto = () => new Promise(() => {}); // um fetch que nunca responde e nem olha o sinal de aborto: só o prazo do próprio app o salva
  assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: ignoraOAborto, prazoMs: 80 }), 'recusada', 'atrasada, mesmo com um fetch que ignora o aborto');
  const antes = chamadas.length;
  const naoUsada = com(() => resp(200, {}));
  assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: naoUsada, gerarNonce: () => { throw new I.SemAleatorioSeguro(); } }), 'sem-aleatorio');
  assert.equal(await I.verificarIdentidade('http://a.invalid', { ...base, fetchImpl: naoUsada, gerarNonce: () => 'curto' }), 'sem-aleatorio', 'nonce que o servidor recusaria');
  assert.equal(chamadas.length, antes, 'sem nonce, nenhuma rede');
  // o pedido da prova: GET, só Accept, sem corpo
  const { init, url } = chamadas[0];
  assert.equal(init.method, 'GET');
  assert.deepEqual(Object.keys(init.headers), ['Accept']);
  assert.equal(init.body, undefined);
  assert.match(url, /^http:\/\/a\.invalid\/v1\/identidade\?nonce=[0-9a-f]{64}$/);
});

// ───────────────────────── a validade da prova e a queda de rede ─────────────────────────

test('a prova VALE por um tempo e depois é conferida de novo: o mesmo IP numa outra rede (outra máquina) é pego antes do token', { timeout: 30000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  let agora = 5_000_000;
  const g = manager([a.url], { agora: () => agora });
  const c = createClient({ servidor: g, token: TOKEN });
  await c.me();
  agora += S.VALIDADE_DA_PROVA_MS - 1;
  await c.me();
  assert.equal(log.filter((e) => e.caminho === '/v1/identidade').length, 1, 'dentro da validade: sem prova nova');
  agora += 1;
  await c.me();
  assert.equal(log.filter((e) => e.caminho === '/v1/identidade').length, 2, 'vencida: prova nova antes do pedido');
  assert.deepEqual(caminhos(log).slice(-3), ['/v1/health', '/v1/identidade', '/v1/me+token']);
  // o celular trocou de rede sem nada cair: no mesmo endereço agora responde OUTRA máquina
  a.modo = 'outra-chave';
  agora += S.VALIDADE_DA_PROVA_MS;
  const antes = log.length;
  await assert.rejects(c.me(), (e) => e.message === S.MSG_IDENTIDADE_NAO_CONFIRMADA);
  assert.deepEqual(caminhos(log).slice(antes), ['/v1/health', '/v1/identidade'], 'o impostor só viu a sonda e a prova');
  assert.equal(g.escolha(), null);
  conferirTokenSoDepoisDaProva(log.slice(0, antes));
});

test('depois de uma queda de rede a identidade vale de novo, mesmo com um endereço só (o pedido não é repetido sozinho)', async () => {
  const chamadas = [];
  let derrubar = true;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    chamadas.push(`${u.pathname}${init.headers?.Authorization ? '+token' : ''}`);
    if (u.pathname === '/v1/health') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (u.pathname === '/v1/identidade') return new Response(JSON.stringify({ ok: true, assinatura: assinaturaDo(LEGIT, u.searchParams.get('nonce')) }), { status: 200 });
    if (derrubar) { derrubar = false; throw new TypeError('fetch failed'); }
    return new Response(JSON.stringify({ userId: '1', role: 'OWNER', memoryScope: 'personal' }), { status: 200 });
  };
  const g = manager(['http://rede-local.invalid:3939'], { fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl });
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 0);
  assert.deepEqual(chamadas, ['/v1/health', '/v1/identidade', '/v1/me+token']);
  assert.equal(g.escolha(), null, 'a identidade deixou de valer');
  await c.me();
  assert.deepEqual(chamadas.slice(3), ['/v1/health', '/v1/identidade', '/v1/me+token'], 'a prova de novo, antes do token');
});

test('a conexão cai no preferido: o reserva só recebe o token depois de provar a identidade', { timeout: 30000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  const g = manager([a.url, b.url]);
  const c = createClient({ servidor: g, token: TOKEN });
  await c.me();
  await a.parar();
  assert.equal((await c.me()).role, 'OWNER');
  assert.equal(g.escolha().url, b.url);
  assert.deepEqual(caminhos(log, 'B'), ['/v1/health', '/v1/identidade', '/v1/me+token']);
  conferirTokenSoDepoisDaProva(log);
});

test('a conexão cai e o reserva é um impostor: o pedido não é repetido nele e o token não vai', { timeout: 30000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const imp = await abrirServidor('I', { modo: 'repetida', log });
  const g = manager([a.url, imp.url]);
  const c = createClient({ servidor: g, token: TOKEN });
  await c.me();
  await a.parar();
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 0);
  conferirQueNadaVazou(log, 'I');
});

// ───────────────────────── falha fechada ─────────────────────────

test('sem fonte de números aleatórios seguros (como no Hermes do Expo SDK 57) a prova falha FECHADA: o app não conecta e nada é enviado', { timeout: 20000 }, async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  const g = manager([a.url, b.url], { identidade: { chavePublica: CHAVE, gerarNonce: () => I.nonceAleatorio(null) } });
  const c = createClient({ servidor: g, token: TOKEN });
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 0 && e.message === S.MSG_SEM_ALEATORIO);
  await assert.rejects(createClient({ servidor: g, token: '' }).login('braga', SENHA), (e) => e.message === S.MSG_SEM_ALEATORIO);
  assert.equal(log.some((e) => e.caminho !== '/v1/health'), false, 'nenhuma prova, nenhum token, nenhuma senha');
  assert.equal(log.filter((e) => e.servidor === 'B').length, 0, 'e o segundo endereço nem é tentado');
  assert.equal(S.textoDoServidor(g.escolha(), false, g.naoConfirmado()), 'Servidor: não confirmado');
});

// ───────────────────────── sem a chave no build: igual a hoje ─────────────────────────

test('SEM a chave pública no build o comportamento é o de hoje: nenhuma prova é pedida (nem a um servidor que a oferece), só a sonda de saúde', { timeout: 20000 }, async () => {
  const log = [];
  const leg = await abrirServidor('L', { log });
  const imp = await abrirServidor('I', { modo: 'sem-assinatura', log });
  // dois endereços: o primeiro que responde ok vence, como na etapa 18 (o impostor, aqui, seria aceito: é o motivo da prova)
  const g = S.criarGerenciadorDeServidor({ enderecos: [imp.url, leg.url] });
  assert.equal(g.exigeIdentidade, false);
  await createClient({ servidor: g, token: TOKEN }).me();
  assert.deepEqual(caminhos(log), ['/v1/health', '/v1/me+token']);
  assert.equal(log.some((e) => e.caminho === '/v1/identidade'), false);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(imp.url)} (rede local)`, 'sem o selo "confirmado"');
  assert.equal(g.escolha().confirmado, undefined);
  // um endereço só: sem sonda e sem prova, direto ao pedido
  const log2 = [];
  const solo = await abrirServidor('S', { log: log2 });
  const g2 = S.criarGerenciadorDeServidor({ enderecos: [solo.url] });
  assert.equal(g2.alterna, false);
  await createClient({ servidor: g2, token: TOKEN }).me();
  assert.deepEqual(caminhos(log2), ['/v1/me+token']);
});

test('com a chave e UM endereço só, a prova também é exigida (não existe atalho de "um endereço = confio")', { timeout: 20000 }, async () => {
  const log = [];
  const imp = await abrirServidor('I', { modo: 'outra-chave', log });
  const g = manager([imp.url]);
  assert.equal(g.alterna, false);
  assert.equal(g.exigeIdentidade, true);
  await assert.rejects(createClient({ servidor: g, token: TOKEN }).me(), (e) => e.message === S.MSG_IDENTIDADE_NAO_CONFIRMADA);
  conferirQueNadaVazou(log, 'I');
});

// ───────────────────────── a configuração do build ─────────────────────────

test('lerConfigServidores: a chave pública do build liga a prova (Android/iOS); inválida = não conecta; a web ignora a chave e fica como sempre', () => {
  const lista = 'http://192.168.0.5:3939,http://100.64.0.1:3939';
  const com = S.lerConfigServidores({ lista, platform: 'android', identidadePubkey: b64(LEGIT.publica) });
  assert.deepEqual(com.enderecos, ['http://192.168.0.5:3939', 'http://100.64.0.1:3939']);
  assert.deepEqual(com.chavePublica, LEGIT.publica);
  assert.equal(com.aviso, null);
  assert.deepEqual(S.lerConfigServidores({ env: 'https://pc.ts.net:3939', platform: 'ios', identidadePubkey: ` ${b64(LEGIT.publica)} ` }).chavePublica, LEGIT.publica, 'vale também com o endereço único');

  for (const ruim of ['isso-nao-e-base64', b64(crypto.randomBytes(31)), b64(crypto.randomBytes(48)), b64(Uint8Array.from([1, ...new Array(31).fill(0)])) /* ponto neutro */]) {
    const r = S.lerConfigServidores({ lista, platform: 'android', identidadePubkey: ruim });
    assert.deepEqual(r.enderecos, [], 'chave de identidade inválida: o app NÃO conecta (falha fechada)');
    assert.equal(r.aviso, S.AVISO_IDENTIDADE_INVALIDA);
    assert.equal(r.chavePublica, null);
  }

  const sem = S.lerConfigServidores({ lista, platform: 'android' });
  assert.equal(sem.chavePublica, null);
  assert.equal(sem.enderecos.length, 2);
  assert.equal(S.lerConfigServidores({ lista, platform: 'android', identidadePubkey: '   ' }).chavePublica, null, 'variável vazia = não existe');

  const pagina = { protocol: 'http:', hostname: 'localhost' };
  const web = S.lerConfigServidores({ lista, platform: 'web', location: pagina, identidadePubkey: b64(LEGIT.publica) });
  assert.deepEqual(web.enderecos, ['http://localhost:3939']);
  assert.equal(web.chavePublica, null, 'a web não muda');
  assert.equal(S.lerConfigServidores({ lista, platform: 'web', location: pagina, identidadePubkey: 'lixo' }).aviso, null, 'nem uma chave estragada afeta a web');
});

test('textoDoServidor: o selo "confirmado" só aparece quando a identidade foi conferida; "não confirmado" quando o endereço respondeu e não provou', () => {
  const a = { url: 'http://192.168.0.5:3939', indice: 0, total: 2, preferido: true, confirmado: true };
  assert.equal(S.textoDoServidor(a), 'Servidor: 192.168.0.5:3939 (rede local, confirmado)');
  assert.equal(S.textoDoServidor({ ...a, indice: 1, preferido: false }), 'Servidor: 192.168.0.5:3939 (reserva, confirmado)');
  assert.equal(S.textoDoServidor({ ...a, total: 1 }), 'Servidor: 192.168.0.5:3939 (confirmado)');
  assert.equal(S.textoDoServidor({ ...a, confirmado: undefined }), 'Servidor: 192.168.0.5:3939 (rede local)');
  assert.equal(S.textoDoServidor(null, false, true), 'Servidor: não confirmado');
  assert.equal(S.textoDoServidor(null, true, true), 'Servidor: procurando…');
  assert.equal(S.textoDoServidor(null), 'Servidor: sem resposta');
});

test('o painel web versionado nunca leva a chave de identidade: o painel:build a remove do ambiente, e o config.ts só a lê como EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY', () => {
  const build = fs.readFileSync(new URL('../scripts/build-painel.mjs', import.meta.url), 'utf8');
  assert.match(build, /delete env\.EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY;/);
  const config = fs.readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.match(config, /identidadePubkey: process\.env\.EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY,/);
  // nada no app lê uma chave PRIVADA: só a pública vai no build
  for (const arquivo of ['../src/config.ts', '../src/servidores.ts', '../src/identidade.ts', '../App.tsx']) {
    const texto = fs.readFileSync(new URL(arquivo, import.meta.url), 'utf8');
    assert.equal(/PRIVATE KEY|IDENTIDADE_(CHAVE|PRIVADA|ARQUIVO)/.test(texto), false, `${arquivo} não pode tocar numa chave privada`);
  }
});
