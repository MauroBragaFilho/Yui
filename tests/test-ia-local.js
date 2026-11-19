// Item 7 (preparo): o PONTO DE LIGAÇÃO DA IA LOCAL (src/core/ai/local.js), DESLIGADO por YUI_IA_LOCAL_URL (padrão: vazio) e SEM ativar o perfil `local`, contra um servidor FALSO compatível com a
// API da OpenAI (GET /v1/models) aberto por este teste em 127.0.0.1 (nada do LM Studio, Ollama ou llama.cpp de verdade é tocado).
//  A. desligado (a chave vazia): nenhuma requisição, nunca;
//  B. o estado para o diagnóstico: "ok, N modelos", "sem resposta" (rede, prazo, HTTP, JSON, formato, tamanho, redirecionamento) e "endereço inválido";
//  C. o endereço só pode ser da própria máquina ou da rede local (nada de nome de computador, usuário e senha, parâmetros nem a internet);
//  D. o perfil `local` CONTINUA reservado e recusado (perfis.js não muda): estar "ok" não ativa nada;
//  E. a sonda com memória curta e o diagnóstico (sem endereço, sem conteúdo).
// Execução: npm run test:ialocal   (node tests/test-ia-local.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ia-local-'));
process.chdir(tmp); // o logger cria a pasta logs/ no diretório atual: que seja a temporária
Object.assign(process.env, { DATABASE_DIR: path.join(tmp, 'db'), LOG_LEVEL: 'error', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false' });
for (const k of ['YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'YUI_IA_LOCAL_URL', 'YUI_GATEWAY_CUSTOM']) delete process.env[k];
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const L = await imp('src/core/ai/local.js');
const { VAR_URL, PERFIL_LOCAL_ATIVO, TIMEOUT_PADRAO_MS, RESPOSTA_MAX_CARACTERES, urlLocalConfigurada, perfilLocalAtivo, validarUrlLocal, testarIaLocal, criarSondaLocal, diagnosticoDaIaLocal } = L;

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 7).join('\n      ')}`); }
};

/** O servidor FALSO de modelos (loopback). `modo` muda o que ele responde. */
async function criarServidorFalso() {
  const requisicoes = [];
  const estado = { modo: 'ok', modelos: ['modelo-a', 'modelo-b'], atrasoMs: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requisicoes.push({ metodo: req.method, caminho: req.url, cabecalhos: { ...req.headers } });
    const responder = () => {
      if (estado.modo === 'redirecionar') { res.writeHead(302, { location: 'http://127.0.0.1:1/outro' }); res.end(); return; }
      if (estado.modo === 'http500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"quebrou"}'); return; }
      if (estado.modo === 'naoJson') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>não sou um servidor de IA</html>'); return; }
      if (estado.modo === 'semData') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[{"name":"x"}]}'); return; }
      if (estado.modo === 'dataNaoLista') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":"x"}'); return; }
      if (estado.modo === 'grande') { const corpo = JSON.stringify({ data: [{ id: 'x'.repeat(RESPOSTA_MAX_CARACTERES + 10) }] }); res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo) }); res.end(corpo); return; }
      if (estado.modo === 'grandeSemTamanho') { res.writeHead(200, { 'content-type': 'application/json' }); res.write(`{"data":[{"id":"${'x'.repeat(RESPOSTA_MAX_CARACTERES + 10)}"}]}`); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: estado.modelos.map((id) => ({ id, object: 'model', owned_by: 'local' })) }));
    };
    if (estado.atrasoMs) setTimeout(responder, estado.atrasoMs); else responder();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, url: `http://127.0.0.1:${port}/v1`, requisicoes, estado,
    definir(extra) { Object.assign(estado, extra); },
    close() { for (const s of sockets) s.destroy(); return new Promise((resolve) => server.close(resolve)); },
  };
}

const servidor = await criarServidorFalso();
// Nada sai da máquina: o fetch daqui só alcança o servidor falso deste teste (qualquer outro destino falha na hora e é contado).
let foraDoFalso = 0;
const portasAbertas = new Set([servidor.port]);
const fetchGuardado = (url, opcoes) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1' || !portasAbertas.has(Number(u.port))) { foraDoFalso += 1; return Promise.reject(new TypeError('destino fora do servidor falso (teste)')); }
  return fetch(url, opcoes);
};
const envCom = (url) => (url === undefined ? {} : { YUI_IA_LOCAL_URL: url });
const testar = (url, extra = {}) => testarIaLocal({ env: envCom(url), fetchImpl: fetchGuardado, ...extra });

