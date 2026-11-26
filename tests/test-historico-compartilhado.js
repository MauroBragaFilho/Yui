// Fase 2: o chat do app do dono usa o mesmo fio da DM (YUI_HISTORICO_COMPARTILHADO, desligado por padrão). npm run test:histcomp
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-hist-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'false';
process.env.YUI_CONTEXT_ENABLED = 'true';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;

const { initMemory } = await import('../src/core/index.js');
const ai = await import('../src/core/ai/manager.js');
const ctxStore = await import('../src/core/context/contextStore.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { fioCompartilhado, historicoCompartilhadoLigado } = await import('../src/core/api/historicoCompartilhado.js');
await initMemory();
assert.equal(ctxStore.contextEnabled(), true, 'premissa: o contexto por horas está ligado neste teste');
await ctxStore.initContextStore();

const seen = [];
ai.registerBackend({ name: 'fake', local: false, async chat(args) { seen.push(args); return `eco: ${args.prompt}`; } }, { activate: true });

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const chat = async (token, message, rota = '/v1/chat') => {
  const res = await fetch(base + rota, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  assert.equal(res.status, 200);
  return res.json();
};
const dm = ctxStore.resolveContextTarget({ userId: '111', guildId: null, personal: true });
const fioDaDM = () => ctxStore.readContextTurns(dm, { sensitive: true });
const historicoEnviado = () => (seen.at(-1).history ?? []).map((t) => t.content).join(' | ');

// 1) Desligado (padrão): o app não lê nem grava o fio da DM.
delete process.env.YUI_HISTORICO_COMPARTILHADO;
assert.equal(historicoCompartilhadoLigado(), false);
ctxStore.recordContextExchange(dm, { userText: 'tok-DM1 na DM', assistantText: 'resposta da DM' });
await chat(OWNER, 'tok-APP0 oi');
assert.ok(!historicoEnviado().includes('tok-DM1'), 'chave desligada: o app não vê a DM');
assert.equal(fioDaDM().length, 2, 'chave desligada: o app não grava no fio');

// 2) Ligado: o app do dono vê o que foi dito na DM e grava no mesmo fio.
process.env.YUI_HISTORICO_COMPARTILHADO = 'true';
await chat(OWNER, 'tok-APP1 e agora?');
assert.ok(historicoEnviado().includes('tok-DM1'), 'o app enxerga a conversa da DM');
assert.ok(fioDaDM().some((t) => t.content.includes('tok-APP1')), 'a fala do app entrou no fio da DM');
assert.deepEqual(Object.keys(fioDaDM()[0]).sort(), ['content', 'role'], 'a etiqueta de origem não vai ao prompt');
await chat(OWNER, 'tok-APP2 pela rota do agente', '/v1/agent');
assert.ok(fioDaDM().some((t) => t.content.includes('tok-APP2')), '/v1/agent também usa o fio');

// 3) Outra pessoa autenticada nunca vê nem grava o fio do dono.
await chat(MEMBER, 'tok-MEMBRO oi');
assert.ok(!historicoEnviado().includes('tok-DM1') && !historicoEnviado().includes('tok-APP1'), 'o membro não vê o fio do dono');
assert.ok(!fioDaDM().some((t) => t.content.includes('tok-MEMBRO')));

// 4) Módulo: falha fechada.
const dono = { userId: '111', role: 'OWNER', memoryScope: 'personal' };
const env = { YUI_HISTORICO_COMPARTILHADO: 'true', YUI_CONTEXT_ENABLED: 'true' };
assert.ok(await fioCompartilhado(dono, { env }));
assert.equal(await fioCompartilhado(dono, { env: { ...env, YUI_HISTORICO_COMPARTILHADO: '1' } }), null, 'só o texto "true" liga');
assert.equal(await fioCompartilhado(dono, { env: { ...env, YUI_CONTEXT_ENABLED: 'false' } }), null, 'sem contexto por horas não há fio');
assert.equal(await fioCompartilhado({ ...dono, role: 'MEMBER' }, { env }), null);
assert.equal(await fioCompartilhado({ ...dono, memoryScope: 'public' }, { env }), null);
assert.equal(await fioCompartilhado(null, { env }), null);
assert.equal(await fioCompartilhado(dono, { env, logger: { warn() {} }, store: { init: async () => { throw new Error('disco'); } } }), null, 'erro do store = histórico do app');

// 5) Peneira: marcador de ferramenta e aviso de erro da IA não entram no fio.
const fio = await fioCompartilhado(dono, { env });
const antes = fioDaDM().length;
assert.equal(fio.gravar('tok-FERR oi', '[Tool Use: search_game args={}]'), false);
assert.equal(fio.gravar('tok-ERRO oi', 'Desculpe, tive um erro ao responder.'), false);
assert.equal(fioDaDM().length, antes);

// 6) Esquecer tudo apaga o que veio do app.
await ctxStore.forgetUserContext('111');
assert.equal(fioDaDM().length, 0);

server.closeAllConnections();
await new Promise((r) => server.close(r));
console.log('test-historico-compartilhado OK');
setTimeout(() => process.exit(0), 200).unref(); // só se algo ainda segurar o processo
