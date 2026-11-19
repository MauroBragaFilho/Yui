// Testes dos DOIS endereços do servidor (rede local e Tailscale): a lista do build, a escolha do que responde, a volta ao reserva no meio do uso e o texto do Status.
// Sem React e sem serviço real: servidores FALSOS em 127.0.0.1 abertos pelo próprio teste (ou um fetch falso que conta as chamadas). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiError, createClient } from '../src/api/client.ts';
import { resolveServerUrl } from '../src/serverUrl.ts';
import * as S from '../src/servidores.ts';

const TOKEN = 'token-do-teste-0123456789';
const semHost = (url) => url.replace(/^https?:\/\//, '');

// ───────────────────────── servidores falsos ─────────────────────────
const abertos = [];
test.after(async () => { for (const s of abertos) await s.parar(); });

/** Um servidor falso da Yui em 127.0.0.1. modo: 'vivo' | 'lento' (aceita e nunca responde) | 'naoOk' ({ok:false}) | 'html' (200 que não é JSON) | 'erro500'. */
async function abrirServidor(nome, { modo = 'vivo', log, meStatus = 200 } = {}) {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    const entrada = { servidor: nome, metodo: req.method, caminho: req.url, auth: req.headers.authorization ?? null, respondeuOk: false };
    log.push(entrada);
    if (modo === 'lento') return; // não responde: o app desiste no prazo da sonda
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/v1/health') {
      if (modo === 'naoOk') return json(200, { ok: false });
      if (modo === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>portal</html>'); }
      if (modo === 'erro500') return json(500, { error: 'falhou' });
      entrada.respondeuOk = true;
      return json(200, { ok: true, memory: true, readOnly: true, backends: [] });
    }
    if (req.url === '/v1/me') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'não autorizado' });
      if (meStatus !== 200) return json(meStatus, { error: 'erro do servidor' });
      return json(200, { userId: '111', role: 'OWNER', memoryScope: 'personal' });
    }
    return json(404, { error: 'não achei' });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const obj = {
    nome,
    url: `http://127.0.0.1:${srv.address().port}`,
    async parar() {
      if (!srv.listening) return;
      srv.closeAllConnections?.();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => srv.close(resolve));
    },
  };
  abertos.push(obj);
  return obj;
}

/** Um endereço em que NINGUÉM atende (a porta foi aberta e fechada): a conexão é recusada na hora. */
async function enderecoMorto() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  await new Promise((resolve) => srv.close(resolve));
  return url;
}

function armazemEmMemoria(inicial = null) {
  return {
    valor: inicial,
    salvos: [],
    async carregar() { return this.valor; },
    async salvar(url) { this.valor = url; this.salvos.push(url); },
  };
}

/** Todo pedido COM token precisa vir depois de uma sonda respondida `ok` no mesmo servidor (e nenhum servidor que não respondeu recebe token). */
function conferirTokenSoDepoisDaSonda(log) {
  const sondados = new Set();
  for (const e of log) {
    if (e.caminho === '/v1/health') {
      assert.equal(e.auth, null, `a sonda de ${e.servidor} não pode levar token`);
      if (e.respondeuOk) sondados.add(e.servidor);
    } else if (e.auth) {
      assert.ok(sondados.has(e.servidor), `o token foi enviado a ${e.servidor} sem a sonda ter respondido ok`);
    }
  }
}