console.log('A. Desligado: sem a chave, nenhuma requisição');
await test('YUI_IA_LOCAL_URL vazia, ausente ou só com espaços: "desligado", e o servidor (no ar) nunca recebe nada', async () => {
  assert.equal(VAR_URL, 'YUI_IA_LOCAL_URL');
  for (const env of [{}, { YUI_IA_LOCAL_URL: '' }, { YUI_IA_LOCAL_URL: '   ' }, { YUI_IA_LOCAL_URL: undefined }, { YUI_IA_LOCAL_URL: null }, { YUI_IA_LOCAL_URL: '\n' }]) {
    const r = await testarIaLocal({ env, fetchImpl: fetchGuardado });
    assert.deepEqual(r, { estado: 'desligado', texto: 'desligado', modelos: 0, nomes: [], perfilAtivo: false, codigo: null });
  }
  assert.equal((await testarIaLocal({ fetchImpl: fetchGuardado })).estado, 'desligado', 'sem env: o do processo, onde a variável não existe');
  assert.equal(servidor.requisicoes.length, 0, 'nenhuma requisição chegou ao servidor');
  assert.equal(foraDoFalso, 0);
  assert.equal(urlLocalConfigurada({}), '');
  assert.equal(urlLocalConfigurada({ YUI_IA_LOCAL_URL: '  http://127.0.0.1:1234  ' }), 'http://127.0.0.1:1234');
  let chamouFetch = 0;
  await testarIaLocal({ env: {}, fetchImpl: () => { chamouFetch += 1; } });
  assert.equal(chamouFetch, 0, 'o fetch nem é tocado');
});
await test('o padrão e o tempo: o prazo padrão é de 3 s e o limite da resposta é de 256 KB', () => {
  assert.equal(TIMEOUT_PADRAO_MS, 3000);
  assert.equal(RESPOSTA_MAX_CARACTERES, 256 * 1024);
});

