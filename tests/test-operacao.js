// Etapa 4: OPERAÇÃO DOS DOIS PROCESSOS (docs/RELATORIO_ETAPA4_OPERACAO.md).
// Execução: npm run test:operacao
//
// O que prova, com processos de verdade:
//  A. o SUPERVISOR de verdade (src/supervisor.js) sobe o cérebro, espera ele ficar pronto e só então sobe o bot; cuida da
//     saúde de cada um; religa com espera crescente quem cai (o bot, o cérebro, os dois juntos); o bot reconecta o WebSocket;
//     um segundo cérebro e um segundo supervisor são recusados; o lembrete sai UMA vez, também quando o bot morre no meio do
//     envio; o backup da memória e o externo funcionam com o cérebro rodando, sem tomar a trava; a parada pelo arquivo de
//     pedido desliga o bot e depois o cérebro, de forma limpa (travas e segredo soltos);
//  B. a idempotência PERSISTENTE no bot de verdade (src/index.js), com o teste fazendo o papel do cérebro: a mesma chave não
//     repete a DM depois de um reinício limpo nem depois de o bot ser derrubado no meio do envio;
//  C. o comportamento do supervisor SIMULADO (processos falsos): espera crescente, travado, ordem de subida e de parada,
//     espera das travas do processo morto, Discord fora, modo único igual ao laço de hoje;
//  D. a política unificada do memory.admin_wipe_user pelo canal de verdade (cérebro de verdade, confirmação do alvo);
//  e mede a RAM e a CPU de cada processo (só dos que este teste abriu, pelo próprio processo, via IPC).
//
// Isolamento (igual ao test-separacao.js): cópia do código em pasta temporária com node_modules por junção; bancos, segredo,
// logs e DMs na pasta temporária; ambiente montado do zero (nenhum token ou chave real); IA FALSA e DISCORD FALSO (só valem
// com NODE_ENV=test). Só são encerrados os processos que este teste abriu, pelo handle; os que o supervisor abriu, o próprio
// supervisor encerra (também pelo handle dele). Nada procura processo por PID.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { criarBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const started = Date.now();
let passed = 0;
let finished = false;
// Segunda revisão da Liz (etapa 6, §12): cada processo que este teste abre (e os que o supervisor abre) carrega o BLOQUEIO de integração
// externa; cada cenário confere o registro.
let BLOQUEIO = null;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); BLOQUEIO?.conferir(name); passed += 1; console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Pastas temporárias ─────────────────────────────────────────────────────────────────────────
const localDb = useIsolatedDatabaseDir('yui-operacao-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-operacao-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(APP, 'database')); // dentro da cópia: o backup externo usa <pasta>/database
const DB_B = assertNotRealDatabaseDir(path.join(T, 'db-b'));
const DB_D = assertNotRealDatabaseDir(path.join(T, 'db-d'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const SECRET_B = path.join(T, 'secrets', 'channel-secret-b.json');
const SECRET_D = path.join(T, 'secrets', 'channel-secret-d.json');
const DMS = path.join(T, 'dms-a.jsonl');
const DMS_B = path.join(T, 'dms-b.jsonl');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
for (const d of [DB_B, DB_D, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);
// Só as exceções que ESTE teste precisa (cada uma com o motivo; o registro guarda o teste e cada uso):
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), {
  teste: 'test:operacao',
  // o supervisor de verdade abre o cérebro e o bot: o Node filho só abre se carregar o mesmo bloqueio (NODE_OPTIONS)
  herdar: true,
  liberar: {
    ...EXCECOES_DO_CANAL,
    'node:com-bloqueio': 'o supervisor de verdade (src/supervisor.js) abre o cérebro e o bot; os dois continuam com o bloqueio',
    'programa:powershell': 'a trava de dono lê a hora de início do processo dono (src/database/ownerLock.js: Get-CimInstance, só leitura local, sem rede)',
    'programa:git': 'o backup externo empurra para um repositório "bare" LOCAL na pasta temporária, no lugar do GitHub (sem rede)',
  },
});

const OWNER = '111111111111111111';
const OTHER = '333333333333333333';
const GUILD = '222222222222222222';
const CHANNEL = '444444444444444444';
const TOKEN = `token-do-app-de-teste-${crypto.randomBytes(8).toString('hex')}`;
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_MEMORY_ENABLED = 'true';

// ── Cópia do código ────────────────────────────────────────────────────────────────────────────
function listCodeFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src', 'persona', 'knowledge', 'scripts', 'package.json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\0').filter(Boolean);
    if (files.length > 50) return files;
  } catch { /* sem git: cai para a cópia filtrada */ }
  const files = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = path.join(rel, d.name);
      if (d.isDirectory()) { if (!d.name.startsWith('temp_') && d.name !== 'node_modules') walk(r); continue; }
      if (/\.(exe|db|db-wal|db-shm|tmp|log)$/i.test(d.name)) continue;
      if (fs.statSync(path.join(ROOT, r)).size > 20 * 1024 * 1024) continue;
      files.push(r);
    }
  };
  for (const dir of ['src', 'persona', 'knowledge', 'scripts']) if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  files.push('package.json');
  return files;
}
function copyCode() {
  let n = 0;
  for (const rel of listCodeFiles()) {
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
  YUI_GATEWAY_ENABLED: 'false', YUI_TESTE_IA_FALSA: 'true', DISCORD_TOKEN: 'token-falso-de-teste',
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
async function waitFor(proc, re, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (re.test(proc.out)) return;
    if (proc.exited) break;
    await sleep(50);
  }
  if (re.test(proc.out)) return;
  throw new Error(`${proc.label}: não apareceu ${re} (${proc.exited ? `saiu com código ${proc.code}` : 'tempo esgotado'}).\n--- saída ---\n${tail(proc.out)}`);
}
async function waitExit(proc, timeoutMs) {
  const r = await Promise.race([proc.exit, sleep(timeoutMs).then(() => null)]);
  if (!r) {
    proc.child.kill(); // o processo que ESTE teste abriu (handle), nunca um achado por varredura
    throw new Error(`${proc.label}: não terminou em ${timeoutMs} ms.\n--- saída ---\n${tail(proc.out)}`);
  }
  return r;
}
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(50);
  }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${typeof what === 'function' ? what() : what}`);
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

// ── Limpeza ─────────────────────────────────────────────────────────────────────────────────────
let channelServer = null;
let testLogger = null;
const closers = [];
async function cleanup() {
  if (process.env.YUI_TESTE_MOSTRAR_SAIDA === '1') {
    for (const p of allProcs) console.log(`\n===== ${p.label} (código ${p.code}) =====\n${p.out}`);
    for (const f of ['supervisor.log', 'cerebro-saida.log', 'bot-saida.log']) {
      try { console.log(`\n===== logs/${f} =====\n${tail(fs.readFileSync(path.join(APP, 'logs', f), 'utf8'), 80)}`); } catch { /* */ }
    }
  }
  for (const fn of closers.splice(0)) { try { await fn(); } catch { /* */ } }
  // Supervisores primeiro (eles param os filhos deles pelo handle); depois o que sobrar deste teste.
  for (const proc of [...procs].filter((p) => p.label.startsWith('supervisor'))) {
    try { proc.child.send({ tipo: 'desligar' }); } catch { /* */ }
    await Promise.race([proc.exit, sleep(15_000)]);
  }
  for (const proc of [...procs]) {
    try { proc.child.kill(); } catch { /* já saiu */ }
    await Promise.race([proc.exit, sleep(3000)]);
  }
  try { await channelServer?.close(); } catch { /* */ }
  try { process.chdir(ROOT); } catch { /* */ }
  try { testLogger?.close(); } catch { /* */ }
  try { (await import('../src/database/db.js')).closeAllDatabases(); } catch { /* */ }
  await sleep(300);
  let junctionGone = false;
  try { fs.unlinkSync(JUNCTION); } catch { /* */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[operacao] não consegui apagar ${T}: ${err.message}`); }
  } else {
    console.warn(`[operacao] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  }
  localDb.cleanup();
}
process.on('exit', () => {
  for (const proc of procs) { try { proc.child.kill(); } catch { /* */ } }
  if (!finished && process.exitCode === undefined) process.exitCode = 1;
});

// ── Ajudantes ───────────────────────────────────────────────────────────────────────────────────
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const readLock = (dir, name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.db.owner`), 'utf8')); } catch { return null; } };
const readDms = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const supLog = () => { try { return fs.readFileSync(path.join(APP, 'logs', 'supervisor.log'), 'utf8'); } catch { return ''; } };
const outLog = (papel) => { try { return fs.readFileSync(path.join(APP, 'logs', `${papel}-saida.log`), 'utf8'); } catch { return ''; } };
let apiPort = 0;
async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// RAM e CPU de cada processo, medidas pelo próprio processo (IPC), em cada cenário.
const medicoes = [];
function registrarUso(cenario, papel, uso, pid) {
  if (!uso) return;
  const cpuMs = (uso.cpuUserMs ?? 0) + (uso.cpuSystemMs ?? 0);
  const medio = uso.uptimeSeconds > 0 ? Math.round((cpuMs / (uso.uptimeSeconds * 1000)) * 1000) / 10 : null;
  medicoes.push({ cenario, papel, pid, rssMB: uso.rssMB, heapMB: uso.heapMB, cpuMs, uptimeS: uso.uptimeSeconds, cpuMedioPct: medio, cpuAgoraPct: uso.cpuPct });
}
async function medirSupervisor(cenario, sup) {
  await ipc(sup, { tipo: 'verificar' }, 'verificado', 15_000);
  const st = (await ipc(sup, { tipo: 'estado' }, 'estado')).estado;
  for (const papel of ['cerebro', 'bot']) registrarUso(cenario, papel, st.processos[papel]?.ultimaSaude?.uso, st.processos[papel]?.pid);
  registrarUso(cenario, 'supervisor', st.supervisor?.uso, st.supervisor?.pid);
  return st;
}
async function medirFilho(cenario, papel, proc) {
  try { const r = await ipc(proc, { tipo: 'saude' }, 'saude', 5_000); registrarUso(cenario, papel, r.uso, r.pid); } catch { /* sem medição */ }
}

