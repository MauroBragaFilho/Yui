// Etapa 10 (piloto do app, só local): "Reiniciar a Yui" com os DOIS PROCESSOS de verdade. Execução: npm run test:reinicioprocessos
//
// O SUPERVISOR de verdade (src/supervisor.js) abre o cérebro (src/cerebro.js, que serve a API do app) e o bot (src/index.js com YUI_CEREBRO_EXTERNO=true), numa CÓPIA do código em
// pasta temporária, com o DISCORD FALSO e a IA FALSA (só valem com NODE_ENV=test) e o BLOQUEIO de integração externa nos três processos. Nenhum token, banco, pasta nem .env reais.
//  1. o reinício pedido pelo app (POST /v1/admin/restart): membro = 403 e sem `confirm: true` = 400 (nada muda); o dono com a confirmação: 200 com a verdade (cérebro E bot), o
//     supervisor para o bot e depois o cérebro (pedido limpo, sem encerrar à força), sobe o cérebro e depois o bot (que reconecta), as travas passam aos processos novos, não é
//     contado como queda e a auditoria `admin.restart` sai; a conversa pelo app e o diagnóstico seguem funcionando;
//  2. o cérebro rodado SEM supervisor (à mão): o pedido é recusado (503, "nada foi reiniciado"), o cérebro continua de pé e a auditoria diz "recusado", sem "admin.restart".
// Os cenários esperam SINAIS reais (o estado do supervisor, a resposta da API, a linha do log), nunca um tempo fixo. Só são encerrados os processos que este teste abriu, pelo
// handle; os que o supervisor abriu, o próprio supervisor encerra (também pelo handle dele). Nada procura processo por PID.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { criarBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const started = Date.now();
let passed = 0;
let finished = false;
let BLOQUEIO = null;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); BLOQUEIO?.conferir(name); passed += 1; console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localDb = useIsolatedDatabaseDir('yui-reinicio-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-reinicio-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(APP, 'database'));
const DB_SOLTO = assertNotRealDatabaseDir(path.join(T, 'db-solto'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const SECRET_SOLTO = path.join(T, 'secrets', 'channel-secret-solto.json');
const DMS = path.join(T, 'dms.jsonl');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
fs.mkdirSync(TEST_CWD, { recursive: true });
process.chdir(TEST_CWD);
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), {
  teste: 'test:reinicioprocessos',
  herdar: true,
  liberar: {
    ...EXCECOES_DO_CANAL,
    'node:com-bloqueio': 'o supervisor de verdade (src/supervisor.js) abre o cérebro e o bot; os dois continuam com o bloqueio',
    'programa:powershell': 'a trava de dono lê a hora de início do processo dono (src/database/ownerLock.js: Get-CimInstance, só leitura local, sem rede)',
  },
});

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const TOKEN_DONO = `token-dono-de-teste-${crypto.randomBytes(8).toString('hex')}`;
const TOKEN_MEMBRO = `token-membro-de-teste-${crypto.randomBytes(8).toString('hex')}`;
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_MEMORY_ENABLED = 'true';

// ── Cópia do código ────────────────────────────────────────────────────────────────────────────
function copyCode() {
  let files = [];
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src', 'persona', 'knowledge', 'scripts', 'package.json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
  } catch { files = []; }
  let n = 0;
  for (const rel of files) {
    if (/^scripts[\\/](minecraft|modpack)[\\/]/.test(rel)) continue;
    const from = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(from); } catch { continue; }
    if (!st.isFile()) continue;
    const to = path.join(APP, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    n += 1;
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), JUNCTION, 'junction');
  fs.mkdirSync(DB, { recursive: true });
  return n;
}

