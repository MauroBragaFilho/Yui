// Fase 2: comandos por conversa no chat do app (YUI_APP_COMANDOS) e continuidade com confirmação (YUI_CONTINUIDADE).
// SEM rede externa (só a API em 127.0.0.1 com IA falsa) e SEM bancos reais (pasta temporária).
// Execução: npm run test:fase2
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-fase2-'));
const DONO = '111111';
const OUTRO = '222222';
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = DONO;
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_LISTS_ENABLED = 'true';
process.env.YUI_REMINDERS_ENABLED = 'true';
for (const k of ['AI_BASE_URL', 'AI_BACKEND', 'YUI_APP_COMANDOS', 'YUI_CONTINUIDADE', 'YUI_HISTORICO_COMPARTILHADO', 'YUI_CONTEXT_ENABLED', 'YUI_RESEARCH_PRE_ROUTE']) delete process.env[k];

const { initMemory } = await import('../src/core/index.js');
const memory = await import('../src/core/memory/store.js');
const ai = await import('../src/core/ai/manager.js');
const { buildContext } = await import('../src/core/permissions.js');
const { buildMemoryBlock } = await import('../src/core/discordAdapter.js');
const cont = await import('../src/core/continuidade.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { preRotaDoApp, FALHA_LEMBRETES } = await import('../src/core/api/preRotas.js');
const lists = await import('../src/handlers/listAssistant.js');
const { createListStore } = await import('../src/handlers/listStore.js');
const { hasForgetAllPending, __resetChatIntentsForTests } = await import('../src/handlers/chatIntents.js');
const { registerCerebroMethods } = await import('../src/cerebro/metodos.js');
const { CATALOGO } = await import('../src/core/painelConfig.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { cont.__resetContinuidadeForTests(); __resetChatIntentsForTests(); await fn(); passed++; console.log(`  ✔ ${name}`); };

const seen = [];
ai.registerBackend({ name: 'fake', local: false, async chat(args) { seen.push(args); return 'resposta da ia'; } }, { activate: true });

const T_DONO = 'owner-token-0123456789';
const T_OUTRO = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${T_DONO}=${DONO},${T_OUTRO}=${OUTRO}`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, route, { token = T_DONO, body } = {}) {
  const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
const falar = async (message, opts = {}) => (await call('POST', opts.route ?? '/v1/agent', { token: opts.token, body: { message } })).json.reply;

const ctxDono = buildContext({ platform: 'api', userId: DONO, isDM: true });
const ctxOutro = buildContext({ platform: 'api', userId: OUTRO, isDM: true });
const doTipo = (type) => memory.listMemories(ctxDono, { limit: 200 }).filter((r) => r.type === type);
const limparMemoria = () => memory.forgetAll(ctxDono);
const arquivoListas = (id) => path.join(tmp, 'listas', `${id}.json`);
const rotear = (text, extra = {}) => cont.rotearContinuidade({ text, ctx: ctxDono, interfaceId: 'dm', memory, enabled: true, env: { YUI_CONTINUIDADE: 'true' }, ...extra });

console.log('Chaves desligadas');
await test('sem as chaves, o pedido vai para a IA e nada é gravado por pré-rota', async () => {
  seen.length = 0;
  for (const message of ['anota na lista de compras: leite', 'me lembra daqui 10 minutos de testar', 'o que você sabe de mim?', 'quais são meus projetos']) {
    assert.equal(await preRotaDoApp({ ctx: ctxDono, message }), null, message);
  }
  assert.equal(await falar('decidimos que o app fica em português'), 'resposta da ia');
  assert.equal(await falar('quais são meus projetos', { route: '/v1/chat' }), 'resposta da ia');
  assert.ok(seen.length >= 2);
  assert.ok(!fs.existsSync(arquivoListas(DONO)));
  assert.equal(doTipo('decision').length, 0);
  assert.deepEqual(await rotear('decidi que sim', { env: {} }), { handled: false });
});
await test('o painel oferece as duas chaves, desligadas, com confirmação para ligar', () => {
  for (const chave of ['YUI_APP_COMANDOS', 'YUI_CONTINUIDADE']) {
    const c = CATALOGO.find((i) => i.chave === chave);
    assert.equal(c.grupo, 'Conversa');
    assert.equal(c.padrao, 'false');
    assert.equal(c.reinicio, chave === 'YUI_APP_COMANDOS');
    assert.deepEqual(c.confirmar, ['true']);
  }
});

console.log('Pré-rotas do app (YUI_APP_COMANDOS)');
process.env.YUI_APP_COMANDOS = 'true';
await test('quem não é o dono não roteia', async () => {
  for (const message of ['anota na lista de compras: leite', 'o que você sabe de mim?', 'meus lembretes']) {
    assert.equal(await preRotaDoApp({ ctx: ctxOutro, message }), null, message);
  }
  assert.equal(await falar('anota na lista de compras: leite', { token: T_OUTRO }), 'resposta da ia');
  assert.ok(!fs.existsSync(arquivoListas(OUTRO)));
});
await test('listas, lembretes e memória respondem sem IA, sem histórico e sem captura', async () => {
  limparMemoria();
  await call('DELETE', '/v1/memory'); // zera o histórico em RAM deste servidor de teste
  seen.length = 0;
  const r = await call('POST', '/v1/agent', { body: { message: 'anota na lista de compras: leite, pão' } });
  assert.equal(r.json.type, 'reply');
  assert.match(r.json.reply, /Anotei 2 itens/);
  assert.match(await falar('mostra a lista de compras', { route: '/v1/chat' }), /leite/);
  assert.match(await falar('me lembra daqui 10 minutos de lembrar que eu gosto de testes'), /./);
  assert.ok(fs.readFileSync(path.join(tmp, 'lembretes.json'), 'utf8').includes('gosto de testes'));
  assert.match(await falar('meus lembretes'), /gosto de testes/);
  assert.equal(seen.length, 0, 'nenhuma chamada de IA');
  assert.equal(memory.listMemories(ctxDono).length, 0, 'sem captura automática');
  await falar('oi');
  assert.equal((seen.at(-1).history ?? []).length, 0, 'a pré-rota não entra no histórico');
  const trilha = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8');
  assert.match(trilha, /api\.prerota/);
  assert.doesNotMatch(trilha, /leite|gosto de testes/);
});
await test('memória: ver, esquecer por número e apagar tudo com confirmação (auditoria com platform api)', async () => {
  limparMemoria();
  memory.remember(ctxDono, { type: 'note', content: 'primeira nota' });
  memory.remember(ctxDono, { type: 'note', content: 'segunda nota' });
  const ver = await falar('o que você sabe de mim?');
  assert.match(ver, /primeira nota/);
  const id = memory.listMemories(ctxDono).find((r) => r.content === 'primeira nota').id;
  assert.match(await falar(`esquece a lembrança #${id}`), /apagada/);
  assert.match(await falar('apaga tudo que você sabe de mim'), /confirmar/);
  assert.ok(hasForgetAllPending(`app:${DONO}`) && !hasForgetAllPending(DONO), 'a pendência do app não é a da DM');
  assert.match(await falar('sim, apagar tudo'), /Apaguei 1 lembrança/);
  assert.equal(memory.listMemories(ctxDono).length, 0);
  const linha = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').split('\n').find((l) => l.includes('memory.forgetAll.chat'));
  assert.match(linha, /"api"/);
});
await test('memória desligada: responde como a DM, sem cair na IA', async () => {
  process.env.YUI_MEMORY_ENABLED = 'false';
  try {
    assert.match(await falar('o que você sabe de mim?'), /desativado/);
  } finally { process.env.YUI_MEMORY_ENABLED = 'true'; }
});
await test('erro ao escrever não cai na IA', async () => {
  const quebrado = () => ({ list: () => { throw new Error('disco'); }, add: () => { throw new Error('disco'); } });
  const r = await preRotaDoApp({ ctx: ctxDono, message: 'me lembra daqui 10 minutos de testar' }, { reminderStore: quebrado, logger: { warn() {} } });
  assert.equal(r.reply, FALHA_LEMBRETES);
});
await test('DELETE /v1/memory também limpa o histórico em RAM do app (vale sem as chaves)', async () => {
  delete process.env.YUI_APP_COMANDOS;
  try {
    await falar('uma conversa qualquer');
    await falar('outra');
    assert.ok(seen.at(-1).history.length > 0);
    assert.equal((await call('DELETE', '/v1/memory')).status, 200);
    await falar('depois de apagar');
    assert.equal((seen.at(-1).history ?? []).length, 0);
  } finally { process.env.YUI_APP_COMANDOS = 'true'; }
});

