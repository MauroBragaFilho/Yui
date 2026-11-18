// Etapa 8, item 4: o /steam_jogo de PONTA A PONTA com processos de verdade (revisão da Liz, §9 do relatório da etapa 7). Execução: npm run test:steamjogo
//
// O cérebro (src/cerebro.js) e o bot (src/index.js com YUI_CEREBRO_EXTERNO=true) são processos de verdade, numa CÓPIA do código em pasta temporária,
// com a IA FALSA no cérebro, o DISCORD FALSO e a STEAM FALSA (src/discord/steamFalsa.js) no bot, e o BLOQUEIO de integração externa nos dois
// (nenhuma rede, nenhum programa, nenhum worker; só o icacls e o whoami do segredo do canal). O comando de barra entra pelo interactionCreate de
// verdade (tests/test-comentarios-cerebro.js já faz o mesmo com o /converter_moeda; aqui é o /steam_jogo, que busca na "Steam" antes do comentário).
//
// Cenários (cada um confere que a MESMA interação nunca gera duas entregas):
//  1. comentário normal (público): o embed da Steam e o comentário numa edição só;
//  2. comentário privado (a DM do Braga, com conversa privada no contexto e o nome do jogo digitado na DM): sensível, nada da conversa entra;
//  3. a IA falha: o embed sai sem comentário, na hora, e a mensagem de erro não carrega nada privado;
//  4. o cérebro cai NO MEIO: o bot espera, repete com a MESMA chave e entrega UMA vez (e o diagnóstico mostra o cérebro de pé);
//  5. o cérebro está FORA: o embed sai sem comentário (sem travar: um segundo comando é atendido ao mesmo tempo); o comentário volta com o cérebro;
//  6. o bot cai NO MEIO: nada sai depois, nem em dobro (e o diagnóstico mostra o bot desconectado);
//  7. o PRAZO expira (o bot com o prazo mínimo de 5 s; o padrão é 45 s): o embed sai sem comentário e NENHUM comentário atrasado sai depois, nem
//     uma segunda entrega, mesmo quando a IA enfim responde;
//  8. CONTEÚDO PRIVADO: depois de tudo, a conversa do Braga e o nome do jogo que ele digitou na DM não estão em nenhum log (a saída dos dois
//     processos e os arquivos de log), na auditoria, na saúde pelo IPC, no /v1/health nem no diagnóstico (GET /v1/admin/diagnostico); e o dono do
//     arquivo da cota por hora é o cérebro (o bot nunca grava).
// Os testes de ponta a ponta conferem o banco ou as saídas só DEPOIS de a resposta chegar: tudo espera com waitUntil (nunca lê logo depois da resposta).
// Só são encerrados os processos que este teste abriu, pelo handle (nunca por PID achado em varredura).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
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

