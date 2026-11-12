// Memória dos usuários: modo permanente (MEMORY_RETENTION_DAYS=0), conteúdo só para o dono e apagar item a item. npm run test:memperm
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATABASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-perm-'));
const mem = await import('../src/core/memory/store.js');
const { ROLES, MEMORY_SCOPES } = await import('../src/core/permissions.js');
await mem.initMemory();

const member = (id) => ({ userId: id, role: ROLES.MEMBER, memoryScope: MEMORY_SCOPES.PUBLIC, platform: 'discord' });
const owner = { userId: '1', role: ROLES.OWNER, memoryScope: MEMORY_SCOPES.PERSONAL, platform: 'discord' };
const A = '222222222222222222'; const B = '333333333333333333';
const DAY = 86400000;

// padrão: temporária (30 dias)
delete process.env.MEMORY_RETENTION_DAYS;
assert.equal(mem.isPermanent(), false);
assert.equal(mem.retentionDays(), 30);
assert.match(mem.retentionLabel(), /30 dias/);
mem.remember(member(A), { content: 'gosta de arknights' });
let row = mem.adminListUsers(owner).users.find((u) => u.userId === A);
assert.ok(row.expiresAt > Date.now() + 29 * DAY && row.expiresAt < Date.now() + 31 * DAY, 'expira em ~30 dias');

// permanente: 0, "permanente" e variações
for (const v of ['0', 'permanente', 'Forever', ' infinito ', 'sempre']) { process.env.MEMORY_RETENTION_DAYS = v; assert.equal(mem.isPermanent(), true, v); }
process.env.MEMORY_RETENTION_DAYS = '45'; assert.equal(mem.isPermanent(), false); assert.equal(mem.retentionDays(), 45);
process.env.MEMORY_RETENTION_DAYS = '0';
assert.equal(mem.retentionLabel(), 'permanente');
// o que já tinha prazo passa a valer para sempre ao iniciar no modo permanente
await mem.initMemory();
assert.equal(mem.adminListUsers(owner).users.find((u) => u.userId === A).expiresAt, null, 'initMemory tira o prazo do que já existia');
// novas memórias e novas interações não geram prazo
mem.remember(member(B), { content: 'joga muito Ark' });
mem.remember(member(A), { content: 'tem um gato chamado Bob' });
assert.equal(mem.adminListUsers(owner).users.every((u) => u.expiresAt === null), true, 'nada expira');
// purgeExpired não apaga nada no modo permanente, mesmo com last_seen antigo
assert.equal(mem.purgeExpired(), 0);
assert.equal(mem.adminListUsers(owner).total, 2);

// conteúdo só para o dono
const content = mem.adminListContent(owner, A);
assert.deepEqual(content.map((m) => m.content).sort(), ['gosta de arknights', 'tem um gato chamado Bob']);
assert.throws(() => mem.adminListContent(member(B), A), /dono/i, 'membro não lê a memória dos outros');
assert.throws(() => mem.adminListContent({ ...owner, role: ROLES.MEMBER }, A), /dono/i);

// apagar um item específico: só ele sai; o resto fica
const gato = content.find((m) => m.content.includes('gato'));
assert.equal(mem.adminForget(owner, A, gato.id), true);
assert.deepEqual(mem.adminListContent(owner, A).map((m) => m.content), ['gosta de arknights']);
assert.equal(mem.adminListContent(owner, B).length, 1, 'os do outro usuário não mudam');
assert.equal(mem.adminForget(owner, B, gato.id), false, 'id de outra pessoa não apaga');
// o próprio usuário continua podendo esquecer tudo
assert.equal(mem.forgetAll(member(A)), 1);
assert.equal(mem.adminListContent(owner, A).length, 0);
// sem o modo permanente, volta a expirar
process.env.MEMORY_RETENTION_DAYS = '30';
mem.remember(member(B), { content: 'outra coisa' });
assert.ok(mem.adminListUsers(owner).users.find((u) => u.userId === B).expiresAt > Date.now());
console.log('test-memory-permanent OK');
process.exit(0);
