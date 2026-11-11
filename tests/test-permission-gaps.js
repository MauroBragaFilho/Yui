import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// bans.json de teste (nunca o real) e dono definido por ambiente, ANTES de importar os módulos
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-perm-'));
process.env.YUI_BANS_FILE = path.join(dir, 'bans.json');
process.env.OWNER_ID = '111111111111111111';
process.env.YUI_OWNER_ID = '222222222222222222';

const { addBan, removeBan, checkBan, getBans } = await import('../src/handlers/banHandler.js');
const { isForeignDm } = await import('../src/discord/prefixRouter.js');

let ok = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); ok += 1; };

// 1) o dono nunca é banido (OWNER_ID e YUI_OWNER_ID), mas qualquer outra pessoa pode
eq(addBan('user', '111111111111111111', 'teste'), false, 'OWNER_ID protegido');
eq(addBan('user', '222222222222222222', 'teste'), false, 'YUI_OWNER_ID protegido');
eq(getBans().users['111111111111111111'], undefined, 'nada foi gravado para o dono');
eq(addBan('user', '999999999999999999', 'spam'), true, 'outra pessoa continua banível');
eq(checkBan('999999999999999999', null, null)?.type, 'user');
removeBan('user', '999999999999999999');
// servidor e canal com o MESMO id do dono não são afetados pela regra (ela é só para usuários)
eq(addBan('guild', '111111111111111111', 'x'), true);
removeBan('guild', '111111111111111111');

// 2) registro antigo no bans.json não derruba o dono
fs.writeFileSync(process.env.YUI_BANS_FILE, JSON.stringify({ users: { '111111111111111111': { reason: 'antigo', timestamp: 'x' } }, guilds: {}, channels: {}, autoblock: {} }));
const again = await import('../src/handlers/banHandler.js?recarrega=1');
eq(again.checkBan('111111111111111111', null, null), null, 'dono com registro antigo passa');

// 3) "+yui" no privado de quem não é o dono: silêncio; dono em DM e qualquer um em servidor seguem
const owner = (id) => id === 'dono';
eq(isForeignDm({ guildId: null, author: { id: 'fulano' } }, owner), true, 'DM de estranho');
eq(isForeignDm({ guildId: null, author: { id: 'dono' } }, owner), false, 'DM do dono');
eq(isForeignDm({ guildId: '123', author: { id: 'fulano' } }, owner), false, 'em servidor vale para todos');
eq(isForeignDm({ guild: { id: '123' }, author: { id: 'fulano' } }, owner), false, 'guild.id também conta como servidor');

// 4) o aviso do ToS cita um comando que existe
const tos = fs.readFileSync('src/handlers/tosHandler.js', 'utf8');
eq(/chat_updates/.test(tos), false, 'não cita mais /chat_updates');
eq(/yui-servidor canal_updates/.test(tos), true, 'cita /yui-servidor canal_updates');
const slash = fs.readFileSync('src/commands/slashCommands.js', 'utf8');
eq(/setName\('yui-servidor'\)/.test(slash) && /setName\('canal_updates'\)/.test(slash), true, 'o comando citado existe');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`OK: permission-gaps (${ok} verificações)`);
process.exit(0); // o prefixRouter importa módulos do Discord que mantêm o processo vivo