// ── Processos (só os que este teste abre; encerrados só pelo handle) ─────────────────────────────
const SYSTEM_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'ProgramFiles', 'ProgramData', 'SystemDrive', 'LANG'];
const NATIVE = String(process.env.YUI_DB_NATIVE ?? '').trim();
const COMMON = {
  NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', LOG_LEVEL: 'info',
  YUI_CHANNEL_PORT: '0', YUI_DB_OWNER_HEARTBEAT_MS: '300', YUI_DB_OWNER_STALE_MS: '1500',
  YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'true',
  YUI_ALERTS: 'false', YUI_MORNING_REPORT: 'false', YUI_HEALTH_REPORT: 'false',
  GTA_WEEKLY_ENABLED: 'false', NEWSWIRE_ENABLED: 'false', YOUTUBE_INTERVAL_MINUTES: '0', TWITCH_INTERVAL_MINUTES: '0',
  YUI_GATEWAY_ENABLED: 'false', YUI_TESTE_IA_FALSA: 'true', DISCORD_TOKEN: 'token-falso-de-teste', YUI_RESEARCH_ENABLED: 'false',
};
function childEnv(extra = {}) {
  const env = {};
  for (const k of SYSTEM_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...COMMON, ...(NATIVE ? { YUI_DB_NATIVE: NATIVE } : {}), ...extra };
}
const procs = new Set();
const allProcs = [];
function startProc(label, args, env, { ipc = true } = {}) {
  const child = spawn(process.execPath, [...BLOQUEIO.argv, ...args], { cwd: APP, env: { ...env, ...BLOQUEIO.env(label) }, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const proc = { label, child, out: '', exited: false, code: null };
  allProcs.push(proc);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { proc.out += d; });
  child.stderr.on('data', (d) => { proc.out += d; });
  proc.exit = new Promise((resolve) => child.on('exit', (code, signal) => { proc.exited = true; proc.code = code; procs.delete(proc); resolve({ code, signal }); }));
  procs.add(proc);
  return proc;
}
const tail = (text, n = 30) => String(text).split(/\r?\n/).slice(-n).join('\n');
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(50);
  }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${typeof what === 'function' ? what() : what}`);
}
async function waitExit(proc, timeoutMs) {
  const r = await Promise.race([proc.exit, sleep(timeoutMs).then(() => null)]);
  if (!r) {
    proc.child.kill(); // o processo que ESTE teste abriu (handle), nunca um achado por varredura
    throw new Error(`${proc.label}: não terminou em ${timeoutMs} ms.\n--- saída ---\n${tail(proc.out)}`);
  }
  return r;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
let ipcSeq = 0;
function ipc(proc, msg, replyType, timeoutMs = 8_000) {
  const id = `t${++ipcSeq}`;
  return new Promise((resolve, reject) => {
    const onMsg = (m) => { if (m?.tipo === replyType && m.id === id) { done(); resolve(m); } };
    const timer = setTimeout(() => { done(); reject(new Error(`${proc.label}: sem resposta "${replyType}" em ${timeoutMs} ms`)); }, timeoutMs);
    const done = () => { clearTimeout(timer); proc.child.off('message', onMsg); };
    proc.child.on('message', onMsg);
    try { proc.child.send({ ...msg, id }); } catch (err) { done(); reject(err); }
  });
}

let channelClosers = [];
async function cleanup() {
  if (process.env.YUI_TESTE_MOSTRAR_SAIDA === '1') {
    for (const p of allProcs) console.log(`\n===== ${p.label} (código ${p.code}) =====\n${p.out}`);
    for (const f of ['supervisor.log', 'cerebro-saida.log', 'bot-saida.log']) {
      try { console.log(`\n===== logs/${f} =====\n${tail(fs.readFileSync(path.join(APP, 'logs', f), 'utf8'), 80)}`); } catch { /* */ }
    }
  }
  for (const fn of channelClosers.splice(0)) { try { await fn(); } catch { /* */ } }
  // Supervisores primeiro (eles param os filhos deles pelo handle); depois o que sobrar deste teste.
  for (const proc of [...procs].filter((p) => p.label.startsWith('supervisor'))) {
    try { proc.child.send({ tipo: 'desligar' }); } catch { /* */ }
    await Promise.race([proc.exit, sleep(20_000)]);
  }
  for (const proc of [...procs]) {
    try { proc.child.send({ tipo: 'desligar' }); } catch { /* */ }
    await Promise.race([proc.exit, sleep(8_000)]);
    try { proc.child.kill(); } catch { /* já saiu */ }
    await Promise.race([proc.exit, sleep(3000)]);
  }
  try { process.chdir(ROOT); } catch { /* */ }
  try { (await import('../src/database/db.js')).closeAllDatabases(); } catch { /* */ }
  await sleep(300);
  let junctionGone = false;
  try { fs.unlinkSync(JUNCTION); } catch { /* */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[reinicio] não consegui apagar ${T}: ${err.message}`); }
  } else {
    console.warn(`[reinicio] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  }
  localDb.cleanup();
}
process.on('exit', () => {
  for (const proc of procs) { try { proc.child.kill(); } catch { /* */ } }
  if (!finished && process.exitCode === undefined) process.exitCode = 1;
});

const readLock = (dir, name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.db.owner`), 'utf8')); } catch { return null; } };
const supLog = () => { try { return fs.readFileSync(path.join(APP, 'logs', 'supervisor.log'), 'utf8'); } catch { return ''; } };
const auditEvents = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let apiPort = 0;
async function api(port, token, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
const LOAD_ERRORS = /ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|Cannot find (?:module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED|TypeError: .* is not a function/;

try {
  console.log('Preparação');
  await test('cópia do código numa pasta temporária (node_modules por junção) e portas livres', async () => {
    const n = copyCode();
    assert.ok(n > 100, `poucos arquivos copiados (${n})`);
    assert.ok(!fs.existsSync(path.join(APP, '.env')), 'a cópia não pode ter .env');
    apiPort = await freePort();
  });

  const supEnv = () => childEnv({
    DATABASE_DIR: DB, YUI_CHANNEL_SECRET_FILE: SECRET, YUI_CEREBRO_EXTERNO: 'true',
    YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: DMS, YUI_TESTE_DISCORD_FALSO_ATRASO_MS: '500',
    YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(apiPort), YUI_API_TOKENS: `${TOKEN_DONO}=${OWNER},${TOKEN_MEMBRO}=${MEMBER}`,
    YUI_CEREBRO_LEMBRETES_MS: '300', YUI_CEREBRO_DM_TIMEOUT_MS: '6000',
    YUI_SUPERVISOR_SAUDE_MS: '400', YUI_SUPERVISOR_PRAZO_SAUDE_MS: '2000', YUI_SUPERVISOR_FALHAS: '3',
    YUI_SUPERVISOR_ESPERA_MIN_MS: '200', YUI_SUPERVISOR_ESPERA_MAX_MS: '2000', YUI_SUPERVISOR_ESTAVEL_MS: '60000',
    YUI_SUPERVISOR_PARADA_MS: '15000', YUI_SUPERVISOR_ESPERA_CEREBRO_MS: '30000', YUI_SUPERVISOR_SUBIDA_MS: '60000',
    YUI_SUPERVISOR_REINICIO_ATRASO_MS: '700', YUI_SUPERVISOR_SAIDA: 'arquivo',
  });
  const supState = async (sup) => (await ipc(sup, { tipo: 'estado' }, 'estado')).estado;
  async function waitState(sup, pred, timeoutMs, what) {
    let last = null;
    await waitUntil(async () => { last = await supState(sup); return pred(last); }, timeoutMs, () => `${what}\n--- estado ---\n${JSON.stringify(last?.processos ?? last, null, 1).slice(0, 1500)}\n--- supervisor.log ---\n${tail(supLog(), 25)}`);
    return last;
  }
  const bothReady = (st) => st.processos.cerebro?.estado === 'pronto' && st.processos.bot?.estado === 'pronto';
  const audit = () => auditEvents(path.join(APP, 'logs', 'core-audit.jsonl'));

  console.log('1. Reiniciar a Yui com o supervisor de verdade (cérebro + bot)');
  let sup;
  let antes;
  await test('os dois sobem (o cérebro serve a API do app) e o bot conecta no cérebro', async () => {
    sup = startProc('supervisor#1', ['src/supervisor.js'], supEnv());
    antes = await waitState(sup, bothReady, 90_000, 'os dois ficarem prontos');
    await waitUntil(async () => (await api(apiPort, TOKEN_DONO, 'GET', '/v1/health').catch(() => ({ json: null }))).json?.cerebro?.bot === true, 20_000, 'o bot conectar no canal do cérebro');
    assert.equal(antes.modo, 'dois');
    assert.equal(antes.reinicioControlado.total, 0);
    assert.equal(antes.reinicioControlado.emCurso, false);
    const me = await api(apiPort, TOKEN_DONO, 'GET', '/v1/me');
    assert.equal(me.json.role, 'OWNER');
    // a visão geral do app mostra que é o cérebro separado (é o que a tela usa para dizer o que o reinício reinicia)
    const ov = await api(apiPort, TOKEN_DONO, 'GET', '/v1/admin/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.json.cerebro?.botConectado, true);
  });

  await test('membro = 403 e sem `confirm: true` = 400: NADA reinicia (os mesmos processos, nenhuma parada)', async () => {
    assert.equal((await api(apiPort, null, 'POST', '/v1/admin/restart', { confirm: true })).status, 401);
    assert.equal((await api(apiPort, TOKEN_MEMBRO, 'POST', '/v1/admin/restart', { confirm: true })).status, 403);
    assert.equal((await api(apiPort, TOKEN_DONO, 'POST', '/v1/admin/restart', {})).status, 400);
    assert.equal((await api(apiPort, TOKEN_DONO, 'POST', '/v1/admin/restart', { confirm: 'sim' })).status, 400);
    await ipc(sup, { tipo: 'verificar' }, 'verificado', 15_000);
    const depois = await supState(sup);
    assert.equal(depois.processos.cerebro.pid, antes.processos.cerebro.pid);
    assert.equal(depois.processos.bot.pid, antes.processos.bot.pid);
    assert.equal(depois.processos.cerebro.inicios, 1);
    assert.equal(depois.processos.bot.inicios, 1);
    assert.equal(depois.reinicioControlado.total, 0);
    assert.equal(audit().filter((e) => e.event === 'admin.restart' || e.event === 'admin.restart.recusado').length, 0, 'sem ordem válida do dono não há registro de reinício');
  });

  let respostaDoReinicio;
  let tempoDoReinicioMs;
  await test('o dono com a confirmação: 200 com a verdade; o bot para, depois o cérebro (pedido limpo); o cérebro sobe, depois o bot; os dois processos são NOVOS e prontos', async () => {
    const t0 = Date.now();
    respostaDoReinicio = await api(apiPort, TOKEN_DONO, 'POST', '/v1/admin/restart', { confirm: true });
    assert.equal(respostaDoReinicio.status, 200, JSON.stringify(respostaDoReinicio.json));
    assert.equal(respostaDoReinicio.json.ok, true);
    assert.equal(respostaDoReinicio.json.escopo, 'cerebro-e-bot');
    assert.match(respostaDoReinicio.json.message, /cérebro/i);
    assert.match(respostaDoReinicio.json.message, /\bbot\b/i);
    const depois = await waitState(sup, (s) => bothReady(s) && s.processos.cerebro.pid !== antes.processos.cerebro.pid && s.processos.bot.pid !== antes.processos.bot.pid && !s.reinicioControlado.emCurso, 90_000, 'os dois novos ficarem prontos');
    tempoDoReinicioMs = Date.now() - t0;
    assert.ok(Date.parse(depois.processos.cerebro.prontoEm) <= Date.parse(depois.processos.bot.iniciadoEm), 'o bot novo só sobe depois de o cérebro novo avisar "pronto"');
    const log = supLog();
    const iPararBot = log.indexOf('bot: parou para o reinício controlado');
    const iPararCerebro = log.indexOf('cerebro: parou para o reinício controlado');
    assert.ok(iPararBot > 0 && iPararCerebro > iPararBot, `o bot precisa parar antes do cérebro\n${tail(log, 20)}`);
    assert.match(log, /bot: parou para o reinício controlado \(código 0\)/, 'o bot saiu limpo');
    assert.match(log, /cerebro: parou para o reinício controlado \(código 0\)/, 'o cérebro saiu limpo');
    assert.doesNotMatch(log, /encerrando pelo handle/, 'ninguém foi encerrado à força');
    assert.doesNotMatch(log, /saiu sozinho|queda seguida/, 'o supervisor não chama de queda');
    assert.match(log, /REINÍCIO CONTROLADO dos dois processos \(pedido-do-dono, pedido por: cerebro\)/);
    for (const papel of ['cerebro', 'bot']) {
      assert.equal(depois.processos[papel].inicios, 2, `${papel}: subiu duas vezes`);
      assert.equal(depois.processos[papel].quedasSeguidas, 0, `${papel}: não foi queda`);
      assert.equal(depois.processos[papel].religadas, 0);
    }
    assert.equal(depois.reinicioControlado.total, 1);
    assert.equal(depois.reinicioControlado.ultimo.origem, 'cerebro');
    assert.doesNotMatch(fs.readFileSync(path.join(APP, 'logs', 'cerebro-saida.log'), 'utf8') + fs.readFileSync(path.join(APP, 'logs', 'bot-saida.log'), 'utf8'), LOAD_ERRORS);
    antes = depois;
  });

  await test('depois do reinício: o bot reconecta no cérebro novo, as travas são dos processos novos, a auditoria tem o `admin.restart`, e a conversa e o diagnóstico do app funcionam', async () => {
    await waitUntil(async () => (await api(apiPort, TOKEN_DONO, 'GET', '/v1/health').catch(() => ({ json: null }))).json?.cerebro?.bot === true, 30_000, 'o bot novo conectar no cérebro novo');
    assert.equal(readLock(DB, 'memory-personal')?.pid, antes.processos.cerebro.pid, 'a memória é do cérebro novo');
    assert.equal(readLock(DB, 'core')?.pid, antes.processos.bot.pid, 'o core é do bot novo');
    const ev = audit().filter((e) => e.event === 'admin.restart');
    assert.equal(ev.length, 1, 'uma ordem do dono, um registro');
    assert.equal(ev[0].escopo, 'cerebro-e-bot');
    assert.equal(ev[0].role, 'OWNER');
    assert.equal(audit().filter((e) => e.event === 'admin.restart.recusado').length, 0);
    const conversa = await api(apiPort, TOKEN_DONO, 'POST', '/v1/chat', { message: 'oi, voltou do reinício?' });
    assert.equal(conversa.status, 200, JSON.stringify(conversa.json));
    assert.ok(String(conversa.json.reply).length > 0);
    const d = await api(apiPort, TOKEN_DONO, 'GET', '/v1/admin/diagnostico');
    assert.equal(d.status, 200);
    assert.equal(d.json.modo, 'cerebro-separado');
    assert.equal(d.json.cerebro.botConectado, true);
    assert.ok(d.json.perfisDeIa && d.json.motorAgente);
    assert.equal((await api(apiPort, TOKEN_MEMBRO, 'GET', '/v1/admin/diagnostico')).status, 403, 'o membro continua sem ver o diagnóstico');
    const { verifyAudit } = await import('../src/core/audit.js');
    assert.equal(verifyAudit(path.join(APP, 'logs', 'core-audit.jsonl')).ok, true, 'a cadeia da auditoria íntegra');
    console.log(`     (o reinício dos dois, do pedido até os dois prontos: ${(tempoDoReinicioMs / 1000).toFixed(1)} s neste PC)`);
  });

  await test('parada limpa no fim: o supervisor desliga o bot e depois o cérebro; todas as travas soltas', async () => {
    fs.writeFileSync(path.join(APP, 'logs', 'supervisor.parar'), new Date().toISOString());
    const { code } = await waitExit(sup, 60_000);
    assert.equal(code, 0, tail(supLog()));
    assert.deepEqual(fs.readdirSync(DB).filter((f) => f.endsWith('.owner')), [], 'todas as travas de dono soltas');
  });

  console.log('2. O cérebro rodado SEM supervisor (à mão): o pedido é recusado e nada reinicia');
  await test('POST /v1/admin/restart: 503 "nada foi reiniciado"; o cérebro continua de pé; a auditoria diz "recusado" e não tem "admin.restart"', async () => {
    const porta = await freePort();
    const solto = startProc('cerebro-solto', ['src/cerebro.js'], childEnv({
      DATABASE_DIR: DB_SOLTO, YUI_CHANNEL_SECRET_FILE: SECRET_SOLTO, YUI_AUDIT_FILE: path.join(T, 'audit-solto.jsonl'),
      YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(porta), YUI_API_TOKENS: `${TOKEN_DONO}=${OWNER}`,
    }), { ipc: false });
    fs.mkdirSync(DB_SOLTO, { recursive: true });
    await waitUntil(async () => (await api(porta, null, 'GET', '/v1/health').catch(() => null))?.status === 200, 60_000, () => `o cérebro solto subir\n${tail(solto.out)}`);
    const r = await api(porta, TOKEN_DONO, 'POST', '/v1/admin/restart', { confirm: true });
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.match(r.json.error, /Nada foi reiniciado/);
    assert.match(r.json.error, /supervisor/);
    assert.equal(solto.exited, false, 'o cérebro continua de pé (nada o encerrou)');
    assert.equal((await api(porta, null, 'GET', '/v1/health')).status, 200);
    const ev = auditEvents(path.join(T, 'audit-solto.jsonl'));
    assert.equal(ev.filter((e) => e.event === 'admin.restart').length, 0);
    assert.equal(ev.filter((e) => e.event === 'admin.restart.recusado').length, 1);
    assert.equal(ev.find((e) => e.event === 'admin.restart.recusado').motivo, 'sem-supervisor');
    // o desligamento é feito por este teste, pelo handle (pedido limpo e, no limite, o handle)
    solto.child.kill();
    await waitExit(solto, 30_000);
  });

  console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);
