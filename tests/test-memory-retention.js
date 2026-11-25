// Retenção da memória pública: CONVERSAR renova o prazo (antes só gravar renovava). npm run test:memret
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATABASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ret-'));
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.MEMORY_RETENTION_DAYS = '30';
const mem = await import('../src/core/memory/store.js');
const { getDbWrapper } = await import('../src/database/db.js');
const { buildMemoryBlock } = await import('../src/core/discordAdapter.js');
const { ROLES, MEMORY_SCOPES } = await import('../src/core/permissions.js');
await mem.initMemory();

const DAY = 86400000;
const HOUR = 3600000;
const pub = (id) => ({ userId: id, role: ROLES.MEMBER, memoryScope: MEMORY_SCOPES.PUBLIC, platform: 'discord' });
const owner = { userId: '1', role: ROLES.OWNER, memoryScope: MEMORY_SCOPES.PERSONAL, platform: 'discord' };
const A = '222222222222222222';
const NEVER = '444444444444444444';
const db = () => getDbWrapper('memory-discord');
const seen = (id) => db().prepare('SELECT last_seen FROM memory_users WHERE user_id = ?').get(id)?.last_seen;
const expiry = (id) => db().prepare('SELECT expires_at FROM memories WHERE user_id = ?').get(id)?.expires_at;
/** Simula que a última atividade foi há `ms` e o prazo está quase no fim. */
function envelhece(id, ms) {
  const t = Date.now() - ms;
  db().prepare('UPDATE memory_users SET last_seen = ? WHERE user_id = ?').run(t, id);
  db().prepare('UPDATE memories SET expires_at = ? WHERE user_id = ?').run(Date.now() + DAY, id);
}

mem.remember(pub(A), { content: 'gosta de arknights' });

// 1) Conversar (montar o bloco de memória) renova o prazo de quem já tem memória.
envelhece(A, 2 * HOUR);
assert.ok(expiry(A) < Date.now() + 2 * DAY, 'ponto de partida: prazo quase no fim');
buildMemoryBlock(pub(A), 'oi, tudo bem?');
assert.ok(expiry(A) > Date.now() + 29 * DAY, 'conversar renovou o prazo para ~30 dias');
assert.ok(Date.now() - seen(A) < 5000, 'última atividade atualizada');

// 2) Limite de 1x por hora: conversar logo em seguida não regrava (o prazo não muda).
envelhece(A, 10 * 60 * 1000);
const antes = expiry(A);
buildMemoryBlock(pub(A), 'mais uma');
assert.equal(expiry(A), antes, 'dentro de 1 hora não mexe no banco');

// 3) Quem nunca teve memória não ganha registro só por conversar.
buildMemoryBlock(pub(NEVER), 'oi');
assert.equal(seen(NEVER), undefined, 'conversar sozinho não cria registro do usuário');

// 4) Memória pessoal (dono) nunca expira e conversar não cria registro público.
buildMemoryBlock(owner, 'oi');
assert.equal(seen(owner.userId), undefined);

// 5) Sem opções, touchUser continua renovando sempre (remember e o gancho antigo).
envelhece(A, 5 * 60 * 1000);
mem.touchUser(pub(A));
assert.ok(expiry(A) > Date.now() + 29 * DAY, 'sem opções renova sempre');

// 6) Sem renovação o prazo vence e a limpeza apaga (o comportamento que o bug causava).
envelhece(A, 40 * DAY);
db().prepare('UPDATE memories SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, A);
assert.equal(mem.purgeExpired() >= 1, true, 'vencida e sem conversa: some');

// 7) Memória desligada: conversar não mexe em nada.
mem.remember(pub(A), { content: 'outra memória' });
envelhece(A, 2 * HOUR);
process.env.YUI_MEMORY_ENABLED = 'false';
const venc = expiry(A);
assert.equal(buildMemoryBlock(pub(A), 'oi'), '');
assert.equal(expiry(A), venc, 'memória desligada não renova');

console.log('test-memory-retention OK');
process.exit(0);
