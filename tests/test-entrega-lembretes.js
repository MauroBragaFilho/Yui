// Entrega dos lembretes com ESTADOS e RECONCILIAÇÃO (etapa 4, depois da revisão da Liz; relatório §14).
// Execução: npm run test:entregalembretes
//
// A Liz não aceitou o "incerto conta como entregue". Aqui se prova, sem DM em dobro em nenhum caso:
//  1. a lógica (no próprio processo do teste): nonce estável (até 25 caracteres) com enforceNonce, marcador discreto,
//     reconciliação no bot (achou no histórico / não saiu / impossível dentro e fora da janela da nonce / parte que faltou),
//     estados no cérebro (pendente, enviando, enviado, incerto), recuperação pelo dono por conversa (reenviar ou descartar),
//     o incerto visível na lista e no relatório de saúde, e o processo único do jeito de sempre;
//  2. de ponta a ponta, com o CÉREBRO e o BOT de verdade (cópia do código em pasta temporária, IA falsa e Discord falso, que
//     só valem com NODE_ENV=test), derrubando o bot entre o envio e a confirmação, com as três saídas:
//     a reconciliação ACHA a mensagem (vira enviado); PROVA que não saiu (sai uma vez); é IMPOSSÍVEL (fica incerto e visível,
//     e a recuperação pelo dono funciona).
// Só são encerrados os processos que este teste abriu, pelo handle. Nada procura processo por PID.
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
// Segunda revisão da Liz (etapa 6, §12): cada processo que este teste abre carrega o BLOQUEIO de integração externa; cada cenário confere o registro.
let BLOQUEIO = null;
const test = async (name, fn) => { const t0 = Date.now(); await fn(); BLOQUEIO?.conferir(name); passed += 1; console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localDb = useIsolatedDatabaseDir('yui-entrega-local-');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-entrega-'));
const APP = path.join(T, 'app');
const DB = assertNotRealDatabaseDir(path.join(T, 'db'));
const SECRET = path.join(T, 'secrets', 'channel-secret.json');
const DMS = path.join(T, 'dms.jsonl');
const CTRL = path.join(T, 'controle-discord.json');
const JUNCTION = path.join(APP, 'node_modules');
const TEST_CWD = path.join(T, 'teste');
for (const d of [DB, TEST_CWD]) fs.mkdirSync(d, { recursive: true });
process.chdir(TEST_CWD);
// Só as exceções que ESTE teste precisa: o icacls e o whoami do segredo do canal no Windows.
BLOQUEIO = criarBloqueio(path.join(T, 'bloqueio'), { teste: 'test:entregalembretes', liberar: { ...EXCECOES_DO_CANAL } });

const OWNER = '111111111111111111';
const OTHER = '333333333333333333';
const TOKEN = `token-do-app-de-teste-${crypto.randomBytes(8).toString('hex')}`;
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_AUDIT_FILE = path.join(T, 'audit-local.jsonl');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// ── Cópia do código e processos (como no test-separacao.js) ──────────────────────────────────────────
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
    YUI_TESTE_IA_FALSA: 'true', DISCORD_TOKEN: 'token-falso-de-teste',
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
const tail = (t, n = 30) => String(t).split(/\r?\n/).slice(-n).join('\n');
async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await check()) return; await sleep(50); }
  if (await check()) return;
  throw new Error(`tempo esgotado esperando: ${typeof what === 'function' ? what() : what}`);
}
async function waitFor(proc, re, timeoutMs = 60_000) {
  await waitUntil(() => re.test(proc.out) || proc.exited, timeoutMs, () => `${proc.label}: ${re}\n${tail(proc.out)}`);
  if (!re.test(proc.out)) throw new Error(`${proc.label} saiu (código ${proc.code}) sem ${re}\n${tail(proc.out)}`);
}
async function waitExit(proc, timeoutMs) {
  const r = await Promise.race([proc.exit, sleep(timeoutMs).then(() => null)]);
  if (!r) { proc.child.kill(); throw new Error(`${proc.label}: não terminou\n${tail(proc.out)}`); }
  return r;
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const readDms = () => { try { return fs.readFileSync(DMS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const contaDm = (texto) => readDms().filter((d) => d.text.includes(texto)).length;
const controle = (c) => fs.writeFileSync(CTRL, JSON.stringify(c));
const lockAge = (name) => { try { return Date.now() - fs.statSync(path.join(DB, `${name}.db.owner`)).mtimeMs; } catch { return Infinity; } };
const idemDoBot = () => { try { return JSON.parse(fs.readFileSync(path.join(DB, 'idempotencia-bot.json'), 'utf8')).chaves; } catch { return {}; } };

const closers = [];
async function cleanup() {
  if (process.env.YUI_TESTE_MOSTRAR_SAIDA === '1') for (const p of allProcs) console.log(`\n===== ${p.label} (código ${p.code}) =====\n${p.out}`);
  for (const fn of closers.splice(0)) { try { await fn(); } catch { /* */ } }
  for (const proc of [...procs]) { try { proc.child.send({ tipo: 'desligar' }); } catch { /* */ } await Promise.race([proc.exit, sleep(8000)]); }
  for (const proc of [...procs]) { try { proc.child.kill(); } catch { /* */ } await Promise.race([proc.exit, sleep(3000)]); }
  try { process.chdir(ROOT); } catch { /* */ }
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  try { (await import('../src/database/db.js')).closeAllDatabases(); } catch { /* */ }
  await sleep(300);
  let junctionGone = !fs.existsSync(JUNCTION);
  try { fs.unlinkSync(JUNCTION); } catch { /* */ }
  try { fs.lstatSync(JUNCTION); } catch (err) { junctionGone = err?.code === 'ENOENT'; }
  if (junctionGone) { try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.warn(`[entrega] não apaguei ${T}: ${err.message}`); } }
  else console.warn(`[entrega] a junção ${JUNCTION} não saiu; a pasta ${T} ficou para apagar à mão.`);
  localDb.cleanup();
}
process.on('exit', () => { for (const p of procs) { try { p.child.kill(); } catch { /* */ } } if (!finished && process.exitCode === undefined) process.exitCode = 1; });

try {
  // ═════ 1. A lógica, no próprio processo ═════
  console.log('1. A lógica (no processo do teste)');
  const { registerBotActions, nonceDaChave, marcaDaChave } = await import('../src/discord/canalCerebro.js');
  const { createFakeDiscordClient } = await import('../src/discord/discordFalso.js');
  const { createPersistentIdemStore } = await import('../src/core/channel/idemPersistente.js');
  const { createReminderStore } = await import('../src/reminders/store.js');
  const { entregarLembretesDevidos, estadoDaEntrega, chaveDaOcorrencia, RECONCILIAR_INCERTO_MS } = await import('../src/cerebro/entregaLembretes.js');
  const { routeReminders, formatReminderList } = await import('../src/reminders/assistant.js');
  const { buildHealthReport } = await import('../src/core/healthReport.js');
  const { runDueReminders } = await import('../src/reminders/runner.js');

  const localDms = path.join(T, 'dms-local.jsonl');
  const localCtrl = path.join(T, 'ctrl-local.json');
  const fakeEnv = { YUI_TESTE_DISCORD_FALSO_ARQUIVO: localDms, YUI_TESTE_DISCORD_FALSO_CONTROLE: localCtrl };
  const discord = createFakeDiscordClient({ env: fakeEnv });
  const localCount = (t) => { try { return fs.readFileSync(localDms, 'utf8').split('\n').filter((l) => l.includes(t)).length; } catch { return 0; } };
  const idemFile = path.join(T, 'idem-local.json');
  /** Um "bot" no processo do teste; `novoProcesso` relê o arquivo de idempotência (é o que um reinício faz). */
  function botLocal() {
    const handlers = new Map();
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => discord, idemStore: createPersistentIdemStore({ file: idemFile }), logger: quiet });
    return (p, idem) => handlers.get('discord.dm.send')(p, { role: 'cerebro', idem });
  }
  const dm = (texto) => ({ userId: OWNER, motivo: 'lembrete', text: texto });

  await test('nonce estável (até 25 caracteres, uma por parte) com enforceNonce, e o Discord falso deduplica como o de verdade', async () => {
    const k = 'lembrete:7:2026-11-18T10:00:00.000Z';
    assert.ok(nonceDaChave(k).length <= 25);
    assert.equal(nonceDaChave(k), nonceDaChave(k), 'a mesma chave dá a mesma nonce');
    assert.notEqual(nonceDaChave(k, 0), nonceDaChave(k, 1), 'cada parte tem a sua');
    assert.match(marcaDaChave(k), /^[0-9a-f]{10}$/);
    const u = await discord.users.fetch(OWNER);
    const m1 = await u.send({ content: 'teste-nonce-1', nonce: 'n-igual', enforceNonce: true });
    const m2 = await u.send({ content: 'teste-nonce-1 (repetida)', nonce: 'n-igual', enforceNonce: true });
    assert.equal(m2.id, m1.id, 'a mesma nonce devolve a mensagem que já existe');
    assert.equal(localCount('teste-nonce-1'), 1);
    await assert.rejects(u.send({ content: 'x', enforceNonce: true }), /nonce is required/);
  });

  await test('bot: envio normal leva nonce, enforceNonce e o marcador; a mesma chave de novo é repetida, sem mandar', async () => {
    const send = botLocal();
    const r = await send(dm('aviso-normal-a'), 'lembrete:1:2026-11-18T10:00:00.000Z');
    assert.equal(r.sent, true);
    const linha = JSON.parse(fs.readFileSync(localDms, 'utf8').split('\n').filter(Boolean).at(-1));
    assert.equal(linha.nonce, nonceDaChave('lembrete:1:2026-11-18T10:00:00.000Z'));
    assert.match(linha.text, new RegExp(`\\n-# ref ${marcaDaChave('lembrete:1:2026-11-18T10:00:00.000Z')}$`), 'marcador discreto no fim');
    assert.equal((await send(dm('aviso-normal-a'), 'lembrete:1:2026-11-18T10:00:00.000Z')).repetido, true);
    assert.equal(localCount('aviso-normal-a'), 1);
  });

  /** Simula o bot que caiu entre mandar e confirmar: a chave fica "enviando" no arquivo; `saiu` = a DM chegou ao Discord. */
  async function quedaNoMeio(chave, texto, { saiu, partes = null }) {
    const idem = createPersistentIdemStore({ file: idemFile });
    idem.iniciar(`discord.dm.send:${chave}`, Date.now() - 1000);
    if (saiu) {
      const u = await discord.users.fetch(OWNER);
      const marca = marcaDaChave(chave);
      const corpo = partes ?? [texto];
      const enviar = partes ? partes.slice(0, saiu) : corpo;
      for (let i = 0; i < enviar.length; i += 1) await u.send({ content: `${enviar[i]}\n-# ref ${marca}${corpo.length > 1 ? ` · ${i + 1}/${corpo.length}` : ''}`, nonce: nonceDaChave(chave, i), enforceNonce: true });
    }
  }

  await test('bot reconcilia: ACHOU no histórico (nada é mandado) ou PROVOU que não saiu (manda uma vez)', async () => {
    controle({});
    fs.writeFileSync(localCtrl, '{}');
    await quedaNoMeio('lembrete:2:x', 'aviso-achou', { saiu: true });
    const r1 = await botLocal()(dm('aviso-achou'), 'lembrete:2:x');
    assert.deepEqual([r1.sent, r1.reconciliado, r1.reenviadas], [true, 'historico', 0]);
    assert.equal(localCount('aviso-achou'), 1);
    await quedaNoMeio('lembrete:3:x', 'aviso-nao-saiu', { saiu: false });
    const r2 = await botLocal()(dm('aviso-nao-saiu'), 'lembrete:3:x');
    assert.deepEqual([r2.sent, r2.reconciliado, r2.reenviadas], [true, 'nao-saiu', 1]);
    assert.equal(localCount('aviso-nao-saiu'), 1);
    // o cérebro pede a reconciliação mesmo sem a marca no bot (ex.: o cérebro caiu): a chave de antes é achada
    const r3 = await botLocal()({ ...dm('aviso-achou'), reconciliar: true, desde: new Date().toISOString() }, 'lembrete:2:x');
    assert.equal(r3.repetido, true, 'chave já feita: repetida');
  });

  await test('bot reconcilia: sem histórico DENTRO da janela usa a nonce (o Discord devolve a que existe); FORA da janela fica INCERTO', async () => {
    fs.writeFileSync(localCtrl, JSON.stringify({ semHistorico: true }));
    await quedaNoMeio('lembrete:4:x', 'aviso-nonce', { saiu: true });
    const r1 = await botLocal()(dm('aviso-nonce'), 'lembrete:4:x');
    assert.equal(r1.reconciliado, 'nonce');
    assert.equal(localCount('aviso-nonce'), 1, 'a nonce impediu a duplicata');
    process.env.YUI_DM_NONCE_JANELA_MS = '0';
    try {
      await quedaNoMeio('lembrete:5:x', 'aviso-incerto', { saiu: false });
      const r2 = await botLocal()(dm('aviso-incerto'), 'lembrete:5:x');
      assert.equal(r2.incerto, true, JSON.stringify(r2));
      assert.match(r2.motivo, /histórico da DM indisponível/);
      assert.equal(localCount('aviso-incerto'), 0, 'nada é mandado às cegas');
      const again = await botLocal()(dm('aviso-incerto'), 'lembrete:5:x');
      assert.equal(again.incerto, true, 'continua incerto, sem mandar');
    } finally { delete process.env.YUI_DM_NONCE_JANELA_MS; fs.writeFileSync(localCtrl, '{}'); }
  });

  await test('bot reconcilia: histórico lido que NÃO alcança o envio não prova nada (fora da janela fica INCERTO, sem mandar)', async () => {
    // Revisão da Liz: ausência de evidência não vira "não saiu". Outra pessoa, para não encher a DM do dono dos outros testes.
    const OUTRO = '777777777777777777';
    const chave = 'lembrete:9:x';
    createPersistentIdemStore({ file: idemFile }).iniciar(`discord.dm.send:${chave}`, Date.now() - 1000);
    const u = await discord.users.fetch(OUTRO);
    for (let i = 0; i < 100; i += 1) await u.send(`enchimento-${i}`); // 100 mensagens DEPOIS do envio: a leitura não chega lá
    process.env.YUI_DM_NONCE_JANELA_MS = '0';
    try {
      const r = await botLocal()({ userId: OUTRO, motivo: 'lembrete', text: 'aviso-alem-do-historico' }, chave);
      assert.equal(r.incerto, true, JSON.stringify(r));
      assert.match(r.motivo, /não alcança o horário do envio/);
      assert.equal(localCount('aviso-alem-do-historico'), 0, 'nada é mandado às cegas');
    } finally { delete process.env.YUI_DM_NONCE_JANELA_MS; }
    // Dentro da janela da nonce, o mesmo caso manda com a nonce (o Discord devolveria a que já existe): sai uma vez só.
    const chave2 = 'lembrete:10:x';
    createPersistentIdemStore({ file: idemFile }).iniciar(`discord.dm.send:${chave2}`, Date.now() - 1000);
    for (let i = 0; i < 100; i += 1) await u.send(`enchimento-b-${i}`);
    const r2 = await botLocal()({ userId: OUTRO, motivo: 'lembrete', text: 'aviso-alem-dentro-da-janela' }, chave2);
    assert.equal(r2.reconciliado, 'nonce', JSON.stringify(r2));
    assert.equal(localCount('aviso-alem-dentro-da-janela'), 1);
  });

  await test('bot reconcilia mensagem longa: só a parte que faltou é mandada; recusa do Discord = DM_NAO_SAIU', async () => {
    const longo = `INICIO-PARTE-1 ${'linha comprida de lembrete '.repeat(80)}\n${'segunda metade '.repeat(80)}fim-parte-2`;
    const { splitForDiscord } = await import('../src/core/alerts.js');
    const partes = splitForDiscord(longo);
    assert.equal(partes.length, 2);
    await quedaNoMeio('lembrete:6:x', longo, { saiu: 1, partes });
    const r = await botLocal()(dm(longo), 'lembrete:6:x');
    assert.deepEqual([r.reconciliado, r.reenviadas, r.parts], ['historico-parcial', 1, 2]);
    assert.equal(localCount('fim-parte-2'), 1, 'a parte 2 saiu uma vez');
    assert.equal(localCount('INICIO-PARTE-1'), 1, 'a parte 1 não foi repetida');
    // DM fechada: o Discord recusa a primeira parte -> nada saiu -> o cérebro pode voltar a "pendente"
    const fechado = { ...discord, users: { fetch: async () => ({ send: async () => { throw Object.assign(new Error('Cannot send messages to this user'), { status: 403, code: 50007 }); } }) } };
    const handlers = new Map();
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => fechado, idemStore: createPersistentIdemStore({ file: idemFile }), logger: quiet });
    await assert.rejects(handlers.get('discord.dm.send')(dm('aviso-dm-fechada'), { idem: 'lembrete:8:x' }), (e) => e.code === 'DM_NAO_SAIU');
    assert.equal(createPersistentIdemStore({ file: idemFile }).consultar('discord.dm.send:lembrete:8:x').estado, 'novo', 'a marca foi desfeita');
  });

  // ── Estados no cérebro ──
  let now = Date.parse('2026-11-18T12:00:00.000Z');
  const store = createReminderStore({ file: path.join(T, 'lembretes-local.json'), now: () => now });
  const audits = [];
  const auditFn = (e, ctx, d) => audits.push({ e, ...d });
  const pedidos = [];
  let resposta = async () => ({ sent: true, parts: 1 });
  const enviar = async (texto, r, opcoes) => { pedidos.push({ id: r.id, ...opcoes }); return resposta(r, opcoes); };
  const passada = () => entregarLembretesDevidos({ store, enviar, audit: auditFn, now, logger: quiet });

  await test('cérebro: pendente -> enviando (gravado ANTES de pedir) -> enviado; "nada saiu" volta a pendente e conta a tentativa', async () => {
    const r1 = store.add({ text: 'tomar agua', at: now - 1000 });
    resposta = async (r) => { assert.equal(estadoDaEntrega(store.get(r.id)), 'enviando', 'enviando já no disco antes do pedido'); return { sent: true }; };
    assert.equal((await passada()).enviados, 1);
    assert.equal(store.get(r1.id), null, 'enviado: saiu da lista');
    const r2 = store.add({ text: 'alongar', at: now - 1000 });
    resposta = async () => { throw Object.assign(new Error('DM fechada'), { code: 'DM_NAO_SAIU' }); };
    assert.equal((await passada()).adiados, 1);
    assert.equal(estadoDaEntrega(store.get(r2.id)), 'pendente');
    assert.equal(store.get(r2.id).tries, 1);
    store.remove(r2.id);
  });

  await test('cérebro: resposta perdida = continua "enviando" e a próxima passada RECONCILIA com a mesma chave e a mesma hora', async () => {
    const r = store.add({ text: 'beber cafe', at: now - 1000 });
    pedidos.length = 0;
    resposta = async () => { throw Object.assign(new Error('caiu'), { code: 'CONNECTION_LOST' }); };
    assert.equal((await passada()).aConfirmar, 1);
    const e = store.get(r.id).entrega;
    assert.equal(e.estado, 'enviando');
    resposta = async () => ({ sent: true, reconciliado: 'historico' });
    now += 5000;
    const out = await passada();
    assert.equal(out.reconciliados, 1);
    assert.deepEqual(pedidos.map((p) => [p.reconciliar, p.chave, p.desde]), [[false, e.chave, e.desde], [true, e.chave, e.desde]]);
    assert.equal(store.get(r.id), null);
    assert.ok(audits.some((a) => a.e === 'reminder.fire' && a.id === r.id && a.reconciliado === 'historico'));
  });

  let incerto;
  await test('cérebro: reconciliação impossível = INCERTO, visível (lista, saúde, auditoria) e nunca reenviado às cegas', async () => {
    incerto = store.add({ text: 'pagar a conta', at: now - 1000 });
    pedidos.length = 0;
    resposta = async (r, o) => (o.reconciliar ? { sent: null, incerto: true, motivo: 'histórico da DM indisponível (50001)' } : (() => { throw Object.assign(new Error('caiu'), { code: 'TIMEOUT' }); })());
    await passada(); // enviando (resposta perdida)
    await passada(); // reconcilia: impossível
    assert.equal(estadoDaEntrega(store.get(incerto.id)), 'incerto');
    assert.ok(audits.some((a) => a.e === 'reminder.incerto' && a.id === incerto.id));
    const antes = pedidos.length;
    await passada();
    await passada();
    assert.equal(pedidos.length, antes, 'nenhum pedido ao bot enquanto incerto (até a próxima reconciliação)');
    now += RECONCILIAR_INCERTO_MS + 1;
    await passada();
    assert.equal(pedidos.length, antes + 1, 'depois do intervalo, tenta RECONCILIAR de novo');
    assert.equal(pedidos.at(-1).reconciliar, true, 'nunca às cegas');
    assert.equal(estadoDaEntrega(store.get(incerto.id)), 'incerto');
    const lista = formatReminderList(store.list(), new Date(now));
    assert.match(lista, new RegExp(`#${incerto.id}\\*\\* .*entrega incerta.*reenvia o lembrete ${incerto.id}.*descarta o lembrete ${incerto.id}`));
    const saude = buildHealthReport({ now, uptimeSeconds: 99999, processMB: 100, reconnects: 0, errors: 0, byTag: {}, lembretesIncertos: [incerto.id] });
    assert.match(saude.body, new RegExp(`entrega incerta \\(#${incerto.id}\\)`));
    assert.equal(saude.level, 'warn');
  });

  await test('recuperação pelo dono, por conversa: "reenvia" manda uma vez com chave nova; "descarta" resolve sem mandar; só o dono, só o incerto', async () => {
    const isOwner = (id) => id === OWNER;
    const conversa = (text, userId = OWNER) => routeReminders({ text, userId }, { store, isOwner, now: new Date(now), audit: auditFn, env: {} });
    const outro = await conversa(`reenvia o lembrete ${incerto.id}`, OTHER);
    assert.equal(estadoDaEntrega(store.get(incerto.id)), 'incerto', `outra pessoa não decide (${outro.text})`);
    const r = await conversa(`reenvia o lembrete ${incerto.id}`);
    assert.match(r.text, /vou mandar o aviso do lembrete #\d+ de novo, uma vez/);
    assert.ok(audits.some((a) => a.e === 'reminder.reenvio_autorizado' && a.id === incerto.id));
    pedidos.length = 0;
    resposta = async () => ({ sent: true });
    await passada();
    assert.deepEqual(pedidos.map((p) => [p.reconciliar, p.chave]), [[false, `${chaveDaOcorrencia({ id: incerto.id, at: incerto.at })}:r1`]]);
    assert.equal(store.get(incerto.id), null, 'reenviado: saiu da lista');
    // descartar: um lembrete que repete, incerto -> vai para a próxima vez, sem mandar
    const rep = store.add({ text: 'remedio', at: now - 1000, repeat: { kind: 'daily', hour: 9, minute: 0 } });
    store.setEntrega(rep.id, { estado: 'incerto', desde: new Date(now).toISOString(), chave: 'k', proximaTentativa: new Date(now + 999999).toISOString() });
    assert.match((await conversa(`descarta o lembrete ${rep.id}`)).text, /Descartei o aviso incerto do lembrete #\d+; ele continua valendo para a próxima vez/);
    assert.equal(estadoDaEntrega(store.get(rep.id)), 'pendente');
    assert.ok(Date.parse(store.get(rep.id).at) > now);
    assert.ok(audits.some((a) => a.e === 'reminder.incerto_descartado' && a.id === rep.id));
    assert.match((await conversa(`descarta o lembrete ${rep.id}`)).text, /não está com a entrega incerta/);
  });

  await test('processo único: o caminho de sempre (runDueReminders) não muda', async () => {
    const s1 = createReminderStore({ file: path.join(T, 'lembretes-unico.json'), now: () => now });
    s1.add({ text: 'unico', at: now - 1000 });
    const enviados = [];
    const out = await runDueReminders({ store: s1, now, send: async (t) => { enviados.push(t); return true; } });
    assert.deepEqual([out.fired, out.failed, s1.count()], [1, 0, 0]);
    assert.ok(!JSON.stringify(s1.list()).includes('entrega'));
  });

  // ═════ 2. Ponta a ponta: cérebro e bot de verdade ═════
  console.log('2. Ponta a ponta (cérebro e bot de verdade, bot derrubado entre o envio e a confirmação)');
  const apiPort = await freePort();
  async function api(method, route, body) {
    const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }
  const lembrete = async (id) => (await api('GET', '/v1/admin/reminders')).json.reminders.find((x) => x.id === id) ?? null;
  const novo = async (text) => { const r = await api('POST', '/v1/admin/reminders', { text, at: new Date(Date.now() + 300).toISOString() }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.reminder; };
  const botEnv = (extra = {}) => childEnv({ YUI_CEREBRO_EXTERNO: 'true', YUI_TESTE_DISCORD_FALSO: 'true', YUI_TESTE_DISCORD_FALSO_ARQUIVO: DMS, YUI_TESTE_DISCORD_FALSO_CONTROLE: CTRL, ...extra });
  let botN = 0;
  async function subirBot(extra = {}) {
    await waitUntil(() => lockAge('core') > 1700, 10_000, 'a trava do bot anterior vencer');
    const b = startProc(`bot#${++botN}`, 'src/index.js', botEnv(extra));
    await waitFor(b, /Yui inicializada \(Discord falso/);
    await waitUntil(async () => (await api('GET', '/v1/health')).json?.cerebro?.bot === true, 15_000, 'o bot conectar');
    return b;
  }
  async function derrubar(b) { b.child.kill(); await waitExit(b, 10_000); } // pelo handle: o processo que este teste abriu

  let cerebro;
  let bot;
  await test('sobe o cérebro e o bot de verdade (Discord falso)', async () => {
    assert.ok(copyCode() > 100);
    controle({});
    cerebro = startProc('cerebro', 'src/cerebro.js', childEnv({ YUI_API_ENABLED: 'true', YUI_API_HOST: '127.0.0.1', YUI_API_PORT: String(apiPort), YUI_API_TOKENS: `${TOKEN}=${OWNER}`, YUI_CEREBRO_LEMBRETES_MS: '300', YUI_CEREBRO_DM_TIMEOUT_MS: '8000' }));
    await waitFor(cerebro, /YuiCerebro pronto/);
    bot = await subirBot();
  });

  await test('saída 1: o bot cai DEPOIS de a DM sair; a ocorrência fica "enviando" (visível); a reconciliação ACHA a mensagem: enviado, sem DM em dobro', async () => {
    controle({ atrasoDepoisMs: 2500 });
    const r = await novo('saida-1-achou');
    await waitUntil(() => contaDm('saida-1-achou') === 1, 10_000, 'a DM sair');
    await derrubar(bot);
    await waitUntil(async () => (await lembrete(r.id))?.entrega?.estado === 'enviando', 10_000, 'o "enviando" visível no painel');
    controle({});
    bot = await subirBot();
    await waitUntil(async () => (await lembrete(r.id)) === null, 15_000, 'o lembrete sair da lista');
    await sleep(800);
    assert.equal(contaDm('saida-1-achou'), 1);
    assert.match(bot.out, /DM reconciliada \(motivo lembrete, historico\): 0 parte\(s\)/);
  });

  await test('saída 2: o bot cai ANTES de a DM sair; a reconciliação lê o histórico, PROVA que não saiu e manda UMA vez', async () => {
    controle({ atrasoAntesMs: 4000 });
    const r = await novo('saida-2-nao-saiu');
    await waitUntil(() => Object.entries(idemDoBot()).some(([k, v]) => k.startsWith(`discord.dm.send:lembrete:${r.id}:`) && v.estado === 'enviando'), 10_000, 'o "enviando" no arquivo do bot');
    await derrubar(bot);
    assert.equal(contaDm('saida-2-nao-saiu'), 0);
    controle({});
    bot = await subirBot();
    await waitUntil(async () => (await lembrete(r.id)) === null, 15_000, 'o lembrete sair da lista');
    await sleep(800);
    assert.equal(contaDm('saida-2-nao-saiu'), 1, 'saiu uma vez');
    assert.match(bot.out, /DM reconciliada \(motivo lembrete, nao-saiu\): 1 parte\(s\)/);
  });

  await test('saída 3: reconciliação IMPOSSÍVEL (sem histórico, fora da janela da nonce): INCERTO visível, nada às cegas; o dono reenvia por conversa e sai UMA vez', async () => {
    controle({ atrasoAntesMs: 4000 });
    const r = await novo('saida-3-impossivel');
    await waitUntil(() => Object.entries(idemDoBot()).some(([k, v]) => k.startsWith(`discord.dm.send:lembrete:${r.id}:`) && v.estado === 'enviando'), 10_000, 'o "enviando" no arquivo do bot');
    await derrubar(bot);
    controle({ semHistorico: true });
    bot = await subirBot({ YUI_DM_NONCE_JANELA_MS: '0' });
    await waitUntil(async () => (await lembrete(r.id))?.entrega?.estado === 'incerto', 15_000, 'o lembrete ficar INCERTO');
    const h = (await api('GET', '/v1/health')).json;
    assert.deepEqual(h.cerebro.lembretes.incertos, [r.id], 'visível no /v1/health');
    await sleep(1500); // várias passadas
    assert.equal(contaDm('saida-3-impossivel'), 0, 'nada reenviado às cegas');
    assert.equal((await lembrete(r.id))?.entrega?.estado, 'incerto');
    const auditCerebro = fs.readFileSync(path.join(APP, 'logs', 'core-audit.jsonl'), 'utf8');
    assert.match(auditCerebro, new RegExp(`"reminder\\.incerto".*"id":${r.id}`));
    // Recuperação pelo dono, por conversa (o pedido chega ao cérebro pelo canal, como o bot faria com a mensagem do dono).
    bot.child.send({ tipo: 'desligar' });
    assert.equal((await waitExit(bot, 15_000)).code, 0);
    const { connectChannel } = await import('../src/core/channel/client.js');
    const conversa = connectChannel({ role: 'bot', secretFile: SECRET, logger: quiet, minBackoffMs: 50, maxBackoffMs: 300 });
    closers.push(() => conversa.close());
    const recebidas = [];
    conversa.handle('discord.status', async () => ({ online: true }));
    conversa.handle('discord.dm.send', async (p, meta) => { recebidas.push({ ...p, idem: meta.idem }); return { sent: true, parts: 1 }; });
    await conversa.ready(10_000);
    const lista = await conversa.request('reminders.route', { text: 'meus lembretes', userId: OWNER });
    assert.match(lista.text, new RegExp(`#${r.id}\\*\\* .*entrega incerta`), 'visível na lista do dono');
    const resp = await conversa.request('reminders.route', { text: `reenvia o lembrete ${r.id}`, userId: OWNER }, { idem: 'teste-reenvio-1' });
    assert.match(resp.text, /vou mandar o aviso do lembrete/);
    await waitUntil(() => recebidas.some((d) => /saida-3-impossivel/.test(d.text)), 10_000, 'o reenvio autorizado sair');
    await waitUntil(async () => (await lembrete(r.id)) === null, 10_000, 'o lembrete sair da lista');
    const reenvios = recebidas.filter((d) => /saida-3-impossivel/.test(d.text));
    assert.equal(reenvios.length, 1, 'uma vez');
    assert.match(reenvios[0].idem, new RegExp(`^lembrete:${r.id}:.*:r1$`), 'com chave nova (reenvio autorizado)');
    assert.equal(reenvios[0].reconciliar, undefined);
    assert.equal(contaDm('saida-3-impossivel') + reenvios.length, 1, 'no total, uma DM');
    assert.match(fs.readFileSync(path.join(APP, 'logs', 'core-audit.jsonl'), 'utf8'), /"reminder\.reenvio_autorizado"/);
  });

  // o registro das exceções: qual teste abriu cada uma e quantas vezes foi usada (segunda revisão da Liz, §12)
  console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${BLOQUEIO.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
  finished = true;
  console.log(`\n${passed} testes OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} finally {
  await cleanup();
}
process.exit(finished ? 0 : 1);
