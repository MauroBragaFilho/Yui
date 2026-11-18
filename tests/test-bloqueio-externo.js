// O BLOQUEIO de integração externa dos testes com processos de verdade funciona? (regra da Liz depois do incidente do download_audio; relatório
// da etapa 6, §11). Abre processos filhos com o mesmo `--import` dos testes de ponta a ponta e confere, de verdade, que:
//  - a rede para fora do loopback falha com BLOQUEIO_EXTERNO_TESTE (fetch, http, net) e fica registrada; o endereço usado é o TEST-NET-1
//    (192.0.2.1, RFC 5737, nunca roteado) e nomes ".invalid" (RFC 2606): nem um bloqueio quebrado tocaria um serviço de verdade;
//  - o loopback numa porta que NÃO é do teste (como um LM Studio ou OmniRoute na máquina) também falha: a porta do pai fica sem conexão;
//  - a porta que o próprio processo do teste escuta funciona (o canal cérebro <-> bot depende disso);
//  - DNS de nome externo, UDP para fora, qualquer processo (yt-dlp, powershell, exec, node) e qualquer worker (uma thread nova não herdaria o
//    bloqueio) falham e ficam registrados;
//  - EXCEÇÕES POR TESTE (segunda revisão da Liz, §12): sem exceção global; o icacls, o worker de leitura do HTML da busca e o Node filho só
//    passam quando o teste os DECLARA (com o motivo); sem declarar, ficam bloqueados. O registro das liberações guarda qual teste abriu cada
//    exceção e cada uso dela; o Node filho só abre outro Node que continue bloqueado (o neto anota no mesmo registro);
//  - as duas exceções novas da rodada depois da revisão da Liz (§12 da etapa 8): "programa:node" (um Node SEM bloqueio, só quando o teste declara) e
//    "nome-local:<nome>" (um nome que o teste mapeia para o loopback; só alcança as portas do teste);
//  - REGISTRO ÚNICO (tests/externos.json): o criarBloqueio recusa uma exceção que o teste declara mas o registro não tem;
//  - sem NODE_ENV=test o bloqueio nem deixa o processo subir;
//  - o lado do teste (conferirBloqueio) falha alto quando há registro e passa quando não há.
// (A Yui de verdade com o bloqueio: test:chatturn e test:pesquisa sobem o cérebro e o bot com ele e conferem o registro a cada cenário.)
// Execução: npm run test:bloqueioexterno
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { criarBloqueio, conferirBloqueio, lerBloqueios } from './helpers/bloqueioExternoTeste.js';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-bloqueio-'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };

const SONDA = path.join(T, 'sonda.mjs');
fs.writeFileSync(SONDA, `
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { spawn, execFileSync, exec } from 'node:child_process';
import cp from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
const portaDoPai = Number(process.argv[2]);
const out = {};
const pega = async (nome, fn) => { try { await fn(); out[nome] = 'passou'; } catch (err) { out[nome] = err?.code ?? err?.cause?.code ?? String(err?.message ?? err).slice(0, 80); } };
await pega('fetch_externo', () => fetch('http://192.0.2.1:8080/teste', { signal: AbortSignal.timeout(4000) }));
await pega('fetch_nome_invalido', () => fetch('https://yui-teste.invalid/x', { signal: AbortSignal.timeout(4000) }));
await pega('http_porta_do_pai', () => new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port: portaDoPai, path: '/' }, resolve); r.on('error', reject); r.setTimeout(4000, () => r.destroy(new Error('tempo'))); }));
await pega('net_externo', () => new Promise((resolve, reject) => { const s = net.connect(443, '192.0.2.1'); s.on('connect', resolve); s.on('error', reject); s.setTimeout(4000, () => s.destroy(new Error('tempo'))); }));
await pega('dns', () => dns.promises.lookup('yui-teste.invalid'));
await pega('dns_callback', () => new Promise((resolve, reject) => dns.lookup('yui-teste.invalid', (err) => (err ? reject(err) : resolve()))));
await pega('udp', () => new Promise((resolve, reject) => { const u = dgram.createSocket('udp4'); u.on('error', (e) => { u.close(); reject(e); }); u.send(Buffer.from('x'), 8080, '192.0.2.1', (e) => { u.close(); e ? reject(e) : resolve(); }); }));
await pega('spawn_ytdlp', () => { spawn('yt-dlp', ['--version']); });
await pega('spawn_cp_ytdlp', () => { cp.spawn('yt-dlp', ['--version']); });
await pega('execFileSync_powershell', () => { execFileSync('powershell', ['-NoProfile', '-Command', 'exit 0']); });
await pega('worker_eval', () => { new Worker('1 + 1', { eval: true }); });
await pega('worker_parse', async () => { const w = new Worker(new URL(process.argv[4]), { workerData: {} }); w.on('error', () => {}); await w.terminate(); });
await pega('exec_curl', () => { exec('curl http://192.0.2.1:8080/'); });
// a porta do próprio processo do teste funciona (é o canal cérebro <-> bot)
await pega('porta_propria', () => new Promise((resolve, reject) => {
  const srv = http.createServer((q, s) => s.end('ok'));
  srv.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: '/' }, (res) => { res.resume(); res.on('end', () => { srv.close(); resolve(); }); }).on('error', (e) => { srv.close(); reject(e); });
  });
}));
// um nome que o teste mapeia para o loopback com um lookup próprio (a simulação do DNS rebinding do safeFetch): só passa com a exceção nome-local:rebind.test
// E numa porta aberta por um processo do teste; numa porta alheia continua bloqueado
await pega('nome_local', () => new Promise((resolve, reject) => {
  const srv = net.createServer((s) => s.end());
  srv.listen(0, '127.0.0.1', () => {
    const s = net.connect({ host: 'rebind.test', port: srv.address().port, lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) });
    s.on('connect', () => { s.destroy(); srv.close(); resolve(); });
    s.on('error', (e) => { srv.close(); reject(e); });
  });
}));
await pega('nome_local_porta_alheia', () => new Promise((resolve, reject) => {
  const s = net.connect({ host: 'rebind.test', port: portaDoPai, lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) });
  s.on('connect', () => { s.destroy(); resolve(); });
  s.on('error', reject);
}));
// o IP da PRÓPRIA máquina na rede local (uma interface dela), numa porta que a sonda abriu no loopback: só com ip-da-maquina declarada a conexão sai do bloqueio
// (e o servidor, que escuta só no loopback, a recusa); sem a declaração, bloqueada
await pega('ip_da_maquina', () => new Promise((resolve, reject) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return resolve();
  const srv = net.createServer((s) => s.end());
  srv.listen(0, '127.0.0.1', () => {
    const s = net.connect({ host: lan.address, port: srv.address().port });
    s.on('connect', () => { s.destroy(); srv.close(); resolve(); });
    s.on('error', (e) => { srv.close(); reject(e); });
  });
}));
// util.promisify(execFile) (como o test:approvals faz): continua BLOQUEADO (a versão promisificada do original não pode furar o bloqueio) e, quando o programa é liberado,
// devolve o formato de sempre ({ stdout, stderr })
await pega('promisify_execfile_externo', () => promisify(cp.execFile)('yt-dlp', ['--version']));
await pega('promisify_execfile_node', async () => {
  const r = await promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write(String(40 + 2))']);
  if (r.stdout !== '42') throw new Error('formato: ' + JSON.stringify(r));
});
await pega('icacls_permitido', () => { if (process.platform !== 'win32') return; const f = process.argv[3]; execFileSync('icacls', [f], { stdio: 'ignore', windowsHide: true }); });
// um Node filho que CONTINUA bloqueado (o --import vem pelo NODE_OPTIONS) e tenta a rede: só abre com a exceção node:com-bloqueio
await pega('node_filho_bloqueado', () => {
  const codigo = "fetch('http://192.0.2.1:8080/').then(() => process.stdout.write('passou'), (e) => process.stdout.write(String(e?.cause?.code ?? e?.code)))";
  const r = execFileSync(process.execPath, ['-e', codigo], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r !== 'BLOQUEIO_EXTERNO_TESTE') throw new Error('o neto não ficou bloqueado: ' + r);
});
// um Node filho SEM o bloqueio (env sem o NODE_OPTIONS nem o registro): nunca abre
await pega('node_filho_sem_bloqueio', () => { execFileSync(process.execPath, ['-e', '1'], { env: { PATH: process.env.PATH, NODE_ENV: 'test' }, windowsHide: true }); });
process.stdout.write(JSON.stringify(out));
`);