/** Um fetch falso que conta as chamadas. `roteiro({ base, caminho, init, chamadas })` devolve um Response ou lança. Passa de 40 chamadas = laço. */
function fetchFalso(roteiro) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const entrada = { base: u.origin, caminho: u.pathname, metodo: init.method ?? 'GET', auth: init.headers?.Authorization ?? null };
    chamadas.push(entrada);
    if (chamadas.length > 40) throw new Error('laço: chamadas demais');
    return roteiro({ base: u.origin, caminho: u.pathname, init, chamadas });
  };
  const doTipo = (base, caminho) => chamadas.filter((c) => c.base === base && c.caminho === caminho).length;
  return { fetchImpl, chamadas, doTipo };
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const HEALTH = () => json(200, { ok: true, memory: true, backends: [] });
const ME = () => json(200, { userId: '111', role: 'OWNER', memoryScope: 'personal' });
const quedaDeRede = () => { throw new TypeError('fetch failed'); };
/** Fica pendurado até o app desistir (o prazo aborta). */
const penduraAteAbortar = (init) => new Promise((_, rejeita) => {
  init.signal.addEventListener('abort', () => rejeita(Object.assign(new Error('abortado'), { name: 'AbortError' })));
});

const A = 'http://rede-local.invalid:3939';
const B = 'http://tailscale.invalid:3939';

// ───────────────────────── a lista do build ─────────────────────────

test('validarEndereco: só http/https, host e porta válidos, SEM usuário/senha', () => {
  assert.equal(S.validarEndereco('http://192.168.0.5:3939'), 'http://192.168.0.5:3939');
  assert.equal(S.validarEndereco('  https://x.ts.net:3939/  '), 'https://x.ts.net:3939');
  assert.equal(S.validarEndereco('192.168.0.5:3939'), 'http://192.168.0.5:3939', 'sem esquema: http');
  assert.equal(S.validarEndereco('meu-pc.ts.net:3939'), 'https://meu-pc.ts.net:3939', '*.ts.net assume https (como o endereço único sempre fez)');
  assert.equal(S.validarEndereco('http://x:3939/v1/'), 'http://x:3939', 'tira /v1 e barras finais');
  assert.equal(S.validarEndereco('http://[::1]:3939'), 'http://[::1]:3939');
  for (const ruim of [
    '', '   ', null, undefined,
    'ftp://x.com:21', 'file:///etc/passwd', 'ws://x:3939', 'javascript:alert(1)',
    'http://usuario:senha@host:3939', 'http://usuario@host:3939', 'http://:senha@host:3939',
    'http://host:0', 'http://host:99999', 'http://host:abc',
    'http://', 'http://:3939', 'http://exa mple.com:3939',
  ]) {
    assert.equal(S.validarEndereco(ruim), null, `deveria recusar: ${JSON.stringify(ruim)}`);
  }
});

test('lerListaDeEnderecos: ordem mantida, inválido ignorado, repetido e excedente também', () => {
  const l = S.lerListaDeEnderecos('http://192.168.0.5:3939, https://pc.ts.net:3939 ,');
  assert.deepEqual(l.enderecos, ['http://192.168.0.5:3939', 'https://pc.ts.net:3939']);
  assert.deepEqual([l.invalidos, l.repetidos, l.excedentes], [0, 0, 0]);

  const misto = S.lerListaDeEnderecos('ftp://x, http://a:3939, http://u:p@b:3939, http://c:3939');
  assert.deepEqual(misto.enderecos, ['http://a:3939', 'http://c:3939']);
  assert.equal(misto.invalidos, 2);

  const dup = S.lerListaDeEnderecos('http://a:3939, http://A:3939/, http://a:3939/v1, http://b:3939, http://b:3939');
  assert.deepEqual(dup.enderecos, ['http://a:3939', 'http://b:3939']);
  assert.equal(dup.repetidos, 3);
  assert.deepEqual(S.lerListaDeEnderecos('http://a:80,http://a').enderecos, ['http://a'], 'a porta padrão não cria endereço novo');

  const muitos = S.lerListaDeEnderecos('http://a:1,http://b:1,http://c:1,http://d:1,http://e:1,http://f:1');
  assert.equal(S.MAX_ENDERECOS, 4);
  assert.deepEqual(muitos.enderecos, ['http://a:1', 'http://b:1', 'http://c:1', 'http://d:1']);
  assert.equal(muitos.excedentes, 2);

  assert.deepEqual(S.lerListaDeEnderecos('').enderecos, []);
  assert.deepEqual(S.lerListaDeEnderecos(undefined).enderecos, []);
});

