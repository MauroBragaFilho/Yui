// memory.admin_wipe_user UNIFICADO (etapa 4, decisão da Liz de 18/11/2026): o MESMO fluxo do /yui-criador memorias roda nos
// dois modos e tem de dar o MESMO resultado em cada passo:
//  - processo único: o handler chama a fachada da memória, que aplica a regra (core/memory/adminWipe.js) antes do store;
//  - cérebro separado: a fachada pede pelo canal de verdade (WebSocket local, neste processo) e o cérebro aplica a regra.
// Regras: só o dono; confirmação explícita do alvo (botão que carrega o id do alvo, só para quem pediu, com prazo); política
// (observe só registra; enforce nega canal público e somente leitura); auditoria.
// Execução: npm run test:memoriaadmin
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { rodarSobBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';

// Segunda revisão da Liz (etapa 6, §12): o canal de verdade roda NESTE processo; o teste se relança com o BLOQUEIO de integração externa
// carregado (só as exceções do canal: o icacls e o whoami do segredo) e confere o registro no fim.
rodarSobBloqueio(import.meta.url, { teste: 'test:memoriaadmin', liberar: { ...EXCECOES_DO_CANAL } });

const isolated = useIsolatedDatabaseDir('yui-memoria-admin-');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-memoria-admin-cwd-'));
process.chdir(work); // o log dos módulos vai para esta pasta
const OWNER = '111111111111111111';
const ALVO = '333333333333333333';
const OUTRO = '444444444444444444';
const GUILD = '222222222222222222';
const CANAL = '555555555555555555';
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_AUDIT_FILE = path.join(work, 'audit.jsonl');
delete process.env.YUI_POLICY_MODE;

const { config } = await import('../src/config/index.js');
assertNotRealDatabaseDir(path.resolve(config.database.dir));
const store = await import('../src/core/memory/store.js');
const facade = await import('../src/core/memory/facade.js');
const { buildContext } = await import('../src/core/permissions.js');
const { handleMemoriasAdmin, handleMemoriasAdminButton, parseConfirmId, __definirRelogioParaTeste, __esquecerConfirmacoesParaTeste } = await import('../src/handlers/memoryAdminHandler.js');
const { startChannelServer } = await import('../src/core/channel/server.js');
const { connectChannel } = await import('../src/core/channel/client.js');
const { registerCerebroMethods } = await import('../src/cerebro/metodos.js');
const { verifyAudit } = await import('../src/core/audit.js');
await store.initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// ── Interação falsa do Discord (só o que o handler usa) ──
// O cliente do Discord do bot: diz o nome da conta do alvo (usuário e nome global). `semNome` simula o Discord sem resposta.
const clienteDiscord = (semNome = false) => ({
  users: { cache: new Map(), fetch: async (id) => { if (semNome) throw new Error('Unknown User'); return { id, username: 'ana_teste', globalName: 'Ana Souza' }; } },
});
function interaction({ user = OWNER, guildId = null, channelId = null, customId = null, opts = {}, semNome = false } = {}) {
  const log = [];
  return {
    user: { id: user }, guildId, channelId, customId, log, client: clienteDiscord(semNome),
    options: { getString: (k) => opts[k] ?? null, getInteger: (k) => opts[k] ?? null },
    reply: async (p) => { log.push({ tipo: 'reply', ...p }); },
    update: async (p) => { log.push({ tipo: 'update', ...p }); },
  };
}
const memberCtx = buildContext({ platform: 'discord', userId: ALVO, guildId: GUILD, channelId: CANAL });
const contar = () => store.adminListMetadata(buildContext({ platform: 'discord', userId: OWNER, isDM: true }), ALVO).length;
function semear(n = 2) {
  store.adminForgetUser(buildContext({ platform: 'discord', userId: OWNER, isDM: true }), ALVO); // limpa (store direto, sem a regra: preparação)
  for (let i = 0; i < n; i += 1) store.remember(memberCtx, { type: 'fact', content: `lembrança ${i} do alvo`, importance: 2 });
}
const botoesDe = (it) => it.log[0]?.components?.[0]?.toJSON?.().components ?? [];
const texto = (it) => String(it.log.at(-1)?.content ?? '');
const resumo = (t) => t.replace(/\d{15,}/g, '<id>').replace(/#\d+/g, '#<n>').replace(/\s+/g, ' ').slice(0, 160);
const auditCount = (evento) => { try { return fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').split('\n').filter((l) => l.includes(`"${evento}"`)).length; } catch { return 0; } };
/** Pede a confirmação pelo comando e devolve os dois botões. */
async function pedir(acao = 'apagar_usuario', extra = {}) {
  const it = interaction({ opts: { acao, usuario_id: ALVO, ...extra.opts }, semNome: extra.semNome });
  await handleMemoriasAdmin(it);
  const [ok, cancel] = botoesDe(it);
  return { it, ok: ok?.custom_id, cancel: cancel?.custom_id, rotulo: ok?.label };
}
const clicar = async (customId, extra = {}) => { const it = interaction({ customId, ...extra }); await handleMemoriasAdminButton(it); return it; };

/** O mesmo roteiro, passo a passo; devolve o que aconteceu em cada passo (para comparar os dois modos). */
async function roteiro() {
  const passos = [];
  const anota = (nome, it, extra = {}) => passos.push({ nome, saida: resumo(texto(it)), restam: contar(), ...extra });
  semear(2);
  // 1. o comando NÃO apaga: mostra quem (id E nome da conta) e pede a confirmação num botão
  const p1 = await pedir();
  anota('pede confirmação', p1.it, { botoes: [p1.ok?.slice(0, 10), p1.cancel?.slice(0, 10)], rotulo: resumo(p1.rotulo ?? '') });
  const req = parseConfirmId(p1.ok);
  assert.equal(req?.alvo, ALVO, 'o botão carrega o id do alvo');
  assert.equal(req?.requester, OWNER, 'e o de quem pediu');
  assert.ok(req?.exp > Date.now() / 1000 && req?.token, 'e o prazo e o token de uso único');
  // 2. outra pessoa aperta o botão do dono: recusado, e o botão NÃO é gasto por isso
  anota('outra pessoa aperta', await clicar(p1.ok, { user: OUTRO }));
  // 3. cancelar consome o pedido: o "Confirmar" da mesma mensagem não vale mais
  anota('cancelar', await clicar(p1.cancel));
  anota('confirmar depois de cancelar', await clicar(p1.ok));
  // 4. chamada direta sem confirmação (código que esqueceu o botão): recusada pela regra única
  const direta = await Promise.resolve().then(() => facade.adminForgetUser(buildContext({ platform: 'discord', userId: OWNER, isDM: true }), ALVO)).then(() => 'apagou', (e) => e.code);
  passos.push({ nome: 'sem confirmação', saida: direta, restam: contar() });
  // 5. o dono confirma na DM: apaga; o segundo clique (ou a repetição da interação) é recusado
  const p5 = await pedir();
  anota('dono confirma na DM', await clicar(p5.ok));
  semear(2);
  anota('segundo clique no mesmo botão', await clicar(p5.ok));
  // 6. clique duplo rápido (a corrida): só um passa, e a exclusão roda uma vez
  const antes = auditCount('memory.admin.forgetUser');
  const p6 = await pedir();
  const [a, b] = await Promise.all([clicar(p6.ok), clicar(p6.ok)]);
  passos.push({ nome: 'clique duplo rápido', saida: [resumo(texto(a)), resumo(texto(b))].sort().join(' | '), restam: contar(), exclusoes: auditCount('memory.admin.forgetUser') - antes });
  // 7. botão vencido (relógio do teste 2 min e 1 s à frente): recusado
  semear(2);
  const p7 = await pedir();
  __definirRelogioParaTeste(() => Date.now() + 121_000);
  try { anota('botão vencido', await clicar(p7.ok)); } finally { __definirRelogioParaTeste(null); }
  // 8. o processo reiniciou dentro dos 2 min: o botão de antes não é deste processo e é recusado
  const p8 = await pedir();
  __esquecerConfirmacoesParaTeste();
  anota('botão de antes de um reinício', await clicar(p8.ok));
  // 9. o Discord não diz o nome da conta: mostra só o id, sem falhar
  const p9 = await pedir('apagar_usuario', { semNome: true });
  anota('nome indisponível', p9.it, { rotulo: resumo(p9.rotulo ?? '') });
  // 10. uma lembrança só (acao: apagar), confirmada
  const id = store.adminListMetadata(buildContext({ platform: 'discord', userId: OWNER, isDM: true }), ALVO)[0].id;
  const p10 = await pedir('apagar', { opts: { memoria_id: id } });
  anota('apaga uma lembrança', await clicar(p10.ok));
  // 11. enforce sem somente leitura: canal público negado; DM com confirmação passa
  process.env.YUI_POLICY_MODE = 'enforce';
  process.env.YUI_READ_ONLY = 'false';
  try {
    semear(2);
    anota('enforce: dono em canal público', await clicar((await pedir()).ok, { guildId: GUILD, channelId: CANAL }));
    anota('enforce: dono na DM com confirmação', await clicar((await pedir()).ok));
    // 12. enforce + somente leitura: a regra 1 (somente leitura vence sempre) continua negando, também para o dono
    semear(1);
    process.env.YUI_READ_ONLY = 'true';
    anota('enforce + somente leitura', await clicar((await pedir()).ok));
  } finally {
    delete process.env.YUI_POLICY_MODE;
    delete process.env.YUI_READ_ONLY;
  }
  return passos;
}

let unico;
let separado;
let finished = false;
try {
console.log('Processo único (a fachada aplica a regra)');
await test('o roteiro inteiro no processo único', async () => {
  facade.setMemoryRemote(null);
  unico = await roteiro();
  const p = Object.fromEntries(unico.map((x) => [x.nome, x]));
  assert.equal(p['pede confirmação'].restam, 2, 'o comando sozinho não apaga');
  assert.match(p['pede confirmação'].saida, /Confirma apagar \*\*2\*\* lembrança\(s\) de <@<id>> \(`<id>`\), conta \*\*Ana Souza\*\* @ana\\_teste\?/, 'o id E o nome da conta');
  assert.deepEqual(p['pede confirmação'].botoes, ['memadm_ok_', 'memadm_no_']);
  assert.equal(p['pede confirmação'].rotulo, 'Confirmar: apagar de @ana_teste (<id>)');
  assert.match(p['outra pessoa aperta'].saida, /Só quem pediu/);
  assert.equal(p['outra pessoa aperta'].restam, 2);
  assert.match(p['cancelar'].saida, /Cancelado/);
  assert.match(p['confirmar depois de cancelar'].saida, /já foi usado/);
  assert.equal(p['confirmar depois de cancelar'].restam, 2);
  assert.equal(p['sem confirmação'].saida, 'CONFIRMACAO_NECESSARIA');
  assert.equal(p['sem confirmação'].restam, 2);
  assert.match(p['dono confirma na DM'].saida, /2 lembrança\(s\) de <@<id>> apagada/);
  assert.equal(p['dono confirma na DM'].restam, 0);
  assert.match(p['segundo clique no mesmo botão'].saida, /já foi usado/);
  assert.equal(p['segundo clique no mesmo botão'].restam, 2, 'o segundo clique não apaga de novo');
  assert.match(p['clique duplo rápido'].saida, /^.*apagada.* \| .*já foi usado|^.*já foi usado.* \| .*apagada/);
  assert.equal(p['clique duplo rápido'].restam, 0);
  assert.equal(p['clique duplo rápido'].exclusoes, 1, 'a exclusão rodou uma vez só');
  assert.match(p['botão vencido'].saida, /expirou/);
  assert.equal(p['botão vencido'].restam, 2);
  assert.match(p['botão de antes de um reinício'].saida, /não vale mais .*reiniciou/);
  assert.equal(p['botão de antes de um reinício'].restam, 2);
  assert.match(p['nome indisponível'].saida, /de <@<id>> \(`<id>`\), nome da conta indisponível\?/);
  assert.equal(p['nome indisponível'].rotulo, 'Confirmar: apagar de <id>');
  assert.match(p['apaga uma lembrança'].saida, /Lembrança #<n> de <@<id>> apagada/);
  assert.equal(p['apaga uma lembrança'].restam, 1);
  assert.match(p['enforce: dono em canal público'].saida, /Não permitido pela política/);
  assert.equal(p['enforce: dono em canal público'].restam, 2);
  assert.equal(p['enforce: dono na DM com confirmação'].restam, 0);
  assert.match(p['enforce + somente leitura'].saida, /somente leitura/);
  assert.equal(p['enforce + somente leitura'].restam, 1);
});

console.log('Cérebro separado (o cérebro aplica a regra; pedido pelo canal de verdade)');
await test('o MESMO roteiro pelo canal dá exatamente o mesmo resultado em cada passo', async () => {
  const secretFile = path.join(work, 'secrets', 'canal.json');
  const server = await startChannelServer({ port: 0, secretFile, logger: quiet });
  registerCerebroMethods(server, { research: async () => ({ runResearchFor: async () => ({}) }) });
  const client = connectChannel({ role: 'bot', secretFile, logger: quiet, minBackoffMs: 50, maxBackoffMs: 200 });
  try {
    await client.ready(10_000);
    facade.setMemoryRemote(client);
    separado = await roteiro();
  } finally {
    facade.setMemoryRemote(null);
    await client.close();
    await server.close();
  }
  assert.deepEqual(separado, unico, 'mesmo comportamento de segurança nos dois modos');
});

await test('auditoria: pedido sem confirmação, recusa pela política e autorização ficam registrados (corrente íntegra)', async () => {
  const eventos = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const nomes = eventos.map((e) => e.event);
  for (const e of ['memory.admin.wipe_sem_confirmacao', 'memory.admin.wipe_recusado', 'memory.admin.wipe_confirmado', 'memory.admin.forgetUser', 'policy.evaluate', 'memory.admin.wipe_botao_reusado', 'memory.admin.wipe_botao_vencido', 'memory.admin.wipe_botao_recusado']) {
    assert.ok(nomes.includes(e), `falta ${e} na auditoria`);
  }
  const conf = eventos.filter((e) => e.event === 'memory.admin.wipe_confirmado');
  assert.ok(conf.every((e) => JSON.stringify(e).includes('discord-botao')), 'a autorização diz de onde veio a confirmação');
  assert.ok(!JSON.stringify(eventos).includes('lembrança 0 do alvo'), 'nunca o conteúdo da memória');
  assert.equal(verifyAudit(process.env.YUI_AUDIT_FILE).ok, true);
});

console.log(`\n${passed} testes OK`);
finished = true;
} finally {
  try { (await import('../src/database/db.js')).closeAllDatabases(); } catch { /* */ }
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  process.chdir(os.tmpdir());
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  isolated.cleanup();
}
process.exit(finished ? 0 : 1);