console.log('Listas com um escritor só');
await test('bot com o cérebro separado: chave ligada pede ao cérebro e nunca grava localmente', async () => {
  const pedidos = [];
  lists.setListsRemote({ route: async (p) => { pedidos.push(p); return { handled: true, text: 'do cérebro' }; } });
  try {
    const r = await lists.routeLists({ text: 'anota na lista remota: um', userId: '333333' });
    assert.equal(r.text, 'do cérebro');
    assert.equal(pedidos.length, 1);
    assert.deepEqual(await lists.routeLists({ text: 'bom dia', userId: '333333' }), { handled: false });
    lists.setListsRemote({ route: async () => { throw new Error('fora'); } });
    const falhou = await lists.routeLists({ text: 'anota na lista remota: um', userId: '333333' });
    assert.equal(falhou.text, lists.LISTS_UNAVAILABLE_TEXT);
    assert.ok(!fs.existsSync(arquivoListas('333333')), 'o bot não gravou');
    // chave desligada: como sempre, local
    const local = await lists.routeLists({ text: 'anota na lista remota: um', userId: '333333' }, { env: {} });
    assert.match(local.text, /Anotei/);
    assert.ok(fs.existsSync(arquivoListas('333333')));
  } finally { lists.setListsRemote(null); }
});
await test('o cérebro atende lists.route gravando no arquivo dele', async () => {
  const metodos = new Map();
  const dir = path.join(tmp, 'listas-cerebro');
  registerCerebroMethods({ handle: (m, fn) => metodos.set(m, fn) }, { listStore: createListStore({ dir }), engine: {} });
  const r = await metodos.get('lists.route')({ text: 'anota na lista de compras: café', userId: DONO });
  assert.equal(r.handled, true);
  assert.ok(fs.readFileSync(path.join(dir, `${DONO}.json`), 'utf8').includes('café'));
  assert.deepEqual(await metodos.get('lists.route')({ text: 'x' }), { handled: false });
});

