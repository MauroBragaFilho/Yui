// BLOQUEIO EXPLÍCITO de integração externa nos testes com PROCESSOS DE VERDADE (regra da Liz depois do incidente do download_audio, relatório
// da etapa 6, §10 a §12). Carregado ANTES do código da Yui em cada processo que o teste abre:
//
//   spawn(process.execPath, ['--import', URL_DESTE_ARQUIVO, 'src/cerebro.js'], { env: { ..., NODE_ENV: 'test', ...bloqueio.env('cerebro') } })
//
// O que fica bloqueado (e REGISTRADO, uma linha JSON por tentativa, no arquivo YUI_TESTE_BLOQUEIO_REGISTRO):
//  - REDE: toda conexão TCP/TLS (net.Socket#connect: é por onde passam http, https, fetch/undici, axios, WebSocket e o discord.js) para fora do
//    loopback; e, no loopback, toda porta que NÃO foi aberta por um processo deste teste (cada porta que um processo do teste escuta é anotada
//    em YUI_TESTE_BLOQUEIO_PORTAS). Assim nem um LM Studio, OmniRoute ou Ollama de verdade na máquina pode ser alcançado;
//  - DNS: dns.lookup / dns.promises.lookup / resolve* de qualquer nome que não seja "localhost";
//  - UDP (dgram): envio ou conexão para fora do loopback;
//  - PROCESSOS: spawn, exec, execFile, fork (e as versões Sync) de QUALQUER programa (yt-dlp, ffmpeg, spotdl, deemix, powershell, curl, node...);
//  - WORKERS (worker_threads): uma thread nova não herdaria os bloqueios acima.
//
// EXCEÇÕES POR TESTE (segunda revisão da Liz, §12): não existe mais exceção global. Cada teste declara SÓ o que ele precisa, em
// YUI_TESTE_BLOQUEIO_LIBERAR (lista separada por vírgula; quem monta é tests/helpers/bloqueioExternoTeste.js, com o motivo de cada uma), e o
// nome do teste vai em YUI_TESTE_BLOQUEIO_TESTE. As exceções que existem:
//  - "programa:<nome>": aquele programa, pelo nome do executável (ex.: "programa:icacls" e "programa:whoami", que o canal usa para restringir a
//    permissão do arquivo do segredo no Windows; não usam rede nem baixam nada);
//  - "worker:parseWorker": o worker de leitura do HTML da busca (src/search/parseWorker.js: só analisa um texto já baixado, sem rede);
//  - "node:com-bloqueio": abrir OUTRO processo do Node (o supervisor abrindo o cérebro e o bot), só se o filho também carregar este bloqueio
//    (NODE_OPTIONS ou argumentos com o --import deste arquivo) e as variáveis do registro: o neto continua bloqueado;
//  - "programa:node": abrir o Node SEM bloqueio (um comando local cadastrado que só imprime texto, como no teste da ferramenta commands.run). Só para o
//    teste que prova que precisa dele; prefira "node:com-bloqueio";
//  - "nome-local:<nome>": um nome que o TESTE mapeia para o loopback com um lookup próprio (a simulação do DNS rebinding do safeFetch). A conexão a esse nome
//    só passa se a porta for uma porta aberta por um processo do teste (as mesmas regras do loopback);
//  - "ip-da-maquina": o IP da PRÓPRIA máquina na rede local (uma das interfaces dela), só em portas abertas por um processo do teste: o teste do canal confere
//    que o servidor NÃO escuta fora do loopback (a conexão ao IP da rede tem de ser recusada). Nada sai da máquina.
// Toda exceção vale por TESTE e está no registro único tests/externos.json (teste, recurso e justificativa): o criarBloqueio recusa uma que não esteja lá.
// Cada USO de uma exceção vira uma linha em YUI_TESTE_BLOQUEIO_LIBERACOES ({ tipo: 'uso', excecao, alvo, teste, papel, pid }): o registro mostra
// qual teste abriu cada exceção e o que passou por ela. Programa fora da lista do teste continua bloqueado (e registrado).
// A tentativa bloqueada vira um erro com o código BLOQUEIO_EXTERNO_TESTE (a rede falha como uma conexão recusada; o processo nem é criado) e
// uma linha no registro. O teste lê o registro depois de cada cenário e FALHA ALTO se houver qualquer linha (tests/helpers/bloqueioExternoTeste.js:
// conferirBloqueio). Este arquivo tem efeitos ao ser carregado: o processo do TESTE nunca o importa, só os filhos (--import). Os buscadores e a
// IA de verdade, que são integrações de rede, caem na regra da rede.
// Só liga com NODE_ENV=test; fora disso, o processo nem sobe (este arquivo é só de teste).
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import wt from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