console.log('B. O estado para o diagnóstico');
await test('servidor respondendo: "ok, N modelos" (singular com 1, zero com nenhum), com os nomes limpos e curtos; o teste é um GET simples, sem chave, sem corpo e sem seguir redirecionamento', async () => {
  servidor.definir({ modo: 'ok', modelos: ['qwen2.5-coder-7b', 'llama-3.1-8b', 'gemma-2-9b'] });
  const r = await testar(servidor.url);
  assert.deepEqual(r, { estado: 'ok', texto: 'ok, 3 modelos', modelos: 3, nomes: ['qwen2.5-coder-7b', 'llama-3.1-8b', 'gemma-2-9b'], perfilAtivo: false, codigo: null });
  assert.equal(servidor.requisicoes.length, 1);
  const req = servidor.requisicoes[0];
  assert.deepEqual([req.metodo, req.caminho], ['GET', '/v1/models']);
  assert.equal(req.cabecalhos.authorization, undefined, 'nenhuma chave de API é enviada');
  assert.equal(req.cabecalhos.cookie, undefined);
  assert.equal(req.cabecalhos['content-length'], undefined, 'sem corpo');
  servidor.definir({ modelos: ['unico'] });
  assert.equal((await testar(servidor.url)).texto, 'ok, 1 modelo');
  servidor.definir({ modelos: [] });
  const vazio = await testar(servidor.url);
  assert.deepEqual([vazio.estado, vazio.texto, vazio.modelos], ['ok', 'ok, 0 modelos', 0]);
  servidor.definir({ modelos: Array.from({ length: 30 }, (_, i) => `m${i}`) });
  const muitos = await testar(servidor.url);
  assert.equal(muitos.modelos, 30);
  assert.equal(muitos.nomes.length, 8, 'mostra só os 8 primeiros');
  servidor.definir({ modelos: ['bom', 'com\nquebra<script>', 'x'.repeat(200), '', 7, null] });
  const sujos = await testar(servidor.url);
  assert.ok(sujos.nomes.every((n) => n.length <= 80 && /^[\w.:@/ -]+$/.test(n)), JSON.stringify(sujos.nomes));
  servidor.definir({ modelos: ['a', 'b'] });
});
await test('o endereço sem "/v1" ganha "/v1"; com barra no fim, com outro caminho e com "/v1" já escrito, o GET vai ao lugar certo', async () => {
  servidor.requisicoes.length = 0;
  for (const url of [`http://127.0.0.1:${servidor.port}`, `http://127.0.0.1:${servidor.port}/`, `http://127.0.0.1:${servidor.port}/v1`, `http://127.0.0.1:${servidor.port}/v1/`]) assert.equal((await testar(url)).estado, 'ok', url);
  assert.deepEqual(servidor.requisicoes.map((r) => r.caminho), ['/v1/models', '/v1/models', '/v1/models', '/v1/models']);
  servidor.requisicoes.length = 0;
  await testar(`http://127.0.0.1:${servidor.port}/openai/v1`);
  assert.equal(servidor.requisicoes[0].caminho, '/openai/v1/models');
});
await test('SEM RESPOSTA: porta fechada, HTTP 500, 404, não é JSON, JSON sem "data" em lista, resposta grande demais (com e sem tamanho declarado), redirecionamento e lentidão; sempre sem lançar e sem conteúdo', async () => {
  const fechado = await criarServidorFalso();
  portasAbertas.add(fechado.port);
  const urlFechada = fechado.url;
  await fechado.close();
  const casos = [
    [urlFechada, null, 'rede'],
    [servidor.url, { modo: 'http500' }, 'http-500'],
    [servidor.url, { modo: 'naoJson' }, 'json-invalido'],
    [servidor.url, { modo: 'semData' }, 'formato-invalido'],
    [servidor.url, { modo: 'dataNaoLista' }, 'formato-invalido'],
    [servidor.url, { modo: 'grande' }, 'resposta-grande'],
    [servidor.url, { modo: 'grandeSemTamanho' }, 'resposta-grande'],
    [servidor.url, { modo: 'redirecionar' }, 'rede'],
  ];
  for (const [url, modo, codigo] of casos) {
    if (modo) servidor.definir({ ...modo, atrasoMs: 0 });
    const r = await testar(url);
    assert.deepEqual([r.estado, r.texto, r.modelos, r.perfilAtivo, r.codigo], ['sem-resposta', 'sem resposta', 0, false, codigo], JSON.stringify([url === urlFechada ? 'fechada' : 'servidor', modo]));
    assert.deepEqual(r.nomes, []);
  }
  servidor.definir({ modo: 'ok', atrasoMs: 600 });
  const t0 = Date.now();
  const lento = await testar(servidor.url, { timeoutMs: 150 });
  assert.deepEqual([lento.texto, lento.codigo], ['sem resposta', 'timeout']);
  assert.ok(Date.now() - t0 < 500, 'cortou no prazo');
  servidor.definir({ modo: 'ok', atrasoMs: 0 });
  assert.equal((await testarIaLocal({ env: envCom(servidor.url), fetchImpl: () => Promise.reject(new Error('x')) })).codigo, 'rede');
  assert.equal((await testarIaLocal({ env: envCom(servidor.url), fetchImpl: 'não é função' })).codigo, 'sem-fetch');
  assert.equal((await testarIaLocal({ env: envCom(servidor.url), fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => { throw new Error('cortou'); } }) })).codigo, 'leitura');
  assert.equal(foraDoFalso, 0, 'nada fora do servidor falso');
});
await test('o redirecionamento NÃO é seguido (poderia levar o teste para fora da rede local): só a primeira requisição chega ao servidor', async () => {
  servidor.definir({ modo: 'redirecionar' });
  servidor.requisicoes.length = 0;
  assert.equal((await testar(servidor.url)).estado, 'sem-resposta');
  assert.equal(servidor.requisicoes.length, 1);
  servidor.definir({ modo: 'ok' });
});