const LOAD_ERRORS = /ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|Cannot find (?:module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED|TypeError: .* is not a function/;

try {
  console.log('Preparação');
  await test('cópia do código numa pasta temporária (node_modules por junção), portas livres e Discord falso só em teste', async () => {
    const n = copyCode();
    assert.ok(n > 100, `poucos arquivos copiados (${n})`);
    assert.ok(fs.existsSync(path.join(APP, 'src', 'supervisor.js')) && fs.existsSync(path.join(APP, 'scripts', 'backup-offsite.mjs')));
    assert.ok(!fs.existsSync(path.join(APP, '.env')), 'a cópia não pode ter .env');
    apiPort = await freePort();
    ({ logger: testLogger } = await import('../src/utils/logger.js'));
    const { fakeDiscordMode } = await import('../src/discord/discordFalso.js');
    assert.equal(fakeDiscordMode({}), 'off');
    assert.equal(fakeDiscordMode({ YUI_TESTE_DISCORD_FALSO: 'true', YUI_CEREBRO_EXTERNO: 'true' }), 'refused', 'sem NODE_ENV=test não liga');
    assert.equal(fakeDiscordMode({ YUI_TESTE_DISCORD_FALSO: 'true', NODE_ENV: 'test' }), 'refused', 'sem o cérebro separado não liga');
    assert.equal(fakeDiscordMode({ YUI_TESTE_DISCORD_FALSO: 'true', NODE_ENV: 'production', YUI_CEREBRO_EXTERNO: 'true' }), 'refused');
    assert.equal(fakeDiscordMode({ YUI_TESTE_DISCORD_FALSO: 'true', NODE_ENV: 'test', YUI_CEREBRO_EXTERNO: 'true' }), 'on');
    // Nenhuma varredura de processos nem encerramento por PID no supervisor e no lado do filho.
    for (const f of ['src/supervisor.js', 'src/operacao/supervisor.js', 'src/operacao/filho.js']) {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(code, /Get-Process|tasklist|wmic|netstat|Get-CimInstance|process\.kill\s*\(/i, `${f} não pode procurar nem encerrar processo por PID`);
    }
  });

  // ═════ A. Supervisor de verdade ═════
  const supEnv = () => childEnv({
    DATABASE_DIR: DB, YUI_CHANNEL_SECRET_FILE: SECRET, YUI_CEREBRO_EXTERNO: 'true',
    YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: DMS, YUI_TESTE_DISCORD_FALSO_ATRASO_MS: '1500',
    YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(apiPort), YUI_API_TOKENS: `${TOKEN}=${OWNER}`,
    YUI_CEREBRO_LEMBRETES_MS: '300', YUI_CEREBRO_DM_TIMEOUT_MS: '6000',
    YUI_SUPERVISOR_SAUDE_MS: '400', YUI_SUPERVISOR_PRAZO_SAUDE_MS: '2000', YUI_SUPERVISOR_FALHAS: '3',
    YUI_SUPERVISOR_ESPERA_MIN_MS: '200', YUI_SUPERVISOR_ESPERA_MAX_MS: '2000', YUI_SUPERVISOR_ESTAVEL_MS: '60000',
    YUI_SUPERVISOR_PARADA_MS: '8000', YUI_SUPERVISOR_ESPERA_CEREBRO_MS: '30000', YUI_SUPERVISOR_SUBIDA_MS: '60000',
    YUI_SUPERVISOR_SAIDA: 'arquivo',
  });
  const supState = async (sup) => (await ipc(sup, { tipo: 'estado' }, 'estado')).estado;
  async function waitState(sup, pred, timeoutMs, what) {
    let last = null;
    await waitUntil(async () => { last = await supState(sup); return pred(last); }, timeoutMs, () => `${what}\n--- estado ---\n${JSON.stringify(last?.processos ?? last, null, 1).slice(0, 1500)}\n--- supervisor.log ---\n${tail(supLog(), 20)}`);
    return last;
  }
  const bothReady = (st) => st.processos.cerebro?.estado === 'pronto' && st.processos.bot?.estado === 'pronto';

  console.log('A. Supervisor de verdade (modo dois processos)');
  let sup;
  let st0;
  await test('subida ordenada: o cérebro sobe primeiro, o bot só depois de o cérebro avisar "pronto"; travas e canal certos', async () => {
    sup = startProc('supervisor#1', ['src/supervisor.js'], supEnv());
    st0 = await waitState(sup, bothReady, 60_000, 'os dois ficarem prontos');
    const c = st0.processos.cerebro;
    const b = st0.processos.bot;
    assert.equal(st0.modo, 'dois');
    assert.ok(Date.parse(c.prontoEm) <= Date.parse(b.iniciadoEm), `o bot (${b.iniciadoEm}) subiu antes de o cérebro ficar pronto (${c.prontoEm})`);
    assert.equal(readLock(DB, 'memory-personal')?.pid, c.pid, 'a memória é do cérebro');
    assert.equal(readLock(DB, 'core')?.pid, b.pid, 'o core é do bot');
    assert.equal(readLock(DB, 'core')?.role, 'bot');
    await waitUntil(async () => (await api('GET', '/v1/health')).json?.cerebro?.bot === true, 15_000, 'o bot conectar no canal do cérebro');
    const h = (await api('GET', '/v1/health')).json;
    assert.equal(h.ok, true);
    assert.equal(h.discord.online, null, 'o cérebro não fala do Discord');
    assert.match(supLog(), /bot: esperando o cerebro ficar pronto|cerebro: pronto em/);
    assert.doesNotMatch(outLog('cerebro') + outLog('bot'), LOAD_ERRORS);
    assert.match(outLog('bot'), /DISCORD FALSO ligado/);
    await medirSupervisor('subida', sup);
  });

  await test('ocioso por 3 s: RAM estável e CPU baixa nos três processos (medição no intervalo, não na subida)', async () => {
    const amostra = async () => {
      await ipc(sup, { tipo: 'verificar' }, 'verificado', 15_000);
      const st = (await ipc(sup, { tipo: 'estado' }, 'estado')).estado;
      const u = { cerebro: st.processos.cerebro.ultimaSaude?.uso, bot: st.processos.bot.ultimaSaude?.uso, supervisor: st.supervisor?.uso };
      return { at: Date.now(), u, st };
    };
    await sleep(1500); // deixa a subida assentar
    const a = await amostra();
    await sleep(3000);
    const b = await amostra();
    for (const papel of ['cerebro', 'bot', 'supervisor']) {
      const cpu = (x) => (x?.cpuUserMs ?? 0) + (x?.cpuSystemMs ?? 0);
      const pct = Math.round(((cpu(b.u[papel]) - cpu(a.u[papel])) / (b.at - a.at)) * 1000) / 10;
      medicoes.push({ cenario: 'ocioso (3 s)', papel, pid: papel === 'supervisor' ? b.st.supervisor?.pid : b.st.processos[papel].pid, rssMB: b.u[papel]?.rssMB, heapMB: b.u[papel]?.heapMB, cpuMs: cpu(b.u[papel]) - cpu(a.u[papel]), uptimeS: b.u[papel]?.uptimeSeconds, cpuMedioPct: pct, cpuAgoraPct: pct, intervalo: true });
      assert.ok(pct < 60, `${papel}: CPU ociosa alta demais (${pct}%)`);
    }
  });

  await test('um lembrete que vence sai pelo bot UMA vez (cadeia de verdade: cérebro -> canal -> bot -> Discord falso)', async () => {
    const r = await api('POST', '/v1/admin/reminders', { text: 'lembrete-normal-1', at: new Date(Date.now() + 400).toISOString() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await waitUntil(() => readDms(DMS).some((d) => /lembrete-normal-1/.test(d.text)), 15_000, 'a DM do lembrete');
    await waitUntil(async () => !(await api('GET', '/v1/admin/reminders')).json.reminders.some((x) => x.id === r.json.reminder.id), 10_000, 'o lembrete sair da lista');
    await sleep(800);
    assert.equal(readDms(DMS).filter((d) => /lembrete-normal-1/.test(d.text)).length, 1);
    assert.ok(fs.existsSync(path.join(DB, 'idempotencia-bot.json')), 'a chave foi guardada em disco pelo bot');
    const idem = JSON.parse(fs.readFileSync(path.join(DB, 'idempotencia-bot.json'), 'utf8'));
    assert.ok(Object.entries(idem.chaves).some(([k, v]) => k.startsWith(`discord.dm.send:lembrete:${r.json.reminder.id}:`) && v.estado === 'feito'));
    assert.ok(!JSON.stringify(idem).includes('lembrete-normal-1'), 'o texto da DM nunca vai para o arquivo de idempotência');
    await medirSupervisor('lembrete normal', sup);
  });

  await test('proteção: um segundo cérebro e um segundo supervisor na mesma pasta são recusados, sem mexer nos que rodam', async () => {
    const before = await supState(sup);
    const secretBefore = fs.readFileSync(SECRET, 'utf8');
    const c2 = startProc('cerebro-intruso', ['src/cerebro.js'], childEnv({ DATABASE_DIR: DB, YUI_CHANNEL_SECRET_FILE: SECRET, YUI_API_ENABLED: 'false' }), { ipc: false });
    const s2 = startProc('supervisor-intruso', ['src/supervisor.js'], supEnv(), { ipc: false });
    const [r1, r2] = await Promise.all([waitExit(c2, 60_000), waitExit(s2, 60_000)]);
    assert.notEqual(r1.code, 0);
    assert.match(c2.out, /YUI_DB_OWNER_HELD/);
    assert.equal(r2.code, 1);
    assert.match(s2.out, /Já existe um supervisor nesta pasta/);
    assert.equal(fs.readFileSync(SECRET, 'utf8'), secretBefore, 'o segredo do canal do cérebro de verdade não mudou');
    const after = await supState(sup);
    assert.equal(after.processos.cerebro.pid, before.processos.cerebro.pid);
    assert.equal(after.processos.bot.pid, before.processos.bot.pid);
    assert.equal(after.processos.cerebro.inicios, 1);
  });

  await test('backup da memória e backup externo com o cérebro rodando: leem por cópia consistente, sem tomar a trava', async () => {
    const w = await api('POST', '/v1/memory', { content: 'segredo-do-backup: eu gosto de Sultan RS', type: 'preference' });
    assert.ok([200, 201].includes(w.status), JSON.stringify(w.json));
    const lockBefore = fs.readFileSync(path.join(DB, 'memory-personal.db.owner'), 'utf8');
    const keyHex = crypto.randomBytes(32).toString('hex');
    const backupDir = path.join(T, 'backups-memoria');
    const r = spawnSync(process.execPath, [...BLOQUEIO.argv, 'scripts/backup-memory.mjs', '--dir', backupDir, '--keep', '3'], {
      cwd: APP, encoding: 'utf8', timeout: 120_000, env: childEnv({ DATABASE_DIR: DB, YUI_BACKUP_KEY: keyHex, TEMP: T, TMP: T, ...BLOQUEIO.env('backup-memoria') }),
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /memory-personal\.db/);
    assert.equal(fs.readFileSync(path.join(DB, 'memory-personal.db.owner'), 'utf8'), lockBefore, 'a trava do cérebro ficou intacta (o backup não a toma)');
    // Restauração numa pasta temporária: o banco abre íntegro e tem a lembrança gravada pelo cérebro.
    const { restoreMemoryBackup, listBackups, readBackupManifest } = await import('../src/core/memory/backup.js');
    const last = listBackups(backupDir).filter((b) => b.complete).at(-1);
    assert.ok(last, 'um lote completo');
    const { manifest } = readBackupManifest(path.join(backupDir, last.name), Buffer.from(keyHex, 'hex'));
    const entry = manifest.files.find((f) => f.name === 'memory-personal.db');
    // sql.js: os bytes do arquivo (gravação atômica do dono); motor nativo (WAL): retrato consistente pelo VACUUM INTO.
    const nativos = new Set(NATIVE.split(',').map((x) => x.trim()).filter(Boolean));
    assert.equal(entry?.mode, nativos.has('*') || nativos.has('memory-personal') ? 'wal-snapshot' : 'copia', JSON.stringify(entry));
    const target = path.join(T, 'restaurado');
    await restoreMemoryBackup({ backupFolder: path.join(backupDir, last.name), targetDir: target, key: Buffer.from(keyHex, 'hex') });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(target, 'memory-personal.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(db.prepare('SELECT content FROM memories').all().some((x) => /Sultan RS/.test(x.content)));
    } finally { db.close(); }
    // Backup externo (repositório "bare" local no lugar do GitHub), com o cérebro rodando.
    const bare = path.join(T, 'remoto.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    const keyFile = path.join(T, 'backup.key');
    fs.writeFileSync(keyFile, keyHex);
    const offEnv = childEnv({ YUI_BACKUP_REPO_URL: bare, YUI_BACKUP_SSH_KEY: path.join(T, 'sem-chave'), YUI_BACKUP_KEY_FILE: keyFile, YUI_BACKUP_WORKDIR: path.join(T, 'offsite', 'repo'), YUI_BACKUP_LOG: path.join(T, 'offsite.log'), TEMP: T, TMP: T, ...BLOQUEIO.env('backup-externo') });
    const off = spawnSync(process.execPath, [...BLOQUEIO.argv, 'scripts/backup-offsite.mjs'], { cwd: APP, encoding: 'utf8', timeout: 120_000, env: offEnv });
    assert.equal(off.status, 0, `${off.stdout}${off.stderr}`);
    assert.match(off.stdout, /OK: backup cifrado enviado/);
    const ver = spawnSync(process.execPath, [...BLOQUEIO.argv, 'scripts/backup-offsite.mjs', '--verify'], { cwd: APP, encoding: 'utf8', timeout: 120_000, env: offEnv });
    assert.equal(ver.status, 0, `${ver.stdout}${ver.stderr}`);
    assert.match(ver.stdout, /OK: restauração testada/);
    assert.equal(fs.readFileSync(path.join(DB, 'memory-personal.db.owner'), 'utf8').split('"token"')[1], lockBefore.split('"token"')[1], 'mesmo dono e mesmo token');
    // O cérebro continua gravando depois dos backups (a trava continua com ele).
    const w2 = await api('POST', '/v1/memory', { content: 'depois do backup: eu uso Linux', type: 'fact' });
    assert.ok([200, 201].includes(w2.status), JSON.stringify(w2.json));
  });

  let botPidAntes;
  await test('o bot morre NO MEIO do envio de um lembrete: o supervisor religa (esperando a trava dele vencer) e a DM NÃO sai de novo', async () => {
    botPidAntes = (await supState(sup)).processos.bot.pid;
    const cerebroPid = (await supState(sup)).processos.cerebro.pid;
    const r = await api('POST', '/v1/admin/reminders', { text: 'lembrete-no-meio-2', at: new Date(Date.now() + 300).toISOString() });
    assert.equal(r.status, 200);
    await waitUntil(() => readDms(DMS).some((d) => /lembrete-no-meio-2/.test(d.text)), 15_000, 'a DM sair (antes de a confirmação voltar)');
    sup.child.send({ tipo: 'simular-queda', papel: 'bot' }); // o supervisor derruba o bot pelo handle dele
    const st = await waitState(sup, (s) => s.processos.bot.estado === 'pronto' && s.processos.bot.pid !== botPidAntes, 30_000, 'o bot voltar');
    assert.equal(st.processos.bot.religadas, 1);
    assert.equal(st.processos.cerebro.pid, cerebroPid, 'o cérebro não foi tocado');
    assert.match(supLog(), /bot: o processo anterior caiu sem soltar as travas de dono; espero/);
    await waitUntil(async () => !(await api('GET', '/v1/admin/reminders')).json.reminders.some((x) => x.id === r.json.reminder.id), 20_000, 'o lembrete sair da lista');
    await sleep(1000);
    assert.equal(readDms(DMS).filter((d) => /lembrete-no-meio-2/.test(d.text)).length, 1, 'a DM saiu uma vez só');
    // A reconciliação (etapa 4, depois da revisão da Liz) achou a mensagem no histórico da DM: enviado, sem mandar de novo.
    assert.match(outLog('bot'), /DM reconciliada \(motivo lembrete, historico\): 0 parte\(s\) enviada\(s\) agora de 1/);
    assert.match(outLog('cerebro'), /pela reconciliação/);
    await medirSupervisor('queda do bot no meio da DM', sup);
  });

  await test('queda do cérebro: o supervisor religa só o cérebro e o bot RECONECTA o WebSocket sozinho (mesmo bot)', async () => {
    const before = await supState(sup);
    sup.child.send({ tipo: 'simular-queda', papel: 'cerebro' });
    const st = await waitState(sup, (s) => s.processos.cerebro.estado === 'pronto' && s.processos.cerebro.pid !== before.processos.cerebro.pid, 30_000, 'o cérebro voltar');
    assert.equal(st.processos.bot.pid, before.processos.bot.pid, 'o bot não foi religado');
    await waitUntil(async () => (await api('GET', '/v1/health').catch(() => ({ json: null }))).json?.cerebro?.bot === true, 20_000, 'o bot reconectar no cérebro novo');
    assert.equal(readLock(DB, 'memory-personal')?.pid, st.processos.cerebro.pid, 'o cérebro novo retomou a trava do morto');
    const rec = await api('POST', '/v1/admin/reminders', { text: 'lembrete-apos-reconexao-3', at: new Date(Date.now() + 300).toISOString() });
    assert.equal(rec.status, 200);
    await waitUntil(() => readDms(DMS).some((d) => /lembrete-apos-reconexao-3/.test(d.text)), 15_000, 'a DM depois da reconexão');
    await medirSupervisor('queda do cérebro', sup);
  });

  await test('queda dos DOIS ao mesmo tempo: o supervisor religa os dois, o cérebro primeiro, e nada sai em dobro', async () => {
    const before = await supState(sup);
    const dmsAntes = readDms(DMS).length;
    sup.child.send({ tipo: 'simular-queda', papel: 'todos' });
    const st = await waitState(sup, (s) => bothReady(s) && s.processos.cerebro.pid !== before.processos.cerebro.pid && s.processos.bot.pid !== before.processos.bot.pid, 45_000, 'os dois voltarem');
    assert.ok(Date.parse(st.processos.cerebro.prontoEm) <= Date.parse(st.processos.bot.iniciadoEm), 'o bot só subiu com o cérebro pronto');
    await waitUntil(async () => (await api('GET', '/v1/health').catch(() => ({ json: null }))).json?.cerebro?.bot === true, 20_000, 'o bot conectar no cérebro novo');
    await sleep(1200);
    assert.equal(readDms(DMS).length, dmsAntes, 'nenhuma DM repetida depois de religar os dois');
    for (const texto of ['lembrete-normal-1', 'lembrete-no-meio-2', 'lembrete-apos-reconexao-3']) {
      assert.equal(readDms(DMS).filter((d) => d.text.includes(texto)).length, 1, `${texto}: uma vez só`);
    }
    await medirSupervisor('queda dos dois', sup);
  });

  await test('parada pelo arquivo de pedido (o caminho do atualizador e do watchdog): o bot para antes do cérebro, tudo limpo', async () => {
    fs.writeFileSync(path.join(APP, 'logs', 'supervisor.parar'), new Date().toISOString());
    const { code } = await waitExit(sup, 40_000);
    assert.equal(code, 0, tail(supLog()));
    const log = supLog();
    const iBot = log.lastIndexOf('bot: parou');
    const iCer = log.lastIndexOf('cerebro: parou');
    assert.ok(iBot > 0 && iCer > iBot, `o bot precisa parar antes do cérebro\n${tail(log, 12)}`);
    assert.match(outLog('bot'), /\[Bot\] Desligado: canal com o cérebro fechado/);
    assert.match(outLog('cerebro'), /\[Cérebro\] Desligado: canal, API e Gateway fechados/);
    const owners = fs.readdirSync(DB).filter((f) => f.endsWith('.owner'));
    assert.deepEqual(owners, [], 'todas as travas de dono soltas');
    assert.ok(!fs.existsSync(SECRET), 'o segredo do canal saiu junto');
    assert.ok(!fs.existsSync(path.join(APP, 'logs', 'supervisor.owner')), 'a trava do supervisor saiu');
    assert.ok(!fs.existsSync(path.join(APP, 'logs', 'supervisor.parar')), 'o pedido de parada foi consumido');
    const estado = JSON.parse(fs.readFileSync(path.join(APP, 'logs', 'supervisor-estado.json'), 'utf8'));
    assert.equal(estado.estado, 'parado');
  });

  // ═════ B. Idempotência persistente no bot de verdade (o teste faz o papel do cérebro) ═════
  console.log('B. Idempotência persistente no bot de verdade');
  const { startChannelServer } = await import('../src/core/channel/server.js');
  channelServer = await startChannelServer({ port: 0, secretFile: SECRET_B, logger: quietLogger });
  BLOQUEIO.portaDoTeste(channelServer.port); // o canal que o TESTE serve (no papel do cérebro): o bot de verdade conecta nele
  const botEnvB = () => childEnv({
    DATABASE_DIR: DB_B, YUI_CHANNEL_SECRET_FILE: SECRET_B, YUI_CEREBRO_EXTERNO: 'true',
    YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: DMS_B, YUI_TESTE_DISCORD_FALSO_ATRASO_MS: '1500',
  });
  const dmB = (key, text) => channelServer.request('bot', 'discord.dm.send', { userId: OWNER, motivo: 'lembrete', text }, { idem: key, timeoutMs: 10_000 });
  const countB = (text) => readDms(DMS_B).filter((d) => d.text.includes(text)).length;
  async function startBotB(label) {
    const b = startProc(label, ['src/index.js'], botEnvB());
    await waitFor(b, /Yui inicializada \(Discord falso/, 60_000);
    await waitUntil(() => channelServer.isConnected('bot'), 15_000, `${label} conectar`);
    return b;
  }
  const K1 = 'lembrete:901:2026-11-18T10:00:00.000Z';
  const K2 = 'lembrete:902:2026-11-18T10:05:00.000Z';
  let b1;
  await test('a DM sai uma vez; a mesma chave de novo (mesmo processo) devolve a resposta guardada', async () => {
    b1 = await startBotB('bot-b#1');
    const r1 = await dmB(K1, 'dm-chave-1');
    assert.equal(r1.sent, true);
    const r2 = await dmB(K1, 'dm-chave-1');
    assert.equal(r2.sent, true);
    assert.equal(countB('dm-chave-1'), 1);
    await medirFilho('bot sozinho (teste = cérebro)', 'bot', b1);
  });

  let b2;
  await test('depois de um reinício LIMPO do bot, a mesma chave não repete a DM (resposta guardada em disco)', async () => {
    b1.child.send({ tipo: 'desligar' });
    assert.equal((await waitExit(b1, 20_000)).code, 0, tail(b1.out));
    assert.match(b1.out, /\[Bot\] Desligado/);
    assert.equal(readLock(DB_B, 'core'), null, 'o desligamento limpo soltou a trava');
    b2 = await startBotB('bot-b#2');
    assert.match(b2.out, /Idempotência persistente: \d+ chave\(s\) recente\(s\) carregada\(s\)/);
    const r = await dmB(K1, 'dm-chave-1');
    assert.equal(r.repetido, true);
    assert.equal(countB('dm-chave-1'), 1, 'nada repetido depois do reinício');
  });

  await test('o bot é DERRUBADO no meio do envio: depois de voltar, a mesma chave é RECONCILIADA (achou no histórico) e NÃO repete; chave nova sai normal', async () => {
    const pending = dmB(K2, 'dm-chave-2').then((v) => ({ v }), (e) => ({ e }));
    await waitUntil(() => countB('dm-chave-2') === 1, 10_000, 'a DM 2 sair');
    b2.child.kill(); // pelo handle: o processo que este teste abriu
    await waitExit(b2, 10_000);
    const first = await pending;
    assert.ok(first.e && ['CONNECTION_LOST', 'NOT_CONNECTED'].includes(first.e.code), `o pedido falha com a queda (${first.e?.code})`);
    // A trava do bot morto vence (prazo curto do teste) e o bot volta.
    await waitUntil(() => readLock(DB_B, 'core') === null || Date.now() - fs.statSync(path.join(DB_B, 'core.db.owner')).mtimeMs > 1700, 10_000, 'a trava do bot morto vencer');
    const b3 = await startBotB('bot-b#3');
    const r = await dmB(K2, 'dm-chave-2');
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.equal(r.reconciliado, 'historico', 'achou a mensagem no histórico da DM (marcador), sem mandar de novo');
    assert.equal(countB('dm-chave-2'), 1, 'a DM do meio do envio saiu uma vez só');
    const r3 = await dmB('lembrete:903:2026-11-18T10:10:00.000Z', 'dm-chave-3');
    assert.equal(r3.sent, true);
    assert.equal(countB('dm-chave-3'), 1);
    await medirFilho('bot depois de derrubado', 'bot', b3);
    b3.child.send({ tipo: 'desligar' });
    assert.equal((await waitExit(b3, 20_000)).code, 0);
  });

  // ═════ C. Supervisor simulado ═════
  console.log('C. Supervisor simulado (processos falsos, tempos curtos)');
  const { createSupervisor, calcularEspera, especificacoes, temposDoAmbiente, TEMPOS_PADRAO } = await import('../src/operacao/supervisor.js');
  const { EventEmitter } = await import('node:events');
  function fakeSpawner({ comportamento = {} } = {}) {
    const abertos = [];
    let pid = 5000;
    const spawnFilho = (spec) => {
      const p = new EventEmitter();
      p.pid = ++pid;
      p.papel = spec.papel;
      p.connected = true;
      p.mortoPeloHandle = false;
      p.recebidas = [];
      const extra = comportamento[spec.papel] ?? {};
      const c = { prontoMs: 20, responde: true, sai: false, ...extra };
      const exit = (code) => { if (p.saiu) return; p.saiu = true; p.connected = false; setTimeout(() => p.emit('exit', code, null), 5); };
      p.send = (m) => {
        p.recebidas.push(m.tipo);
        if (m.tipo === 'saude' && (typeof c.responde === 'function' ? c.responde(p) : c.responde)) setTimeout(() => p.emit('message', { tipo: 'saude', id: m.id, ok: true, discord: 'discord' in extra ? extra.discord : true, canal: 'canal' in extra ? extra.canal : true, uso: { rssMB: 1 } }), 2);
        if (m.tipo === 'desligar' && !c.ignoraDesligar) exit(0);
      };
      p.kill = () => { p.mortoPeloHandle = true; exit(null); };
      if (c.sai) setTimeout(() => exit(1), c.sai);
      else if (c.prontoMs !== null) setTimeout(() => { if (!p.saiu) p.emit('message', { tipo: 'pronto' }); }, c.prontoMs);
      abertos.push(p);
      return p;
    };
    return { spawnFilho, abertos };
  }
  const T_RAPIDO = { saudeMs: 30, prazoSaudeMs: 30, falhasParaReligar: 3, subidaMs: 2_000, discordForaMs: 150, canalForaMs: 150, esperaMinMs: 20, esperaMaxMs: 160, estavelMs: 10_000, paradaMs: 120, esperaCerebroMs: 300, unicoReinicioMs: 50 };
  const logs = [];
  const mkSup = (opts) => createSupervisor({ modo: 'dois', specs: especificacoes('dois', { env: {} }), tempos: T_RAPIDO, log: (n, m) => logs.push(`${n} ${m}`), ...opts });

  await test('espera crescente (5 s, 10 s, 20 s, 40 s, 60 s...) e tempos do ambiente com validação', async () => {
    assert.deepEqual([1, 2, 3, 4, 5, 8].map((n) => calcularEspera(n, TEMPOS_PADRAO)), [5000, 10000, 20000, 40000, 60000, 60000]);
    const t = temposDoAmbiente({ YUI_SUPERVISOR_ESPERA_MIN_MS: '1000', YUI_SUPERVISOR_ESPERA_MAX_MS: '500', YUI_SUPERVISOR_SAUDE_MS: 'abc', YUI_SUPERVISOR_FALHAS: '0' });
    assert.equal(t.esperaMinMs, 1000);
    assert.equal(t.esperaMaxMs, 1000, 'o máximo nunca fica abaixo do mínimo');
    assert.equal(t.saudeMs, TEMPOS_PADRAO.saudeMs, 'valor inválido volta ao padrão');
    assert.equal(t.falhasParaReligar, TEMPOS_PADRAO.falhasParaReligar, 'abaixo do mínimo volta ao padrão');
    const specs = especificacoes('dois', { env: { YUI_DB_OWNER_ROLE: 'bot', X: '1' } });
    assert.deepEqual(specs.map((s) => s.papel), ['cerebro', 'bot']);
    assert.equal(specs[0].env.YUI_DB_OWNER_ROLE, undefined, 'cada entrada define o próprio papel');
    assert.equal(specs[1].env.YUI_CEREBRO_EXTERNO, 'true');
    assert.equal(specs[1].depende, 'cerebro');
    assert.deepEqual(especificacoes('unico').map((s) => [s.papel, s.script, s.ipc]), [['yui', 'src/index.js', false]]);
  });

  await test('processo que cai sem parar: religa com espera crescente (20, 40, 80, 160, 160 ms) e só pelo handle', async () => {
    const { spawnFilho, abertos } = fakeSpawner({ comportamento: { cerebro: { sai: 10 } } });
    const s = mkSup({ spawnFilho, specs: especificacoes('dois').slice(0, 1) });
    const subidas = [];
    const orig = spawnFilho;
    const s2 = mkSup({ specs: especificacoes('dois').slice(0, 1), spawnFilho: (spec) => { subidas.push(Date.now()); return orig(spec); } });
    void s;
    s2.iniciar();
    await waitUntil(() => subidas.length >= 6, 5_000, 'seis subidas');
    await s2.parar('fim');
    const gaps = subidas.slice(1).map((v, i) => v - subidas[i]);
    // Cada intervalo = vida do processo (~15 ms) + a espera; a espera dobra até o teto.
    assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1] && gaps[3] > gaps[2], `a espera precisa crescer: ${gaps.join(', ')}`);
    assert.ok(gaps[4] < 160 + 120, `com teto: ${gaps.join(', ')}`);
    assert.equal(s2.estado().processos.cerebro.quedasSeguidas >= 5, true);
    assert.ok(abertos.every((p) => p.saiu));
  });

  await test('travado (não responde à saúde): pedido limpo, e se não sair, encerrado PELO HANDLE do processo que ele abriu', async () => {
    const { spawnFilho, abertos } = fakeSpawner({ comportamento: { cerebro: { responde: (p) => p.pid !== 5001, ignoraDesligar: true } } });
    const s = mkSup({ spawnFilho, specs: especificacoes('dois').slice(0, 1) });
    s.iniciar();
    await waitUntil(() => abertos.length >= 2 && s.estado().processos.cerebro.estado === 'pronto', 5_000, 'religar o travado');
    const travado = abertos[0];
    assert.deepEqual(travado.recebidas.filter((m) => m === 'desligar').length, 1, 'primeiro o pedido limpo');
    assert.equal(travado.mortoPeloHandle, true, 'depois o handle');
    assert.ok(logs.some((l) => /RELIGANDO cerebro: não respondeu à saúde 3 vezes seguidas/.test(l)));
    assert.equal(abertos[1].mortoPeloHandle, false, 'o novo segue de pé');
    await s.parar('fim');
  });

  await test('ordem: o bot espera o cérebro ficar pronto; sem o cérebro pronto no prazo, sobe assim mesmo; a parada é bot -> cérebro', async () => {
    const ordem = [];
    const { spawnFilho, abertos } = fakeSpawner({ comportamento: { cerebro: { prontoMs: 120 } } });
    const s = mkSup({ spawnFilho: (spec) => { ordem.push(`sobe:${spec.papel}`); const p = spawnFilho(spec); p.on('exit', () => ordem.push(`saiu:${spec.papel}`)); return p; } });
    s.iniciar();
    await waitUntil(() => s.estado().processos.bot.estado === 'pronto', 3_000, 'o bot ficar pronto');
    const st = s.estado();
    assert.ok(Date.parse(st.processos.cerebro.prontoEm) <= Date.parse(st.processos.bot.iniciadoEm));
    await s.parar('fim');
    assert.deepEqual(ordem, ['sobe:cerebro', 'sobe:bot', 'saiu:bot', 'saiu:cerebro']);
    assert.ok(abertos.every((p) => !p.mortoPeloHandle), 'saíram pelo pedido limpo, sem encerrar à força');
    // Cérebro que nunca fica pronto: o bot sobe depois de esperaCerebroMs (300 ms).
    logs.length = 0;
    const f2 = fakeSpawner({ comportamento: { cerebro: { prontoMs: null } } });
    const s2 = mkSup({ spawnFilho: f2.spawnFilho });
    s2.iniciar();
    await waitUntil(() => s2.estado().processos.bot.estado === 'pronto', 3_000, 'o bot subir sem o cérebro');
    assert.ok(logs.some((l) => /bot: o cerebro não ficou pronto em .*subo assim mesmo/.test(l)));
    await s2.parar('fim');
  });

  await test('espera as travas do processo MORTO vencerem antes de religar (sem mexer nelas); travas de outro processo não contam', async () => {
    const { spawnFilho, abertos } = fakeSpawner();
    let mtime = Date.now();
    const inspecionar = (dbPath) => {
      const morto = abertos[0];
      if (dbPath.endsWith('memory-personal.db') && morto?.saiu) return { exists: true, stale: Date.now() - mtime >= 400, heartbeatAgeMs: Date.now() - mtime, owner: { pid: morto.pid } };
      if (dbPath.endsWith('memory-discord.db')) return { exists: true, stale: false, heartbeatAgeMs: 0, owner: { pid: 999999 } };
      return { exists: false };
    };
    const s = mkSup({ spawnFilho, specs: especificacoes('dois', { bancos: { cerebro: ['memory-personal', 'memory-discord'] } }).slice(0, 1), travas: { dir: 'x', staleMs: 400, heartbeatMs: 50, inspecionar, processoExiste: () => true } });
    s.iniciar();
    await waitUntil(() => s.estado().processos.cerebro.estado === 'pronto', 2_000, 'subir');
    mtime = Date.now();
    const t0 = Date.now();
    s.simularQueda('cerebro');
    await waitUntil(() => abertos.length === 2, 3_000, 'religar');
    const waited = Date.now() - t0;
    assert.ok(waited >= 380, `esperou a trava vencer (${waited} ms)`);
    assert.ok(logs.some((l) => /caiu sem soltar as travas de dono; espero/.test(l)));
    await s.parar('fim');
    // Dono que não existe mais e que este supervisor nem conheceu (o supervisor anterior caiu junto com os filhos): espera
    // já na primeira subida. Dono VIVO desconhecido não conta (a subida seria recusada pela trava e viraria espera crescente).
    const f2 = fakeSpawner();
    const t1 = Date.now();
    const insp2 = (dbPath) => (dbPath.endsWith('memory-personal.db')
      ? { exists: true, stale: Date.now() - t1 >= 300, heartbeatAgeMs: Date.now() - t1, owner: { pid: 777777, hostname: 'esta-maquina' } }
      : { exists: true, stale: false, heartbeatAgeMs: 0, owner: { pid: 888888, hostname: 'esta-maquina' } });
    const s2 = mkSup({ spawnFilho: f2.spawnFilho, specs: especificacoes('dois', { bancos: { cerebro: ['memory-personal', 'memory-discord'] } }).slice(0, 1), travas: { dir: 'x', staleMs: 300, heartbeatMs: 50, hostname: 'esta-maquina', inspecionar: insp2, processoExiste: (pid) => pid !== 777777 } });
    s2.iniciar();
    await waitUntil(() => f2.abertos.length === 1, 3_000, 'subir depois de a trava do dono morto vencer');
    assert.ok(Date.now() - t1 >= 280, `esperou a trava do dono morto (${Date.now() - t1} ms)`);
    await s2.parar('fim');
  });

  await test('Discord fora (e bot sem canal com o cérebro pronto) por tempo demais: religa só o bot', async () => {
    let discord = true;
    const { spawnFilho, abertos } = fakeSpawner({ comportamento: { bot: { get discord() { return discord; } } } });
    const s = mkSup({ spawnFilho });
    s.iniciar();
    await waitUntil(() => s.estado().processos.bot.estado === 'pronto', 2_000, 'subir');
    discord = false;
    await waitUntil(() => abertos.filter((p) => p.papel === 'bot').length === 2, 3_000, 'religar o bot');
    assert.ok(logs.some((l) => /RELIGANDO bot: o Discord está fora há/.test(l)));
    assert.equal(abertos.filter((p) => p.papel === 'cerebro').length, 1, 'o cérebro não foi tocado');
    discord = true;
    await s.parar('fim');
  });

  await test('modo único: igual ao laço da tarefa de hoje (só src/index.js, sem IPC, sem saúde, religa no intervalo fixo)', async () => {
    const subidas = [];
    const { spawnFilho, abertos } = fakeSpawner({ comportamento: { yui: { sai: 10, prontoMs: null } } });
    const s = createSupervisor({ modo: 'unico', tempos: T_RAPIDO, spawnFilho: (spec) => { subidas.push(Date.now()); return spawnFilho(spec); } });
    s.iniciar();
    await waitUntil(() => subidas.length >= 4, 3_000, 'quatro subidas');
    await s.parar('fim');
    const gaps = subidas.slice(1).map((v, i) => v - subidas[i]);
    assert.ok(gaps.every((g) => g >= 50 && g < 50 + 120), `intervalo fixo: ${gaps.join(', ')}`);
    assert.ok(abertos.every((p) => p.recebidas.length === 0), 'nenhuma mensagem IPC no modo único');
  });

  // ═════ D. Política: memory.admin_wipe_user pelo canal de verdade ═════
  console.log('D. Política do memory.admin_wipe_user pelo canal de verdade');
  await test('cérebro de verdade: apagar a memória de alguém exige o dono E a confirmação do alvo; sem ela, nada é apagado', async () => {
    const c = startProc('cerebro-d', ['src/cerebro.js'], childEnv({ DATABASE_DIR: DB_D, YUI_CHANNEL_SECRET_FILE: SECRET_D, YUI_API_ENABLED: 'false' }));
    await waitFor(c, /YuiCerebro pronto/, 60_000);
    const { connectChannel } = await import('../src/core/channel/client.js');
    const client = connectChannel({ role: 'bot', secretFile: SECRET_D, logger: quietLogger, minBackoffMs: 50, maxBackoffMs: 300 });
    closers.push(() => client.close());
    await client.ready(10_000);
    const ownerWire = { platform: 'discord', userId: OWNER, guildId: null, channelId: null, isDM: true, isBlocked: false };
    const memberWire = { platform: 'discord', userId: OTHER, guildId: GUILD, channelId: CHANNEL, isDM: false, isBlocked: false };
    await client.request('memory.remember', { ctx: memberWire, type: 'fact', content: 'O nome do usuário é Ana.', importance: 4 }, { idem: 'd-1' });
    await client.request('memory.remember', { ctx: memberWire, type: 'fact', content: 'Ana gosta de motos.', importance: 2 }, { idem: 'd-2' });
    const sem = await client.request('memory.adminForgetUser', { ctx: ownerWire, userId: OTHER }).then(() => null, (e) => e);
    assert.equal(sem?.code, 'CONFIRMACAO_NECESSARIA', `sem confirmação: ${sem?.code}`);
    const errado = await client.request('memory.adminForgetUser', { ctx: ownerWire, userId: OTHER, confirmacao: { alvo: '999999999999999999', via: 'teste' } }).then(() => null, (e) => e);
    assert.equal(errado?.code, 'CONFIRMACAO_NECESSARIA', 'confirmação de outro alvo não vale');
    const outro = await client.request('memory.adminForgetUser', { ctx: memberWire, userId: OTHER, confirmacao: { alvo: OTHER, via: 'teste' } }).then(() => null, (e) => e);
    assert.ok(outro && /dono/i.test(outro.message), 'nunca a pedido de outro usuário');
    assert.equal((await client.request('memory.list', { ctx: memberWire })).length, 2, 'nada foi apagado até aqui');
    const ok = await client.request('memory.adminForgetUser', { ctx: ownerWire, userId: OTHER, confirmacao: { alvo: OTHER, via: 'teste' } });
    assert.equal(ok, 2);
    assert.equal((await client.request('memory.list', { ctx: memberWire })).length, 0);
    await medirFilho('cérebro sozinho (canal)', 'cerebro', c);
    const { verifyAudit } = await import('../src/core/audit.js');
    const auditFile = path.join(APP, 'logs', 'core-audit.jsonl');
    const lines = fs.readFileSync(auditFile, 'utf8');
    assert.match(lines, /memory\.admin\.wipe_confirmado/);
    assert.match(lines, /memory\.admin\.wipe_sem_confirmacao/);
    assert.equal(verifyAudit(auditFile).ok, true);
    c.child.send({ tipo: 'desligar' });
    assert.equal((await waitExit(c, 20_000)).code, 0);
  });

  // o registro das exceções: qual teste abriu cada uma e quantas vezes foi usada (segunda revisão da Liz, §12)
  console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log('\nRAM e CPU (medidas pelo próprio processo; PC de desenvolvimento)');
  console.log('cenário | processo | RSS (MB) | heap (MB) | CPU (ms) | vivo (s) | CPU (%) [desde a subida, ou no intervalo se ocioso]');
  for (const m of medicoes) console.log(`${m.cenario} | ${m.papel} | ${m.rssMB} | ${m.heapMB} | ${m.cpuMs} | ${m.uptimeS} | ${m.cpuMedioPct ?? '-'}${m.intervalo ? ' (intervalo)' : ''}`);
  if (process.env.YUI_TESTE_MEDICAO_ARQUIVO) fs.writeFileSync(process.env.YUI_TESTE_MEDICAO_ARQUIVO, JSON.stringify(medicoes, null, 1));
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);