export const CODIGO = 'BLOQUEIO_EXTERNO_TESTE';
const ESTE_ARQUIVO = import.meta.url;
const REGISTRO = String(process.env.YUI_TESTE_BLOQUEIO_REGISTRO ?? '').trim();
const PORTAS = String(process.env.YUI_TESTE_BLOQUEIO_PORTAS ?? '').trim();
const LIBERACOES = String(process.env.YUI_TESTE_BLOQUEIO_LIBERACOES ?? '').trim();
const TESTE = String(process.env.YUI_TESTE_BLOQUEIO_TESTE ?? '').trim() || '(teste sem nome)';
const PAPEL = String(process.env.YUI_TESTE_BLOQUEIO_PAPEL ?? '').trim() || path.basename(process.argv[1] ?? 'processo');
/** As exceções que ESTE teste declarou (nada global). */
const LIBERADAS = new Set(String(process.env.YUI_TESTE_BLOQUEIO_LIBERAR ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const semExtensao = (nome) => path.basename(String(nome ?? '')).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
/** A exceção que libera este programa NESTE teste (ou null). Pelo nome do executável, sem caminho nem extensão. */
export function excecaoDoPrograma(comando, liberadas = LIBERADAS) {
  const nome = semExtensao(comando);
  const chave = `programa:${nome}`;
  return nome && liberadas.has(chave) ? chave : null;
}
/** O endereço é do próprio computador (loopback)? */
export function ehLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function anotar(arquivo, linha) {
  try { if (arquivo) fs.appendFileSync(arquivo, `${JSON.stringify(linha)}\n`); } catch { /* o registro nunca derruba o processo */ }
}
function registrar(tipo, alvo) {
  const linha = { tipo, alvo: String(alvo ?? '').slice(0, 200), teste: TESTE, papel: PAPEL, pid: process.pid, at: new Date().toISOString() };
  anotar(REGISTRO, linha);
  try { process.stderr.write(`[BLOQUEIO_EXTERNO_TESTE] ${tipo} -> ${linha.alvo}\n`); } catch { /* */ }
}
/** Um uso de uma exceção declarada pelo teste (fica no registro das liberações, com o nome do teste). */
function usou(excecao, alvo) {
  anotar(LIBERACOES, { tipo: 'uso', excecao, alvo: String(alvo ?? '').slice(0, 200), teste: TESTE, papel: PAPEL, pid: process.pid, at: new Date().toISOString() });
}
function erro(tipo, alvo) {
  registrar(tipo, alvo);
  return Object.assign(new Error(`Integração externa bloqueada no teste (${tipo}: ${String(alvo).slice(0, 80)})`), { code: CODIGO });
}

if (String(process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'test') {
  process.stderr.write('[BLOQUEIO_EXTERNO_TESTE] este bloqueio é só de teste e exige NODE_ENV=test.\n');
  process.exit(97);
}

// ── Portas abertas pelos processos DESTE teste (o loopback só vale para elas) ──
function portasDoTeste() {
  if (!PORTAS) return new Set();
  try { return new Set(fs.readFileSync(PORTAS, 'utf8').split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0)); } catch { return new Set(); }
}
const listenOriginal = net.Server.prototype.listen;
net.Server.prototype.listen = function listenDoTeste(...args) {
  this.once('listening', () => {
    try {
      const a = this.address();
      if (a && typeof a === 'object' && a.port && PORTAS) fs.appendFileSync(PORTAS, `${a.port}\n`);
    } catch { /* */ }
  });
  return listenOriginal.apply(this, args);
};

/** Os endereços das interfaces da PRÓPRIA máquina (para a exceção "ip-da-maquina"). */
function ipsDaMaquina() {
  const ips = new Set();
  try { for (const lista of Object.values(os.networkInterfaces())) for (const i of lista ?? []) if (i?.address) ips.add(String(i.address).toLowerCase()); } catch { /* */ }
  return ips;
}

// ── Rede (TCP/TLS) ──
const connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connectDoTeste(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0]; // forma interna (normalizada) do Node
  let host;
  let port;
  let pipe = null;
  if (opts && typeof opts === 'object') { host = opts.host ?? opts.hostname; port = opts.port; pipe = opts.path ?? null; }
  else if (typeof opts === 'string' && !/^\d+$/.test(opts)) pipe = opts;
  else { port = opts; host = typeof args[1] === 'string' ? args[1] : undefined; }
  if (pipe) return connectOriginal.apply(this, args); // pipe local (IPC): não é rede
  const p = Number(port);
  // um nome local DECLARADO pelo teste (nome-local:<nome>) vale como o loopback; o resto da regra (a porta ser do teste) não muda
  const nomeDeclarado = !ehLoopback(host) && LIBERADAS.has(`nome-local:${String(host ?? '').toLowerCase()}`);
  const ipDaMaquina = !ehLoopback(host) && !nomeDeclarado && LIBERADAS.has('ip-da-maquina') && ipsDaMaquina().has(String(host ?? '').trim().toLowerCase());
  const local = ehLoopback(host) || nomeDeclarado || ipDaMaquina;
  if (!local || !portasDoTeste().has(p)) {
    const e = erro('rede', `${host ?? 'localhost'}:${port}`);
    process.nextTick(() => this.destroy(e));
    return this;
  }
  if (nomeDeclarado) usou(`nome-local:${String(host).toLowerCase()}`, `${host}:${port}`);
  if (ipDaMaquina) usou('ip-da-maquina', `${host}:${port}`);
  return connectOriginal.apply(this, args);
};

// ── DNS ──
const nomeLocal = (n) => ehLoopback(n) || String(n ?? '').toLowerCase() === 'localhost';
const lookupOriginal = dns.lookup;
dns.lookup = function lookupDoTeste(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (!nomeLocal(hostname)) { const e = erro('dns', hostname); process.nextTick(() => cb?.(e)); return {}; }
  return lookupOriginal.call(this, hostname, options, callback);
};
const promLookupOriginal = dns.promises.lookup;
dns.promises.lookup = async function lookupPromessaDoTeste(hostname, options) {
  if (!nomeLocal(hostname)) throw erro('dns', hostname);
  return promLookupOriginal.call(this, hostname, options);
};
for (const nome of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt', 'resolveSrv', 'resolveNs']) {
  if (typeof dns[nome] === 'function') {
    dns[nome] = function resolveDoTeste(hostname, ...rest) { const cb = rest.at(-1); const e = erro('dns', hostname); process.nextTick(() => (typeof cb === 'function' ? cb(e) : null)); return {}; };
  }
  if (typeof dns.promises[nome] === 'function') dns.promises[nome] = async (hostname) => { throw erro('dns', hostname); };
}

// ── UDP ──
const udpSendOriginal = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function sendDoTeste(...args) {
  const destino = args.find((a, i) => i > 0 && typeof a === 'string');
  if (!ehLoopback(destino ?? 'localhost')) { const e = erro('udp', destino); const cb = args.at(-1); process.nextTick(() => (typeof cb === 'function' ? cb(e) : this.emit('error', e))); return undefined; }
  return udpSendOriginal.apply(this, args);
};
const udpConnectOriginal = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function udpConnectDoTeste(port, address, cb) {
  if (!ehLoopback(typeof address === 'string' ? address : 'localhost')) { const e = erro('udp', `${address}:${port}`); process.nextTick(() => this.emit('error', e)); return undefined; }
  return udpConnectOriginal.call(this, port, address, cb);
};

// ── Processos ──
const ehNode = (programa) => {
  const p = String(programa ?? '');
  return p === process.execPath || ['node'].includes(semExtensao(p));
};
/** O filho do Node vai carregar ESTE bloqueio (pelos argumentos ou pelo NODE_OPTIONS) e as variáveis do registro? */
function filhoComBloqueio(args, opcoes) {
  const lista = Array.isArray(args) ? args.map(String) : [];
  const env = opcoes && typeof opcoes === 'object' && opcoes.env ? opcoes.env : process.env;
  const pelosArgs = lista.some((a, i) => (a === '--import' && lista[i + 1] === ESTE_ARQUIVO) || a === `--import=${ESTE_ARQUIVO}`);
  const pelasOpcoes = String(env?.NODE_OPTIONS ?? '').includes(ESTE_ARQUIVO);
  return (pelosArgs || pelasOpcoes) && String(env?.YUI_TESTE_BLOQUEIO_REGISTRO ?? '') === REGISTRO && String(env?.NODE_ENV ?? '').toLowerCase() === 'test';
}
for (const nome of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[nome];
  cp[nome] = function processoDoTeste(comando, ...rest) {
    // exec/execSync recebem a linha inteira: o programa é a 1ª palavra; fork abre sempre o próprio Node
    const programa = nome === 'exec' || nome === 'execSync' ? String(comando ?? '').trim().split(/\s+/)[0].replace(/^"|"$/g, '') : (nome === 'fork' ? process.execPath : comando);
    if (nome !== 'fork' && ehNode(programa) && LIBERADAS.has('programa:node')) {
      usou('programa:node', `${nome} node`);
      return original.call(this, comando, ...rest);
    }
    if (nome !== 'fork' && !ehNode(programa)) {
      const excecao = excecaoDoPrograma(programa);
      if (excecao) { usou(excecao, `${nome} ${semExtensao(programa)}`); return original.call(this, comando, ...rest); }
    } else if (LIBERADAS.has('node:com-bloqueio') && nome !== 'exec' && nome !== 'execSync') {
      // o Node só abre outro Node que continue bloqueado (o neto carrega este arquivo e anota no mesmo registro)
      const opcoes = Array.isArray(rest[0]) ? rest[1] : rest[0];
      const args = nome === 'fork' ? [...(opcoes?.execArgv ?? process.execArgv)] : rest[0];
      if (filhoComBloqueio(args, opcoes)) { usou('node:com-bloqueio', `${nome} ${path.basename(String(Array.isArray(rest[0]) ? rest[0].at(-1) : comando)).slice(0, 60)}`); return original.call(this, comando, ...rest); }
    }
    throw erro('processo', `${nome} ${path.basename(String(programa ?? ''))}`);
  };
}
// util.promisify(exec/execFile) usa a versão "promisificada" do ORIGINAL (que não passa pelo bloqueio) e devolve { stdout, stderr }: sem isto o teste que faz
// `promisify(execFile)` receberia só o stdout. A versão do bloqueio chama a função BLOQUEADA e devolve o mesmo formato.
for (const nome of ['exec', 'execFile']) {
  cp[nome][promisify.custom] = (...args) => new Promise((resolve, reject) => {
    cp[nome](...args, (err, stdout, stderr) => { if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr }); });
  });
}

// ── Workers ──
const WorkerOriginal = wt.Worker;
const ehParseWorker = (arquivo) => /[\\/]search[\\/]parseWorker\.js$/.test(String(arquivo instanceof URL ? arquivo.pathname : arquivo ?? '').replace(/%5C/gi, '/'));
wt.Worker = class WorkerDoTeste extends WorkerOriginal {
  constructor(arquivo, opcoes = {}) {
    const alvo = opcoes?.eval === true ? 'eval' : path.basename(String(arquivo instanceof URL ? arquivo.pathname : arquivo));
    if (opcoes?.eval === true || !ehParseWorker(arquivo) || !LIBERADAS.has('worker:parseWorker')) throw erro('worker', alvo);
    usou('worker:parseWorker', alvo);
    super(arquivo, opcoes);
  }
};

syncBuiltinESMExports(); // as importações nomeadas (import { spawn } from 'node:child_process') passam a ver as versões bloqueadas