console.log('C. O endereço: só a própria máquina ou a rede local');
await test('aceita: localhost, 127.x, 10.x, 172.16 a 31.x, 192.168.x e 100.64 a 127.x (Tailscale), em http ou https, com porta; recusa a internet, nomes de computador e vizinhos "quase locais"', () => {
  for (const ok of ['http://localhost:1234', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.1.2.3:80', 'http://10.0.0.5:8080', 'http://10.255.255.255', 'http://172.16.0.1', 'http://172.31.255.255:9', 'http://192.168.1.10:1234', 'https://192.168.0.2/v1', 'http://100.64.0.1:1234', 'http://100.127.255.255', 'http://[::1]:1234/v1']) {
    assert.equal(validarUrlLocal(ok).ok, true, ok);
  }
  for (const ruim of ['https://api.openai.com/v1', 'http://8.8.8.8', 'http://172.15.0.1', 'http://172.32.0.1', 'http://100.63.255.255', 'http://100.128.0.1', 'http://11.0.0.1', 'http://192.169.0.1', 'http://169.254.1.1', 'http://0.0.0.0',
    'http://notebook-yui:1234', 'http://meu-pc.local', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://evil.com/127.0.0.1', 'http://1.2.3', 'http://[2001:db8::1]']) {
    const r = validarUrlLocal(ruim);
    assert.equal(r.ok, false, ruim);
    assert.equal(r.codigo, 'endereco-nao-local', `${ruim}: ${r.codigo}`);
  }
});
await test('recusa protocolo que não é http(s), usuário e senha, parâmetros e âncora, caminho estranho e texto que não é endereço', () => {
  assert.equal(validarUrlLocal('ftp://127.0.0.1').codigo, 'protocolo-nao-permitido');
  assert.equal(validarUrlLocal('file:///C:/x').codigo, 'protocolo-nao-permitido');
  assert.equal(validarUrlLocal('ws://127.0.0.1').codigo, 'protocolo-nao-permitido');
  for (const u of ['http://user:senha@127.0.0.1:1234', 'http://user@127.0.0.1', 'http://127.0.0.1:1234/v1?key=abc', 'http://127.0.0.1/v1#x']) assert.equal(validarUrlLocal(u).codigo, 'url-com-credencial-ou-parametro', u);
  for (const u of ['http://127.0.0.1/v1/%20x', 'http://127.0.0.1/a b/c']) assert.equal(validarUrlLocal(u).codigo, 'url-invalida', u);
  for (const u of ['', 'não é endereço', 'http://', 'http://127.0.0.256', null, undefined, 7]) assert.equal(validarUrlLocal(u).codigo, 'url-invalida', String(u));
  assert.deepEqual(validarUrlLocal('http://127.0.0.1:1234'), { ok: true, modelosUrl: 'http://127.0.0.1:1234/v1/models' });
  assert.deepEqual(validarUrlLocal('http://127.0.0.1:1234/'), { ok: true, modelosUrl: 'http://127.0.0.1:1234/v1/models' });
  assert.deepEqual(validarUrlLocal('http://127.0.0.1:1234/v1/'), { ok: true, modelosUrl: 'http://127.0.0.1:1234/v1/models' });
});
await test('endereço inválido: "endereço inválido" com o código do motivo, e NENHUMA requisição (nem para o endereço errado, nem para o servidor falso)', async () => {
  servidor.requisicoes.length = 0;
  let chamou = 0;
  for (const [url, codigo] of [['https://api.openai.com/v1', 'endereco-nao-local'], ['http://user:senha@127.0.0.1/v1', 'url-com-credencial-ou-parametro'], ['ftp://127.0.0.1', 'protocolo-nao-permitido'], ['lixo', 'url-invalida'], ['http://notebook:1234', 'endereco-nao-local']]) {
    const r = await testarIaLocal({ env: envCom(url), fetchImpl: () => { chamou += 1; return Promise.reject(new Error('não devia chamar')); } });
    assert.deepEqual([r.estado, r.texto, r.modelos, r.perfilAtivo, r.codigo], ['invalido', 'endereço inválido', 0, false, codigo], url);
  }
  assert.equal(chamou, 0);
  assert.equal(servidor.requisicoes.length, 0);
});

console.log('D. O perfil `local` continua reservado: estar "ok" não ativa nada');
await test('perfilAtivo é SEMPRE falso (constante), mesmo com o servidor respondendo "ok, N modelos"', async () => {
  assert.equal(PERFIL_LOCAL_ATIVO, false);
  assert.equal(perfilLocalAtivo(), false);
  servidor.definir({ modo: 'ok', modelos: ['a', 'b', 'c'] });
  const r = await testar(servidor.url);
  assert.equal(r.estado, 'ok');
  assert.equal(r.perfilAtivo, false);
  assert.equal(perfilLocalAtivo(), false);
  assert.equal(diagnosticoDaIaLocal(r).perfilAtivo, false);
  assert.equal(diagnosticoDaIaLocal({ ...r, perfilAtivo: true }).perfilAtivo, false, 'o diagnóstico não repete um "ativo" vindo de fora');
});
await test('perfis.js (SEM MUDANÇA): `local` aceito só na configuração, nunca ativo: "habilitado: true" é recusado, e `perfisAtivos` não o devolve com a URL preenchida e o servidor no ar', async () => {
  const perfis = await imp('src/core/ai/perfis.js');
  assert.ok(perfis.NOMES_DE_PERFIL.includes('local'));
  const cfg = { modelo: 'qwen2.5-coder-7b', maxTokens: 1024, privacidade: 'geral' };
  const ligado = perfis.validarPerfil('local', { ...cfg, habilitado: true });
  assert.equal(ligado.ok, false);
  assert.ok(ligado.erros.some((e) => e.codigo === 'local-reservado'), JSON.stringify(ligado.erros));
  const aceito = perfis.validarPerfil('local', cfg);
  assert.equal(aceito.ok, true);
  assert.equal(aceito.perfil.habilitado, false, 'aceito na configuração, mas desabilitado');
  const env = { YUI_IA_LOCAL_URL: servidor.url, YUI_IA_PERFIS: JSON.stringify({ local: cfg, conversa: { modelo: 'auto', maxTokens: 1024, privacidade: 'geral' } }) };
  perfis.esquecerConfigDePerfisParaTeste();
  const ativos = perfis.perfisAtivos(env);
  assert.deepEqual(Object.keys(ativos), ['conversa'], 'só a conversa: o local nunca entra');
  assert.equal(perfis.carregarPerfis(env).perfis.local.habilitado, false);
  const ligadoNaConfig = { ...env, YUI_IA_PERFIS: JSON.stringify({ local: { ...cfg, habilitado: true } }) };
  perfis.esquecerConfigDePerfisParaTeste();
  assert.deepEqual(perfis.perfisAtivos(ligadoNaConfig), {}, 'nem pedindo para habilitar');
  assert.ok(perfis.carregarPerfis(ligadoNaConfig).erros.some((e) => e.codigo === 'local-reservado'));
  perfis.esquecerConfigDePerfisParaTeste();
  assert.equal(perfilLocalAtivo(), false);
});
await test('o arquivo local.js não tem caminho de ativação: não importa perfis, rota, gerenciador nem gateway, só lê YUI_IA_LOCAL_URL e não lê nem envia chave de API', () => {
  const fonte = fs.readFileSync(path.join(repoRoot, 'src/core/ai/local.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.equal([...fonte.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].length, 0, 'não importa nada');
  assert.deepEqual([...new Set([...fonte.matchAll(/env\??\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))], ['YUI_IA_LOCAL_URL']);
  assert.ok(!/authorization|api[_-]?key|bearer|token|secret/i.test(fonte.replace(/Nenhuma chave de API é lida nem enviada/g, '')), 'mexe com chave');
  assert.ok(!/process\.env|setInterval|setTimeout/.test(fonte.replace(/env = process\.env/g, '')), 'lê o ambiente por conta própria ou agenda timer');
  assert.ok(!/['"]POST['"]|\bbody\s*:/.test(fonte), 'só GET, sem corpo');
});

console.log('E. A sonda com memória curta e o diagnóstico');
await test('o diagnóstico é uma lista de permitidos: estado, texto, contagem e perfil; NUNCA o endereço, os nomes dos modelos nem o código de erro', async () => {
  servidor.definir({ modo: 'ok', modelos: ['modelo-secreto-xyz'] });
  const ok = await testar(`http://127.0.0.1:${servidor.port}/v1`);
  const d = diagnosticoDaIaLocal(ok);
  assert.deepEqual(d, { estado: 'ok', texto: 'ok, 1 modelo', modelos: 1, perfilAtivo: false });
  assert.deepEqual(Object.keys(d).sort(), ['estado', 'modelos', 'perfilAtivo', 'texto']);
  const json = JSON.stringify(d);
  for (const proibido of ['127.0.0.1', String(servidor.port), 'modelo-secreto-xyz', 'codigo']) assert.equal(json.includes(proibido), false, `o diagnóstico vazou: ${proibido}`);
  assert.equal(JSON.stringify(ok).includes('127.0.0.1'), false, 'nem o resultado completo leva o endereço');
  assert.deepEqual(diagnosticoDaIaLocal(await testar(undefined)), { estado: 'desligado', texto: 'desligado', modelos: 0, perfilAtivo: false });
  assert.deepEqual(diagnosticoDaIaLocal(null), { estado: 'desligado', texto: 'desligado', modelos: 0, perfilAtivo: false });
  assert.deepEqual(diagnosticoDaIaLocal({ estado: 'sem-resposta', texto: 'sem resposta', modelos: 'muitos', codigo: 'rede', nomes: ['x'] }), { estado: 'sem-resposta', texto: 'sem resposta', modelos: 0, perfilAtivo: false });
});
await test('a sonda guarda o resultado por um tempo (o diagnóstico é consultado com frequência), refaz depois do prazo, com "forcar" ou quando o endereço muda, e chamadas ao mesmo tempo dividem UMA requisição', async () => {
  servidor.definir({ modo: 'ok', modelos: ['a', 'b'] });
  servidor.requisicoes.length = 0;
  let t = 1_000_000;
  const env = { YUI_IA_LOCAL_URL: servidor.url };
  const sonda = criarSondaLocal({ env, fetchImpl: fetchGuardado, ttlMs: 30_000, agora: () => t });
  const [a, b, c] = await Promise.all([sonda.verificar(), sonda.verificar(), sonda.verificar()]);
  assert.equal(servidor.requisicoes.length, 1, 'três chamadas ao mesmo tempo, uma requisição');
  assert.deepEqual([a.texto, b.texto, c.texto], ['ok, 2 modelos', 'ok, 2 modelos', 'ok, 2 modelos']);
  t += 29_000;
  await sonda.verificar();
  assert.equal(servidor.requisicoes.length, 1, 'dentro do prazo: do guardado');
  t += 2000;
  await sonda.verificar();
  assert.equal(servidor.requisicoes.length, 2, 'passou o prazo');
  await sonda.verificar({ forcar: true });
  assert.equal(servidor.requisicoes.length, 3, 'forçado');
  env.YUI_IA_LOCAL_URL = `http://127.0.0.1:${servidor.port}`;
  await sonda.verificar();
  assert.equal(servidor.requisicoes.length, 4, 'o endereço mudou: refaz');
  env.YUI_IA_LOCAL_URL = '';
  servidor.requisicoes.length = 0;
  const desligada = await sonda.verificar();
  assert.equal(desligada.estado, 'desligado', 'sem a chave volta a "desligado" na hora (não fica com o resultado antigo)');
  assert.equal(servidor.requisicoes.length, 0);
});
await test('nenhuma requisição saiu do servidor falso deste teste, e o servidor foi o único destino em todo o teste', async () => {
  assert.equal(foraDoFalso, 0);
  await servidor.close();
});

// O logger (importado por perfis.js) deixa arquivos abertos em <tmp>/logs: fecha antes de apagar a pasta temporária (no Windows um arquivo aberto impede apagar).
try { process.chdir(repoRoot); } catch { /* */ }
try {
  const { logger } = await imp('src/utils/logger.js');
  await new Promise((resolve) => { const prazo = setTimeout(resolve, 1500); logger.on('finish', () => { clearTimeout(prazo); resolve(); }); logger.close(); });
} catch { /* */ }
for (let i = 0; i < 50 && fs.existsSync(tmp); i++) { // apaga assim que o sistema soltar os arquivos de log (o sinal real: a remoção funcionar)
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
}
console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