test('lerConfigServidores (Android): a lista vale; o endereço único continua valendo quando a lista não existe', () => {
  const lista = S.lerConfigServidores({ lista: 'http://192.168.0.5:3939,http://100.64.0.1:3939', platform: 'android' });
  assert.deepEqual(lista.enderecos, ['http://192.168.0.5:3939', 'http://100.64.0.1:3939']);
  assert.equal(lista.origem, 'lista');
  assert.equal(lista.aviso, null);

  const unico = S.lerConfigServidores({ env: 'https://meu-pc.ts.net:3939/', platform: 'android' });
  assert.deepEqual(unico.enderecos, ['https://meu-pc.ts.net:3939']);
  assert.equal(unico.origem, 'unico');
  assert.deepEqual(S.lerConfigServidores({ env: 'meu-pc.ts.net:3939', lista: '   ', platform: 'ios' }).enderecos, ['https://meu-pc.ts.net:3939'], 'lista vazia = não existe');

  assert.deepEqual(S.lerConfigServidores({ lista: 'http://a:3939', env: 'http://b:3939', platform: 'android' }).enderecos, ['http://a:3939'], 'a lista tem prioridade sobre o único');

  const nada = S.lerConfigServidores({ platform: 'android' });
  assert.deepEqual([nada.enderecos, nada.origem, nada.aviso], [[], 'nenhuma', null]);
});

test('lerConfigServidores: item inválido é ignorado; se TODOS forem inválidos, avisa e não conecta em lugar nenhum', () => {
  const parcial = S.lerConfigServidores({ lista: 'ftp://x,http://u:p@h:3939,http://ok:3939', platform: 'android' });
  assert.deepEqual(parcial.enderecos, ['http://ok:3939']);
  assert.equal(parcial.aviso, null);
  assert.equal(parcial.ignorados, 2);

  const todos = S.lerConfigServidores({ lista: 'ftp://x, http://u:p@h:3939, http://h:0', env: 'http://b:3939', platform: 'android' });
  assert.deepEqual(todos.enderecos, [], 'não cai no endereço único: melhor avisar do que conectar em outro lugar');
  assert.equal(todos.aviso, S.AVISO_TODOS_INVALIDOS);

  const unicoRuim = S.lerConfigServidores({ env: 'ftp://x.com', platform: 'android' });
  assert.deepEqual([unicoRuim.enderecos, unicoRuim.aviso], [[], S.AVISO_TODOS_INVALIDOS]);
});

test('a web continua igual: o mesmo computador que serviu a página (a lista não vale na web)', () => {
  const pagina = { protocol: 'http:', hostname: 'localhost' };
  const lista = 'http://192.168.0.5:3939,http://100.64.0.1:3939';
  const web = S.lerConfigServidores({ lista, platform: 'web', location: pagina });
  assert.deepEqual(web.enderecos, ['http://localhost:3939']);
  assert.equal(web.origem, 'web');
  assert.equal(S.lerConfigServidores({ lista, platform: 'web', location: { protocol: 'https:', hostname: 'pc.ts.net' }, apiPort: 4000 }).enderecos[0], 'https://pc.ts.net:4000');
  // o endereço único continua mandando na web, como antes
  assert.deepEqual(S.lerConfigServidores({ lista, env: 'https://a.ts.net:3939', platform: 'web', location: pagina }).enderecos, ['https://a.ts.net:3939']);
  // e dá exatamente o mesmo resultado de sempre (resolveServerUrl)
  for (const entrada of [
    { platform: 'web', location: pagina },
    { platform: 'web', location: { protocol: 'https:', hostname: 'pc.ts.net' }, apiPort: '4000' },
    { env: 'https://a.ts.net:3939', platform: 'web', location: pagina },
    { env: 'ftp://x.com', platform: 'web', location: pagina },
    { platform: 'web', location: null },
  ]) {
    const antes = resolveServerUrl(entrada);
    assert.deepEqual(S.lerConfigServidores({ ...entrada, lista }).enderecos, antes ? [antes] : [], JSON.stringify(entrada));
  }
  // um endereço só (web): nada de sonda nem reserva
  const g = S.criarGerenciadorDeServidor({ enderecos: web.enderecos });
  assert.equal(g.alterna, false);
});