const localDb = useIsolatedDatabaseDir('yui-steamjogo-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-steamjogo-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const INBOX = path.join(T, 'entrada.jsonl');
const CANAL = path.join(T, 'canal.jsonl');
const DMS = path.join(T, 'dms.jsonl');
const IA_CTRL = path.join(T, 'controle-ia.json');
const ORCAMENTO = path.join(T, 'cota', 'search-budget.json');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
// Só as exceções que ESTE teste precisa: o icacls e o whoami do segredo do canal no Windows.
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:steamjogo', liberar: { ...EXCECOES_DO_CANAL } });
for (const d of [DB, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const BOT_ID = '900000000000000001';
const TOKEN = `token-do-app-de-teste-${Math.random().toString(16).slice(2)}0123456789`;
// O conteúdo PRIVADO do Braga: a fala dele em DM e o nome do jogo que ele pediu na DM. Nada disto pode aparecer em log, auditoria, saúde, /v1/health
// nem diagnóstico (só na conversa dele, no banco, e na mensagem entregue a ele).
const CONVERSA_PRIVADA = 'tok-CONVPRIV7b21';
const JOGO_PRIVADO = 'tok-JOGOPRIV7b21';
const NOME_JOGO_PRIVADO = `Segredo do Braga ${JOGO_PRIVADO}`;

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
let apiPort = 0;
function childEnv(extra = {}) {
  const env = {};
  for (const k of SYSTEM_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env, NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', LOG_LEVEL: 'debug', // debug: o máximo de linhas de log, para a conferência de vazamento valer mais
    DATABASE_DIR: DB, YUI_CHANNEL_SECRET_FILE: SECRET, YUI_CHANNEL_PORT: '0', YUI_DB_OWNER_HEARTBEAT_MS: '300', YUI_DB_OWNER_STALE_MS: '1500',
    YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'true', YUI_ALERTS: 'false', YUI_MORNING_REPORT: 'false', YUI_HEALTH_REPORT: 'false',
    GTA_WEEKLY_ENABLED: 'false', NEWSWIRE_ENABLED: 'false', YOUTUBE_INTERVAL_MINUTES: '0', TWITCH_INTERVAL_MINUTES: '0', YUI_GATEWAY_ENABLED: 'false',
    YUI_TESTE_IA_FALSA: 'true', YUI_TESTE_IA_FALSA_CONTROLE: IA_CTRL, DISCORD_TOKEN: 'token-falso-de-teste',
    YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', REQUIRE_TOS: 'false', YUI_QUEUE_MAX_PER_USER: '20',
    YUI_POLICY_MODE: 'observe', YUI_IMAGE_PRE_ROUTE: 'false', YUI_RESEARCH_ENABLED: 'false', YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '',
    YUI_SEARCH_BUDGET_FILE: ORCAMENTO, YUI_COMENTARIO_PRAZO_MS: '20000',
    YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(apiPort), YUI_API_TOKENS: `${TOKEN}=${OWNER}`,
    ...(NATIVE ? { YUI_DB_NATIVE: NATIVE } : {}), ...extra,
  };
}
const procs = new Set();
const allProcs = [];
function startProc(label, script, env) {
  const child = spawn(process.execPath, [...BLOQUEIO.argv, script], { cwd: APP, env: { ...env, ...BLOQUEIO.env(label) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const proc = { label, child, out: '', exited: false, code: null, ipc: [] };
  allProcs.push(proc);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { proc.out += d; });
  child.stderr.on('data', (d) => { proc.out += d; });
  child.on('message', (m) => { proc.ipc.push(m); });
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
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

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
const contextAll = async () => {
  const out = [];
  for (const f of ['memory-context', 'memory-context-personal']) {
    try { out.push(...(await readDbRows(f, 'SELECT role, content FROM context_turns'))); } catch { /* arquivo ainda não existe */ }
  }
  return out;
};

// ── Discord falso: entrada (mensagens e comandos) e saída ──────────────────────────────────────────────
let idSeq = 1400000000000000000n;
const nextId = () => String(++idSeq);
function send({ user, guild = null, channel, text }) {
  const id = nextId();
  const content = guild ? `<@${BOT_ID}> ${text}` : text;
  fs.appendFileSync(INBOX, `${JSON.stringify({ id, userId: user, username: `pessoa${user.slice(-3)}`, guildId: guild, channelId: channel, content, at: Date.now() })}\n`);
  return id;
}
function steam({ user, guild = null, channel, nome }) {
  const id = nextId();
  fs.appendFileSync(INBOX, `${JSON.stringify({ tipo: 'comando', id, comando: 'steam_jogo', opcoes: { nome }, userId: user, username: `pessoa${user.slice(-3)}`, guildId: guild, channelId: channel, at: Date.now() })}\n`);
  return id;
}
const readCanal = () => { try { return fs.readFileSync(CANAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const edicoesDe = (id) => readCanal().filter((e) => e.paraInteracao === id && e.tipo === 'interacao-edicao');
/** TODAS as respostas de uma interação ao Discord (edição, resposta direta, seguimento): a regra é no máximo UMA entrega. */
const entregasDe = (id) => readCanal().filter((e) => e.paraInteracao === id && ['interacao-edicao', 'interacao-resposta', 'interacao-seguimento'].includes(e.tipo));
const adiadaDe = (id) => readCanal().find((e) => e.paraInteracao === id && e.tipo === 'interacao-adiada');
const finalsFor = (id) => readCanal().filter((e) => e.paraMensagem === id && ['reply', 'edit', 'send'].includes(e.tipo) && e.content && !/Processando|Sua solicitação está na fila/.test(e.content)).map((e) => e.content);
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
/** Espera um tempo e confere que NADA a mais saiu para a interação (a regra de uma entrega só). */
async function nadaAlemDe(id, quantas, ms = 1000) {
  await sleep(ms);
  assert.equal(entregasDe(id).length, quantas, `a interação ${id} recebeu ${entregasDe(id).length} entrega(s), esperava ${quantas}: ${JSON.stringify(entregasDe(id).map((e) => e.tipo))}`);
}

// ── HTTP na API do cérebro (o /v1/health e o diagnóstico) ─────────────────────────────────────────────
async function api(route) {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  let json = null;
  let texto = '';
  try { texto = await res.text(); json = JSON.parse(texto); } catch { json = null; }
  return { status: res.status, json, texto };
}
/** A saúde de um processo pelo IPC (a mesma que o supervisor lê). */
async function saudeIpc(proc) {
  const id = `s${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
  proc.child.send({ tipo: 'saude', id });
  await waitUntil(() => proc.ipc.some((m) => m.tipo === 'saude' && m.id === id), 15_000, `a saúde de ${proc.label}`);
  return proc.ipc.find((m) => m.tipo === 'saude' && m.id === id);
}

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
  if (junctionGone) { try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[steamjogo] não apaguei ${T}: ${err.message}`); } }
  else console.warn(`[steamjogo] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
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
  const b = startProc(`bot#${++botN}`, 'src/index.js', childEnv({ YUI_CEREBRO_EXTERNO: 'true', YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_STEAM_FALSA: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: DMS, YUI_TESTE_DISCORD_FALSO_ENTRADA: INBOX, YUI_TESTE_DISCORD_FALSO_CANAL: CANAL, ...extra }));
  await waitFor(b, /Yui inicializada \(Discord falso/);
  await waitFor(b, /Discord falso: mensagens de/);
  return b;
}
async function botConectado(c, from = 0) { await waitFor(c, /\[canal\] bot conectado/, 30_000, from); }
async function desligar(proc) { proc.child.send({ tipo: 'desligar' }); assert.equal((await waitExit(proc, 20_000)).code, 0, tail(proc.out)); }
async function derrubar(proc) { proc.child.kill(); await waitExit(proc, 10_000); } // pelo handle: o processo que este teste abriu

const BRAGA = { user: OWNER, guild: null, channel: DMCH };
const MEMBRO = { user: MEMBER, guild: GUILD, channel: CHAN };

try {
  apiPort = await freePort();
  await test('sobe o cérebro (IA falsa, API) e o bot (Discord falso, Steam falsa, prazo de 20 s)', async () => {
    assert.ok(copyCode() > 100);
    iaControl({});
    fs.writeFileSync(INBOX, '');
    cerebro = await subirCerebro();
    bot = await subirBot();
    await botConectado(cerebro);
    assert.match(bot.out, /STEAM FALSA ligada/);
    // a cota por hora em disco: o dono do arquivo é o CÉREBRO (o bot nunca grava; a trava mostra quem é o dono)
    assert.match(cerebro.out, /Cota de busca por hora em disco \(dono: cerebro\)/);
    assert.match(bot.out, /o bot não grava/);
    const trava = JSON.parse(fs.readFileSync(`${path.join(T, 'cota', 'search-budget-hora.json')}.owner`, 'utf8'));
    assert.equal(trava.role, 'cerebro');
    assert.equal(trava.pid, cerebro.child.pid);
  });

  await test('1. comentário normal (público): o embed da Steam e o comentário numa edição só, vindo do cérebro, isolado e sem gravar nada', async () => {
    const antes = await contextAll();
    const id = steam({ ...MEMBRO, nome: 'Hollow Knight tok-PUB1' });
    const ed = await entrega(id);
    assert.equal(embedDe(ed)?.title, 'Jogo Hollow Knight tok-PUB1');
    assert.match(embedDe(ed)?.description ?? '', /Steam falsa/);
    const c = comentarioDe(ed);
    assert.match(c, /^IA-FALSA /, `o comentário veio da IA do cérebro: ${c}`);
    assert.match(c, /historico=0 /, 'sem histórico');
    assert.match(c, /memoria=nao /, 'sem memória');
    assert.match(c, /ferramentas=nao /, 'sem ferramentas');
    assert.match(c, /sensivel=nao /, 'público: a chamada não é sensível');
    await nadaAlemDe(id, 1);
    assert.deepEqual(await contextAll(), antes, 'nada entrou no contexto por horas');
    assert.doesNotMatch(bot.out, /\[IA\] /, 'o bot não chamou a cadeia de IA dele');
  });

  await test('2. comentário PRIVADO (a DM do Braga, com conversa privada no contexto): sensível, nada da conversa entra no comentário e o comentário não fica no contexto', async () => {
    const m = send({ ...BRAGA, text: `${CONVERSA_PRIVADA} oi, guarda isso` });
    await reply(m);
    await waitUntil(async () => (await contextAll()).some((r) => r.content.includes(CONVERSA_PRIVADA)), 15_000, 'a conversa privada entrar no contexto'); // o commit sai DEPOIS da entrega
    const antes = await contextAll();
    const id = steam({ ...BRAGA, nome: NOME_JOGO_PRIVADO });
    const ed = await entrega(id);
    const c = comentarioDe(ed);
    assert.match(c, /sensivel=sim /, `privado: nunca provedor anônimo: ${c}`);
    assert.match(c, /historico=0 vistos=\[\] /, 'nada da conversa privada entrou no comentário');
    assert.equal(embedDe(ed)?.title, `Jogo ${NOME_JOGO_PRIVADO}`, 'o embed (entregue ao próprio Braga) leva o nome que ele pediu');
    await nadaAlemDe(id, 1);
    assert.deepEqual(await contextAll(), antes, 'o comentário não entrou no contexto');
  });

  await test('3. a IA FALHA: o embed sai sem comentário, na hora, uma vez; e a mensagem de erro do cérebro não carrega o nome do jogo', async () => {
    iaControl({ falhar: true });
    const t0 = Date.now();
    const id = steam({ ...BRAGA, nome: `${NOME_JOGO_PRIVADO} 2` });
    const ed = await entrega(id, 20_000);
    assert.equal(comentarioDe(ed), '', 'sem comentário');
    assert.equal(embedDe(ed)?.title, `Jogo ${NOME_JOGO_PRIVADO} 2`);
    assert.ok(Date.now() - t0 < 15_000, 'não esperou à toa');
    await nadaAlemDe(id, 1);
    await waitUntil(() => /a IA não respondeu o comentário \(steam\)/.test(cerebro.out), 10_000, 'o aviso do cérebro de que a IA falhou');
    iaControl({});
  });

  await test('4. o cérebro cai NO MEIO do comentário: o bot espera, repete com a MESMA chave no cérebro novo e entrega UMA vez', async () => {
    iaControl({ atrasoMs: 6000 });
    const id = steam({ ...MEMBRO, nome: 'Celeste tok-MEIO1' });
    await waitUntil(() => adiadaDe(id), 15_000, 'a interação ser adiada');
    await sleep(1500); // o pedido já está no cérebro (a IA falsa segura 6 s)
    await derrubar(cerebro);
    iaControl({});
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const ed = await entrega(id, 60_000);
    assert.match(comentarioDe(ed), /^IA-FALSA /, 'o comentário saiu do cérebro novo');
    assert.equal(embedDe(ed)?.title, 'Jogo Celeste tok-MEIO1');
    await nadaAlemDe(id, 1);
    assert.match(bot.out, /chat\.comentario: a conexão caiu no meio \(CONNECTION_LOST\); esperando o cérebro voltar para repetir com a mesma chave/);
    // o diagnóstico (só o dono) mostra o cérebro de pé e o bot conectado
    // (o dono da cota por hora pode levar um instante para assumir o arquivo depois da queda: a trava do cérebro que caiu vence em ~2 s)
    await waitUntil(async () => (await api('/v1/admin/diagnostico')).json?.cotasDeBusca?.hora?.persistencia?.gravando === true, 20_000, 'o cérebro novo assumir o arquivo da cota por hora');
    const d = await api('/v1/admin/diagnostico');
    assert.equal(d.status, 200, d.texto);
    assert.equal(d.json.modo, 'cerebro-separado');
    assert.equal(d.json.cerebro.botConectado, true);
    assert.equal(d.json.cerebro.discordOnline, true);
    assert.ok(d.json.cerebro.comentarios.pedidos >= 1, JSON.stringify(d.json.cerebro.comentarios));
    assert.equal(d.json.cotasDeBusca.hora.persistencia.papel, 'cerebro', 'o dono da cota por hora é o cérebro');
    assert.equal(d.json.cotasDeBusca.hora.persistencia.gravando, true);
  });

  await test('5. o cérebro está FORA: o embed sai sem comentário (sem travar: um segundo comando é atendido ao mesmo tempo) e o comentário volta com o cérebro', async () => {
    await desligar(cerebro);
    const t0 = Date.now();
    const sem = steam({ ...BRAGA, nome: `${NOME_JOGO_PRIVADO} fora` });
    const outro = steam({ ...MEMBRO, nome: 'jogo inexistente' }); // outra interação ao mesmo tempo: o erro da Steam, sem comentário nenhum
    const erro = await entrega(outro, 30_000);
    assert.equal(embedDe(erro)?.title, '❌ Erro na Steam', 'o segundo comando foi atendido (o primeiro não o travou)');
    const ed = await entrega(sem, 45_000);
    assert.equal(comentarioDe(ed), '', 'sem comentário');
    assert.equal(embedDe(ed)?.title, `Jogo ${NOME_JOGO_PRIVADO} fora`, 'o embed saiu sozinho');
    assert.ok(Date.now() - t0 >= 14_000, 'esperou a janela de religamento antes de desistir do comentário');
    await nadaAlemDe(sem, 1);
    await nadaAlemDe(outro, 1, 200);
    cerebro = await subirCerebro();
    await botConectado(cerebro, 0);
    const volta = steam({ ...MEMBRO, nome: 'Hades tok-VOLTA1' });
    assert.match(comentarioDe(await entrega(volta)), /^IA-FALSA /, 'o comentário volta quando o cérebro volta');
  });

  await test('6. o bot cai NO MEIO do comentário: na volta nada sai (a interação perdida não é reentregue às cegas) e o diagnóstico mostra o bot desconectado', async () => {
    iaControl({ atrasoMs: 4000 });
    const id = steam({ ...MEMBRO, nome: 'Dead Cells tok-BOTCAI' });
    await waitUntil(() => adiadaDe(id), 15_000, 'a interação ser adiada');
    await sleep(800);
    await derrubar(bot);
    iaControl({});
    await waitUntil(async () => { const d = await api('/v1/admin/diagnostico'); return d.json?.cerebro?.botConectado === false; }, 15_000, 'o cérebro perceber que o bot saiu');
    const d = await api('/v1/admin/diagnostico');
    assert.equal(d.json.cerebro.botConectado, false);
    assert.equal(d.json.cerebro.discordOnline, null, 'sem o bot, o Discord é desconhecido');
    assert.ok(d.json.motivos.some((m) => m.codigo === 'bot-desconectado'), JSON.stringify(d.json.motivos));
    assert.equal(d.json.estado, 'atencao');
    await sleep(4500); // o cérebro termina o comentário; a resposta não tem para onde ir
    // o bot novo, já com o PRAZO MÍNIMO de 5 s (o cenário 7 usa o mesmo processo)
    bot = await subirBot({ YUI_COMENTARIO_PRAZO_MS: '5000' });
    await waitUntil(() => /conectado ao cérebro/i.test(bot.out), 15_000, 'o bot novo conectar');
    const seguinte = steam({ ...MEMBRO, nome: 'Outer Wilds tok-NOVOBOT' });
    assert.match(comentarioDe(await entrega(seguinte)), /^IA-FALSA /, 'o bot novo segue comentando');
    await sleep(800);
    assert.equal(entregasDe(id).length, 0, 'a interação do bot que caiu não recebe nada depois (nem em dobro)');
  });

  await test('7. o PRAZO expira (5 s no bot; o padrão é 45 s): o embed sai sem comentário e NENHUM comentário atrasado sai depois, nem uma segunda entrega', async () => {
    iaControl({ atrasoMs: 9000 }); // a IA só responde em 9 s, bem depois do prazo de 5 s
    const t0 = Date.now();
    const id = steam({ ...BRAGA, nome: `${NOME_JOGO_PRIVADO} lento` });
    const ed = await entrega(id, 25_000);
    const levou = Date.now() - t0;
    assert.equal(comentarioDe(ed), '', 'expirou: sem comentário');
    assert.equal(embedDe(ed)?.title, `Jogo ${NOME_JOGO_PRIVADO} lento`);
    assert.ok(levou >= 4000 && levou < 9000, `o embed saiu no prazo (${levou} ms), sem esperar a IA`);
    // a IA enfim responde (em ~9 s, no cérebro): a resposta atrasada não tem para onde ir. Espera passar do instante dela e confere de novo.
    await waitUntil(() => Date.now() - t0 > 12_000, 20_000, 'passar do instante da resposta atrasada');
    await nadaAlemDe(id, 1, 500);
    assert.equal(edicoesDe(id).length, 1);
    assert.equal(comentarioDe(edicoesDe(id)[0]), '', 'nenhuma edição posterior trouxe o comentário atrasado');
    // o bot não ficou preso: o comando seguinte, com a IA normal, comenta
    iaControl({});
    const seguinte = steam({ ...MEMBRO, nome: 'Balatro tok-DEPOIS1' });
    assert.match(comentarioDe(await entrega(seguinte)), /^IA-FALSA /);
    await nadaAlemDe(id, 1, 200);
  });

  await test('8. CONTEÚDO PRIVADO: a conversa e o nome do jogo digitados na DM do Braga não estão em nenhum log, na auditoria, na saúde, no /v1/health nem no diagnóstico', async () => {
    const marcas = [CONVERSA_PRIVADA, JOGO_PRIVADO, 'Segredo do Braga'];
    const onde = [];
    // (a) a saída dos dois processos (o que o winston escreve no console) de TODOS os processos deste teste, inclusive os que caíram
    for (const p of allProcs) onde.push([`saída de ${p.label}`, p.out]);
    // (b) todos os arquivos de log, auditoria, estado e telemetria das pastas dos processos (os bancos, o contexto e o Discord falso ficam de fora: lá
    //     a conversa É guardada, por desenho, só no arquivo do próprio dono)
    const pular = (rel) => /(^|[\\/])(node_modules|src|persona|knowledge)([\\/]|$)/.test(rel) || /\.(db|db-wal|db-shm|owner)$/i.test(rel) || /^(entrada|canal|dms|controle-ia)\.json/.test(path.basename(rel)) || /historico\.txt$/i.test(rel);
    let arquivos = 0;
    const varre = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, d.name);
        const rel = path.relative(T, abs);
        if (d.isDirectory()) { if (!pular(`${rel}/`)) varre(abs); continue; }
        if (pular(rel) || fs.statSync(abs).size > 20 * 1024 * 1024) continue;
        arquivos += 1;
        onde.push([`arquivo ${rel}`, fs.readFileSync(abs, 'utf8')]);
      }
    };
    varre(T);
    assert.ok(arquivos >= 3, `deveria haver logs e arquivos de estado para conferir (${arquivos})`);
    assert.ok(readdirLogs().length >= 2, 'os logs dos dois processos existem (app e erro)');
    // (c) a saúde pelo IPC dos dois processos e o /v1/health e o diagnóstico do cérebro
    const c = await saudeIpc(cerebro);
    const b = await saudeIpc(bot);
    onde.push(['saúde (IPC) do cérebro', JSON.stringify(c)], ['saúde (IPC) do bot', JSON.stringify(b)]);
    const h = await api('/v1/health');
    assert.equal(h.status, 200);
    onde.push(['/v1/health', h.texto]);
    const d = await api('/v1/admin/diagnostico');
    assert.equal(d.status, 200);
    onde.push(['/v1/admin/diagnostico', d.texto]);
    for (const [nome, texto] of onde) {
      for (const marca of marcas) assert.ok(!String(texto).includes(marca), `VAZOU em ${nome}: "${marca}"\n${String(texto).split(/\r?\n/).filter((l) => l.includes(marca)).slice(0, 3).join('\n')}`);
    }
    // o comentário em si (a frase da IA) também não vai para o log: ele só é entregue
    for (const p of allProcs) assert.doesNotMatch(p.out, /IA-FALSA persona=/, `o texto do comentário apareceu no log de ${p.label}`);
    // o diagnóstico, que o app vai mostrar, tem os números e nenhuma sequência de id
    assert.doesNotMatch(d.texto, new RegExp(`${OWNER}|${MEMBER}|${GUILD}|${CHAN}`), 'nenhum id de pessoa, servidor ou canal');
    assert.equal(d.json.cerebro.comentarios.pedidos >= 3, true);
    assert.equal(d.json.estado, 'ok', JSON.stringify(d.json.motivos));
    // e o que o dono precisa ver está lá
    assert.equal(d.json.ia.backendAtivo, 'teste-ia-falsa');
    assert.equal(h.json.ok, true);
    assert.deepEqual(h.json.avisosDeConfiguracao, []);
    // o cérebro e o bot confirmam a saúde pelo IPC (só números)
    assert.equal(c.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.discordFalso, true);
  });

  await test('parada limpa: as travas (dos bancos e da cota por hora) e o segredo do canal saem', async () => {
    await desligar(bot);
    await desligar(cerebro);
    for (const name of ['memory-personal', 'memory-discord', 'memory-context', 'memory-context-personal', 'core']) assert.equal(readLock(name), null, `trava de ${name}`);
    assert.equal(fs.existsSync(`${path.join(T, 'cota', 'search-budget-hora.json')}.owner`), false, 'a trava da cota por hora saiu com o cérebro');
    assert.ok(!fs.existsSync(SECRET));
  });

  console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);

/** Os arquivos de log (app e erro) dos processos, na pasta de trabalho da cópia. */
function readdirLogs() {
  try { return fs.readdirSync(path.join(APP, 'logs')).filter((f) => /^(app|error)-.*\.log$/.test(f)); } catch { return []; }
}
