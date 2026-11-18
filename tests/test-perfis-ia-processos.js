// Etapa 9: os PERFIS DE IA de PONTA A PONTA com processos de verdade. Execução: npm run test:perfisiaprocessos
//
// O cérebro (src/cerebro.js) e o bot (src/index.js com YUI_CEREBRO_EXTERNO=true) são processos de verdade, numa CÓPIA do código em pasta temporária, com o DISCORD FALSO
// e a STEAM FALSA no bot, o OMNIROUTE FALSO (um servidor em loopback aberto por ESTE teste: tests/helpers/omnirouteFalso.js) no lugar do OmniRoute, os perfis lidos de um ARQUIVO
// (YUI_IA_PERFIS_ARQUIVO) e o BLOQUEIO de integração externa nos dois processos (nenhuma rede fora do loopback, nenhum programa, nenhum worker; só o icacls e o whoami do segredo do
// canal e a porta do OmniRoute falso, que é deste teste). A IA falsa de sempre NÃO entra aqui: o cérebro conversa pelos perfis, de verdade, com o servidor falso.
// Nada do OmniRoute real é tocado: os combos, as chaves e os nomes aqui são inventados pelo teste.
//
// Cenários:
//  1. a subida: o motor nativo, a rota privada verificada pela SONDA (sem conteúdo privado, pelo combo e pela chave do perfil privado) e o diagnóstico (GET /v1/admin/diagnostico);
//  2. ISOLAMENTO: o Braga em DM e um membro no servidor ao MESMO TEMPO, em várias rodadas, cada um com o seu combo, a sua chave e a sua marca (nenhuma requisição mistura os dois);
//  3. os comentários do /steam_jogo (público pelo rápido, o do Braga em DM pelo privado);
//  4. o perfil GERAL que falha: cai no fluxo de hoje (a cadeia do cérebro), registrado; e a falha do perfil PRIVADO: falha fechada, sem nunca ir à rota geral;
//  5. a VIOLAÇÃO (cabeçalho nomeando um provedor fora da lista numa chamada real): a resposta não chega ao Braga, a rota fica BLOQUEADA, o dono recebe UMA DM, o diagnóstico mostra o
//     problema, e o membro continua conversando;
//  6. o REINÍCIO do cérebro: a configuração dos perfis é recuperada, a rota privada volta a exigir verificação (a nova sonda, com um segredo plantado no cabeçalho, não valida) e só uma
//     sonda boa a liga de novo;
//  7. SEGREDOS: o segredo plantado no cabeçalho, as chaves de API e a conversa privada não estão em nenhum log, na auditoria, nas DMs de alerta, na saúde nem no diagnóstico.
// Os testes de ponta a ponta esperam SINAIS reais (nunca um tempo fixo): a resposta chegar, a linha do log, o pedido chegar ao OmniRoute falso, a DM de alerta. Só são encerrados os
// processos que este teste abriu, pelo handle (nunca por PID achado em varredura).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { criarBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';
import { criarOmniRouteFalso, CHAVE_GERAL, CHAVE_PRIVADA, SEGREDO_PLANTADO } from './helpers/omnirouteFalso.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const started = Date.now();
let passed = 0;
let finished = false;
let BLOQUEIO = null;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); BLOQUEIO?.conferir(name); passed += 1; console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localDb = useIsolatedDatabaseDir('yui-perfisia-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-perfisia-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const INBOX = path.join(T, 'entrada.jsonl');
const CANAL = path.join(T, 'canal.jsonl');
const DMS = path.join(T, 'dms.jsonl');
const ORCAMENTO = path.join(T, 'cota', 'search-budget.json');
const PERFIS_ARQ = path.join(T, 'perfis-ia.json');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
// Só as exceções que ESTE teste precisa: o icacls e o whoami do segredo do canal no Windows. A porta do OmniRoute falso entra como "porta do teste".
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:perfisiaprocessos', liberar: { ...EXCECOES_DO_CANAL } });
for (const d of [DB, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const BOT_ID = '900000000000000001';
const TOKEN = `token-do-app-de-teste-${Math.random().toString(16).slice(2)}0123456789`;
// Marcas: o que o Braga fala em privado (nunca pode aparecer em log, auditoria, DM de alerta, saúde nem diagnóstico) e o que o membro fala no servidor.
const PRIV = 'tok-BRAGAPRIV9c41';
const MARCA_MEMBRO = 'tok-MEMBRO9c41';

const omni = await criarOmniRouteFalso();
BLOQUEIO.portaDoTeste(omni.port);
const EXEMPLO = {
  conversa: { modelo: 'auto', maxTokens: 1024, privacidade: 'geral', provedor: 'omniroute' },
  rapido: { modelo: 'auto/fast', maxTokens: 256, privacidade: 'geral', provedor: 'omniroute' },
  pesquisa: { modelo: 'auto/smart', maxTokens: 2048, privacidade: 'geral', provedor: 'omniroute' },
  raciocinio: { modelo: 'auto/reason', maxTokens: 4096, privacidade: 'geral', provedor: 'omniroute' },
  privado: { modelo: 'combo-privado', maxTokens: 1024, privacidade: 'privada', provedor: 'omniroute-privado', chaveVinculada: true, provedoresPermitidos: ['groq', 'gemini-pago'], decisao: { formato: 'pares', campoProvedor: 'provider' } },
  visao: { modelo: 'combo-visao', maxTokens: 1024, privacidade: 'geral', provedor: 'omniroute' },
};
fs.writeFileSync(PERFIS_ARQ, JSON.stringify(EXEMPLO, null, 2));
const GATEWAY_CUSTOM = JSON.stringify([
  { id: 'omniroute', label: 'OmniRoute (falso)', baseUrl: omni.url, apiKeyEnv: 'OMNI_CHAVE_GERAL', models: ['auto'], anonymous: true },
  { id: 'omniroute-privado', label: 'OmniRoute privado (falso)', baseUrl: omni.url, apiKeyEnv: 'OMNI_CHAVE_PRIVADA', models: ['combo-privado'], anonymous: false },
]);

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
    GTA_WEEKLY_ENABLED: 'false', NEWSWIRE_ENABLED: 'false', YOUTUBE_INTERVAL_MINUTES: '0', TWITCH_INTERVAL_MINUTES: '0', YUI_GATEWAY_ENABLED: 'false', DISCORD_TOKEN: 'token-falso-de-teste',
    YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', REQUIRE_TOS: 'false', YUI_QUEUE_MAX_PER_USER: '20',
    YUI_POLICY_MODE: 'observe', YUI_IMAGE_PRE_ROUTE: 'false', YUI_RESEARCH_ENABLED: 'false', YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '',
    YUI_SEARCH_BUDGET_FILE: ORCAMENTO, YUI_COMENTARIO_PRAZO_MS: '20000',
    YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(apiPort), YUI_API_TOKENS: `${TOKEN}=${OWNER}`,
    // o OmniRoute FALSO (os provedores da Yui apontam para ele), os perfis por ARQUIVO e a sonda só na subida (nada de sondas sozinhas durante o teste)
    YUI_GATEWAY_CUSTOM: GATEWAY_CUSTOM, OMNI_CHAVE_GERAL: CHAVE_GERAL, OMNI_CHAVE_PRIVADA: CHAVE_PRIVADA, YUI_IA_PERFIS_ARQUIVO: PERFIS_ARQ,
    YUI_IA_SONDA_INTERVALO_S: '0', YUI_IA_PERFIL_TIMEOUT_MS: '15000',
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
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

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
const readAuditoria = () => { try { return fs.readFileSync(path.join(APP, 'logs', 'core-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readDms = () => { try { return fs.readFileSync(DMS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const edicoesDe = (id) => readCanal().filter((e) => e.paraInteracao === id && e.tipo === 'interacao-edicao');
const finalsFor = (id) => readCanal().filter((e) => e.paraMensagem === id && ['reply', 'edit', 'send'].includes(e.tipo) && e.content && !/Processando|Sua solicitação está na fila/.test(e.content)).map((e) => e.content);
async function reply(id, timeoutMs = 60_000) {
  await waitUntil(() => finalsFor(id).length > 0, timeoutMs, () => `a resposta à mensagem ${id}\n--- bot ---\n${tail(bot?.out ?? '')}\n--- cérebro ---\n${tail(cerebro?.out ?? '')}`);
  return finalsFor(id).at(-1);
}
async function entrega(id, timeoutMs = 60_000) {
  await waitUntil(() => edicoesDe(id).length > 0, timeoutMs, () => `a entrega do comando ${id}\n--- bot ---\n${tail(bot?.out ?? '')}\n--- cérebro ---\n${tail(cerebro?.out ?? '')}`);
  return edicoesDe(id).at(-1);
}
/** As requisições (não sondas) do OmniRoute falso que levam uma marca. */
const comMarca = (marca) => omni.requisicoes.filter((r) => !r.sonda && r.marcas.includes(marca));

// ── HTTP na API do cérebro (o diagnóstico) ─────────────────────────────────────────────────────────────
async function api(route) {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  let json = null;
  let texto = '';
  try { texto = await res.text(); json = JSON.parse(texto); } catch { json = null; }
  return { status: res.status, json, texto };
}
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
  try { await omni.close(); } catch { /* */ }
  try { process.chdir(ROOT); } catch { /* */ }
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  await sleep(300);
  let junctionGone = !fs.existsSync(JUNCTION);
  try { fs.unlinkSync(JUNCTION); } catch { /* */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) { try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[perfisia] não apaguei ${T}: ${err.message}`); } }
  else console.warn(`[perfisia] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  localDb.cleanup();
}
process.on('exit', () => { for (const p of procs) { try { p.child.kill(); } catch { /* */ } } if (!finished && process.exitCode === undefined) process.exitCode = 1; });

let cerebro = null;
let bot = null;
let cerebroN = 0;
let botN = 0;
// O cérebro sobe com os alertas LIGADOS (a DM do dono sai pelo bot, para o Discord falso): o teste lê as DMs de alerta no arquivo do Discord falso.
async function subirCerebro(extra = {}) {
  await waitUntil(() => lockAge('memory-personal') > 1700, 15_000, 'a trava do cérebro anterior vencer');
  const c = startProc(`cerebro#${++cerebroN}`, 'src/cerebro.js', childEnv({ YUI_ALERTS: 'true', ...extra }));
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

const BRAGA = { user: OWNER, guild: null, channel: DMCH };
const MEMBRO = { user: MEMBER, guild: GUILD, channel: CHAN };
const FECHADA = /rota privada da IA não está liberada/;

try {
  apiPort = await freePort();

  await test('1. a subida: o motor nativo, a rota privada VERIFICADA pela sonda (sem conteúdo privado, pelo combo e pela chave do perfil privado) e o diagnóstico', async () => {
    assert.ok(copyCode() > 100);
    fs.writeFileSync(INBOX, '');
    omni.definir('combo-privado', { decisao: 'permitido', provedorPermitido: 'gemini-pago' });
    cerebro = await subirCerebro();
    bot = await subirBot();
    await botConectado(cerebro);
    await waitFor(cerebro, /Rota privada da IA: validada/);
    const sondas = omni.requisicoes.filter((r) => r.sonda);
    assert.equal(sondas.length, 1, 'uma sonda só, na subida');
    assert.deepEqual([sondas[0].modelo, sondas[0].papel, sondas[0].mensagens, sondas[0].marcas], ['combo-privado', 'privada', 1, []], 'a sonda leva só a frase fixa, pelo combo e pela chave do privado');
    const d = await api('/v1/admin/diagnostico');
    assert.equal(d.status, 200, d.texto);
    const p = d.json.perfisDeIa;
    assert.equal(p.configurado, true);
    assert.equal(p.origem, 'arquivo');
    assert.deepEqual(p.perfis.map((x) => x.nome).sort(), ['conversa', 'pesquisa', 'privado', 'rapido', 'raciocinio', 'visao'].sort(), 'a configuração do arquivo foi recuperada');
    assert.equal(p.rotaPrivada.estado, 'validada');
    assert.equal(p.rotaPrivada.sondasValidas, 1);
    assert.equal(p.rotaPrivada.formatoDefinido, true);
    assert.equal(d.json.motorAgente.ativo, 'nativo');
    assert.equal(d.json.motorAgente.recusado, false);
    assert.equal(d.json.estado, 'ok', JSON.stringify(d.json.motivos));
    assert.doesNotMatch(bot.out, /\[IA\] /, 'o bot não chamou a cadeia de IA dele');
  });

  await test('2. ISOLAMENTO: o Braga em DM e um membro no servidor AO MESMO TEMPO (3 rodadas): cada um com o seu combo, a sua chave e a sua marca; nenhuma requisição mistura os dois', async () => {
    omni.definir('auto', { atrasoMs: 200 });
    omni.definir('combo-privado', { decisao: 'permitido', atrasoMs: 200 });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push([send({ ...BRAGA, text: `${PRIV}r${i} guarda esse segredo meu` }), send({ ...MEMBRO, text: `${MARCA_MEMBRO}r${i} qual o melhor carro?` })]);
    }
    for (let i = 0; i < 3; i += 1) {
      const [rb, rm] = [await reply(ids[i][0]), await reply(ids[i][1])];
      assert.match(rb, /^OMNI-FALSO modelo=combo-privado chave=privada /, `Braga, rodada ${i}: ${rb}`);
      assert.match(rm, /^OMNI-FALSO modelo=auto chave=geral /, `membro, rodada ${i}: ${rm}`);
      assert.ok(rb.includes(`${PRIV}r${i}`) && !rb.includes(MARCA_MEMBRO), 'a resposta do Braga só tem a marca dele');
      assert.ok(rm.includes(`${MARCA_MEMBRO}r${i}`) && !rm.includes(PRIV), 'a resposta do membro só tem a marca dele');
    }
    const reais = omni.requisicoes.filter((r) => !r.sonda);
    assert.equal(reais.length, 6, 'seis pedidos, seis chamadas (nenhuma duplicada)');
    for (const r of reais) {
      const doBraga = r.marcas.some((m) => m.startsWith('tok-BRAGAPRIV'));
      const doMembro = r.marcas.some((m) => m.startsWith('tok-MEMBRO'));
      assert.notEqual(doBraga, doMembro, `uma requisição nunca mistura as duas pessoas: ${JSON.stringify(r.marcas)}`);
      if (doBraga) assert.deepEqual([r.modelo, r.papel], ['combo-privado', 'privada']);
      if (doMembro) assert.deepEqual([r.modelo, r.papel], ['auto', 'geral'], 'o membro nunca usa a chave nem o combo do privado');
      assert.ok(r.maxTokens <= 1024);
    }
    const d = await api('/v1/admin/diagnostico');
    const por = Object.fromEntries(d.json.perfisDeIa.perfis.map((x) => [x.nome, x]));
    assert.equal(por.privado.ok, 3);
    assert.equal(por.conversa.ok, 3);
    assert.equal(d.json.perfisDeIa.totais.fallbacks, 0);
    assert.equal(d.json.perfisDeIa.rotaPrivada.estado, 'validada');
    omni.definir('auto', {});
  });

  await test('3. o comentário do /steam_jogo: o público vai pelo perfil RÁPIDO (combo e chave gerais); o do Braga em DM, pelo PRIVADO', async () => {
    omni.definir('combo-privado', { decisao: 'permitido' });
    const pub = await entrega(steam({ ...MEMBRO, nome: 'Hollow Knight tok-STEAMPUB' }));
    assert.match(String(pub.content), /^OMNI-FALSO modelo=auto\/fast chave=geral max=256 /, String(pub.content));
    assert.equal(pub.embeds?.[0]?.title, 'Jogo Hollow Knight tok-STEAMPUB');
    const priv = await entrega(steam({ ...BRAGA, nome: `Segredo ${PRIV}steam` }));
    assert.match(String(priv.content), /^OMNI-FALSO modelo=combo-privado chave=privada /, String(priv.content));
    assert.ok(!comMarca(`${PRIV}steam`).some((r) => r.papel === 'geral'), 'o nome que o Braga digitou na DM nunca foi à chave geral');
  });

  await test('4. o perfil GERAL que falha cai no fluxo de hoje (registrado); a falha do PRIVADO é FECHADA, sem nunca ir à rota geral nem ao fluxo de hoje', async () => {
    omni.definir('auto', { falhasAntes: 1 });
    const m = send({ ...MEMBRO, text: `${MARCA_MEMBRO}fb pergunta com falha na rota` });
    const r = await reply(m);
    assert.match(r, /^OMNI-FALSO modelo=auto chave=geral /, `o fluxo de hoje atendeu: ${r}`);
    assert.equal(comMarca(`${MARCA_MEMBRO}fb`).length, 2, 'a rota do perfil (que falhou) e o fluxo de hoje: duas chamadas ao combo auto');
    await waitUntil(() => /perfil conversa \(combo auto\): a rota falhou \(servidor\); seguindo pelo fluxo de hoje/.test(cerebro.out), 10_000, 'o fallback no log do cérebro');
    const d = await api('/v1/admin/diagnostico');
    const conv = d.json.perfisDeIa.perfis.find((x) => x.nome === 'conversa');
    assert.equal(conv.fallbacks, 1);
    assert.ok(d.json.perfisDeIa.ultimas.some((u) => u.perfil === 'conversa' && u.fallbackUsado === true && u.resultado === 'fallback' && u.motivo === 'servidor'));
    omni.definir('auto', {});
    // a falha do privado: 500 no combo privado
    omni.definir('combo-privado', { status: 500 });
    const antes = omni.requisicoes.length;
    const mb = send({ ...BRAGA, text: `${PRIV}f1 mais um segredo` });
    const rb = await reply(mb);
    assert.match(rb, FECHADA, `o Braga recebe a mensagem curta e clara: ${rb}`);
    assert.doesNotMatch(rb, /Limites de Processamento/, 'não é o aviso de "IA fora"');
    assert.deepEqual(comMarca(`${PRIV}f1`).map((x) => [x.modelo, x.papel]), [['combo-privado', 'privada']], 'uma chamada só, ao combo privado: nunca à rota geral');
    assert.equal(omni.requisicoes.length, antes + 1, 'e mais nenhuma chamada a lugar nenhum (o fluxo de hoje não foi usado)');
    omni.definir('combo-privado', { decisao: 'permitido' });
    // o dono NÃO recebeu o aviso de "IA fora" por causa disso
    assert.ok(!readDms().some((x) => /A IA do cérebro não respondeu/.test(x.text)), 'a falha fechada não vira o alerta de IA fora');
  });

  await test('5. a VIOLAÇÃO numa chamada real (provedor fora da lista): a resposta NÃO chega ao Braga, a rota fica BLOQUEADA, o dono recebe UMA DM, o diagnóstico mostra o problema e o membro continua', async () => {
    omni.definir('combo-privado', { decisao: 'fora', provedorFora: 'anonimo-x' });
    const mb = send({ ...BRAGA, text: `${PRIV}v1 outro segredo` });
    const rb = await reply(mb);
    assert.match(rb, FECHADA, rb);
    assert.ok(!rb.includes('OMNI-FALSO'), 'a resposta que veio do OmniRoute foi DESCARTADA');
    assert.equal(comMarca(`${PRIV}v1`).length, 1, 'a chamada saiu (não há como desfazer), mas só ela');
    await waitUntil(() => readDms().some((x) => /rota privada da IA foi bloqueada/.test(x.text)), 15_000, 'a DM de alerta ao dono');
    const alertas = readDms().filter((x) => /rota privada da IA foi bloqueada/.test(x.text));
    assert.equal(alertas.length, 1, 'uma DM só');
    assert.equal(alertas[0].userId, OWNER);
    assert.match(alertas[0].text, /provedor citado: anonimo-x/);
    await waitUntil(async () => (await api('/v1/admin/diagnostico')).json?.perfisDeIa?.rotaPrivada?.estado === 'bloqueada', 10_000, 'o diagnóstico mostrar a rota bloqueada');
    const d = await api('/v1/admin/diagnostico');
    assert.equal(d.json.perfisDeIa.rotaPrivada.motivo, 'provedor-fora-da-lista');
    assert.equal(d.json.perfisDeIa.rotaPrivada.violacoes, 1);
    assert.equal(d.json.estado, 'problema');
    assert.ok(d.json.motivos.some((m) => m.codigo === 'rota-privada-bloqueada'));
    // a auditoria (o hash encadeado do cérebro) registrou o bloqueio: só o motivo e o provedor citado, nunca o cabeçalho
    const aud = readAuditoria().filter((e) => e.event === 'ia.rota_privada_bloqueada');
    assert.equal(aud.length, 1);
    assert.deepEqual([aud[0].perfil, aud[0].motivo, aud[0].provedorCitado], ['privado', 'provedor-fora-da-lista', 'anonimo-x']);
    assert.ok(typeof aud[0].hash === 'string' && aud[0].hash.length === 64, 'a linha é da auditoria encadeada');
    // o membro continua conversando (o bloqueio é só da rota privada)
    const mm = send({ ...MEMBRO, text: `${MARCA_MEMBRO}v2 e agora?` });
    assert.match(await reply(mm), /^OMNI-FALSO modelo=auto chave=geral /);
    // o Braga de novo: nem sai (nenhuma chamada nova), e o aviso ao dono não se repete
    const antes = omni.requisicoes.length;
    const mb2 = send({ ...BRAGA, text: `${PRIV}v3 de novo` });
    const rb2 = await reply(mb2);
    assert.match(rb2, FECHADA);
    assert.equal(comMarca(`${PRIV}v3`).length, 0, 'com a rota bloqueada a conversa privada nem sai');
    assert.equal(omni.requisicoes.length, antes, 'nenhuma chamada nova ao OmniRoute');
    assert.equal(readDms().filter((x) => /rota privada da IA foi bloqueada/.test(x.text)).length, 1, 'o aviso não se repete');
  });

  await test('6. o REINÍCIO do cérebro: a configuração dos perfis é recuperada; o bloqueio NÃO sobrevive, mas a nova sonda (com um SEGREDO plantado no cabeçalho) não valida e a conversa privada continua fechada; só uma sonda boa liga a rota', async () => {
    await desligar(cerebro);
    omni.definir('combo-privado', { decisao: 'segredo' });
    const sondasAntes = omni.requisicoes.filter((r) => r.sonda).length;
    cerebro = await subirCerebro();
    await waitFor(cerebro, /Rota privada da IA: nao-validada \(formato-desconhecido\)/);
    await botConectado(cerebro);
    assert.equal(omni.requisicoes.filter((r) => r.sonda).length, sondasAntes + 1, 'o cérebro novo fez a SUA sonda');
    const d = await api('/v1/admin/diagnostico');
    assert.deepEqual(d.json.perfisDeIa.perfis.map((x) => x.nome).sort(), ['conversa', 'pesquisa', 'privado', 'rapido', 'raciocinio', 'visao'].sort(), 'a configuração do arquivo recuperada');
    assert.equal(d.json.perfisDeIa.rotaPrivada.estado, 'nao-validada');
    assert.equal(d.json.perfisDeIa.rotaPrivada.motivo, 'formato-desconhecido');
    assert.equal(d.json.perfisDeIa.rotaPrivada.violacoes, 0, 'o contador do processo anterior não vem junto');
    assert.equal(d.json.estado, 'atencao');
    const antes = omni.requisicoes.length;
    const rb = await reply(send({ ...BRAGA, text: `${PRIV}x1 depois do reinício` }));
    assert.match(rb, FECHADA);
    assert.equal(omni.requisicoes.length, antes, 'a conversa privada não saiu com a sonda não validada');
    // o membro conversa normalmente depois do reinício
    assert.match(await reply(send({ ...MEMBRO, text: `${MARCA_MEMBRO}x2 oi de novo` })), /^OMNI-FALSO modelo=auto chave=geral /);
    // a rota corrigida + um novo reinício (a verificação nova) liga de novo
    await desligar(cerebro);
    omni.definir('combo-privado', { decisao: 'permitido' });
    cerebro = await subirCerebro();
    await waitFor(cerebro, /Rota privada da IA: validada/);
    await botConectado(cerebro);
    const rb2 = await reply(send({ ...BRAGA, text: `${PRIV}x3 agora sim` }));
    assert.match(rb2, /^OMNI-FALSO modelo=combo-privado chave=privada /, rb2);
  });

  await test('6b. Motor 1 DESATIVADO: YUI_MOTOR_AGENTE=mastra (não implementado) é RECUSADO e registrado (log, auditoria e diagnóstico), e o Motor 0 (nativo) funciona normalmente', async () => {
    await desligar(cerebro);
    cerebro = await subirCerebro({ YUI_MOTOR_AGENTE: 'mastra' });
    await waitFor(cerebro, /\[Motor\] YUI_MOTOR_AGENTE="mastra" foi recusado \(motor-nao-implementado\): o cérebro segue no motor nativo/);
    await waitFor(cerebro, /Rota privada da IA: validada/);
    await botConectado(cerebro);
    const d = await api('/v1/admin/diagnostico');
    assert.deepEqual([d.json.motorAgente.pedido, d.json.motorAgente.ativo, d.json.motorAgente.recusado, d.json.motorAgente.motivo], ['mastra', 'nativo', true, 'motor-nao-implementado']);
    assert.deepEqual(d.json.motorAgente.implementados, { nativo: true, mastra: false });
    assert.equal(d.json.estado, 'atencao');
    assert.ok(d.json.motivos.some((m) => m.codigo === 'motor-recusado'), JSON.stringify(d.json.motivos));
    const aud = readAuditoria().filter((e) => e.event === 'ia.motor_recusado');
    assert.equal(aud.length, 1);
    assert.deepEqual([aud[0].pedido, aud[0].motivo, aud[0].ativo], ['mastra', 'motor-nao-implementado', 'nativo']);
    // o Motor 0 segue normal: a conversa do membro (perfil geral) e a do Braga (perfil privado, com a rota verificada)
    assert.match(await reply(send({ ...MEMBRO, text: `${MARCA_MEMBRO}m1 oi com o motor recusado` })), /^OMNI-FALSO modelo=auto chave=geral /);
    assert.match(await reply(send({ ...BRAGA, text: `${PRIV}m2 oi com o motor recusado` })), /^OMNI-FALSO modelo=combo-privado chave=privada /);
  });

  await test('7. SEGREDOS e CONTEÚDO PRIVADO: o segredo plantado no cabeçalho, as chaves de API e a conversa privada do Braga não estão em nenhum log, na auditoria, nas DMs de alerta, na saúde nem no diagnóstico', async () => {
    const segredos = [SEGREDO_PLANTADO, 'SEGREDO-PLANTADO', CHAVE_GERAL, CHAVE_PRIVADA, TOKEN];
    const privado = [PRIV];
    const onde = [];
    for (const p of allProcs) onde.push([`saída de ${p.label}`, p.out]);
    const pular = (rel) => /(^|[\\/])(node_modules|src|persona|knowledge)([\\/]|$)/.test(rel) || /\.(db|db-wal|db-shm|owner)$/i.test(rel) || /^(entrada|canal|dms|perfis-ia)\.json/.test(path.basename(rel)) || /historico\.txt$/i.test(rel);
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
    // a auditoria do cérebro (o hash encadeado) e as DMs de alerta
    onde.push(['as DMs de alerta (Discord falso)', readDms().map((x) => x.text).join('\n')]);
    const c = await saudeIpc(cerebro);
    const b = await saudeIpc(bot);
    onde.push(['saúde (IPC) do cérebro', JSON.stringify(c)], ['saúde (IPC) do bot', JSON.stringify(b)]);
    const h = await api('/v1/health');
    onde.push(['/v1/health', h.texto]);
    const d = await api('/v1/admin/diagnostico');
    onde.push(['/v1/admin/diagnostico', d.texto]);
    for (const [nome, texto] of onde) {
      for (const marca of [...segredos, ...privado]) assert.ok(!String(texto).includes(marca), `VAZOU em ${nome}: "${marca}"\n${String(texto).split(/\r?\n/).filter((l) => l.includes(marca)).slice(0, 3).join('\n')}`);
    }
    assert.doesNotMatch(d.texto, new RegExp(`${OWNER}|${MEMBER}|${GUILD}|${CHAN}`), 'nenhum id de pessoa, servidor ou canal');
    // a conversa privada do Braga nunca foi enviada com a chave geral, nem o contrário
    for (const r of omni.requisicoes.filter((x) => !x.sonda)) {
      if (r.marcas.some((m) => m.startsWith('tok-BRAGAPRIV'))) assert.equal(r.papel, 'privada', `a conversa privada saiu pela chave ${r.papel}: ${JSON.stringify(r.marcas)}`);
      if (r.marcas.some((m) => m.startsWith('tok-MEMBRO'))) assert.equal(r.papel, 'geral', 'a conversa do membro usou a chave privada');
    }
    assert.ok(omni.requisicoes.every((r) => r.maxTokens === null || r.maxTokens <= 4096), 'nenhuma chamada passou de 4096 tokens');
    assert.equal(h.json.ok, true);
    assert.equal(b.ok, true);
  });

  await test('parada limpa: as travas dos bancos e o segredo do canal saem', async () => {
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