test('textoDoServidor: "(rede local)" para o preferido e "(reserva)" para os outros, pela ORDEM da lista; um só endereço, sem rótulo', () => {
  const a = { url: 'http://192.168.0.5:3939', indice: 0, total: 2, preferido: true };
  const b = { url: 'http://100.64.0.1:3939', indice: 1, total: 2, preferido: false };
  assert.equal(S.textoDoServidor(a), 'Servidor: 192.168.0.5:3939 (rede local)');
  assert.equal(S.textoDoServidor(b), 'Servidor: 100.64.0.1:3939 (reserva)');
  assert.equal(S.textoDoServidor({ url: 'https://pc.ts.net:3939', indice: 2, total: 3, preferido: false }), 'Servidor: pc.ts.net:3939 (reserva)');
  assert.equal(S.textoDoServidor({ url: 'https://pc.ts.net:3939', indice: 0, total: 1, preferido: true }), 'Servidor: pc.ts.net:3939');
  assert.equal(S.textoDoServidor(null, true), 'Servidor: procurando…');
  assert.equal(S.textoDoServidor(null), 'Servidor: sem resposta');
});

test('ordemDaSonda: o último que funcionou vem primeiro, mas só se ainda está na lista do build', () => {
  assert.deepEqual(S.ordemDaSonda([A, B], null), [A, B]);
  assert.deepEqual(S.ordemDaSonda([A, B], B), [B, A]);
  assert.deepEqual(S.ordemDaSonda([A, B], 'http://antigo.invalid:3939'), [A, B], 'endereço que saiu do build é esquecido (token nunca vai a ele)');
});

// ───────────────────────── a escolha, com servidores falsos ─────────────────────────

test('o preferido responde: usa o PRIMEIRO e nem olha o reserva', async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [a.url, b.url], prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  const e = await g.escolher();
  assert.deepEqual([e.url, e.indice, e.preferido, e.total], [a.url, 0, true, 2]);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(a.url)} (rede local)`);
  assert.equal(log.filter((x) => x.servidor === 'B').length, 0, 'o reserva nem foi consultado');
  assert.deepEqual(log.map((x) => [x.servidor, x.metodo, x.caminho, x.auth]), [['A', 'GET', '/v1/health', null]], 'a sonda é um GET /v1/health sem token');
});

test('o preferido está morto: usa o reserva (e o rótulo diz "reserva")', async () => {
  const log = [];
  const morto = await enderecoMorto();
  const b = await abrirServidor('B', { log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [morto, b.url], prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  const e = await g.escolher();
  assert.deepEqual([e.url, e.indice, e.preferido], [b.url, 1, false]);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(b.url)} (reserva)`);
});

test('o preferido está LENTO (não responde no prazo): desiste dele e usa o reserva, sem mandar token ao lento', async () => {
  const log = [];
  const lento = await abrirServidor('A', { modo: 'lento', log });
  const b = await abrirServidor('B', { log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [lento.url, b.url], prazoPrimeiroMs: 150, prazoDemaisMs: 2000 });
  const c = createClient({ servidor: g, token: TOKEN });
  assert.equal((await c.me()).role, 'OWNER');
  assert.equal(g.escolha().url, b.url);
  assert.deepEqual(log.filter((x) => x.servidor === 'A').map((x) => [x.caminho, x.auth]), [['/v1/health', null]], 'o lento só recebeu a sonda');
  conferirTokenSoDepoisDaSonda(log);
});

