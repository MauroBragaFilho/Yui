// Etapa 7 de ponta a ponta: os COMENTÁRIOS fora da fila no cérebro (docs/RELATORIO_ETAPA7_COMENTARIOS.md). Execução: npm run test:comentarios
//
// Processos de verdade (como no test-pesquisa-cerebro.js): uma CÓPIA do código numa pasta temporária, bancos e segredo do canal em pastas
// temporárias, portas livres; IA FALSA no cérebro e DISCORD FALSO no bot, agora também com COMANDOS DE BARRA (o /converter_moeda entra pelo
// interactionCreate de verdade; as cotações vêm do cache do dia na cópia, sem rede). Cada processo roda com o BLOQUEIO de integração externa.
// Cenários: o comentário público e o privado (o Braga em DM, com conversa privada no contexto: nada dela entra no comentário e o comentário
// não entra no contexto); vários comandos e mensagens ao mesmo tempo, de pessoas diferentes (cada um só o seu, uma entrega por interação); o
// cérebro derrubado no meio do comentário (o bot repete com a mesma chave; uma entrega só); o cérebro fora (o embed sai sozinho, na hora certa);
// o bot derrubado no meio (nada sai em dobro depois); a parada limpa.
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
let BLOQUEIO = null;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); BLOQUEIO?.conferir(name); passed += 1; console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localDb = useIsolatedDatabaseDir('yui-comentarios-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-comentarios-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const INBOX = path.join(T, 'entrada.jsonl');
const CANAL = path.join(T, 'canal.jsonl');
const DMS = path.join(T, 'dms.jsonl');
const IA_CTRL = path.join(T, 'controle-ia.json');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
// Só as exceções que ESTE teste precisa: o icacls e o whoami do segredo do canal no Windows.
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:comentarios', liberar: { ...EXCECOES_DO_CANAL } });
for (const d of [DB, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const DMCH2 = '777777777777777778';
const BOT_ID = '900000000000000001';

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
  // As cotações do dia no cache da CÓPIA (o currencyHandler lê o cache do dia e não vai à rede): o /converter_moeda funciona offline.
  const d = new Date();
  const hoje = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  fs.mkdirSync(path.join(APP, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'src', 'data', 'currency_cache.json'), JSON.stringify({ date: hoje, rates: { BRL: 1, USD: 5, EUR: 6 }, dynamicRates: {} }));
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
    YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', REQUIRE_TOS: 'false', YUI_QUEUE_MAX_PER_USER: '20', YUI_CHAT_ESPERA_CEREBRO_MS: '15000',
    YUI_POLICY_MODE: 'observe', YUI_IMAGE_PRE_ROUTE: 'false', YUI_RESEARCH_ENABLED: 'false', YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '',
    YUI_SEARCH_BUDGET_FILE: path.join(T, 'search-budget.json'), YUI_COMENTARIO_PRAZO_MS: '20000',
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
/** Todas as linhas do contexto por horas (os dois arquivos), só papel e texto. */
const contextAll = async () => {
  const out = [];
  for (const f of ['memory-context', 'memory-context-personal']) {
    try { out.push(...(await readDbRows(f, 'SELECT role, content FROM context_turns'))); } catch { /* arquivo ainda não existe */ }
  }
  return out;
};

// ── Discord falso: entrada (mensagens e comandos) e saída ──────────────────────────────────────────────
let idSeq = 1300000000000000000n;
const nextId = () => String(++idSeq);
function send({ user, guild = null, channel, text }) {
  const id = nextId();
  const content = guild ? `<@${BOT_ID}> ${text}` : text;
  fs.appendFileSync(INBOX, `${JSON.stringify({ id, userId: user, username: `pessoa${user.slice(-3)}`, guildId: guild, channelId: channel, content, at: Date.now() })}\n`);
  return id;
}
function comando({ user, guild = null, channel, valor }) {
  const id = nextId();
  fs.appendFileSync(INBOX, `${JSON.stringify({ tipo: 'comando', id, comando: 'converter_moeda', opcoes: { valor, de: 'USD', para: 'BRL' }, userId: user, username: `pessoa${user.slice(-3)}`, guildId: guild, channelId: channel, at: Date.now() })}\n`);
  return id;
}
const readCanal = () => { try { return fs.readFileSync(CANAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const edicoesDe = (id) => readCanal().filter((e) => e.paraInteracao === id && e.tipo === 'interacao-edicao');
const isProgress = (c) => /Processando|Sua solicitação está na fila/.test(c);
const finalsFor = (id) => readCanal().filter((e) => e.paraMensagem === id && ['reply', 'edit', 'send'].includes(e.tipo) && e.content && !isProgress(e.content)).map((e) => e.content);
async function entrega(id, timeoutMs = 45_000) {
  await waitUntil(() => edicoesDe(id).length > 0, timeoutMs, () => `a entrega do comando ${id}\n--- bot ---\n${tail(bot?.out ?? '')}\n--- cérebro ---\n${tail(cerebro?.out ?? '')}`);
  return edicoesDe(id).at(-1);
}
async function reply(id, timeoutMs = 45_000) {
  await waitUntil(() => finalsFor(id).length > 0, timeoutMs, () => `a resposta à mensagem ${id}\n${tail(bot?.out ?? '')}`);
  return finalsFor(id).at(-1);
}
const comentarioDe = (ed) => String(ed?.content ?? '');
const embedDe = (ed) => ed?.embeds?.[0] ?? null;

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
  if (junctionGone) { try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[comentarios] não apaguei ${T}: ${err.message}`); } }
  else console.warn(`[comentarios] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
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

const DONO_DM = { user: OWNER, guild: null, channel: DMCH };
const MEMBRO = { user: MEMBER, guild: GUILD, channel: CHAN };
const OUTRO_DM = { user: OTHER, guild: null, channel: DMCH2 };

try {
  await test('sobe o cérebro (IA falsa) e o bot (Discord falso com comandos de barra)', async () => {
    assert.ok(copyCode() > 100);
    iaControl({});
    fs.writeFileSync(INBOX, '');
    cerebro = await subirCerebro();
    bot = await subirBot();
    await botConectado(cerebro);
  });

  await test('comentário PÚBLICO (membro no servidor): o embed e o comentário numa edição só; o comentário veio do cérebro, isolado, sem gravar nada', async () => {
    const antes = await contextAll();
    const id = comando({ ...MEMBRO, valor: 101 });
    const ed = await entrega(id);
    await sleep(800);
    assert.equal(edicoesDe(id).length, 1, 'uma entrega só');
    assert.match(embedDe(ed)?.title ?? '', /Conversão de Moedas: USD\/BRL/);
    assert.match(embedDe(ed)?.description ?? '', /101 USD/);
    const c = comentarioDe(ed);
    assert.match(c, /^IA-FALSA /, `o comentário veio da IA do cérebro: ${c}`);
    assert.match(c, /historico=0 /, 'sem histórico');
    assert.match(c, /memoria=nao /, 'sem memória');
    assert.match(c, /ferramentas=nao /, 'sem ferramentas');
    assert.match(c, /sensivel=nao /, 'público: a chamada não é sensível');
    assert.deepEqual(await contextAll(), antes, 'nada entrou no contexto por horas');
    assert.doesNotMatch(bot.out, /\[IA\] /, 'o bot não chamou a cadeia de IA dele');
  });

  await test('comentário PRIVADO (o Braga em DM, com conversa privada no contexto): sensível, nada da conversa entra e o comentário não fica', async () => {
    const m = send({ ...DONO_DM, text: 'tok-CTXDONO oi, guarda isso' });
    await reply(m);
    await waitUntil(async () => (await contextAll()).some((r) => r.content.includes('tok-CTXDONO')), 15_000, 'a conversa privada entrar no contexto'); // o commit sai DEPOIS da entrega
    const antes = await contextAll();
    const id = comando({ ...DONO_DM, valor: 202 });
    const c = comentarioDe(await entrega(id));
    assert.match(c, /sensivel=sim /, `privado: nunca provedor anônimo: ${c}`);
    assert.match(c, /historico=0 vistos=\[\] /, 'nada da conversa privada entrou no comentário');
    await sleep(800);
    assert.deepEqual(await contextAll(), antes, 'o comentário não entrou no contexto');
    // a DM de outra pessoa também é privada
    const id2 = comando({ ...OUTRO_DM, valor: 203 });
    assert.match(comentarioDe(await entrega(id2)), /sensivel=sim /);
  });

  await test('ao mesmo tempo: comandos de 3 pessoas e mensagens na fila; cada interação recebe o SEU embed, uma vez, e as mensagens seguem a fila', async () => {
    const pedidos = [
      { id: comando({ ...MEMBRO, valor: 301 }), valor: 301 },
      { id: comando({ ...DONO_DM, valor: 302 }), valor: 302 },
      { id: comando({ ...OUTRO_DM, valor: 303 }), valor: 303 },
      { id: comando({ ...MEMBRO, valor: 304 }), valor: 304 },
    ];
    const msgs = [send({ ...MEMBRO, text: 'tok-SIM1 oi' }), send({ ...OUTRO_DM, text: 'tok-SIM2 oi' })];
    for (const p of pedidos) {
      const ed = await entrega(p.id);
      assert.match(embedDe(ed)?.description ?? '', new RegExp(`${p.valor} USD`), 'o embed da própria interação');
      assert.match(comentarioDe(ed), /^IA-FALSA /);
    }
    for (const id of msgs) assert.match(await reply(id), /IA-FALSA/);
    await sleep(1000);
    for (const p of pedidos) assert.equal(edicoesDe(p.id).length, 1, `uma entrega só (${p.valor})`);
  });

  await test('o cérebro cai DURANTE o comentário: o bot espera, repete com a MESMA chave no cérebro novo e entrega UMA vez', async () => {
    iaControl({ atrasoMs: 6000 });
    const id = comando({ ...MEMBRO, valor: 401 });
    await waitUntil(() => readCanal().some((e) => e.paraInteracao === id && e.tipo === 'interacao-adiada'), 15_000, 'a interação ser adiada');
    await sleep(1500); // o pedido já está no cérebro (a IA falsa segura 6 s)
    await derrubar(cerebro);
    iaControl({});
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const ed = await entrega(id, 60_000);
    assert.match(comentarioDe(ed), /^IA-FALSA /, 'o comentário saiu do cérebro novo');
    await sleep(1000);
    assert.equal(edicoesDe(id).length, 1, 'uma entrega só');
    assert.match(bot.out, /chat\.comentario: a conexão caiu no meio \(CONNECTION_LOST\); esperando o cérebro voltar para repetir com a mesma chave/);
  });

  await test('cérebro FORA por mais que a espera: o embed sai sozinho (sem comentário), na hora certa; e o comentário volta quando ele volta', async () => {
    await desligar(cerebro);
    const t0 = Date.now();
    const id = comando({ ...MEMBRO, valor: 501 });
    const ed = await entrega(id, 40_000);
    assert.equal(comentarioDe(ed), '', 'sem comentário');
    assert.match(embedDe(ed)?.description ?? '', /501 USD/, 'o embed saiu');
    assert.ok(Date.now() - t0 >= 14_000, 'esperou a janela de religamento antes de desistir do comentário');
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const id2 = comando({ ...MEMBRO, valor: 502 });
    assert.match(comentarioDe(await entrega(id2)), /^IA-FALSA /);
  });

  await test('o bot cai DURANTE o comentário: na volta nada sai em dobro (a interação perdida não é reentregue às cegas)', async () => {
    iaControl({ atrasoMs: 4000 });
    const id = comando({ ...MEMBRO, valor: 601 });
    await waitUntil(() => readCanal().some((e) => e.paraInteracao === id && e.tipo === 'interacao-adiada'), 15_000, 'a interação ser adiada');
    await sleep(800);
    await derrubar(bot);
    iaControl({});
    await sleep(4500); // o cérebro termina o comentário; a resposta não tem para onde ir
    bot = await subirBot();
    await waitUntil(() => /conectado ao cérebro/.test(bot.out), 15_000, 'o bot novo conectar');
    const id2 = comando({ ...MEMBRO, valor: 602 });
    assert.match(comentarioDe(await entrega(id2)), /^IA-FALSA /, 'o bot novo segue comentando');
    await sleep(800);
    assert.equal(edicoesDe(id).length, 0, 'a interação do bot que caiu não recebe nada depois (nem em dobro)');
  });

  await test('parada limpa: travas e segredo do canal saem', async () => {
    await desligar(bot);
    await desligar(cerebro);
    for (const name of ['memory-personal', 'memory-discord', 'memory-context', 'memory-context-personal', 'core']) assert.equal(readLock(name), null, `trava de ${name}`);
    assert.ok(!fs.existsSync(SECRET));
  });

  console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);
