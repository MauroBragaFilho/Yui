// Etapa 6 de ponta a ponta: a PESQUISA do Discord inteira no cérebro, o "Processando..." guardado e o JSON de ferramenta do cérebro tratado
// como pedido (docs/RELATORIO_ETAPA6_PESQUISA.md). Execução: npm run test:pesquisa
//
// Processos de verdade (como no test-chat-turn.js): uma CÓPIA do código numa pasta temporária, bancos e segredo do canal em pastas
// temporárias, portas livres; IA FALSA e BUSCA FALSA no cérebro (só com NODE_ENV=test; nenhuma busca nem IA de verdade) e DISCORD FALSO no bot
// (mensagens pelo messageCreate de verdade; respostas num arquivo que também faz o papel do "servidor" das mensagens). Nenhum buscador real
// fica disponível nos dois processos (YUI_SEARCH_PROVIDERS=searxng sem endereço).
// Cenários: um membro pesquisando pela ferramenta; o Braga em DM (pesquisa privada liberada) e um membro no servidor ao mesmo tempo; a
// pesquisa pela guarda (pedido explícito); o cérebro derrubado DURANTE a pesquisa; o bot derrubado DURANTE a pesquisa (o "Processando..." é
// avisado na volta, e o registro de outra conversa não é editado); o pedido de ferramenta negado pelo motor em enforce; RAM e CPU dos dois
// processos durante tudo isso (lidos pelo IPC de saúde de cada um).
// Ajustes da Liz (relatório da etapa 6, §11): o cérebro derrubado DURANTE a busca retoma com UMA nova tentativa da busca incerta (contada na
// cota uma vez, na saúde e no log sem texto) e derrubado DURANTE a síntese retoma sem repetir busca nem leitura; e cada processo roda com o
// BLOQUEIO de integração externa (tests/helpers/bloqueioExterno.mjs): qualquer tentativa de rede, DNS, UDP ou programa falha o teste.
// Segunda revisão da Liz (§12/§13): a cota por hora fica em disco no cérebro e SOBREVIVE ao reinício (o cérebro novo começa com as buscas
// da última hora do anterior); o bloqueio libera só as exceções que este teste declara (o icacls e o whoami do segredo do canal).
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