function rodarSonda(bloqueio, portaDoPai, env = {}) {
  const alvo = path.join(T, `alvo-${Date.now()}.txt`);
  fs.writeFileSync(alvo, 'x');
  const sys = {};
  for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k] !== undefined) sys[k] = process.env[k];
  const parseWorker = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'search', 'parseWorker.js')).href;
  const r = spawnSync(process.execPath, [...bloqueio.argv, SONDA, String(portaDoPai), alvo, parseWorker], { cwd: T, encoding: 'utf8', timeout: 90_000, windowsHide: true, env: { ...sys, NODE_ENV: 'test', ...bloqueio.env('sonda'), ...env } });
  return r;
}

let conexoesNoPai = 0;
const pai = net.createServer((s) => { conexoesNoPai += 1; s.destroy(); });
await new Promise((r) => pai.listen(0, '127.0.0.1', r));
try {
  const LIBERAR = {
    'programa:icacls': 'a sonda confere o icacls do segredo do canal',
    'worker:parseWorker': 'a sonda confere o worker de leitura do HTML da busca',
    'node:com-bloqueio': 'a sonda abre um Node filho que continua bloqueado',
    'nome-local:rebind.test': 'a sonda mapeia o nome falso rebind.test para o loopback',
    'ip-da-maquina': 'a sonda conecta ao IP da própria máquina numa porta que ela mesma abriu',
  };
  const bloqueio = criarBloqueio(path.join(T, 'b1'), { teste: 'test:bloqueioexterno', liberar: LIBERAR, herdar: true });
  let saida = null;
  await test('rede para fora, loopback de outra porta, DNS, UDP e processos: tudo falha com BLOQUEIO_EXTERNO_TESTE', () => {
    const r = rodarSonda(bloqueio, pai.address().port);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    saida = JSON.parse(r.stdout);
    for (const k of ['fetch_externo', 'fetch_nome_invalido', 'http_porta_do_pai', 'net_externo', 'dns', 'dns_callback', 'udp', 'spawn_ytdlp', 'spawn_cp_ytdlp', 'execFileSync_powershell', 'exec_curl', 'worker_eval', 'node_filho_sem_bloqueio', 'nome_local_porta_alheia', 'promisify_execfile_externo']) {
      assert.equal(saida[k], 'BLOQUEIO_EXTERNO_TESTE', `${k}: ${saida[k]}`);
    }
    assert.equal(conexoesNoPai, 0, 'nenhuma conexão chegou à porta que não é do teste');
  });
  await test('com as exceções DECLARADAS pelo teste: a porta própria, o icacls, o worker de leitura e o Node filho (que continua bloqueado) passam', () => {
    assert.equal(saida.porta_propria, 'passou');
    assert.equal(saida.icacls_permitido, 'passou');
    assert.equal(saida.worker_parse, 'passou', 'o worker de leitura do HTML da busca (sem rede) pode ser criado');
    assert.equal(saida.node_filho_bloqueado, 'passou', 'o neto abriu, e a rede dele falhou com o bloqueio');
    assert.equal(saida.nome_local, 'passou', 'o nome local declarado alcança a porta que a sonda abriu');
    assert.equal(saida.promisify_execfile_node, 'passou', 'o promisify(execFile) de um Node que continua bloqueado (node:com-bloqueio) devolve { stdout, stderr }');
    assert.equal(saida.nome_local_porta_alheia, 'BLOQUEIO_EXTERNO_TESTE', 'mas não a porta dos outros');
    // o IP da própria máquina (se a máquina tem um): passa pelo bloqueio e é o servidor (só no loopback) que recusa; nunca o bloqueio
    assert.notEqual(saida.ip_da_maquina, 'BLOQUEIO_EXTERNO_TESTE', 'o IP da própria máquina declarado passa pelo bloqueio');
  });
  await test('o registro das liberações: qual teste declarou cada exceção (com o motivo) e cada uso dela (teste, papel, pid)', () => {
    const declaradas = bloqueio.declaradas();
    assert.deepEqual(declaradas.map((d) => d.excecao).sort(), Object.keys(LIBERAR).sort());
    assert.ok(declaradas.every((d) => d.teste === 'test:bloqueioexterno' && d.motivo));
    const usos = bloqueio.usos();
    const temIpDaRede = Object.values(os.networkInterfaces()).flat().some((i) => i && i.family === 'IPv4' && !i.internal);
    for (const e of ['worker:parseWorker', 'node:com-bloqueio', 'nome-local:rebind.test', ...(temIpDaRede ? ['ip-da-maquina'] : []), ...(process.platform === 'win32' ? ['programa:icacls'] : [])]) {
      assert.ok(usos.some((u) => u.excecao === e && u.teste === 'test:bloqueioexterno' && u.papel === 'sonda' && Number.isInteger(u.pid)), `uso de ${e}`);
    }
    assert.ok(bloqueio.resumo().every((r) => r.usos >= 1 || (r.excecao === 'ip-da-maquina' && !temIpDaRede)), JSON.stringify(bloqueio.resumo()));
    assert.throws(() => criarBloqueio(path.join(T, 'bx'), { liberar: { 'programa:icacls': '' } }), /precisa de um motivo/);
    assert.throws(() => criarBloqueio(path.join(T, 'by'), { liberar: { 'rede:tudo': 'não' } }), /exceção desconhecida/);
    assert.throws(() => criarBloqueio(path.join(T, 'bz'), { herdar: true }), /node:com-bloqueio/);
  });
  await test('SEM declarar: o icacls, o worker de leitura e o Node filho ficam bloqueados (não existe exceção global)', () => {
    const seco = criarBloqueio(path.join(T, 'b4'), { teste: 'sem-excecoes' });
    const r = rodarSonda(seco, pai.address().port);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const s = JSON.parse(r.stdout);
    if (process.platform === 'win32') assert.equal(s.icacls_permitido, 'BLOQUEIO_EXTERNO_TESTE');
    assert.equal(s.worker_parse, 'BLOQUEIO_EXTERNO_TESTE');
    assert.equal(s.node_filho_bloqueado, 'BLOQUEIO_EXTERNO_TESTE');
    assert.equal(s.nome_local, 'BLOQUEIO_EXTERNO_TESTE', 'o nome local sem a exceção também fica bloqueado');
    assert.equal(s.promisify_execfile_node, 'BLOQUEIO_EXTERNO_TESTE', 'o promisify(execFile) do Node também fica bloqueado sem a exceção');
    if (Object.values(os.networkInterfaces()).flat().some((i) => i && i.family === 'IPv4' && !i.internal)) assert.equal(s.ip_da_maquina, 'BLOQUEIO_EXTERNO_TESTE', 'o IP da própria máquina sem a exceção também fica bloqueado');
    assert.equal(seco.usos().length, 0, 'nenhuma exceção usada');
    assert.ok(seco.lista().length > 0 && seco.lista().every((l) => l.teste === 'sem-excecoes'), 'cada tentativa leva o nome do teste');
  });
  await test('cada tentativa ficou registrada (tipo, alvo, papel, pid) e o lado do teste FALHA ALTO com o registro', () => {
    const linhas = lerBloqueios(bloqueio.registro);
    const tipos = new Set(linhas.map((l) => l.tipo));
    for (const t of ['rede', 'dns', 'udp', 'processo', 'worker']) assert.ok(tipos.has(t), `registro de ${t}`);
    assert.ok(linhas.some((l) => l.tipo === 'processo' && /yt-dlp/.test(l.alvo)), 'o yt-dlp ficou registrado');
    assert.ok(linhas.some((l) => l.tipo === 'rede' && l.alvo.endsWith(`:${pai.address().port}`)), 'o loopback de outra porta ficou registrado');
    assert.ok(linhas.every((l) => l.papel === 'sonda' && Number.isInteger(l.pid)));
    assert.throws(() => bloqueio.conferir('sonda'), /INTEGRAÇÃO EXTERNA TENTADA/);
    const limpo = criarBloqueio(path.join(T, 'b2'));
    assert.deepEqual(limpo.conferir('limpo'), []);
    assert.equal(conferirBloqueio(path.join(T, 'nao-existe.jsonl')), 0);
  });
  await test('programa:node: só com a exceção declarada o Node SEM bloqueio abre (e fica no registro); sem ela, nunca', () => {
    const comNode = criarBloqueio(path.join(T, 'b5'), { teste: 'test:bloqueioexterno', liberar: { 'programa:node': 'a sonda abre um Node local sem bloqueio' } });
    const r = rodarSonda(comNode, pai.address().port);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const s = JSON.parse(r.stdout);
    assert.equal(s.node_filho_sem_bloqueio, 'passou', 'com a exceção declarada, o Node local abre');
    assert.equal(s.promisify_execfile_node, 'passou', 'e o promisify(execFile) devolve { stdout, stderr } como sempre');
    assert.equal(s.promisify_execfile_externo, 'BLOQUEIO_EXTERNO_TESTE', 'mas outro programa continua bloqueado, até pelo promisify');
    assert.ok(comNode.usos().some((u) => u.excecao === 'programa:node' && u.teste === 'test:bloqueioexterno'), 'o uso ficou no registro');
    assert.equal(s.fetch_externo, 'BLOQUEIO_EXTERNO_TESTE', 'e o resto continua bloqueado (a exceção é só do programa)');
  });
  await test('REGISTRO ÚNICO: o criarBloqueio recusa a exceção que o teste declara e o tests/externos.json não tem (nem teste sem registro, nem exceção de outro teste)', () => {
    assert.throws(() => criarBloqueio(path.join(T, 'bw1'), { teste: 'test:backup', liberar: { 'programa:qualquercoisa': 'um motivo' } }), /NÃO está\(ão\) no registro/);
    assert.throws(() => criarBloqueio(path.join(T, 'bw2'), { teste: 'teste-que-ninguem-registrou', liberar: { 'programa:icacls': 'um motivo' } }), /NÃO está\(ão\) no registro/);
    assert.throws(() => criarBloqueio(path.join(T, 'bw3'), { teste: 'test:backup', liberar: { 'worker:parseWorker': 'um motivo' } }), /NÃO está\(ão\) no registro/, 'a exceção de OUTRO teste não vale');
    // quem declara exatamente o que o registro tem passa
    assert.doesNotThrow(() => criarBloqueio(path.join(T, 'bw4'), { teste: 'test:backup', liberar: { 'programa:icacls': 'ok', 'programa:whoami': 'ok' } }));
    // e sem exceções, qualquer nome serve (não há o que declarar)
    assert.doesNotThrow(() => criarBloqueio(path.join(T, 'bw5'), { teste: 'qualquer-nome' }));
  });
  await test('sem NODE_ENV=test o bloqueio não deixa o processo subir', () => {
    const r = rodarSonda(criarBloqueio(path.join(T, 'b3')), pai.address().port, { NODE_ENV: 'production' });
    assert.equal(r.status, 97);
    assert.match(r.stderr, /exige NODE_ENV=test/);
  });
  console.log(`\n${passed} testes OK`);
} finally {
  await new Promise((r) => pai.close(r));
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
}