test('os dois mortos: nenhuma escolha, erro de conexão em português e nada de token', async () => {
  const m1 = await enderecoMorto();
  const m2 = await enderecoMorto();
  const g = S.criarGerenciadorDeServidor({ enderecos: [m1, m2], prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  assert.equal(await g.escolher(), null);
  assert.equal(g.escolha(), null);
  assert.equal(S.textoDoServidor(g.escolha()), 'Servidor: sem resposta');
  await assert.rejects(g.baseUrl(), (e) => e instanceof ApiError && e.status === 0 && /conectar/.test(e.message));
  await assert.rejects(createClient({ servidor: g, token: TOKEN }).me(), (e) => e instanceof ApiError && e.status === 0 && /conectar/.test(e.message));
});

test('resposta que não é "ok" (ok:false, HTML de portal, erro 500) não conta como servidor vivo, e o token não vai a ele', async () => {
  const log = [];
  const naoOk = await abrirServidor('A', { modo: 'naoOk', log });
  const html = await abrirServidor('B', { modo: 'html', log });
  const erro = await abrirServidor('C', { modo: 'erro500', log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [naoOk.url, html.url, erro.url], prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  assert.equal(await g.escolher(), null);
  await assert.rejects(createClient({ servidor: g, token: TOKEN }).me(), (e) => e instanceof ApiError && e.status === 0);
  assert.equal(log.filter((x) => x.auth).length, 0, 'nenhum token saiu');
  assert.equal(log.every((x) => x.caminho === '/v1/health'), true);
});

test('o token (e a senha) só vão a um endereço que passou pela sonda', async () => {
  const log = [];
  const lento = await abrirServidor('A', { modo: 'lento', log });
  const b = await abrirServidor('B', { log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [lento.url, b.url], prazoPrimeiroMs: 150, prazoDemaisMs: 2000 });
  const c = createClient({ servidor: g, token: TOKEN });
  await c.me();
  await c.me();
  assert.deepEqual(log.filter((x) => x.servidor === 'B').map((x) => `${x.caminho}${x.auth ? '+token' : ''}`), ['/v1/health', '/v1/me+token', '/v1/me+token'], 'a sonda primeiro; só depois os pedidos com token');
  conferirTokenSoDepoisDaSonda(log);
  assert.equal(log.some((x) => x.servidor === 'A' && x.auth), false);
});

test('"lembrado" é tentado primeiro (e só vale se ainda está na lista do build)', async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  const armazem = armazemEmMemoria(b.url);
  const g = S.criarGerenciadorDeServidor({ enderecos: [a.url, b.url], lembrado: armazem, prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  const e = await g.escolher();
  assert.deepEqual([e.url, e.indice, e.preferido], [b.url, 1, false], 'o que funcionou da última vez vem antes do preferido');
  assert.equal(log.filter((x) => x.servidor === 'A').length, 0);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(b.url)} (reserva)`);
  assert.deepEqual(armazem.salvos, [], 'já era o lembrado: não regrava');
});

test('o lembrado está morto: cai para a ordem de preferência', async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const morto = await enderecoMorto();
  const g = S.criarGerenciadorDeServidor({ enderecos: [a.url, morto], lembrado: armazemEmMemoria(morto), prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  const e = await g.escolher();
  assert.equal(e.url, a.url);
});

test('o lembrado que não está mais no build é ignorado: nem é sondado', async () => {
  const f = fetchFalso(({ caminho }) => (caminho === '/v1/health' ? HEALTH() : ME()));
  const armazem = armazemEmMemoria('http://antigo.invalid:3939');
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], lembrado: armazem, fetchImpl: f.fetchImpl });
  const e = await g.escolher();
  assert.equal(e.url, A);
  assert.deepEqual(f.chamadas.map((c) => c.base), [A], 'o antigo nunca recebeu nada');
  assert.deepEqual(armazem.salvos, [A], 'e o que funcionou passa a ser o lembrado');
});

test('guarda SÓ o endereço escolhido, uma vez por mudança', async () => {
  const f = fetchFalso(({ caminho }) => HEALTH());
  const armazem = armazemEmMemoria();
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], lembrado: armazem, fetchImpl: f.fetchImpl });
  await g.escolher();
  await g.escolher();
  assert.deepEqual(armazem.salvos, [A]);
  assert.equal(typeof armazem.valor, 'string');
});

test('um armazém que falha não derruba a escolha', async () => {
  const f = fetchFalso(() => HEALTH());
  const quebrado = { async carregar() { throw new Error('sem disco'); }, async salvar() { throw new Error('sem disco'); } };
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], lembrado: quebrado, fetchImpl: f.fetchImpl });
  assert.equal((await g.escolher()).url, A);
});

test('os prazos da sonda: 2,5 s para o primeiro e 4 s para os demais', async () => {
  assert.equal(S.PRAZO_PRIMEIRO_MS, 2500);
  assert.equal(S.PRAZO_DEMAIS_MS, 4000);
  const pedidos = [];
  const agendar = (fn, ms, ...resto) => { pedidos.push(ms); return setTimeout(fn, 1, ...resto); }; // anota o prazo pedido e dispara logo
  const f = fetchFalso(({ init }) => penduraAteAbortar(init));
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B, 'http://terceiro.invalid:3939'], fetchImpl: f.fetchImpl, agendar });
  assert.equal(await g.escolher(), null);
  assert.deepEqual(pedidos, [2500, 4000, 4000]);
  assert.deepEqual(f.chamadas.map((c) => c.base), [A, B, 'http://terceiro.invalid:3939'], 'sonda na ordem de preferência, uma de cada vez');
});

test('a sonda é só leitura e não leva nenhum cabeçalho de login', async () => {
  const vistos = [];
  const fetchImpl = async (url, init) => { vistos.push({ url, init }); return HEALTH(); };
  assert.equal(await S.sondarEndereco(A, { fetchImpl, prazoMs: 500 }), true);
  assert.equal(vistos[0].url, `${A}/v1/health`);
  assert.equal(vistos[0].init.method, 'GET');
  assert.equal(vistos[0].init.body, undefined);
  assert.deepEqual(Object.keys(vistos[0].init.headers).map((k) => k.toLowerCase()), ['accept']);
});

// ───────────────────────── queda no meio do uso ─────────────────────────

test('a conexão cai no meio do uso: refaz a escolha UMA vez e repete o pedido no endereço que responde', async () => {
  const log = [];
  const a = await abrirServidor('A', { log });
  const b = await abrirServidor('B', { log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [a.url, b.url], prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  const c = createClient({ servidor: g, token: TOKEN });
  assert.equal((await c.me()).role, 'OWNER');
  assert.equal(g.escolha().url, a.url);

  await a.parar(); // o preferido cai (a pessoa saiu de casa)
  assert.equal((await c.me()).role, 'OWNER', 'o pedido foi repetido no reserva e deu certo');
  assert.deepEqual([g.escolha().url, g.escolha().indice], [b.url, 1]);
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(b.url)} (reserva)`);
  assert.deepEqual(log.filter((x) => x.servidor === 'B').map((x) => `${x.caminho}${x.auth ? '+token' : ''}`), ['/v1/health', '/v1/me+token']);

  assert.equal((await c.me()).role, 'OWNER');
  assert.equal(log.filter((x) => x.servidor === 'B' && x.caminho === '/v1/health').length, 1, 'não sonda de novo enquanto o reserva responde');
  conferirTokenSoDepoisDaSonda(log);
  assert.equal(c.baseUrl, b.url, 'o cliente passa a apontar para o endereço em uso');
});

test('erro HTTP do servidor NÃO é queda de rede: não refaz a escolha nem repete', async () => {
  const log = [];
  const a = await abrirServidor('A', { log, meStatus: 500 });
  const b = await abrirServidor('B', { log });
  const g = S.criarGerenciadorDeServidor({ enderecos: [a.url, b.url], prazoPrimeiroMs: 2000, prazoDemaisMs: 2000 });
  const c = createClient({ servidor: g, token: TOKEN });
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 500);
  assert.equal(g.escolha().url, a.url);
  assert.equal(log.filter((x) => x.servidor === 'A' && x.caminho === '/v1/health').length, 1);
  assert.equal(log.filter((x) => x.servidor === 'A' && x.caminho === '/v1/me').length, 1, 'o pedido não foi repetido');
  assert.equal(log.filter((x) => x.servidor === 'B').length, 0);
  // 401 (sessão recusada) também é resposta do servidor: o app volta ao login, não troca de endereço
  const c2 = createClient({ servidor: g, token: 'token-errado-0123456789' });
  await assert.rejects(c2.me(), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(log.filter((x) => x.servidor === 'B').length, 0);
});

test('sem laço: se o pedido falha de novo depois de refazer a escolha, o erro sobe (um pedido repetido, uma escolha refeita)', async () => {
  const f = fetchFalso(({ caminho }) => (caminho === '/v1/health' ? HEALTH() : quedaDeRede()));
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl });
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 0 && e.rede === 'conexao');
  assert.equal(f.doTipo(A, '/v1/me'), 2, 'o pedido original e UMA repetição');
  assert.equal(f.doTipo(A, '/v1/health'), 2, 'a escolha inicial e UMA refeita');
  assert.equal(f.chamadas.length, 4);
  assert.equal(f.doTipo(B, '/v1/health'), 0);
});