console.log('Continuidade (YUI_CONTINUIDADE)');
await test('detecção conservadora', () => {
  assert.equal(cont.detectarPedido('registra a decisão: usar SQLite').content, 'usar SQLite');
  assert.equal(cont.detectarPedido('decidimos que o app fica em português').type, 'decision');
  assert.equal(cont.detectarPedido('yui, novo projeto: canal de receitas').type, 'project');
  assert.equal(cont.detectarPedido('registra no projeto Yui: trocar a voz').content, 'Projeto Yui: trocar a voz');
  for (const t of ['ontem decidimos que sim', 'decidimos que vai ser assim?', 'como registra a decisão: xyz', '> decidi que apago tudo', 'registra a decisão:\noutra linha']) {
    assert.equal(cont.detectarPedido(t), null, t);
  }
});
await test('só "sim" sozinho grava; "não" e outra mensagem descartam', async () => {
  limparMemoria();
  const p = await rotear('registra a decisão: usar SQLite');
  assert.equal(p.kind, 'proposta');
  assert.match(p.text, /"usar SQLite"/);
  assert.equal(doTipo('decision').length, 0);
  assert.equal((await rotear('sim')).kind, 'gravado');
  assert.deepEqual(doTipo('decision').map((r) => [r.content, r.source]), [['usar SQLite', 'continuidade']]);

  await rotear('novo projeto: canal');
  assert.equal((await rotear('não')).kind, 'descartado');
  assert.deepEqual(await rotear('sim'), { handled: false });

  await rotear('novo projeto: canal');
  assert.deepEqual(await rotear('sim, mas muda o nome'), { handled: false });
  assert.deepEqual(await rotear('sim'), { handled: false });
  assert.equal(doTipo('project').length, 0);
});
await test('expira em 2 minutos, fica presa à interface e anexo/terceiros não confirmam', async () => {
  limparMemoria();
  await rotear('novo projeto: alfa', { now: 1000 });
  assert.deepEqual(await rotear('sim', { now: 1000 + cont.VALIDADE_MS + 1 }), { handled: false });
  await rotear('novo projeto: beta');
  assert.deepEqual(await rotear('sim', { interfaceId: 'app' }), { handled: false });
  assert.equal((await rotear('sim')).kind, 'gravado');
  await rotear('novo projeto: gama');
  assert.deepEqual(await rotear('sim', { semProposta: true }), { handled: false });
  assert.deepEqual(await rotear('sim'), { handled: false });
  assert.deepEqual(doTipo('project').map((r) => r.content), ['beta']);
});
await test('nunca em servidor, voz ou para quem não é o dono', async () => {
  const servidor = buildContext({ platform: 'discord', userId: DONO, guildId: '999999', channelId: '888888' });
  const voz = buildContext({ platform: 'discord', userId: DONO, guildId: '999999', channelId: null });
  for (const ctx of [servidor, voz, ctxOutro]) assert.deepEqual(await rotear('novo projeto: x', { ctx }), { handled: false });
});
await test('no app: proposta, confirmação, consulta com #id, sem virar nota; DELETE descarta a pendência', async () => {
  process.env.YUI_CONTINUIDADE = 'true';
  try {
    limparMemoria();
    seen.length = 0;
    assert.match(await falar('decidi que eu gosto de planilhas'), /sim ou não/);
    assert.equal(memory.listMemories(ctxDono).length, 0, 'sem captura automática');
    assert.match(await falar('sim'), /Guardei/);
    const id = doTipo('decision')[0].id;
    assert.match(await falar('quais decisões eu registrei'), new RegExp(`#${id} - decidi que eu gosto`));
    assert.match(await falar('quais são meus projetos'), /nenhum projeto/);
    assert.equal(seen.length, 0);
    await falar('novo projeto: apagar depois');
    await call('DELETE', '/v1/memory');
    assert.equal(await falar('sim'), 'resposta da ia');
    assert.equal(memory.listMemories(ctxDono).filter((r) => r.type === 'project').length, 0);
  } finally { delete process.env.YUI_CONTINUIDADE; }
});
await test('a proposta substitui a confirmação de apagar tudo (um "sim" não vale para as duas)', async () => {
  process.env.YUI_CONTINUIDADE = 'true';
  try {
    limparMemoria();
    memory.remember(ctxDono, { type: 'note', content: 'fica' });
    await falar('apaga tudo que você sabe de mim');
    await falar('novo projeto: novo');
    await falar('sim');
    assert.equal(memory.listMemories(ctxDono).length, 2);
  } finally { delete process.env.YUI_CONTINUIDADE; }
});
await test('bloco de memória: só com a chave, sem duplicar e com teto', () => {
  limparMemoria();
  for (let i = 1; i <= 8; i++) memory.remember(ctxDono, { type: 'decision', content: `item ${i} zzz` });
  assert.equal(buildMemoryBlock(ctxDono, 'e os projetos?'), '');
  process.env.YUI_CONTINUIDADE = 'true';
  try {
    assert.equal((buildMemoryBlock(ctxDono, 'e os projetos?').match(/\[decision\]/g) || []).length, 5);
    assert.equal(buildMemoryBlock(ctxDono, 'bom dia'), '');
    const tudo = buildMemoryBlock(ctxDono, 'decisão sobre zzz').match(/item \d zzz/g);
    assert.equal(new Set(tudo).size, tudo.length);
    assert.equal(buildMemoryBlock(ctxOutro, 'e os projetos?'), '');
  } finally { delete process.env.YUI_CONTINUIDADE; }
});
await test('a DM chama a continuidade antes das outras portas, só fora de servidor e voz', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'handlers', 'llmHandler.js'), 'utf8');
  const i = src.indexOf('rotearContinuidade({');
  assert.ok(i > 0 && i < src.indexOf('await routeLists({'));
  const porta = src.slice(src.lastIndexOf('if (continuidadeLigada()', i), i);
  for (const trava of ['!guildId', '!isVoice', 'thirdPartyPrompt !== true', 'directToYui']) assert.ok(porta.includes(trava), trava);
});

