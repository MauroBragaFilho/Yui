// Etapa 3 de ponta a ponta: o CÉREBRO (src/cerebro.js) e o BOT (src/index.js com YUI_CEREBRO_EXTERNO=true) em processos de
// verdade, conversando pelo canal local (docs/ETAPA3_DONOS_E_CONTRATO.md).
// Execução: npm run test:separacao
//
// Isolamento (nada de produção, nada dos bancos reais):
//  - uma CÓPIA do código (os arquivos que o git enxerga em src/, persona/, knowledge/ e o package.json) numa pasta temporária,
//    com node_modules por junção; os processos rodam com essa pasta como diretório de trabalho (logs, secrets e .env de lá:
//    não há .env na cópia);
//  - bancos numa pasta temporária (conferida contra a pasta real), segredo do canal na pasta temporária, portas aleatórias;
//  - ambiente dos processos montado do zero (só PATH, pastas do sistema e as variáveis do teste): nenhum token ou chave real;
//  - IA FALSA (YUI_TESTE_IA_FALSA=true com NODE_ENV=test): nenhuma chamada a provedor de IA;
//  - o bot sobe com DISCORD_TOKEN=token-falso-de-teste e o motor de políticas em enforce com somente leitura (nenhum download
//    de manutenção); o login falha e o processo sai sozinho, como no teste de subida do atualizador (Testar-Subida).
// Só são encerrados os processos que este teste abriu, pelo handle (nunca por PID achado em varredura).
// Segunda revisão da Liz (etapa 6, §12): cada processo que este teste abre carrega o BLOQUEIO de integração externa
// (tests/helpers/bloqueioExterno.mjs); só as exceções do canal (icacls e whoami do segredo) são liberadas, e cada cenário confere o registro.
// O login no Discord com o token falso, que antes chegava de verdade ao Discord, agora é BLOQUEADO antes de qualquer pacote sair: os cenários
// da subida do bot esperam exatamente essa tentativa bloqueada (e nenhuma outra).
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

// ── Pastas temporárias ─────────────────────────────────────────────────────────────────────────
// O próprio processo do teste também importa módulos de src/ (fachada da memória, auditoria): pasta de bancos isolada antes.
const localDb = useIsolatedDatabaseDir('yui-separacao-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-separacao-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const JUNCTION = path.join(APP, 'node_modules');
fs.mkdirSync(DB, { recursive: true });
// Só as exceções que ESTE teste precisa: o icacls e o whoami do segredo do canal no Windows, e o PowerShell da trava de dono (o segundo
// cérebro recusado lê a hora de início do processo dono pelo CIM para não confiar só no PID; só leitura local, sem rede).
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), {
  teste: 'test:separacao',
  liberar: { ...EXCECOES_DO_CANAL, 'programa:powershell': 'a trava de dono lê a hora de início do processo dono (src/database/ownerLock.js: Get-CimInstance, só leitura local, sem rede)' },
});
/** O login de verdade no Discord com o token falso: o bloqueio impede a conexão (nenhum pacote sai); a subida chega até ele e para ali. */
const LOGIN_DISCORD_BLOQUEADO = [
  { tipo: 'rede', alvo: /discord(?:app)?\.(?:com|gg)/i, motivo: 'o login no Discord com o token falso, bloqueado antes de sair' },
  // a subida procura os binários de mídia no PATH (src/utils/binaries.js, `where`): bloqueado também (nenhum programa roda no teste); a
  // subida segue sem eles, como numa máquina sem os binários
  { tipo: 'processo', alvo: /^execFile where$/, motivo: 'a busca dos binários de mídia no PATH, bloqueada', opcional: true },
];
// O processo do teste também trabalha na pasta temporária: o log dos módulos de src/ que ele importa vai para T/logs e o .env
// real do repositório não é lido (não há .env lá).
const TEST_CWD = path.join(T, 'teste');
fs.mkdirSync(TEST_CWD, { recursive: true });
process.chdir(TEST_CWD);

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
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src', 'persona', 'knowledge', 'package.json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\0').filter(Boolean);
    if (files.length > 50) return files;
  } catch { /* sem git: cai para a cópia filtrada */ }
  // Sem git: a árvore inteira, sem binários, temporários de mídia e bancos (o que o .gitignore deixaria de fora).
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
  for (const dir of ['src', 'persona', 'knowledge']) if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  files.push('package.json');
  return files;
}

function copyCode() {
  let n = 0;
  for (const rel of listCodeFiles()) {
    const from = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(from); } catch { continue; } // apagado no disco (ainda no índice do git)
    if (!st.isFile()) continue;
    const to = path.join(APP, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    n += 1;
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), JUNCTION, 'junction');
  return n;
}

// ── Processos ──────────────────────────────────────────────────────────────────────────────────
const SYSTEM_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'ProgramFiles', 'ProgramData', 'SystemDrive', 'LANG'];
const COMMON = {
  NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', LOG_LEVEL: 'info',
  DATABASE_DIR: DB, YUI_CHANNEL_SECRET_FILE: SECRET, YUI_CHANNEL_PORT: '0',
  YUI_DB_OWNER_HEARTBEAT_MS: '300', YUI_DB_OWNER_STALE_MS: '1500',
  YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'true',
  YUI_ALERTS: 'false', YUI_MORNING_REPORT: 'false', YUI_HEALTH_REPORT: 'false',
  GTA_WEEKLY_ENABLED: 'false', NEWSWIRE_ENABLED: 'false', YOUTUBE_INTERVAL_MINUTES: '0', TWITCH_INTERVAL_MINUTES: '0',
  YUI_GATEWAY_ENABLED: 'false',
};
// O motor dos bancos acompanha o do teste (npm run test:ci com YUI_DB_NATIVE=* roda tudo no node:sqlite).
const NATIVE = String(process.env.YUI_DB_NATIVE ?? '').trim();
function childEnv(extra = {}) {
  const env = {};
  for (const k of SYSTEM_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...COMMON, ...(NATIVE ? { YUI_DB_NATIVE: NATIVE } : {}), ...extra };
}

