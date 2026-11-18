// Etapa 5 de ponta a ponta: a conversa do Discord respondida pelo CÉREBRO (chat.turn e chat.commit), com o contexto por horas no cérebro
// (docs/ETAPA3_DONOS_E_CONTRATO.md §8 e docs/RELATORIO_ETAPA5_CHAT_TURN.md).
// Execução: npm run test:chatturn
//
// Processos de verdade (como no test-separacao.js e no test-operacao.js):
//  - uma CÓPIA do código numa pasta temporária (node_modules por junção), bancos e segredo do canal em pastas temporárias, portas livres;
//  - IA FALSA no cérebro e DISCORD FALSO no bot (os dois só valem com NODE_ENV=test). As mensagens entram pelo messageCreate DE VERDADE
//    (YUI_TESTE_DISCORD_FALSO_ENTRADA) e as respostas saem num arquivo (YUI_TESTE_DISCORD_FALSO_CANAL);
//  - a IA falsa devolve as marcas `tok-...` que viu no HISTÓRICO recebido (`vistos=[...]`): é assim que se confere que cada conversa recebeu
//    só o próprio histórico, na ordem certa.
// Cenários: o dono em DM (contexto pessoal, memória permanente), um membro no servidor (contexto público, memória de 30 dias), conversas
// intercaladas e simultâneas de várias pessoas sem vazamento, ordem dentro de uma conversa, o cérebro reiniciado no meio da conversa
// (reconexão do WebSocket), o cérebro fora (aviso claro, a fila não trava), o cérebro derrubado durante um passo (repetição com a mesma
// chave), o cérebro derrubado DURANTE a gravação de um turno (antes e depois: nem pela metade, nem duas vezes) e o bot derrubado no meio.
// Cada processo roda com o BLOQUEIO de integração externa (tests/helpers/bloqueioExterno.mjs, ajustes da Liz na etapa 6): qualquer tentativa de
// rede, DNS, UDP ou programa (yt-dlp, ffmpeg...) falha e fica registrada, e o registro é conferido no fim de cada cenário.
// Só são encerrados os processos que este teste abriu, pelo handle (nunca por PID achado em varredura).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { criarBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const started = Date.now();
let passed = 0;
let finished = false;
// Bloqueio EXPLÍCITO de integração externa (regra da Liz): cada processo que este teste abre carrega tests/helpers/bloqueioExterno.mjs
// (rede fora do loopback ou numa porta que não é do teste, DNS, UDP e qualquer programa, como o yt-dlp, falham e ficam registrados), e
// cada cenário termina conferindo o registro: uma tentativa só já FALHA o teste.
let BLOQUEIO = null;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); BLOQUEIO?.conferir(name); passed += 1; console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localDb = useIsolatedDatabaseDir('yui-chatturn-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-chatturn-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const INBOX = path.join(T, 'entrada.jsonl');
const CANAL = path.join(T, 'canal.jsonl');
const DMS = path.join(T, 'dms.jsonl');
const IA_CTRL = path.join(T, 'controle-ia.json');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
// Só as exceções que ESTE teste precisa (segunda revisão da Liz, §12): o icacls e o whoami do segredo do canal no Windows.
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:chatturn', liberar: { ...EXCECOES_DO_CANAL } });
for (const d of [DB, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const CHAN2 = '555555555555555556';
const CHAN3 = '555555555555555557';
const DMCH = '777777777777777777';
const BOT_ID = '900000000000000001'; // o id do bot no Discord falso
const UNAVAILABLE = 'A Yui está indisponível agora';

// ── Cópia do código e processos ───────────────────────────────────────────────────────────────────
function copyCode() {
  let files = [];
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src', 'persona', 'knowledge', 'package.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch { files = []; }
  let n = 0;
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(from); } catch { continue; }
    if (!st.isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(APP, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(APP, rel));
    n += 1;
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), JUNCTION, 'junction');
  return n;
}
const SYSTEM_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'ProgramFiles', 'ProgramData', 'SystemDrive', 'LANG'];
const NATIVE = String(process.env.YUI_DB_NATIVE ?? '').trim();
function childEnv(extra = {}) {
  const env = {};
  for (const k of SYSTEM_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env, NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', LOG_LEVEL: 'info',
    DATABASE_DIR: DB, YUI_CHANNEL_SECRET_FILE: SECRET, YUI_CHANNEL_PORT: '0', YUI_DB_OWNER_HEARTBEAT_MS: '300', YUI_DB_OWNER_STALE_MS: '1500',
    YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'true', YUI_ALERTS: 'false', YUI_MORNING_REPORT: 'false', YUI_HEALTH_REPORT: 'false',
    GTA_WEEKLY_ENABLED: 'false', NEWSWIRE_ENABLED: 'false', YOUTUBE_INTERVAL_MINUTES: '0', TWITCH_INTERVAL_MINUTES: '0', YUI_GATEWAY_ENABLED: 'false',
    YUI_TESTE_IA_FALSA: 'true', YUI_TESTE_IA_FALSA_CONTROLE: IA_CTRL, DISCORD_TOKEN: 'token-falso-de-teste',
    // contexto por horas ligado para TODOS (escopo all): cada pessoa tem o próprio fio, o que torna o teste de vazamento mais forte
    YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', REQUIRE_TOS: 'false', YUI_QUEUE_MAX_PER_USER: '20', YUI_CHAT_ESPERA_CEREBRO_MS: '12000',
    YUI_POLICY_MODE: 'observe',
    ...(NATIVE ? { YUI_DB_NATIVE: NATIVE } : {}), ...extra,
  };
}
const procs = new Set();
const allProcs = [];
function startProc(label, script, env) {
  const child = spawn(process.execPath, [...BLOQUEIO.argv, script], { cwd: APP, env: { ...env, ...BLOQUEIO.env(label) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const proc = { label, child, out: '', exited: false, code: null };
  allProcs.push(proc);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { proc.out += d; });
  child.stderr.on('data', (d) => { proc.out += d; });
  proc.exit = new Promise((resolve) => child.on('exit', (code) => { proc.exited = true; proc.code = code; procs.delete(proc); resolve({ code }); }));
  procs.add(proc);
  return proc;
}
const tail = (t, n = 40) => String(t).split(/\r?\n/).slice(-n).join('\n');
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await sleep(50); }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${typeof what === 'function' ? what() : what}`);
}
async function waitFor(proc, re, timeoutMs = 60_000, from = 0) {
  await waitUntil(() => re.test(proc.out.slice(from)) || proc.exited, timeoutMs, () => `${proc.label}: ${re}\n${tail(proc.out)}`);
  if (!re.test(proc.out.slice(from))) throw new Error(`${proc.label} saiu (código ${proc.code}) sem ${re}\n${tail(proc.out)}`);
}
async function waitExit(proc, timeoutMs) {
  const r = await Promise.race([proc.exit, sleep(timeoutMs).then(() => null)]);
  if (!r) { proc.child.kill(); throw new Error(`${proc.label}: não terminou\n${tail(proc.out)}`); }
  return r;
}
const lockAge = (name) => { try { return Date.now() - fs.statSync(path.join(DB, `${name}.db.owner`)).mtimeMs; } catch { return Infinity; } };
const readLock = (name) => { try { return JSON.parse(fs.readFileSync(path.join(DB, `${name}.db.owner`), 'utf8')); } catch { return null; } };
const iaControl = (c) => fs.writeFileSync(IA_CTRL, JSON.stringify(c));

async function readDbRows(name, sql) {
  const file = path.join(DB, `${name}.db`);
  const nativeNames = new Set(NATIVE.split(',').map((s) => s.trim()).filter(Boolean));
  if (nativeNames.has('*') || nativeNames.has(name)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
  }
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const res = db.exec(sql);
    if (!res.length) return [];
    return res[0].values.map((row) => Object.fromEntries(res[0].columns.map((c, i) => [c, row[i]])));
  } finally { db.close(); }
}

// ── Discord falso: entrada e saída ───────────────────────────────────────────────────────────────
let idSeq = 1100000000000000000n;
const nextId = () => String(++idSeq);
/** Uma mensagem chegando ao bot. `guild` null = DM. No servidor, a menção ao bot vai no começo. */
function send({ user, guild = null, channel, text }) {
  const id = nextId();
  const content = guild ? `<@${BOT_ID}> ${text}` : text;
  fs.appendFileSync(INBOX, `${JSON.stringify({ id, userId: user, username: `pessoa${user.slice(-3)}`, guildId: guild, channelId: channel, content, at: Date.now() })}\n`);
  return id;
}
const readCanal = () => { try { return fs.readFileSync(CANAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const isProgress = (c) => /Processando|Sua solicitação está na fila/.test(c);
/** As respostas de verdade (sem progresso) a uma mensagem, na ordem em que saíram. */
const finalsFor = (id) => readCanal().filter((e) => e.paraMensagem === id && ['reply', 'edit', 'send'].includes(e.tipo) && e.content && !isProgress(e.content)).map((e) => e.content);
async function reply(id, timeoutMs = 30_000) {
  await waitUntil(() => finalsFor(id).length > 0, timeoutMs, () => `a resposta à mensagem ${id}\n--- bot ---\n${tail(bot?.out ?? '')}\n--- cérebro ---\n${tail(cerebro?.out ?? '')}`);
  return finalsFor(id).at(-1);
}
const seen = (text) => { const m = /vistos=\[([^\]]*)\]/.exec(String(text)); return m && m[1] ? m[1].split(',') : []; };
async function say(who, text) { const id = send({ ...who, text }); return { id, text: await reply(id) }; }

// ── Limpeza ─────────────────────────────────────────────────────────────────────────────────────
async function cleanup() {
  if (process.env.YUI_TESTE_MOSTRAR_SAIDA === '1') for (const p of allProcs) console.log(`\n===== ${p.label} (código ${p.code}) =====\n${p.out}`);
  for (const proc of [...procs]) { try { proc.child.send({ tipo: 'desligar' }); } catch { /* */ } await Promise.race([proc.exit, sleep(8000)]); }
  for (const proc of [...procs]) { try { proc.child.kill(); } catch { /* */ } await Promise.race([proc.exit, sleep(3000)]); }
  try { process.chdir(ROOT); } catch { /* */ }
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  await sleep(300);
  let junctionGone = !fs.existsSync(JUNCTION);
  try { fs.unlinkSync(JUNCTION); } catch { /* */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) { try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[chat-turn] não apaguei ${T}: ${err.message}`); } }
  else console.warn(`[chat-turn] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  localDb.cleanup();
}
process.on('exit', () => { for (const p of procs) { try { p.child.kill(); } catch { /* */ } } if (!finished && process.exitCode === undefined) process.exitCode = 1; });

let cerebro = null;
let bot = null;
let cerebroN = 0;
let botN = 0;
async function subirCerebro(extra = {}) {
  await waitUntil(() => lockAge('memory-personal') > 1700, 15_000, 'a trava do cérebro anterior vencer');
  const c = startProc(`cerebro#${++cerebroN}`, 'src/cerebro.js', childEnv(extra));
  await waitFor(c, /YuiCerebro pronto/);
  return c;
}
async function subirBot(extra = {}) {
  await waitUntil(() => lockAge('core') > 1700, 15_000, 'a trava do bot anterior vencer');
  const b = startProc(`bot#${++botN}`, 'src/index.js', childEnv({ YUI_CEREBRO_EXTERNO: 'true', YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: DMS, YUI_TESTE_DISCORD_FALSO_ENTRADA: INBOX, YUI_TESTE_DISCORD_FALSO_CANAL: CANAL, ...extra }));
  await waitFor(b, /Yui inicializada \(Discord falso/);
  await waitFor(b, /Discord falso: mensagens de/);
  return b;
}
async function botConectado(c, from = 0) { await waitFor(c, /\[canal\] bot conectado/, 30_000, from); }
async function desligar(proc) { proc.child.send({ tipo: 'desligar' }); assert.equal((await waitExit(proc, 20_000)).code, 0, tail(proc.out)); }
async function derrubar(proc) { proc.child.kill(); await waitExit(proc, 10_000); } // pelo handle: o processo que este teste abriu

const A = { user: OWNER, guild: null, channel: DMCH }; // o Braga em DM
const B = { user: MEMBER, guild: GUILD, channel: CHAN }; // um membro no servidor
const C = { user: OTHER, guild: GUILD, channel: CHAN }; // outra pessoa no MESMO canal
const D = { user: MEMBER, guild: GUILD, channel: CHAN2 }; // a mesma pessoa de B, em outro canal
const E = { user: OTHER, guild: GUILD, channel: CHAN3 };

const contextTurns = async (file, token) => (await readDbRows(file, 'SELECT role, content, at FROM context_turns ORDER BY at, id'))
  .filter((r) => (token ? r.content.includes(token) : true));

try {
  await test('sobe o cérebro e o bot de verdade (Discord falso com entrada de mensagens, IA falsa)', async () => {
    assert.ok(copyCode() > 100);
    iaControl({});
    fs.writeFileSync(INBOX, '');
    cerebro = await subirCerebro();
    bot = await subirBot();
    await botConectado(cerebro);
    assert.equal(readLock('memory-context')?.role, 'cerebro', 'os arquivos de contexto são do cérebro');
    assert.equal(readLock('memory-context-personal')?.role, 'cerebro');
    assert.doesNotMatch(bot.out, /YUI_CONTEXT_ENABLED=true ainda não funciona/, 'o bot separado sobe com o contexto por horas ligado');
  });

  await test('o Braga em DM: a resposta vem do cérebro, com o fio PESSOAL e a memória permanente e privada', async () => {
    const a1 = await say(A, 'tok-A1 oi, meu nome é Braga Teste');
    const a2 = await say(A, 'tok-A2 você lembra do meu nome?');
    const a3 = await say(A, 'tok-A3 e agora?');
    assert.match(a1.text, /^IA-FALSA persona=sim /, 'persona pessoal (dono em DM), montada pelo cérebro');
    assert.deepEqual(seen(a1.text), []);
    assert.deepEqual(seen(a2.text), ['tok-A1']);
    assert.deepEqual(seen(a3.text), ['tok-A1', 'tok-A2']);
    assert.match(a2.text, /memoria=sim/, 'a memória do dono foi lembrada pelo cérebro');
    assert.match(a3.text, /sensivel=sim/, 'conversa pessoal: nunca provedor anônimo');
    const mem = await readDbRows('memory-personal', `SELECT user_id, content, expires_at FROM memories WHERE user_id = '${OWNER}'`);
    assert.deepEqual(mem.map((r) => r.content), ['O nome do usuário é Braga Teste.']);
    assert.equal(mem[0].expires_at, null, 'a memória do Braga é permanente');
    const personal = await contextTurns('memory-context-personal');
    assert.deepEqual(personal.filter((r) => r.role === 'user').map((r) => r.content.match(/tok-A\d/)[0]), ['tok-A1', 'tok-A2', 'tok-A3']);
    assert.equal(personal.length, 6, 'três trocas inteiras (fala + resposta)');
    assert.equal((await contextTurns('memory-context', 'tok-A')).length, 0, 'nada do Braga em DM no arquivo público');
  });

  await test('um membro no servidor: fio público separado do Braga e memória com 30 dias', async () => {
    const b1 = await say(B, 'tok-B1 oi, meu nome é Ana Teste');
    const b2 = await say(B, 'tok-B2 tudo bem?');
    assert.deepEqual(seen(b1.text), []);
    assert.deepEqual(seen(b2.text), ['tok-B1']);
    assert.match(b2.text, /sensivel=nao/);
    assert.match(b2.text, /ferramentas=sim/, 'as ferramentas do servidor oferecidas pelo cérebro');
    const mem = await readDbRows('memory-discord', `SELECT content, expires_at FROM memories WHERE user_id = '${MEMBER}'`);
    assert.deepEqual(mem.map((r) => r.content), ['O nome do usuário é Ana Teste.']);
    const days = (Number(mem[0].expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30.01, `retenção de 30 dias (${days.toFixed(2)})`);
    assert.equal((await readDbRows('memory-personal', `SELECT 1 FROM memories WHERE user_id = '${MEMBER}'`)).length, 0, 'nada na memória pessoal');
    assert.equal((await contextTurns('memory-context-personal', 'tok-B')).length, 0);
    // O commit do último turno sai depois da entrega da resposta: espera ele chegar ao disco antes de contar.
    await waitUntil(async () => (await contextTurns('memory-context', 'tok-B2')).length >= 1, 10_000, 'o turno tok-B2 gravado no contexto');
    assert.equal((await contextTurns('memory-context', 'tok-B')).filter((r) => r.role === 'user').length, 2);
  });

  await test('conversas intercaladas e simultâneas de quatro pessoas (burst): cada uma só vê o próprio fio, na ordem', async () => {
    const ids = [
      ['C', send({ ...C, text: 'tok-C1 oi' })],
      ['D', send({ ...D, text: 'tok-D1 oi' })],
      ['A', send({ ...A, text: 'tok-A4 voltei' })],
      ['B', send({ ...B, text: 'tok-B3 mais uma' })],
      ['C', send({ ...C, text: 'tok-C2 de novo' })],
      ['D', send({ ...D, text: 'tok-D2 de novo' })],
    ];
    const out = [];
    for (const [who, id] of ids) out.push([who, await reply(id, 60_000)]);
    const expected = { 0: [], 1: [], 2: ['tok-A1', 'tok-A2', 'tok-A3'], 3: ['tok-B1', 'tok-B2'], 4: ['tok-C1'], 5: ['tok-D1'] };
    out.forEach(([who, text], i) => {
      assert.deepEqual(seen(text), expected[i], `${who} (${i})`);
      for (const t of seen(text)) assert.ok(t.startsWith(`tok-${who}`), `vazamento: ${who} viu ${t}`);
    });
  });

  await test('mensagens simultâneas da MESMA conversa: processadas em ordem, cada uma vendo as anteriores', async () => {
    const ids = [send({ ...E, text: 'tok-E1 um' }), send({ ...E, text: 'tok-E2 dois' }), send({ ...E, text: 'tok-E3 três' })];
    const texts = [];
    for (const id of ids) texts.push(await reply(id, 60_000));
    assert.deepEqual(texts.map(seen), [[], ['tok-E1'], ['tok-E1', 'tok-E2']]);
    // O commit do último turno sai DEPOIS da entrega da resposta (fim do turno): espera ele chegar ao disco antes de conferir.
    const userRowsE = async () => (await contextTurns('memory-context', 'tok-E')).filter((r) => r.role === 'user');
    await waitUntil(async () => (await userRowsE()).some((r) => /tok-E3/.test(r.content)), 10_000, 'o turno tok-E3 gravado no contexto');
    const rows = (await userRowsE()).map((r) => r.content.match(/tok-E\d/)[0]);
    assert.deepEqual(rows, ['tok-E1', 'tok-E2', 'tok-E3'], 'no banco, na ordem e uma vez cada');
  });

  await test('reconexão: o cérebro reinicia no meio da conversa, o MESMO bot reconecta sozinho e o fio continua (veio do disco)', async () => {
    const botPid = bot.child.pid;
    await desligar(cerebro);
    cerebro = await subirCerebro();
    await botConectado(cerebro);
    const a5 = await say(A, 'tok-A5 ainda aí?');
    assert.deepEqual(seen(a5.text), ['tok-A1', 'tok-A2', 'tok-A3', 'tok-A4']);
    assert.equal(bot.child.pid, botPid, 'o bot não foi reiniciado');
    assert.match(bot.out, /conectado ao cérebro/);
  });

  await test('cérebro fora: o bot responde "a Yui está indisponível agora" e não trava; quando o cérebro volta, a conversa segue', async () => {
    await desligar(cerebro);
    const t0 = Date.now();
    const lost1 = await say(B, 'tok-B4 perdida');
    assert.match(lost1.text, new RegExp(UNAVAILABLE));
    assert.ok(Date.now() - t0 < 25_000, 'respondeu dentro da janela de espera');
    const t1 = Date.now();
    const lost2 = await say(B, 'tok-B5 perdida também');
    assert.match(lost2.text, new RegExp(UNAVAILABLE));
    assert.ok(Date.now() - t1 < 5_000, `depois da janela, o aviso sai na hora (${Date.now() - t1} ms)`);
    cerebro = await subirCerebro();
    await botConectado(cerebro);
    const b6 = await say(B, 'tok-B6 voltou?');
    assert.deepEqual(seen(b6.text), ['tok-B1', 'tok-B2', 'tok-B3'], 'as mensagens do período fora não entraram no contexto');
  });

  await test('o cérebro cai à força DURANTE um passo (IA lenta): o bot espera, repete com a MESMA chave e a resposta sai UMA vez', async () => {
    iaControl({ atrasoMs: 4000 });
    const desdeOnde = cerebro.out.length;
    const id = send({ ...D, text: 'tok-D3 pergunta lenta' });
    await waitUntil(() => readCanal().some((e) => e.paraMensagem === id && isProgress(e.content ?? '')), 15_000, 'o "Processando..."');
    // Espera a IA falsa AVISAR que a chamada começou (o pedido está de fato em andamento no cérebro). Um sleep fixo não serve em máquina
    // lenta (o notebook): o pedido ainda nem tinha saído do bot quando o tempo acabava, e o cérebro caía antes dele (sem 'caiu no meio').
    await waitFor(cerebro, /\[IA falsa\] chamada em andamento/, 60_000, desdeOnde);
    await sleep(300); // a IA falsa está no meio da resposta (4 s)
    await derrubar(cerebro);
    iaControl({ atrasoMs: 1000 });
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const text = await reply(id, 60_000);
    assert.deepEqual(seen(text), ['tok-D1', 'tok-D2']);
    assert.equal(finalsFor(id).length, 1, 'uma resposta só');
    assert.match(bot.out, /chat\.turn: a conexão caiu no meio \(CONNECTION_LOST\); esperando o cérebro voltar para repetir com a mesma chave/);
    iaControl({});
    await sleep(1500);
    assert.equal((await contextTurns('memory-context', 'tok-D3')).filter((r) => r.role === 'user').length, 1, 'o turno entrou uma vez');
  });

  for (const when of ['depois', 'antes']) {
    await test(`reinício do cérebro DURANTE a gravação do turno (${when} de gravar): a troca entra inteira e UMA vez`, async () => {
      await desligar(cerebro);
      cerebro = await subirCerebro({ YUI_TESTE_CHAT_PAUSA_GRAVACAO: `${when}:6000` });
      await botConectado(cerebro);
      const tok = when === 'depois' ? 'tok-C3' : 'tok-C4';
      const id = send({ ...C, text: `${tok} gravando` });
      await reply(id, 30_000);
      await waitFor(cerebro, new RegExp(`teste: pausa ${when.toUpperCase()} de gravar a troca`), 15_000);
      await derrubar(cerebro); // à força, no meio da gravação
      cerebro = await subirCerebro();
      await botConectado(cerebro);
      await waitUntil(async () => (await contextTurns('memory-context', tok)).length >= 1, 20_000, 'o turno guardado no bot chegar ao cérebro novo');
      await sleep(1500);
      const rows = await contextTurns('memory-context', tok);
      const users = rows.filter((r) => r.role === 'user');
      assert.equal(users.length, 1, `a fala de ${tok} entrou uma vez`);
      assert.match(bot.out, /O fim do turno não chegou ao cérebro agora; guardado para mandar quando ele voltar/, 'o bot guardou o fim do turno');
      if (when === 'depois') await waitFor(cerebro, /já estava no contexto \(repetida depois de um reinício\): não entrou de novo/, 10_000);
      const all = await contextTurns('memory-context');
      const i = all.findIndex((r) => r.role === 'user' && r.content.includes(tok));
      assert.equal(all[i + 1]?.role, 'assistant', 'a resposta veio junto (nada pela metade)');
      const next = await say(C, `tok-C${when === 'depois' ? 5 : 6} e agora?`);
      assert.equal(seen(next.text).filter((t) => t === tok).length, 1);
    });
  }

  await test('o bot cai no meio da conversa (IA lenta): o turno interrompido não entra no contexto; o bot volta e a conversa segue', async () => {
    iaControl({ atrasoMs: 3000 });
    const id = send({ ...B, text: 'tok-B7 interrompida' });
    await waitUntil(() => readCanal().some((e) => e.paraMensagem === id && isProgress(e.content ?? '')), 15_000, 'o "Processando..."');
    await sleep(800);
    await derrubar(bot);
    iaControl({});
    await sleep(3500); // o cérebro termina o passo; a resposta não tem para onde ir
    bot = await subirBot();
    await botConectado(cerebro, 0);
    await waitUntil(() => /conectado ao cérebro/.test(bot.out), 15_000, 'o bot novo conectar');
    const b8 = await say(B, 'tok-B8 voltei');
    assert.deepEqual(seen(b8.text), ['tok-B1', 'tok-B2', 'tok-B3', 'tok-B6'], 'nem a interrompida nem as do período fora');
    assert.equal(finalsFor(id).length, 0, 'a mensagem interrompida ficou sem resposta (o bot caiu): o usuário pede de novo');
    assert.equal((await contextTurns('memory-context', 'tok-B7')).length, 0);
  });

  await test('desligamento limpo dos dois: as travas e o segredo do canal saem', async () => {
    await desligar(bot);
    await desligar(cerebro);
    for (const name of ['memory-personal', 'memory-discord', 'memory-context', 'memory-context-personal', 'core']) assert.equal(readLock(name), null, `trava de ${name}`);
    assert.ok(!fs.existsSync(SECRET));
  });

  // o registro das exceções: qual teste abriu cada uma e quantas vezes foi usada (segunda revisão da Liz, §12)
  console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);