console.log('Correções da revisão');
await test('app: outra mensagem descarta a confirmação de apagar tudo', async () => {
  limparMemoria();
  memory.remember(ctxDono, { type: 'note', content: 'fica' });
  const pre = async (message) => (await preRotaDoApp({ ctx: ctxDono, message }, { env: { YUI_APP_COMANDOS: 'true' } }))?.reply ?? null;
  for (const outra of ['me indica um filme', 'mostra a lista de compras', 'meus lembretes']) {
    assert.match(await pre('apaga tudo que você sabe de mim'), /confirmar/);
    await pre(outra);
    assert.equal(await pre('quero'), null, outra);
    assert.ok(memory.listMemories(ctxDono).some((r) => r.content === 'fica'), outra);
  }
});
await test('frase com pedido de ajuda não vira proposta', () => {
  for (const t of ['decidi que vou aprender violão, me indica por onde começar', 'Decidimos que o jantar vai ser pizza, me passa uma receita',
    'decidi que não sei o que fazer, me ajuda', 'novo projeto: me ajuda a pensar num nome']) assert.equal(cont.detectarPedido(t), null, t);
  assert.equal(cont.detectarPedido('decidimos que o bot vai me mandar o resumo').type, 'decision');
});
await test('DM: o que não passa pela fila também descarta a proposta', async () => {
  limparMemoria();
  for (const [texto, extra] of [['+yui diario', {}], ['', { comAnexo: true }], ['sim', { comAnexo: true }]]) {
    assert.equal((await rotear('novo projeto: canal')).kind, 'proposta');
    cont.observarMensagem(DONO, 'dm', texto, extra);
    assert.deepEqual(await rotear('sim'), { handled: false }, texto);
  }
  assert.equal((await rotear('novo projeto: canal')).kind, 'proposta');
  cont.observarMensagem(DONO, 'dm', 'sim');
  assert.equal((await rotear('sim')).kind, 'gravado');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'events', 'messageCreate.js'), 'utf8');
  const i = src.indexOf('observarMensagem(message.author.id');
  assert.ok(i > 0 && i < src.indexOf('if (startsWithCommandPrefix('));
});
await test('apagar tudo descarta as propostas, inclusive entre os dois processos', async () => {
  const metodos = new Map();
  registerCerebroMethods({ handle: (m, fn) => metodos.set(m, fn) }, { engine: { gate: () => ({ decision: 'ALLOW' }) } });
  await rotear('novo projeto: alfa', { interfaceId: 'app' });
  await metodos.get('context.forgetUser')({ userId: DONO }, {});
  assert.deepEqual(await rotear('sim', { interfaceId: 'app' }), { handled: false });

  const avisos = [];
  const deps = { env: { YUI_APP_COMANDOS: 'true' }, aoApagarMemoria: (u) => avisos.push(u) };
  await rotear('novo projeto: beta');
  await preRotaDoApp({ ctx: ctxDono, message: 'apaga tudo que você sabe de mim' }, deps);
  await preRotaDoApp({ ctx: ctxDono, message: 'sim, apagar tudo' }, deps);
  assert.deepEqual(avisos, [DONO]);
  assert.deepEqual(await rotear('sim'), { handled: false });

  const ler = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', f), 'utf8');
  assert.match(ler('cerebro.js'), /emit\('continuidade\.descartar'/);
  assert.match(ler('discord/canalCerebro.js'), /on\('continuidade\.descartar'/);
  assert.match(ler('discord/commands/memoria.js'), /descartarContinuidade\(userId\)/);
  assert.match(ler('handlers/llmHandler.js'), /wipeContext: async \(uid\) => \{ descartarContinuidade\(uid\)/);
});

server.close();
console.log(`\n${passed} testes OK`);
process.exit(0);