test('sem laço: depois da queda, se nenhum endereço responde, o erro original sobe sem repetir o pedido', async () => {
  let viva = true;
  const f = fetchFalso(({ caminho }) => {
    if (!viva) return quedaDeRede();
    if (caminho === '/v1/health') return HEALTH();
    viva = false; // o pedido de verdade derruba tudo
    return quedaDeRede();
  });
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl });
  await assert.rejects(c.me(), (e) => e instanceof ApiError && e.status === 0 && /conectar/.test(e.message));
  assert.equal(f.doTipo(A, '/v1/me'), 1, 'sem alternativa, não repete');
  assert.equal(f.chamadas.length, 4, '1 sonda + 1 pedido + 2 sondas da escolha refeita (A e B)');
  assert.equal(g.escolha(), null);
});

test('queda simultânea de vários pedidos: uma só escolha refeita, e todos repetem no endereço novo', async () => {
  let aCaiu = false;
  const f = fetchFalso(({ base, caminho }) => {
    if (base === A && aCaiu) return quedaDeRede();
    return caminho === '/v1/health' ? HEALTH() : ME();
  });
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl });
  await c.me();
  aCaiu = true;
  const todos = await Promise.all([c.me(), c.me(), c.me()]);
  assert.equal(todos.every((m) => m.role === 'OWNER'), true);
  assert.equal(f.doTipo(B, '/v1/health'), 1, 'uma sonda no reserva, dividida entre os três pedidos');
  assert.equal(f.doTipo(B, '/v1/me'), 3);
  assert.equal(g.escolha().url, B);
});