const localDb = useIsolatedDatabaseDir('yui-pesquisa-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-pesquisa-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const INBOX = path.join(T, 'entrada.jsonl');
const CANAL = path.join(T, 'canal.jsonl');
const DMS = path.join(T, 'dms.jsonl');
const IA_CTRL = path.join(T, 'controle-ia.json');
const BUSCA_CTRL = path.join(T, 'controle-busca.json');
const BUSCAS = path.join(T, 'buscas.jsonl');
const PROCESSANDO = path.join(DB, 'processando-bot.json');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
// Só as exceções que ESTE teste precisa (segunda revisão da Liz, §12): o icacls e o whoami do segredo do canal no Windows.
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:pesquisa', liberar: { ...EXCECOES_DO_CANAL } });
for (const d of [DB, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const CHAN2 = '555555555555555556';
const DMCH = '777777777777777777';
const BOT_ID = '900000000000000001';
const AVISO = 'Fui reiniciada no meio deste pedido';

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
    YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', REQUIRE_TOS: 'false', YUI_QUEUE_MAX_PER_USER: '20', YUI_CHAT_ESPERA_CEREBRO_MS: '15000',
    YUI_POLICY_MODE: 'observe', YUI_IMAGE_PRE_ROUTE: 'false',
    // pesquisa: o agente ligado, a privada só para o dono, e NENHUM buscador real disponível em nenhum dos dois processos
    YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'owner',
    YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '', YUI_SEARCH_BUDGET_FILE: path.join(T, 'search-budget.json'),
    ...(NATIVE ? { YUI_DB_NATIVE: NATIVE } : {}), ...extra,
  };
}
const procs = new Set();
const allProcs = [];
function startProc(label, script, env) {
  const child = spawn(process.execPath, [...BLOQUEIO.argv, script], { cwd: APP, env: { ...env, ...BLOQUEIO.env(label) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const proc = { label, child, out: '', exited: false, code: null, saude: new Map() };
  allProcs.push(proc);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { proc.out += d; });
  child.stderr.on('data', (d) => { proc.out += d; });
  child.on('message', (m) => { if (m?.tipo === 'saude' && m.id) { proc.saude.get(m.id)?.(m); proc.saude.delete(m.id); } });
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
const buscaControl = (c) => fs.writeFileSync(BUSCA_CTRL, JSON.stringify(c));
const buscas = () => { try { return fs.readFileSync(BUSCAS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

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
const contextRows = async (token) => {
  const out = [];
  for (const f of ['memory-context', 'memory-context-personal']) {
    try { out.push(...(await readDbRows(f, 'SELECT role, content FROM context_turns')).filter((r) => r.content.includes(token))); } catch { /* arquivo ainda não existe */ }
  }
  return out;
};

// ── RAM e CPU (pelo IPC de saúde de cada processo; nada de varredura de processos) ───────────────────
let saudeSeq = 0;
function pedirSaude(proc, timeoutMs = 3000, completa = false) {
  if (!proc || proc.exited) return Promise.resolve(null);
  const id = `s${++saudeSeq}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { proc.saude.delete(id); resolve(null); }, timeoutMs);
    proc.saude.set(id, (m) => { clearTimeout(t); resolve(completa ? m : (m.uso ?? null)); });
    try { proc.child.send({ tipo: 'saude', id }); } catch { clearTimeout(t); resolve(null); }
  });
}
const medidas = {};
let amostrador = null;
const cpuMs = (u) => (u ? u.cpuUserMs + u.cpuSystemMs : 0);
/** Memória privada (Windows) de um processo que ESTE teste abriu (o pid vem do handle; só leitura, nada é encerrado). null fora do Windows. */
function memoriaPrivadaMB(proc) {
  if (process.platform !== 'win32' || !proc || proc.exited) return null;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(proc.child.pid)}).PrivateMemorySize64`], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const n = Number(String(out).trim());
    return Number.isFinite(n) && n > 0 ? Math.round((n / 1024 / 1024) * 10) / 10 : null;
  } catch { return null; }
}
/**
 * Mede os DOIS processos enquanto `fn` roda (os mesmos processos do começo ao fim): a RAM (rss) a cada 300 ms, a CPU usada no intervalo
 * (usuário + sistema, em ms e em % de UM núcleo) e a memória privada no fim (Windows).
 */
async function medirDurante(rotulo, fn) {
  const procsMedidos = { cerebro, bot };
  const antes = { cerebro: await pedirSaude(cerebro), bot: await pedirSaude(bot) };
  const rss = { cerebro: [], bot: [] };
  const t0 = Date.now();
  const loop = async () => {
    while (amostrador === loop) {
      const [c, b] = await Promise.all([pedirSaude(procsMedidos.cerebro), pedirSaude(procsMedidos.bot)]);
      if (c) rss.cerebro.push(c.rssMB);
      if (b) rss.bot.push(b.rssMB);
      await sleep(300);
    }
  };
  amostrador = loop;
  loop();
  try { await fn(); } finally { amostrador = null; }
  const ms = Date.now() - t0;
  const depois = { cerebro: await pedirSaude(procsMedidos.cerebro), bot: await pedirSaude(procsMedidos.bot) };
  const um = (papel) => {
    const xs = rss[papel].length ? rss[papel] : [depois[papel]?.rssMB ?? 0];
    const cpu = Math.max(0, cpuMs(depois[papel]) - cpuMs(antes[papel]));
    return {
      rssMB: { min: Math.min(...xs), max: Math.max(...xs), media: Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 },
      heapMB: depois[papel]?.heapMB ?? null, cpuMs: cpu, cpuPctDeUmNucleo: Math.round((cpu / ms) * 1000) / 10, privadaMB: memoriaPrivadaMB(procsMedidos[papel]),
    };
  };
  medidas[rotulo] = { duracaoS: Math.round(ms / 100) / 10, cerebro: um('cerebro'), bot: um('bot') };
  return medidas[rotulo];
}

// ── Discord falso: entrada e saída ───────────────────────────────────────────────────────────────
let idSeq = 1200000000000000000n;
const nextId = () => String(++idSeq);
function send({ user, guild = null, channel, text }) {
  const id = nextId();
  const content = guild ? `<@${BOT_ID}> ${text}` : text;
  fs.appendFileSync(INBOX, `${JSON.stringify({ id, userId: user, username: `pessoa${user.slice(-3)}`, guildId: guild, channelId: channel, content, at: Date.now() })}\n`);
  return id;
}
const readCanal = () => { try { return fs.readFileSync(CANAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const isProgress = (c) => /Processando|Sua solicitação está na fila/.test(c);
const finalsFor = (id) => readCanal().filter((e) => e.paraMensagem === id && ['reply', 'edit', 'send'].includes(e.tipo) && e.content && !isProgress(e.content)).map((e) => e.content);
const progressFor = (id) => readCanal().filter((e) => e.paraMensagem === id && e.content && isProgress(e.content)).map((e) => e.content);
async function reply(id, timeoutMs = 45_000) {
  await waitUntil(() => finalsFor(id).length > 0, timeoutMs, () => `a resposta à mensagem ${id}\n--- bot ---\n${tail(bot?.out ?? '')}\n--- cérebro ---\n${tail(cerebro?.out ?? '')}`);
  return finalsFor(id).at(-1);
}
const tokensOf = (text) => [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
const searchJson = (query) => JSON.stringify({ thought: 'pesquisar', tool: 'search_web', args: { query } });

// ── Limpeza ─────────────────────────────────────────────────────────────────────────────────────
async function cleanup() {
  amostrador = null;
  if (process.env.YUI_TESTE_MOSTRAR_SAIDA === '1') for (const p of allProcs) console.log(`\n===== ${p.label} (código ${p.code}) =====\n${p.out}`);
  for (const proc of [...procs]) { try { proc.child.send({ tipo: 'desligar' }); } catch { /* */ } await Promise.race([proc.exit, sleep(8000)]); }
  for (const proc of [...procs]) { try { proc.child.kill(); } catch { /* */ } await Promise.race([proc.exit, sleep(3000)]); }
  try { process.chdir(ROOT); } catch { /* */ }
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  await sleep(300);
  let junctionGone = !fs.existsSync(JUNCTION);
  try { fs.unlinkSync(JUNCTION); } catch { /* */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) { try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[pesquisa] não apaguei ${T}: ${err.message}`); } }
  else console.warn(`[pesquisa] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  localDb.cleanup();
}
process.on('exit', () => { for (const p of procs) { try { p.child.kill(); } catch { /* */ } } if (!finished && process.exitCode === undefined) process.exitCode = 1; });

let cerebro = null;
let bot = null;
let cerebroN = 0;
let botN = 0;
// A busca falsa passa pela cota por hora de verdade (YUI_TESTE_BUSCA_FALSA_COTA): a saúde do cérebro mostra quantas buscas contaram. Limites
// largos (nenhum cenário bate no limite); o que se confere é a CONTAGEM depois de uma retomada.
const CEREBRO_ENV = { YUI_TESTE_BUSCA_FALSA: 'true', YUI_TESTE_BUSCA_FALSA_CONTROLE: BUSCA_CTRL, YUI_TESTE_BUSCA_FALSA_REGISTRO: BUSCAS, YUI_TESTE_BUSCA_FALSA_COTA: 'true', YUI_SEARCH_USER_PER_HOUR: '50', YUI_SEARCH_GLOBAL_PER_HOUR: '200' };
const saudeDaPesquisa = async (proc) => (await pedirSaude(proc, 5000, true))?.pesquisa ?? null;
async function subirCerebro(extra = {}) {
  await waitUntil(() => lockAge('memory-personal') > 1700, 15_000, 'a trava do cérebro anterior vencer');
  const c = startProc(`cerebro#${++cerebroN}`, 'src/cerebro.js', childEnv({ ...CEREBRO_ENV, ...extra }));
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
const C = { user: OTHER, guild: GUILD, channel: CHAN2 };

try {
  await test('sobe o cérebro (IA e busca falsas) e o bot (Discord falso); RAM e CPU em repouso', async () => {
    assert.ok(copyCode() > 100);
    iaControl({});
    buscaControl({});
    fs.writeFileSync(INBOX, '');
    cerebro = await subirCerebro();
    bot = await subirBot();
    await botConectado(cerebro);
    assert.match(cerebro.out, /BUSCA FALSA ligada/);
    await sleep(1500);
    const r = await medirDurante('repouso', () => sleep(5000));
    assert.ok(r.cerebro.rssMB.max > 0 && r.bot.rssMB.max > 0, 'as medidas chegaram pelo IPC');
  });

  await test('rajada de 8 pesquisas de 4 pessoas (o Braga em DM e três no servidor): todas respondidas, cada uma com a própria evidência; RAM e CPU medidas', async () => {
    iaControl({ ferramentaJson: searchJson('consulta do teste de carga') });
    const quem = [A, B, C, { user: OTHER, guild: GUILD, channel: CHAN }];
    const pedidos = [];
    const r = await medirDurante('rajada', async () => {
      for (let i = 0; i < 8; i += 1) {
        const w = quem[i % quem.length];
        pedidos.push({ id: send({ ...w, text: `pesquise o preço do console ${i} tok-RJ${i}` }), i });
      }
      for (const p of pedidos) {
        const text = await reply(p.id, 90_000);
        assert.ok(tokensOf(text).includes(`tok-RJ${p.i}`), `a resposta ${p.i} veio com a própria pergunta`);
        for (const t of tokensOf(text)) if (t.startsWith('tok-RJ')) assert.equal(t, `tok-RJ${p.i}`, `vazamento entre pedidos: ${p.i} viu ${t}`);
      }
    });
    iaControl({});
    assert.ok(r.cerebro.cpuMs > 0 && r.bot.cpuMs > 0);
  });

  await test('um membro pesquisa pela ferramenta: a busca, a leitura, a síntese e as fontes no CÉREBRO; o progresso só na mensagem dele; nada no contexto', async () => {
    iaControl({ ferramentaJson: searchJson('preço do PS5 tok-M1') });
    const antes = buscas().length;
    const id = send({ ...B, text: 'pesquise o preço do PS5 tok-M1' });
    const text = await reply(id);
    iaControl({});
    assert.match(text, /📎 \*\*Fontes:\*\*/, text);
    assert.match(text, /-# 🔎 Search/);
    assert.ok(tokensOf(text).includes('tok-M1'), 'a síntese recebeu a evidência da consulta dele');
    const novas = buscas().slice(antes);
    assert.ok(novas.some((b) => b.tipo === 'agente'), 'a busca rodou');
    assert.ok(novas.every((b) => b.pid === cerebro.child.pid), 'TODA busca e leitura rodou no processo do cérebro');
    assert.ok(novas.some((b) => b.tipo === 'pagina'), 'as páginas foram lidas no cérebro');
    assert.ok(progressFor(id).some((p) => /-# 🔎 Pesquisando/.test(p)), 'o progresso apareceu no "Processando..." desta mensagem');
    assert.equal((await contextRows('tok-M1')).length, 0, 'resposta com pesquisa não entra no contexto por horas');
  });

  await test('o Braga em DM (pesquisa privada liberada) e um membro no servidor AO MESMO TEMPO: cada um só a própria evidência; a privada só com o texto literal', async () => {
    iaControl({ ferramentaJson: searchJson('consulta inventada pelo modelo tok-MODELO') });
    const antes = buscas().length;
    const ida = send({ ...A, text: 'pesquise o preço do PS5 tok-DONO porque é pro presente da Fulana' });
    const idb = send({ ...C, text: 'pesquise o preço do Xbox tok-OUTRO' });
    const [ta, tb] = [await reply(ida, 60_000), await reply(idb, 60_000)];
    iaControl({});
    assert.ok(tokensOf(ta).includes('tok-DONO') && !tokensOf(ta).includes('tok-OUTRO'), `vazamento no dono: ${ta}`);
    assert.ok(!tokensOf(tb).includes('tok-DONO'), `vazamento no membro: ${tb}`);
    const novas = buscas().slice(antes).filter((b) => b.tipo === 'agente');
    const dono = novas.filter((b) => b.consulta.includes('tok-DONO'));
    assert.equal(dono.length, 1);
    assert.equal(dono[0].privado, true, 'a do dono é privada');
    assert.ok(!/Fulana|presente|tok-MODELO/.test(dono[0].consulta), 'só o pedido literal: nem a justificativa pessoal nem a consulta do modelo');
    assert.ok(!progressFor(ida).some((p) => /tok-DONO|PS5/.test(p)), 'o progresso da privada não mostra a consulta');
    assert.match(ta, /sensivel=sim/, 'a síntese privada nunca vai a provedor anônimo');
    assert.equal((await contextRows('tok-DONO')).length + (await contextRows('tok-OUTRO')).length, 0);
  });

  await test('a pesquisa pela guarda (pedido explícito, sem a ferramenta): o bot pede, o cérebro pesquisa', async () => {
    const id = send({ ...B, text: 'pesquise quem ganhou o Oscar de melhor filme este ano tok-G1' });
    const text = await reply(id);
    assert.match(text, /📎 \*\*Fontes:\*\*/, text);
    assert.match(bot.out, /\[Pesquisa\] guarda: acao=search/);
  });

  await test('o cérebro cai à força DURANTE a pesquisa: o bot espera, repete com a MESMA chave no cérebro novo e a resposta sai UMA vez', async () => {
    iaControl({ ferramentaJson: searchJson('jogo do ano tok-Q1') });
    buscaControl({ atrasoMs: 5000 });
    const id = send({ ...B, text: 'pesquise o jogo do ano tok-Q1' });
    await waitUntil(() => buscas().some((b) => b.consulta?.includes('tok-Q1')), 20_000, 'a busca começar no cérebro');
    // a cota por hora no cérebro que vai cair (a busca em andamento já contou e já está no disco: a cota é gravada ANTES de a busca sair)
    const cotaAntes = (await saudeDaPesquisa(cerebro))?.cota;
    assert.equal(cotaAntes?.hora?.persistente, true, JSON.stringify(cotaAntes));
    await derrubar(cerebro);
    buscaControl({});
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const text = await reply(id, 60_000);
    iaControl({});
    assert.match(text, /📎 \*\*Fontes:\*\*|tok-Q1/, text);
    assert.equal(finalsFor(id).length, 1, 'uma resposta só');
    assert.match(bot.out, /research\.turn: a conexão caiu no meio \(CONNECTION_LOST\); esperando o cérebro voltar para repetir com a mesma chave/);
    const q = buscas().filter((b) => b.tipo === 'agente' && b.consulta.includes('tok-Q1'));
    // Ajustes da Liz (§11): a busca que saiu e não teve resultado registrado ficou INCERTA no diário; o cérebro novo fez UMA nova tentativa
    // controlada (nunca uma terceira), contada na cota uma vez, e mostra isso na saúde e no log (só números).
    assert.equal(q.length, 2, `a busca incerta + UMA nova tentativa (${q.length})`);
    assert.equal(new Set(q.map((b) => b.pid)).size, 2, 'uma em cada cérebro');
    const s = await saudeDaPesquisa(cerebro);
    assert.equal(s?.retomada?.incertasNaCarga, 1, JSON.stringify(s));
    assert.equal(s.retomada.novasTentativas, 1);
    assert.equal(s.retomada.desistencias, 0);
    // Segunda revisão da Liz (§12): a cota por hora SOBREVIVE ao reinício (em disco, no cérebro). O cérebro novo começa com as buscas da última
    // hora do anterior (inclusive a incerta, que pode ter saído) e soma a nova tentativa: as duas contam, como na cota mensal dos provedores.
    assert.ok(s.cota.hora?.carregadas >= cotaAntes.globalUsadas, `as buscas da última hora voltaram do disco: ${JSON.stringify(s.cota)}`);
    assert.equal(s.cota.globalUsadas, cotaAntes.globalUsadas + 1, `a cota por hora sobreviveu ao reinício e contou a nova tentativa: ${JSON.stringify(s.cota)}`);
    assert.equal(s.retomada.cotaDevolvida, 0, 'nada a devolver: a cota já voltou do disco');
    const linhas = cerebro.out.split(/\r?\n/).filter((l) => /\[Pesquisa\] retomada/.test(l));
    assert.ok(linhas.some((l) => /INCERTA/.test(l) && /nova tentativa controlada \(2 de 2\)/.test(l)), linhas.join('\n'));
    assert.ok(linhas.every((l) => !/tok-|jogo do ano/.test(l)), 'o log da retomada não leva a pergunta nem a consulta');
  });

  await test('o cérebro cai à força DURANTE a SÍNTESE (busca e páginas já guardadas): no cérebro novo, nenhuma busca nem leitura se repete e a cota conta certo', async () => {
    iaControl({ ferramentaJson: searchJson('melhor monitor tok-S1'), atrasoSinteseMs: 8000 });
    const id = send({ ...B, text: 'pesquise o melhor monitor tok-S1' });
    // a busca e a leitura das páginas terminam rápido; a síntese fica 8 s parada (IA falsa): derruba o cérebro no meio dela
    await waitUntil(() => { const b = buscas(); const i = b.findIndex((x) => x.tipo === 'agente' && x.consulta.includes('tok-S1')); return i >= 0 && b.slice(i).filter((x) => x.tipo === 'pagina').length >= 2; }, 30_000, 'a busca e a leitura das páginas');
    await sleep(1500);
    const antes = buscas();
    assert.equal(antes.filter((b) => b.tipo === 'agente' && b.consulta.includes('tok-S1')).length, 1);
    const paginasAntes = antes.filter((b) => b.tipo === 'pagina').length;
    const cotaAntes = (await saudeDaPesquisa(cerebro))?.cota;
    await derrubar(cerebro);
    iaControl({});
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const text = await reply(id, 60_000);
    assert.match(text, /📎 \*\*Fontes:\*\*/, text);
    assert.equal(finalsFor(id).length, 1, 'uma resposta só');
    const depois = buscas();
    assert.equal(depois.filter((b) => b.tipo === 'agente' && b.consulta.includes('tok-S1')).length, 1, 'a busca concluída e guardada NÃO rodou de novo');
    assert.equal(depois.filter((b) => b.tipo === 'pagina').length, paginasAntes, 'as páginas lidas e guardadas NÃO foram lidas de novo');
    const s = await saudeDaPesquisa(cerebro);
    assert.equal(s?.retomada?.buscasReaproveitadas, 1, JSON.stringify(s));
    assert.equal(s.retomada.novasTentativas, 0);
    // Segunda revisão da Liz (§12): com a cota por hora em disco, a busca do cérebro anterior já voltou do arquivo (nada a "devolver"), e o
    // cérebro novo conta exatamente o mesmo que o anterior contava (nenhuma busca nova, nenhuma conta em dobro).
    assert.equal(s.retomada.cotaDevolvida, 0, 'nada a devolver: a cota já voltou do disco');
    assert.equal(s.cota.globalUsadas, cotaAntes.globalUsadas, `a cota por hora sobreviveu ao reinício, sem contar a busca duas vezes: ${JSON.stringify(s.cota)}`);
  });

  await test('o bot cai DURANTE a pesquisa: na volta, o "Processando..." recebe o aviso e o registro sai; o de outra conversa NÃO é editado', async () => {
    // uma resposta já entregue (de outra conversa), que nunca pode ser editada
    iaControl({});
    const idOutra = send({ ...C, text: 'tok-Z0 oi' });
    await reply(idOutra);
    iaControl({ ferramentaJson: searchJson('melhor ssd tok-Z1') });
    buscaControl({ atrasoMs: 4000 });
    const id = send({ ...B, text: 'pesquise o melhor ssd tok-Z1' });
    await waitUntil(() => progressFor(id).some((p) => /🔎 Pesquisando/.test(p)), 30_000, 'a pesquisa começar (progresso)');
    const reg = JSON.parse(fs.readFileSync(PROCESSANDO, 'utf8'));
    const meu = Object.values(reg.registros).find((r) => r.mensagemOriginal === id);
    assert.ok(meu, 'o "Processando..." deste turno está guardado');
    assert.equal(meu.estado, 'pesquisando', 'com o estado do turno');
    assert.equal(meu.conversa, `ch:${CHAN}:u:${MEMBER}`);
    await derrubar(bot);
    buscaControl({});
    iaControl({});
    // um registro de OUTRA conversa apontando para uma resposta já entregue (o bot está fora: o arquivo é dele e ninguém grava agora)
    const doneMsg = readCanal().find((e) => e.tipo === 'reply' && e.paraMensagem === idOutra);
    const regs = JSON.parse(fs.readFileSync(PROCESSANDO, 'utf8'));
    regs.registros[doneMsg.mensagemId] = { mensagemOriginal: idOutra, mensagemProcessando: doneMsg.mensagemId, canal: CHAN2, conversa: `ch:${CHAN2}:u:${OTHER}`, turno: idOutra, resposta: true, estado: 'entregando', criadoEm: Date.now(), atualizadoEm: Date.now() };
    fs.writeFileSync(PROCESSANDO, JSON.stringify(regs));
    const conteudoAntes = finalsFor(idOutra).at(-1);
    await sleep(4500); // o cérebro termina a pesquisa; a resposta não tem para onde ir
    bot = await subirBot();
    await waitUntil(() => /conectado ao cérebro/.test(bot.out), 15_000, 'o bot novo conectar');
    await waitUntil(() => finalsFor(id).some((t) => t.includes(AVISO)), 15_000, () => `o aviso no "Processando..."\n${tail(bot.out)}`);
    assert.equal(finalsFor(id).length, 1, 'só o aviso (a resposta perdida não aparece depois)');
    assert.equal(finalsFor(idOutra).at(-1), conteudoAntes, 'a mensagem de outra conversa ficou intacta');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(PROCESSANDO, 'utf8')).registros).length, 0, 'os registros saíram');
    assert.match(bot.out, /1 mensagem\(ns\) "Processando\.\.\." avisada\(s\).*1 que não conferiam/);
    assert.equal((await contextRows('tok-Z1')).length, 0);
  });

  await test('o JSON de ferramenta do cérebro é um PEDIDO: com a regra negando (enforce), o bot não executa (processos de verdade)', async () => {
    await desligar(bot);
    bot = await subirBot({ YUI_POLICY_MODE: 'enforce', POLICY_CHAT_AUTONOMY: 'DENY' });
    await waitUntil(() => /conectado ao cérebro/.test(bot.out), 15_000, 'o bot novo conectar');
    iaControl({ ferramentaJson: JSON.stringify({ thought: 'imagem', tool: 'generate_image', args: { prompt: 'a cat', negative_prompt: 'nsfw' } }) });
    const id = send({ ...B, text: 'tok-F1 faz aquilo que eu pedi' });
    const text = await reply(id);
    iaControl({});
    assert.match(text, /não é permitido pela política de segurança/, text);
  });

  await test('RAM e CPU dos dois processos (pelo IPC de saúde de cada um) e desligamento limpo', async () => {
    console.log(`  medidas (PC local): ${JSON.stringify(medidas)}`);
    for (const k of ['repouso', 'rajada']) assert.ok(medidas[k]?.cerebro?.rssMB?.max > 0 && medidas[k]?.bot?.rssMB?.max > 0, `medidas de ${k}`);
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
