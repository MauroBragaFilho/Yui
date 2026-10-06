// Testes do Yui Core (permissões + memória). Usa um diretório temporário de
// banco, então não toca nos dados reais.  Execução: npm run test:core
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-core-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_OWNER_ID = '111';
process.env.YUI_PRIVATE_CHANNEL_IDS = 'priv1';
process.env.YUI_TRUSTED_IDS = '333';
process.env.MEMORY_RETENTION_DAYS = '30';

const core = await import('../src/core/index.js');
const { buildContext, ROLES, MEMORY_SCOPES, registerToolPolicy, checkToolAccess, memory } = core;

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✔ ${name}`); };

await core.initMemory();

const ownerDm = buildContext({ platform: 'discord', userId: '111', isDM: true });
const ownerPriv = buildContext({ platform: 'discord', userId: '111', channelId: 'priv1' });
const ownerPublic = buildContext({ platform: 'discord', userId: '111', channelId: 'pub' });
const member = buildContext({ platform: 'discord', userId: '222', channelId: 'pub' });
const blocked = buildContext({ platform: 'discord', userId: '444', isBlocked: true });

console.log('Permissões');
test('dono é OWNER; membro é MEMBER; trusted configurado', () => {
  assert.equal(ownerDm.role, ROLES.OWNER);
  assert.equal(member.role, ROLES.MEMBER);
  assert.equal(buildContext({ userId: '333' }).role, ROLES.TRUSTED);
  assert.equal(blocked.role, ROLES.BLOCKED);
});
test('memória pessoal só em DM/canal privado', () => {
  assert.equal(ownerDm.memoryScope, MEMORY_SCOPES.PERSONAL);
  assert.equal(ownerPriv.memoryScope, MEMORY_SCOPES.PERSONAL);
  assert.equal(ownerPublic.memoryScope, MEMORY_SCOPES.PUBLIC);
  assert.equal(member.memoryScope, MEMORY_SCOPES.PUBLIC);
});
test('ferramentas: default deny, nível mínimo e canal privado', () => {
  registerToolPolicy('pc.open_project', { minRole: ROLES.OWNER, access: 'open' });
  registerToolPolicy('search.web', { minRole: ROLES.MEMBER, privateOnly: false, access: 'read' });
  assert.equal(checkToolAccess(ownerDm, 'inexistente').allowed, false);
  assert.equal(checkToolAccess(ownerDm, 'pc.open_project').allowed, true);
  assert.equal(checkToolAccess(ownerPublic, 'pc.open_project').allowed, false);
  assert.equal(checkToolAccess(member, 'pc.open_project').allowed, false);
  assert.equal(checkToolAccess(member, 'search.web').allowed, true);
  assert.equal(checkToolAccess(blocked, 'search.web').allowed, false);
});

console.log('Memória');
test('memória pessoal é permanente e isolada da pública', () => {
  memory.remember(ownerDm, { type: 'project', content: 'Projeto BDS usa Laravel', tags: ['bds'], importance: 4 });
  assert.equal(memory.recall(ownerDm, 'projeto bds').length, 1);
  // o mesmo dono em canal público NÃO enxerga a memória pessoal
  assert.equal(memory.recall(ownerPublic, 'projeto bds').length, 0);
  assert.equal(memory.listMemories(ownerDm)[0].expires_at, null);
});
test('usuário comum não acessa memória de outro usuário nem a pessoal', () => {
  memory.remember(member, { content: 'Gosta de carros esportivos' });
  assert.equal(memory.recall(member, 'projeto bds').length, 0);
  assert.equal(memory.recall(member, 'carros').length, 1);
  const other = buildContext({ platform: 'discord', userId: '555', channelId: 'pub' });
  assert.equal(memory.recall(other, 'carros').length, 0);
});
test('memória pública expira após a retenção e é renovada pela interação', () => {
  const rows = memory.listMemories(member);
  assert.ok(rows[0].expires_at > Date.now() + 29 * 86400000);
});
test('usuário bloqueado não lê nem grava memória', () => {
  assert.throws(() => memory.remember(blocked, { content: 'x' }));
  assert.throws(() => memory.recall(blocked, 'x'));
});
test('forgetAll apaga somente a memória do próprio usuário', () => {
  assert.ok(memory.forgetAll(member) >= 1);
  assert.equal(memory.listMemories(member).length, 0);
  assert.equal(memory.recall(ownerDm, 'bds').length, 1);
});


// ── Adaptador Discord (flag + captura + bloco de prompt) ──
console.log('Adaptador Discord');
process.env.YUI_MEMORY_ENABLED = 'false';
const adapter = await import('../src/core/discordAdapter.js');
const dm = adapter.contextFromDiscord({ userId: '111', guildId: null, channelId: 'dm1' });
const pub = adapter.contextFromDiscord({ userId: '111', guildId: 'g1', channelId: 'pub' });
test('com a flag desligada nada é gravado nem injetado', () => {
  assert.equal(adapter.captureFromUserText(dm, 'lembra que eu uso Windows 11'), 0);
  assert.equal(adapter.buildMemoryBlock(dm, 'windows'), '');
});
process.env.YUI_MEMORY_ENABLED = 'true';
test('captura determinística da fala do usuário', () => {
  assert.equal(adapter.captureFromUserText(dm, 'Yui, lembra que o projeto LAC usa Node 24'), 1);
  assert.equal(adapter.captureFromUserText(dm, 'meu nome é Mauro'), 1);
  assert.equal(adapter.captureFromUserText(dm, 'bom dia, tudo bem?'), 0);
});
test('bloco de memória: DM do dono vê o pessoal; canal público não', () => {
  assert.match(adapter.buildMemoryBlock(dm, 'projeto lac node'), /LAC usa Node 24/);
  assert.match(adapter.buildMemoryBlock(dm, 'projeto lac node'), /PRIVADAS/);
  assert.equal(adapter.buildMemoryBlock(pub, 'projeto lac node'), '');
});
test('bloco marca memória como dados, não instruções', () => {
  assert.match(adapter.buildMemoryBlock(dm, 'nome mauro'), /NÃO instruções/);
});
test('usuário bloqueado: bloco vazio e sem erro', () => {
  const b = adapter.contextFromDiscord({ userId: '999', guildId: 'g1', channelId: 'pub', isBlocked: true });
  assert.equal(adapter.buildMemoryBlock(b, 'x'), '');
  assert.equal(adapter.captureFromUserText(b, 'lembra que teste'), 0);
});


test('"lembra que eu gosto de X" grava UMA lembrança (sem duplicar nota + preferência)', () => {
  const u = adapter.contextFromDiscord({ userId: '10000000000000099', guildId: 'g1', channelId: 'pub' });
  assert.equal(adapter.captureFromUserText(u, 'lembra que eu gosto de Sultan RS'), 1);
  const rows = memory.listMemories(u);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'preference');
  // repetir o mesmo pedido apenas renova a lembrança existente
  adapter.captureFromUserText(u, 'lembra que eu gosto de Sultan RS');
  assert.equal(memory.listMemories(u).length, 1);
  memory.forgetAll(u);
});
test('remember é idempotente: o mesmo texto não duplica e mantém a maior importância', () => {
  const u = buildContext({ platform: 'discord', userId: '10000000000000098', guildId: 'g1', channelId: 'pub' });
  memory.remember(u, { content: 'Gosta de café', importance: 2 });
  const r = memory.remember(u, { content: 'gosta de CAFÉ', importance: 4 });
  assert.equal(r.deduplicated, true);
  const rows = memory.listMemories(u);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].importance, 4);
  memory.forgetAll(u);
});

// ── Administração das memórias (somente metadados, somente dono) ──
console.log('Administração');
const u1 = buildContext({ platform: 'discord', userId: '10000000000000001', guildId: 'g1', channelId: 'pub' });
const u2 = buildContext({ platform: 'discord', userId: '10000000000000002', guildId: 'g1', channelId: 'pub' });
memory.remember(u1, { content: 'SEGREDO-DO-USUARIO-1 gosta de Sultan', type: 'preference' });
memory.remember(u1, { content: 'outra coisa do usuario 1' });
memory.remember(u2, { content: 'memoria do usuario 2' });
const adminOwner = adapter.contextFromDiscord({ userId: '111', guildId: null });
test('somente o dono administra: membro e trusted são recusados no backend', () => {
  assert.throws(() => memory.adminListUsers(u1), /Apenas o dono/);
  assert.throws(() => memory.adminListMetadata(buildContext({ userId: '333' }), '1'), /Apenas o dono/);
  assert.throws(() => memory.adminForgetUser(member, '1'), /Apenas o dono/);
  assert.throws(() => memory.adminForget(u1, u2.userId, 1), /Apenas o dono/);
});
test('listar usuários mostra contagem e datas, sem conteúdo', () => {
  const { users, total } = memory.adminListUsers(adminOwner);
  const a = users.find((u) => u.userId === u1.userId);
  assert.equal(a.count, 2);
  assert.ok(a.lastSeen && a.expiresAt);
  assert.ok(total >= 2);
  assert.ok(!JSON.stringify(users).includes('SEGREDO'));
});
test('metadados por usuário não expõem o conteúdo', () => {
  const rows = memory.adminListMetadata(adminOwner, u1.userId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !('content' in r) && r.chars > 0));
  assert.ok(!JSON.stringify(rows).includes('SEGREDO'));
});
test('apagar uma lembrança e apagar tudo de um usuário, sem afetar outros', () => {
  const [first] = memory.adminListMetadata(adminOwner, u1.userId);
  assert.equal(memory.adminForget(adminOwner, u2.userId, first.id), false, 'id de outro usuário não pode ser apagado');
  assert.equal(memory.adminForget(adminOwner, u1.userId, first.id), true);
  assert.equal(memory.adminForgetUser(adminOwner, u1.userId), 1);
  assert.equal(memory.adminListMetadata(adminOwner, u1.userId).length, 0);
  assert.equal(memory.adminListMetadata(adminOwner, u2.userId).length, 1);
});
test('a administração não alcança a memória pessoal do dono', () => {
  assert.equal(memory.adminListMetadata(adminOwner, '111').length, 0);
  assert.equal(memory.adminForgetUser(adminOwner, '111'), 0);
  assert.ok(memory.recall(dm, 'projeto lac node').length >= 1, 'memória pessoal intacta');
});

// Expiração real (precisa do módulo de banco)
const { getDbWrapper } = await import('../src/database/db.js');
const old = buildContext({ platform: 'discord', userId: '777', channelId: 'pub' });
memory.remember(old, { content: 'vai expirar' });
getDbWrapper('memory-discord').prepare('UPDATE memories SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, '777');
assert.equal(memory.recall(old, 'expirar').length, 0, 'expirada não deve ser retornada');
assert.ok(memory.purgeExpired() >= 1);
passed++; console.log('  ✔ expiração real e purge');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