// (c.send usa o prazo padrão do cliente, que o teste encurta com timeoutMs; c.me() tem prazo próprio de 15 s)
const RESPOSTA = () => json(200, { type: 'reply', reply: 'oi' });

test('espera esgotada no MESMO endereço (servidor lento, não caído): não repete o pedido', async () => {
  const f = fetchFalso(({ caminho, init }) => (caminho === '/v1/health' ? HEALTH() : penduraAteAbortar(init)));
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl, timeoutMs: 30 });
  await assert.rejects(c.send('oi'), (e) => e instanceof ApiError && e.status === 0 && e.rede === 'prazo' && /demorou/.test(e.message));
  assert.equal(f.doTipo(A, '/v1/agent'), 1, 'um pedido lento não pode ser executado em dobro');
});

test('espera esgotada porque o preferido sumiu (o reserva responde): repete no reserva', async () => {
  let aSumiu = false;
  const f = fetchFalso(({ base, caminho, init }) => {
    if (base === A && aSumiu) return caminho === '/v1/health' ? quedaDeRede() : penduraAteAbortar(init); // pacotes engolidos: nem erro, só silêncio
    return caminho === '/v1/health' ? HEALTH() : RESPOSTA();
  });
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl, timeoutMs: 30 });
  await c.send('oi');
  aSumiu = true;
  assert.equal((await c.send('oi')).reply, 'oi');
  assert.equal(g.escolha().url, B);
  assert.equal(f.doTipo(A, '/v1/agent'), 2);
  assert.equal(f.doTipo(B, '/v1/agent'), 1);
});