const procs = new Set();
const allProcs = [];
function startProc(label, script, env, { ipc = false } = {}) {
  const child = spawn(process.execPath, [...BLOQUEIO.argv, script], { cwd: APP, env: { ...env, ...BLOQUEIO.env(label) }, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
const tail = (proc, n = 30) => proc.out.split(/\r?\n/).slice(-n).join('\n');
async function waitFor(proc, re, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (re.test(proc.out)) return;
    if (proc.exited) break;
    await sleep(50);
  }
  if (re.test(proc.out)) return;
  throw new Error(`${proc.label}: não apareceu ${re} (${proc.exited ? `saiu com código ${proc.code}` : 'tempo esgotado'}).\n--- saída ---\n${tail(proc)}`);
}
async function waitExit(proc, timeoutMs) {
  const r = await Promise.race([proc.exit, sleep(timeoutMs).then(() => null)]);
  if (!r) {
    proc.child.kill(); // o processo que ESTE teste abriu (handle), nunca um achado por varredura
    throw new Error(`${proc.label}: não terminou em ${timeoutMs} ms.\n--- saída ---\n${tail(proc)}`);
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
  throw new Error(`tempo esgotado esperando: ${what}`);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ── Limpeza (sempre: só os processos deste teste, a junção primeiro, depois as pastas) ─────────────
async function cleanup() {
  // YUI_TESTE_MOSTRAR_SAIDA=1: mostra a saída de cada processo (para investigar uma falha).
  if (process.env.YUI_TESTE_MOSTRAR_SAIDA === '1') for (const p of allProcs) console.log(`\n===== ${p.label} (código ${p.code}) =====\n${p.out}`);
  for (const proc of [...procs]) {
    try { proc.child.kill(); } catch { /* já saiu */ }
    await Promise.race([proc.exit, sleep(3000)]);
  }
  // Sai da pasta temporária e fecha o log deste processo (no Windows arquivo aberto e pasta de trabalho não saem).
  try { process.chdir(ROOT); } catch { /* */ }
  try { testLogger?.close(); } catch { /* */ }
  await sleep(300);
  let junctionGone = false;
  try { fs.unlinkSync(JUNCTION); } catch { /* não existe ou não deu */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[separacao] não consegui apagar ${T}: ${err.message}`); }
  } else {
    // Nunca apaga recursivamente uma pasta com a junção ainda lá (apagaria o node_modules de verdade).
    console.warn(`[separacao] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  }
  localDb.cleanup();
}
process.on('exit', () => {
  for (const proc of procs) { try { proc.child.kill(); } catch { /* */ } }
  if (!finished && process.exitCode === undefined) process.exitCode = 1;
});

// ── HTTP na API do cérebro ─────────────────────────────────────────────────────────────────────
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

// ── Bot de teste (cliente do canal no papel `bot`, no próprio processo do teste) ──────────────────
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
let connectChannel;
let ChannelError;
let testLogger = null;
function fakeBot() {
  const state = { dms: [], setChannel: [], dmDelayMs: 0, statusCalls: 0, aiEvents: [] };
  const client = connectChannel({ role: 'bot', secretFile: SECRET, capabilities: ['discord.dm', 'discord.status', 'guild.admin'], logger: quietLogger, minBackoffMs: 50, maxBackoffMs: 300 });
  client.on('ai.settingsChanged', (payload) => { state.aiEvents.push(payload?.tipo); });
  client.handle('discord.status', async () => { state.statusCalls += 1; return { online: true, tag: 'YuiTeste#0001', guilds: 1, bans: { users: 0, guilds: 0, channels: 0 } }; });
  client.handle('discord.dm.send', async (p, meta) => {
    if (state.dmDelayMs) await sleep(state.dmDelayMs);
    state.dms.push({ ...p, idem: meta.idem });
    return { sent: true, parts: 1 };
  });
  client.handle('guild.list', async (p) => [{ id: GUILD, name: 'Servidor de Teste', members: 3, automod: 'off', tosAccepted: true, pedidoPor: p.userId }]);
  client.handle('guild.get', async (p) => {
    if (p.guildId !== GUILD) throw new ChannelError('ADMIN_404', 'A Yui não está nesse servidor.');
    return { id: p.guildId, name: 'Servidor de Teste', channels: [{ id: CHANNEL, name: 'geral', type: 0 }] };
  });
  client.handle('guild.setChannel', async (p, meta) => { state.setChannel.push({ ...p, idem: meta.idem }); return { ok: true }; });
  return { client, state };
}
const ownerWire = { platform: 'discord', userId: OWNER, guildId: null, channelId: null, isDM: true, isBlocked: false };
const memberWire = { platform: 'discord', userId: OTHER, guildId: GUILD, channelId: CHANNEL, isDM: false, isBlocked: false };

const readLock = (name) => { try { return JSON.parse(fs.readFileSync(path.join(DB, `${name}.db.owner`), 'utf8')); } catch { return null; } };
async function readDbRows(name, sql) {
  const file = path.join(DB, `${name}.db`);
  const nativeNames = new Set(NATIVE.split(',').map((s) => s.trim()).filter(Boolean));
  if (nativeNames.has('*') || nativeNames.has(name)) {
    // Motor nativo (WAL): o que ainda está no -wal só aparece por uma conexão SQLite de verdade (só leitura).
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
  }
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(DB, `${name}.db`)));
  try {
    const res = db.exec(sql);
    if (!res.length) return [];
    return res[0].values.map((row) => Object.fromEntries(res[0].columns.map((c, i) => [c, row[i]])));
  } finally { db.close(); }
}

const LOAD_ERRORS = /ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|Cannot find (?:module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED|TypeError: .* is not a function/;

try {
  console.log('Preparação');
  await test('cópia do código numa pasta temporária (node_modules por junção) e portas livres', async () => {
    const n = copyCode();
    assert.ok(n > 100, `poucos arquivos copiados (${n})`);
    assert.ok(fs.existsSync(path.join(APP, 'src', 'cerebro.js')) && fs.existsSync(path.join(APP, 'src', 'index.js')));
    assert.ok(!fs.existsSync(path.join(APP, '.env')), 'a cópia não pode ter .env');
    apiPort = await freePort();
    ({ connectChannel } = await import('../src/core/channel/client.js'));
    ({ ChannelError } = await import('../src/core/channel/protocol.js'));
    ({ logger: testLogger } = await import('../src/utils/logger.js'));
  });

  await test('a IA falsa só liga com NODE_ENV=test (nunca vale em produção)', async () => {
    const { fakeAiMode, activateFakeAi } = await import('../src/cerebro/iaFalsa.js');
    assert.equal(fakeAiMode({}), 'off');
    assert.equal(fakeAiMode({ YUI_TESTE_IA_FALSA: 'true' }), 'refused');
    assert.equal(fakeAiMode({ YUI_TESTE_IA_FALSA: 'true', NODE_ENV: 'production' }), 'refused');
    assert.equal(fakeAiMode({ YUI_TESTE_IA_FALSA: 'true', NODE_ENV: 'test' }), 'on');
    const registered = [];
    assert.equal(activateFakeAi({ registerBackend: (b) => registered.push(b.name) }, { env: { YUI_TESTE_IA_FALSA: 'true', NODE_ENV: 'production' } }), 'refused');
    assert.deepEqual(registered, [], 'em produção nada é registrado');
  });

  const cerebroEnv = () => childEnv({
    YUI_TESTE_IA_FALSA: 'true', YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(apiPort), YUI_API_TOKENS: `${TOKEN}=${OWNER}`,
    YUI_CEREBRO_LEMBRETES_MS: '300', YUI_CEREBRO_DM_TIMEOUT_MS: '800',
  });

  console.log('Cérebro sozinho');
  let c1;
  await test('o cérebro sobe, responde /v1/health e /v1/agent com a persona, sem a ponte do bot, e pega as travas de dono', async () => {
    c1 = startProc('cerebro#1', 'src/cerebro.js', cerebroEnv(), { ipc: true });
    await waitFor(c1, /YuiCerebro pronto/);
    await waitFor(c1, /Yui API ouvindo/);
    // Etapa 8: o cérebro é o DONO do arquivo da cota de busca por hora (a trava de dono fica ao lado do arquivo, em secrets/ da cópia)
    assert.match(c1.out, /Cota de busca por hora em disco \(dono: cerebro\)/);
    const travaCota = JSON.parse(fs.readFileSync(path.join(APP, 'secrets', 'search-budget-hora.json.owner'), 'utf8'));
    assert.equal(travaCota.role, 'cerebro');
    assert.equal(travaCota.pid, c1.child.pid);
    const h = await api('GET', '/v1/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.memory, true);
    assert.equal(h.json.cerebro.ponteDoBot, false, 'o cérebro não tem a ponte do bot');
    assert.equal(h.json.cerebro.backend, 'teste-ia-falsa');
    assert.equal(h.json.discord.online, null, 'o cérebro não diz nada sobre o Discord ao supervisor');
    assert.ok(h.json.backends.some((b) => b.name === 'teste-ia-falsa' && b.active));
    const a = await api('POST', '/v1/agent', { message: 'oi, tudo bem com você?' });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.type, 'reply');
    assert.match(a.json.reply, /^IA-FALSA persona=sim /, 'a persona chegou ao backend (texto com o horário de Brasília)');
    for (const name of ['memory-personal', 'memory-discord']) {
      const lock = readLock(name);
      assert.equal(lock?.role, 'cerebro', `trava de ${name}`);
      assert.equal(lock?.pid, c1.child.pid);
    }
    assert.ok(!fs.existsSync(path.join(DB, 'core.db')), 'o cérebro não abre os bancos do bot');
    assert.doesNotMatch(c1.out, LOAD_ERRORS);
  });

  console.log('Canal: o bot pede, o cérebro é o dono');
  let bot = fakeBot();
  await test('o cliente no papel bot conecta e vê os métodos do cérebro', async () => {
    const hello = await bot.client.ready(10_000);
    for (const m of ['memory.recall', 'memory.remember', 'memory.forget', 'memory.forgetAll', 'memory.list', 'memory.touch', 'memory.adminListUsers', 'memory.adminForgetUser', 'context.forgetUser', 'reminders.route', 'research.run', 'health']) {
      assert.ok(hello.accepted.includes(m), `o cérebro não oferece ${m}`);
    }
  });

  await test('memory.remember e memory.recall pelo canal; os dados ficam nos bancos do cérebro', async () => {
    const r1 = await bot.client.request('memory.remember', { ctx: ownerWire, type: 'preference', content: 'eu gosto de Sultan RS', importance: 3, source: 'teste' }, { idem: 'teste-remember-1' });
    assert.equal(r1.changes, 1);
    const r2 = await bot.client.request('memory.remember', { ctx: memberWire, type: 'fact', content: 'O nome do usuário é Ana.', importance: 4 }, { idem: 'teste-remember-2' });
    assert.equal(r2.changes, 1);
    const rec = await bot.client.request('memory.recall', { ctx: ownerWire, query: 'qual carro, sultan?' });
    assert.equal(rec.length, 1);
    assert.match(rec[0].content, /Sultan RS/);
    const list = await bot.client.request('memory.list', { ctx: memberWire });
    assert.deepEqual(list.map((m) => m.content), ['O nome do usuário é Ana.']);
    // o dono em DM vai para a memória PESSOAL e o membro no servidor para a do Discord (o cérebro decide o escopo)
    assert.deepEqual((await readDbRows('memory-personal', 'SELECT user_id, content FROM memories')).map((r) => [r.user_id, r.content]), [[OWNER, 'eu gosto de Sultan RS']]);
    assert.deepEqual((await readDbRows('memory-discord', 'SELECT user_id, content FROM memories')).map((r) => [r.user_id, r.content]), [[OTHER, 'O nome do usuário é Ana.']]);
    // o que o bot gravou chega ao app (a mesma memória pessoal do dono)
    const a = await api('POST', '/v1/agent', { message: 'você lembra do meu carro? sultan' });
    assert.match(a.json.reply, /persona=sim .*memoria=sim/);
  });

  await test('o cérebro remonta o contexto e confere o dono (o bot não escolhe escopo nem papel)', async () => {
    await assert.rejects(bot.client.request('memory.recall', { ctx: { ...ownerWire, platform: 'api' }, query: 'x' }), (e) => e.code === 'BAD_PARAMS');
    await assert.rejects(bot.client.request('memory.list', { ctx: { ...ownerWire, userId: 'abc' } }), (e) => e.code === 'BAD_PARAMS');
    await assert.rejects(bot.client.request('memory.adminListUsers', { ctx: memberWire }), (e) => /Apenas o dono/.test(e.message));
    const admin = await bot.client.request('memory.adminListUsers', { ctx: ownerWire });
    assert.equal(admin.total, 1);
    // o dono num canal PÚBLICO do servidor fica na memória pública (nada da pessoal)
    const pub = await bot.client.request('memory.recall', { ctx: { ...ownerWire, guildId: GUILD, channelId: CHANNEL, isDM: false }, query: 'sultan' });
    assert.equal(pub.length, 0);
  });

  await test('pesquisa (research.run), lembretes por conversa (reminders.*) e saúde (health) pelo canal', async () => {
    const res = await bot.client.request('research.run', { question: 'pesquise o preço da RTX 5090', userId: OWNER, disabled: true });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'refused');
    assert.ok(res.text.length > 0);
    const rem = await bot.client.request('reminders.route', { text: 'me lembra daqui 10 minutos de conferir o teste', userId: OWNER, authorName: 'dono' }, { idem: 'teste-rem-1' });
    assert.equal(rem.handled, true);
    assert.match(rem.text, /Anotado/);
    const mine = await bot.client.request('reminders.list', { userId: OWNER });
    assert.equal(mine.length, 1);
    assert.equal((await bot.client.request('reminders.list', { userId: OTHER })).length, 0, 'cada pessoa só vê os próprios lembretes');
    const notReminder = await bot.client.request('reminders.route', { text: 'você lembra do Gabriel?', userId: OWNER });
    assert.equal(notReminder.handled, false);
    const h = await bot.client.request('health');
    assert.equal(h.role, 'cerebro');
    assert.equal(h.ponteDoBot, false);
    assert.equal(h.bot.conectado, true);
    assert.equal(h.travas.role, 'cerebro');
    assert.deepEqual(h.travas.held.map((x) => x.name).sort(), ['memory-discord', 'memory-personal']);
  });

  await test('o painel do cérebro pede ao bot as telas do Discord (guild.list, guild.get, guild.setChannel)', async () => {
    const g = await api('GET', '/v1/admin/guilds');
    assert.equal(g.status, 200, JSON.stringify(g.json));
    assert.equal(g.json.guilds[0].name, 'Servidor de Teste');
    assert.equal(g.json.guilds[0].pedidoPor, OWNER);
    const d = await api('GET', `/v1/admin/guilds/${GUILD}`);
    assert.equal(d.status, 200);
    assert.equal(d.json.channels[0].id, CHANNEL);
    const missing = await api('GET', '/v1/admin/guilds/999999999999999999');
    assert.equal(missing.status, 404, 'o status do erro do bot volta igual ao painel');
    assert.match(missing.json.error, /não está nesse servidor/);
    const s = await api('PUT', `/v1/admin/guilds/${GUILD}/channels`, { type: 'noticias', channelId: CHANNEL });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(bot.state.setChannel.length, 1);
    assert.ok(bot.state.setChannel[0].idem, 'gravação pelo canal leva chave de idempotência');
    const o = await api('GET', '/v1/admin/overview');
    assert.equal(o.status, 200);
    assert.equal(o.json.discord.online, true);
    assert.equal(o.json.cerebro.botConectado, true);
    // IA: o painel grava no cérebro e avisa o bot (que tem a cadeia de IA dele); na conexão o bot também é avisado
    assert.ok(bot.state.aiEvents.includes('reconexao'), 'o bot relê a configuração de IA ao conectar');
    const reset = await api('POST', '/v1/admin/gateway/reset', {});
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    await waitUntil(() => bot.state.aiEvents.includes('descanso'), 5_000, 'o aviso de descansos zerados chegar ao bot');
  });

  console.log('Ações do bot (o adaptador atende o cérebro)');
  await test('discord.dm.send, discord.status, guild.* e panel.admin no adaptador, com Discord e painel falsos', async () => {
    const { registerBotActions } = await import('../src/discord/canalCerebro.js');
    const { AdminError } = await import('../src/core/api/admin.js');
    const handlers = new Map();
    const sent = [];
    const calls = [];
    let ready = true;
    const discord = { isReady: () => ready, user: { tag: 'Yui#0001' }, guilds: { cache: new Map([[GUILD, {}]]) }, users: { fetch: async (id) => ({ send: async (t) => { sent.push({ id, t }); } }) } };
    const admin = {
      guilds: async (ctx) => { calls.push(['guilds', ctx.role]); return [{ id: GUILD }]; },
      guildDetail: async () => { throw new AdminError(404, 'A Yui não está nesse servidor.'); },
      setGuildChannel: async (ctx, id, type, ch) => { calls.push(['setGuildChannel', id, type, ch]); return { ok: true }; },
      bans: async () => ({ users: [] }),
    };
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => discord, admin, getBans: async () => ({ users: { [OTHER]: {} }, guilds: {}, channels: {} }) });
    const call = (m, p) => handlers.get(m)(p, { role: 'cerebro' });
    for (const m of ['discord.dm.send', 'discord.status', 'guild.list', 'guild.get', 'guild.setChannel', 'panel.admin']) assert.ok(handlers.has(m), m);
    process.env.YUI_TESTE_SEGREDO_TOKEN = 'segredo-que-nao-pode-sair-123';
    try {
      await call('discord.dm.send', { userId: OWNER, motivo: 'lembrete', text: `lembrete com segredo-que-nao-pode-sair-123 e ${'x '.repeat(1500)}` });
      assert.ok(sent.length >= 2, 'texto longo vira várias mensagens');
      assert.ok(sent.every((s) => s.id === OWNER && !s.t.includes('segredo-que-nao-pode-sair-123')), 'o lembrete sai mascarado, como no processo único');
    } finally { delete process.env.YUI_TESTE_SEGREDO_TOKEN; }
    await assert.rejects(call('discord.dm.send', { userId: OTHER, motivo: 'alerta', text: 'oi' }), (e) => e.code === 'FORBIDDEN', 'só lembrete vai para quem não é o dono');
    await call('discord.dm.send', { userId: OTHER, motivo: 'lembrete', text: 'seu lembrete' });
    assert.equal(sent.at(-1).id, OTHER);
    await assert.rejects(call('discord.dm.send', { userId: OWNER, motivo: 'qualquer', text: 'oi' }), (e) => e.code === 'BAD_PARAMS');
    ready = false;
    await assert.rejects(call('discord.dm.send', { userId: OWNER, motivo: 'painel', text: 'oi' }), (e) => e.code === 'DISCORD_OFFLINE');
    assert.deepEqual(await call('discord.status', {}), { online: false, tag: null, guilds: 0, bans: { users: 1, guilds: 0, channels: 0 } });
    ready = true;
    assert.equal((await call('discord.status', {})).guilds, 1);
    assert.deepEqual(await call('guild.list', { userId: OWNER }), [{ id: GUILD }]);
    assert.deepEqual(calls[0], ['guilds', 'OWNER'], 'o bot monta o contexto do dono com as regras dele');
    await assert.rejects(call('guild.list', { userId: OTHER }), (e) => e.code === 'FORBIDDEN');
    await assert.rejects(call('guild.get', { userId: OWNER, guildId: GUILD }), (e) => e.code === 'ADMIN_404' && /não está nesse servidor/.test(e.message));
    await call('guild.setChannel', { userId: OWNER, guildId: GUILD, type: 'noticias', channelId: CHANNEL });
    assert.deepEqual(calls.at(-1), ['setGuildChannel', GUILD, 'noticias', CHANNEL]);
    assert.deepEqual(await call('panel.admin', { userId: OWNER, action: 'bans', args: [] }), { users: [] });
    await assert.rejects(call('panel.admin', { userId: OWNER, action: 'restart', args: [true] }), (e) => e.code === 'METHOD_NOT_ALLOWED', 'só as telas da lista');
    // mudança de IA no painel (cérebro) -> a cadeia de IA do bot acompanha
    const { applyAiSettingsChange } = await import('../src/discord/canalCerebro.js');
    const seen = [];
    const env = { GROQ_API_KEY: 'a' };
    const gateway = { getGateway: () => ({ reset: () => seen.push('reset') }), resetGateway: () => seen.push('rebuild') };
    assert.equal(applyAiSettingsChange({ tipo: 'descanso' }, quietLogger, { apply: () => seen.push('apply'), gateway, env }), true);
    assert.equal(applyAiSettingsChange({ tipo: 'chaves' }, quietLogger, { apply: () => seen.push('apply'), gateway, env }), true);
    assert.equal(applyAiSettingsChange({ tipo: 'reconexao' }, quietLogger, { apply: () => seen.push('apply'), gateway, env }), false, 'nada mudou: o Gateway não é refeito');
    assert.equal(applyAiSettingsChange({ tipo: 'reconexao' }, quietLogger, { apply: () => { env.GROQ_API_KEY = 'b'; }, gateway, env }), true);
    assert.deepEqual(seen, ['reset', 'apply', 'rebuild', 'apply', 'rebuild']);
  });

  console.log('Travas de dono');
  await test('um segundo cérebro na mesma pasta é recusado pela trava (HELD) e não mexe no canal do primeiro', async () => {
    const secretBefore = fs.readFileSync(SECRET, 'utf8');
    const c2 = startProc('cerebro#2', 'src/cerebro.js', childEnv({ ...cerebroEnv(), YUI_API_PORT: String(await freePort()) }));
    const { code } = await waitExit(c2, 60_000);
    assert.notEqual(code, 0);
    assert.match(c2.out, /YUI_DB_OWNER_HELD/);
    assert.equal(fs.readFileSync(SECRET, 'utf8'), secretBefore, 'o segredo do canal do primeiro cérebro não pode mudar');
    assert.equal(readLock('memory-personal')?.pid, c1.child.pid);
    assert.equal(bot.client.connected, true);
  });

  await test('o processo bot não consegue abrir memory-personal (recusa por dono) e abre os bancos dele com a trava', async () => {
    const code = [
      "const db = await import('./src/database/db.js');",
      "try { await db.initDatabase('memory-personal', 'CREATE TABLE IF NOT EXISTS t (a)'); console.log('ABRIU memory-personal'); } catch (e) { console.log('RECUSA ' + e.code); }",
      "try { await db.initDatabase('banco-fora-do-mapa', 'CREATE TABLE IF NOT EXISTS t (a)'); console.log('ABRIU fora do mapa'); } catch (e) { console.log('FORA ' + e.code); }",
      "await db.initDatabase('core', 'CREATE TABLE IF NOT EXISTS t (a)');",
      "console.log('TRAVAS ' + JSON.stringify(db.databaseOwnerStats().held));",
      "console.log('FALHAS ' + JSON.stringify(db.databaseStats().filter((b) => b.openFailures).map((b) => b.name).sort()));",
      'db.closeAllDatabases();',
      "console.log('FIM');",
    ].join('\n');
    const q = spawn(process.execPath, [...BLOQUEIO.argv, '--input-type=module', '-e', code], { cwd: APP, env: childEnv({ YUI_DB_OWNER_ROLE: 'bot', ...BLOQUEIO.env('banco-do-bot') }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    q.stdout.on('data', (d) => { out += d; });
    q.stderr.on('data', (d) => { out += d; });
    const exitCode = await Promise.race([new Promise((r) => q.on('exit', r)), sleep(60_000).then(() => { q.kill(); return 'tempo esgotado'; })]);
    assert.equal(exitCode, 0, out);
    assert.match(out, /RECUSA YUI_DB_NOT_OWNER/);
    assert.match(out, /FORA YUI_DB_NOT_OWNER/);
    assert.match(out, /TRAVAS \[\{"name":"core","held":true\}\]/);
    assert.match(out, /FALHAS \["banco-fora-do-mapa","memory-personal"\]/, 'as recusas contam para o relatório de saúde');
    assert.match(out, /FIM/);
    assert.equal(readLock('core'), null, 'fechar o banco solta a trava');
    assert.ok(!fs.existsSync(path.join(DB, 'banco-fora-do-mapa.db')));
    assert.equal(readLock('memory-personal')?.pid, c1.child.pid, 'a trava do cérebro continua com ele');
  });

  await test('trava PERDIDA (outro processo tomou o arquivo): o banco fecha sem gravar e o relatório de saúde mostra', async () => {
    const lostDir = path.join(T, 'db-trava-perdida');
    fs.mkdirSync(lostDir, { recursive: true });
    const code = [
      "import fs from 'node:fs';",
      "const db = await import('./src/database/db.js');",
      "const { summarizeDatabases } = await import('./src/core/healthReport.js');",
      "await db.initDatabase('memory-personal', 'CREATE TABLE IF NOT EXISTS t (a)');",
      "db.getDbWrapper('memory-personal').prepare('INSERT INTO t (a) VALUES (1)').run();",
      "const lockFile = process.env.DATABASE_DIR + '/memory-personal.db.owner';",
      "const rec = JSON.parse(fs.readFileSync(lockFile, 'utf8'));",
      "fs.writeFileSync(lockFile, JSON.stringify({ ...rec, pid: rec.pid + 1, token: 'outro-processo' }));",
      'await new Promise((r) => setTimeout(r, 900));',
      "try { db.getDbWrapper('memory-personal').prepare('INSERT INTO t (a) VALUES (2)').run(); console.log('GRAVOU'); } catch (e) { console.log('RECUSOU ' + /não inicializado/.test(e.message)); }",
      "const st = db.databaseStats().find((b) => b.name === 'memory-personal');",
      "console.log('PERDIDA ' + st.ownerLost + ' ' + st.open + ' ' + db.databaseOwnerStats().lost);",
      "console.log('SAUDE ' + summarizeDatabases(db.databaseStats()).line);",
      "console.log('TRAVA ' + JSON.parse(fs.readFileSync(lockFile, 'utf8')).token);",
    ].join('\n');
    const q = spawn(process.execPath, [...BLOQUEIO.argv, '--input-type=module', '-e', code], {
      cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ YUI_DB_OWNER_ROLE: 'cerebro', DATABASE_DIR: lostDir, YUI_DB_OWNER_HEARTBEAT_MS: '200', YUI_DB_OWNER_STALE_MS: '1000', ...BLOQUEIO.env('trava-perdida') }),
    });
    let out = '';
    q.stdout.on('data', (d) => { out += d; });
    q.stderr.on('data', (d) => { out += d; });
    const exitCode = await Promise.race([new Promise((r) => q.on('exit', r)), sleep(60_000).then(() => { q.kill(); return 'tempo esgotado'; })]);
    assert.equal(exitCode, 0, out);
    assert.match(out, /a trava de dono foi PERDIDA/);
    assert.match(out, /RECUSOU true/, 'sem a trava, o banco não grava mais');
    assert.match(out, /PERDIDA 1 false 1/);
    assert.match(out, /SAUDE .*memory-personal: .*trava de dono perdida/);
    assert.match(out, /TRAVA outro-processo/, 'a trava do outro processo fica intacta (nunca é apagada por quem perdeu)');
  });

  console.log('Lembretes: o cérebro é o dono, o aviso sai pelo bot');
  const reminders = async () => (await api('GET', '/v1/admin/reminders')).json.reminders;
  const addReminder = async (text, inMs) => {
    const r = await api('POST', '/v1/admin/reminders', { text, at: new Date(Date.now() + inMs).toISOString() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.reminder;
  };
  await test('um lembrete que vence dispara discord.dm.send no bot, uma vez, com chave de idempotência', async () => {
    const r = await addReminder('tomar agua', 800);
    await waitUntil(() => bot.state.dms.some((d) => /tomar agua/.test(d.text)), 10_000, 'a DM do lembrete');
    await sleep(900);
    const dms = bot.state.dms.filter((d) => /tomar agua/.test(d.text));
    assert.equal(dms.length, 1);
    assert.equal(dms[0].userId, OWNER);
    assert.equal(dms[0].motivo, 'lembrete');
    assert.match(dms[0].idem, new RegExp(`^lembrete:${r.id}:`));
    assert.ok(!(await reminders()).some((x) => x.id === r.id), 'avisado = fora da lista');
  });

  await test('com o bot desconectado o lembrete fica pendente (sem contar tentativa) e sai uma vez só quando ele volta', async () => {
    await bot.client.close();
    await waitUntil(async () => (await api('GET', '/v1/admin/guilds')).status === 503, 5_000, 'o painel perceber o bot fora');
    const off = await api('GET', '/v1/admin/guilds');
    assert.match(off.json.error, /Disponível só com o bot conectado/);
    const r = await addReminder('alongar as costas', 300);
    await sleep(2000);
    const pending = (await reminders()).find((x) => x.id === r.id);
    assert.ok(pending, 'o lembrete continua pendente');
    assert.equal(pending.tries, 0, 'bot fora não conta tentativa');
    bot = fakeBot();
    await bot.client.ready(10_000);
    await waitUntil(() => bot.state.dms.some((d) => /alongar as costas/.test(d.text)), 10_000, 'a DM quando o bot volta');
    await sleep(1200);
    assert.equal(bot.state.dms.filter((d) => /alongar as costas/.test(d.text)).length, 1, 'nada de aviso repetido');
    assert.ok(!(await reminders()).some((x) => x.id === r.id));
  });

  await test('resposta do bot perdida (prazo estourado): o cérebro tenta de novo e a idempotência impede a DM repetida', async () => {
    bot.state.dmDelayMs = 1500; // maior que o prazo da DM no cérebro (800 ms): a primeira resposta chega tarde demais
    const r = await addReminder('beber cafe', 200);
    await waitUntil(async () => !(await reminders()).some((x) => x.id === r.id), 15_000, 'o lembrete sair da lista');
    bot.state.dmDelayMs = 0;
    await sleep(600);
    assert.equal(bot.state.dms.filter((d) => /beber cafe/.test(d.text)).length, 1, 'o bot mandou a DM uma vez só');
    assert.match(c1.out, /o bot não entregou a DM \(TIMEOUT\)/, 'houve mesmo uma nova tentativa');
  });

  console.log('Queda e volta do cérebro');
  let c3;
  await test('matar o cérebro faz o pedido do bot falhar com erro claro, e a fachada da memória responde "indisponível"', async () => {
    c1.child.kill(); // pelo handle
    await waitExit(c1, 15_000);
    await waitUntil(() => !bot.client.connected, 5_000, 'o bot perceber a queda');
    await assert.rejects(bot.client.request('memory.recall', { ctx: ownerWire, query: 'sultan' }), (e) => ['NOT_CONNECTED', 'CONNECTION_LOST'].includes(e.code) && /cérebro/.test(e.message));
    const facade = await import('../src/core/memory/facade.js');
    const adapter = await import('../src/core/discordAdapter.js');
    const { buildContext } = await import('../src/core/permissions.js');
    const ctx = buildContext({ platform: 'discord', userId: OWNER, isDM: true });
    facade.setMemoryRemote(bot.client);
    try {
      await assert.rejects(facade.recall(ctx, 'sultan'), (e) => e.code === facade.MEMORY_UNAVAILABLE && /indisponível/.test(e.message));
      assert.equal(await adapter.buildMemoryBlock(ctx, 'sultan'), '', 'sem memória, a conversa segue');
      assert.equal(await adapter.captureFromUserText(ctx, 'lembra que eu uso Linux'), 0);
    } finally {
      facade.setMemoryRemote(null);
    }
    assert.equal(readLock('memory-personal')?.pid, c1.child.pid, 'a trava do processo morto fica no disco');
  });

  await test('o cérebro volta (retoma a trava do processo morto) e o bot reconecta sozinho; os dados continuam lá', async () => {
    c3 = startProc('cerebro#3', 'src/cerebro.js', cerebroEnv(), { ipc: true });
    await waitFor(c3, /YuiCerebro pronto/);
    assert.equal(readLock('memory-personal')?.pid, c3.child.pid);
    await waitUntil(() => bot.client.connected, 10_000, 'o bot reconectar');
    const rec = await bot.client.request('memory.recall', { ctx: ownerWire, query: 'sultan' });
    assert.match(rec[0]?.content ?? '', /Sultan RS/);
  });

  await test('o desligamento limpo fecha o canal, a API e os bancos e solta as travas', async () => {
    c3.child.send({ tipo: 'desligar' });
    const { code } = await waitExit(c3, 20_000);
    assert.equal(code, 0, tail(c3));
    assert.match(c3.out, /Desligado: canal, API e Gateway fechados; \d+ banco\(s\) fechado\(s\) e travas de dono soltas/);
    for (const name of ['memory-personal', 'memory-discord']) assert.equal(readLock(name), null, `trava de ${name} solta`);
    assert.ok(!fs.existsSync(SECRET), 'o arquivo do segredo do canal sai junto');
    await bot.client.close();
  });

  console.log('Subida de verdade do bot (token falso)');
  const botEnv = (extra = {}) => childEnv({ DISCORD_TOKEN: 'token-falso-de-teste', YUI_POLICY_MODE: 'enforce', YUI_READ_ONLY: 'true', ...extra });
  await test('bot separado com o cérebro rodando: conecta no canal, não abre a memória e chega até "Falha ao logar no Discord"', async () => {
    const c4 = startProc('cerebro#4', 'src/cerebro.js', cerebroEnv(), { ipc: true });
    await waitFor(c4, /YuiCerebro pronto/);
    const b = startProc('bot-separado', 'src/index.js', botEnv({ YUI_CEREBRO_EXTERNO: 'true' }));
    const { code } = await waitExit(b, 150_000);
    assert.notEqual(code, 0);
    assert.doesNotMatch(b.out, LOAD_ERRORS, tail(b));
    assert.match(b.out, /Inicializando Yui/);
    assert.match(b.out, /Cérebro separado \(YUI_CEREBRO_EXTERNO=true\)/);
    assert.match(b.out, /Conectado ao cérebro pelo canal local/);
    // Etapa 8: com o cérebro separado o bot NUNCA grava a cota de busca por hora (o dono do arquivo é o cérebro): nem tenta pegar a trava
    assert.match(b.out, /o bot não grava/);
    assert.doesNotMatch(b.out, /Cota de busca por hora em disco \(dono/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(APP, 'secrets', 'search-budget-hora.json.owner'), 'utf8')).role, 'cerebro', 'a trava continua sendo do cérebro');
    assert.match(b.out, /Falha ao logar no Discord/, tail(b));
    BLOQUEIO.conferir('subida do bot separado', { esperados: LOGIN_DISCORD_BLOQUEADO });
    assert.doesNotMatch(b.out, /"memory-(?:personal|discord)"/, 'o bot separado não abre os bancos de memória');
    assert.match(c4.out, /\[canal\] bot conectado/);
    assert.ok(fs.existsSync(path.join(DB, 'core.db')), 'o bot abriu o banco dele');
    for (const name of ['core', 'newswire', 'gta-diario', 'gta-semanal', 'social-youtube', 'social-twitch']) assert.equal(readLock(name), null, `a trava de ${name} saiu com o processo`);
    // auditoria: cada processo no seu arquivo, cada corrente íntegra
    const { verifyAudit } = await import('../src/core/audit.js');
    const mainAudit = path.join(APP, 'logs', 'core-audit.jsonl');
    const botAudit = path.join(APP, 'logs', 'core-audit-bot.jsonl');
    assert.ok(fs.existsSync(mainAudit), 'auditoria do cérebro');
    assert.ok(fs.existsSync(botAudit), 'auditoria do bot no arquivo dele');
    for (const f of [mainAudit, botAudit]) {
      const v = verifyAudit(f);
      assert.equal(v.ok, true, `${path.basename(f)}: ${JSON.stringify(v.errors.slice(0, 2))}`);
    }
    c4.child.send({ tipo: 'desligar' });
    assert.equal((await waitExit(c4, 20_000)).code, 0);
  });

  await test('bot separado com o cérebro desligado também sobe (memória indisponível) e chega ao login', async () => {
    const b = startProc('bot-sem-cerebro', 'src/index.js', botEnv({ YUI_CEREBRO_EXTERNO: 'true' }));
    const { code } = await waitExit(b, 150_000);
    assert.notEqual(code, 0);
    assert.doesNotMatch(b.out, LOAD_ERRORS, tail(b));
    assert.match(b.out, /O cérebro não respondeu: memória e lembretes ficam indisponíveis/);
    assert.match(b.out, /Falha ao logar no Discord/, tail(b));
    BLOQUEIO.conferir('subida do bot sem o cérebro', { esperados: LOGIN_DISCORD_BLOQUEADO });
  });

  await test('bot separado com o contexto por horas ligado também sobe (etapa 5: o contexto é do cérebro) e não abre os arquivos de contexto', async () => {
    const b = startProc('bot-contexto', 'src/index.js', botEnv({ YUI_CEREBRO_EXTERNO: 'true', YUI_CONTEXT_ENABLED: 'true' }));
    const { code } = await waitExit(b, 150_000);
    assert.notEqual(code, 0);
    assert.doesNotMatch(b.out, LOAD_ERRORS, tail(b));
    assert.doesNotMatch(b.out, /YUI_CONTEXT_ENABLED=true ainda não funciona/, 'a recusa da etapa 3 saiu');
    assert.match(b.out, /Falha ao logar no Discord/, tail(b));
    BLOQUEIO.conferir('subida do bot com o contexto', { esperados: LOGIN_DISCORD_BLOQUEADO });
    assert.doesNotMatch(b.out, /"memory-context(?:-personal)?"/, 'o bot separado não abre os arquivos de contexto (são do cérebro)');
  });

  await test('sem a chave (processo único, o padrão) a subida é a de sempre: abre a memória e chega ao login', async () => {
    const b = startProc('bot-processo-unico', 'src/index.js', botEnv());
    const { code } = await waitExit(b, 150_000);
    assert.notEqual(code, 0);
    assert.doesNotMatch(b.out, LOAD_ERRORS, tail(b));
    assert.doesNotMatch(b.out, /Cérebro separado/);
    assert.match(b.out, /"memory-personal"/, 'o processo único abre a memória, como sempre');
    // Etapa 8: o processo único também grava a cota de busca por hora em disco (o dono do arquivo é ele) e solta a trava ao sair
    assert.match(b.out, /Cota de busca por hora em disco \(dono: unico\)/);
    assert.equal(fs.existsSync(path.join(APP, 'secrets', 'search-budget-hora.json.owner')), false, 'a trava da cota por hora saiu com o processo');
    assert.match(b.out, /Falha ao logar no Discord/, tail(b));
    BLOQUEIO.conferir('subida do processo único', { esperados: LOGIN_DISCORD_BLOQUEADO });
    assert.equal(fs.readdirSync(DB).filter((f) => f.endsWith('.owner')).length, 0, 'sem a chave não há trava de dono');
  });

  // o registro das exceções: qual teste abriu cada uma e quantas vezes foi usada (segunda revisão da Liz, §12)
  console.log(`  bloqueio de integração externa: só as tentativas esperadas (o login no Discord); exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);