test('o link do arquivo sai com o endereço que respondeu depois da queda', async () => {
  let aCaiu = false;
  const f = fetchFalso(({ base, caminho }) => {
    if (base === A && aCaiu) return quedaDeRede();
    return caminho === '/v1/health' ? HEALTH() : json(200, { url: '/v1/bds/get/abc', expiresInSec: 600 });
  });
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl });
  assert.equal(await c.bds.link('C:\\x\\a.mp4', true), `${A}/v1/bds/get/abc`);
  aCaiu = true;
  assert.equal(await c.bds.link('C:\\x\\a.mp4', true), `${B}/v1/bds/get/abc`);
});

// ───────────────────────── um endereço só (e a web): nada muda ─────────────────────────

test('um endereço só: sem sonda, sem reserva e sem repetir; igual ao de sempre', async () => {
  const f = fetchFalso(({ caminho }) => (caminho === '/v1/health' ? HEALTH() : ME()));
  const g = S.criarGerenciadorDeServidor({ enderecos: [A], fetchImpl: f.fetchImpl });
  assert.equal(g.alterna, false);
  const c = createClient({ servidor: g, token: TOKEN, fetchImpl: f.fetchImpl });
  assert.equal((await c.me()).role, 'OWNER');
  assert.deepEqual(f.chamadas.map((x) => [x.caminho, Boolean(x.auth)]), [['/v1/me', true]], 'foi direto ao pedido: nenhuma sonda');
  assert.equal(S.textoDoServidor(g.escolha()), `Servidor: ${semHost(A)}`);

  const queda = fetchFalso(() => quedaDeRede());
  const g2 = S.criarGerenciadorDeServidor({ enderecos: [A], fetchImpl: queda.fetchImpl });
  const c2 = createClient({ servidor: g2, token: TOKEN, fetchImpl: queda.fetchImpl });
  await assert.rejects(c2.me(), (e) => e instanceof ApiError && e.status === 0);
  assert.equal(queda.chamadas.length, 1, 'sem reserva, não há o que refazer');
});

test('o cliente de endereço fixo (baseUrl) continua como antes', async () => {
  const f = fetchFalso(({ caminho }) => (caminho === '/v1/health' ? HEALTH() : ME()));
  const c = createClient({ baseUrl: 'meu-pc.ts.net:3939/', token: TOKEN, fetchImpl: f.fetchImpl });
  assert.equal(c.baseUrl, 'https://meu-pc.ts.net:3939');
  await c.me();
  assert.deepEqual(f.chamadas.map((x) => x.caminho), ['/v1/me']);
  assert.throws(() => createClient({ token: TOKEN }), ApiError, 'sem endereço nenhum, recusa');
});

test('o gerenciador não existe sem endereço', () => {
  assert.throws(() => S.criarGerenciadorDeServidor({ enderecos: [] }), ApiError);
});

test('quem acompanha a tela é avisado quando a escolha muda', async () => {
  const f = fetchFalso(() => HEALTH());
  const g = S.criarGerenciadorDeServidor({ enderecos: [A, B], fetchImpl: f.fetchImpl });
  const textos = [];
  const parar = g.aoMudar(() => textos.push(S.textoDoServidor(g.escolha(), g.procurando())));
  await g.escolher();
  parar();
  await g.escolher();
  assert.deepEqual(textos, ['Servidor: procurando…', `Servidor: ${semHost(A)} (rede local)`]);
});
