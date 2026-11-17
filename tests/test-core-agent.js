// Testes do Agent/JARVIS e das ferramentas (sem LLM real e sem abrir programas).
// Execução: npm run test:core-agent
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-agent-'));
process.env.DATABASE_DIR = tmp;
// Auditoria num arquivo temporário (antes de importar os módulos): sem isto os eventos falsos iam para logs/core-audit.jsonl REAL.
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_PRIVATE_CHANNEL_IDS = 'priv1';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
// Isola o teste do .env real (que pode ter as ferramentas do PC ligadas).
process.env.YUI_TOOLS_PC_ENABLED = 'false';
process.env.YUI_PROJECTS = '';
process.env.YUI_APPS = '';
process.env.YUI_FILE_ROOTS = '';
process.env.YUI_EDITOR_COMMAND = '';
process.env.YUI_MCP_ALLOW = '';

const { buildContext, ROLES } = await import('../src/core/permissions.js');
const ai = await import('../src/core/ai/manager.js');
const { runAgent, resolvePending, extractJson, _pendingCount } = await import('../src/core/agent/agent.js');
const tools = await import('../src/core/agent/tools.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

// LLM falso: devolve a próxima resposta programada e guarda os prompts.
let script = [];
const prompts = [];
ai.registerBackend(
  { name: 'fake', local: false, async chat(a) { prompts.push(a.prompt); return script.shift() ?? '{"reply":"ok"}'; } },
  { activate: true }
);

const ran = [];
tools.clearTools();
tools.registerTool({
  name: 'test.echo', description: 'Ecoa um texto.', params: { text: { type: 'string', required: true, max: 20 } },
  minRole: ROLES.OWNER, access: 'read', async run({ text }) { ran.push(['echo', text]); return `eco ${text}`; },
});
tools.registerTool({
  name: 'test.danger', description: 'Ação sensível.', params: { mode: { type: 'string', enum: ['a', 'b'] } },
  minRole: ROLES.OWNER, access: 'open', confirm: true, async run(args) { ran.push(['danger', args.mode]); return 'feito'; },
});
tools.registerTool({
  name: 'test.boom', description: 'Sempre falha.', minRole: ROLES.OWNER, access: 'read', async run() { throw new Error('quebrou'); },
});
tools.registerTool({
  name: 'test.public', description: 'Pública.', minRole: ROLES.MEMBER, access: 'read', privateOnly: false, async run() { return 'publica'; },
});

const ownerDm = buildContext({ platform: 'api', userId: '111', isDM: true });
const ownerPublic = buildContext({ platform: 'discord', userId: '111', channelId: 'pub' });
const member = buildContext({ platform: 'discord', userId: '222', channelId: 'pub' });
const other = buildContext({ platform: 'api', userId: '333', isDM: true });

console.log('Utilitários');
await test('extractJson tolera cercas de código e texto ao redor', () => {
  assert.deepEqual(extractJson('```json\n{"tool":"a","args":{"x":"}"}}\n```'), { tool: 'a', args: { x: '}' } });
  assert.deepEqual(extractJson('claro! {"reply":"oi"} fim'), { reply: 'oi' });
  assert.equal(extractJson('sem json'), null);
  assert.equal(extractJson('{quebrado'), null);
});
await test('validateArgs: tipos, obrigatórios, enum, tamanho e argumentos extras', () => {
  const t = tools.getTool('test.echo');
  assert.deepEqual(tools.validateArgs(t, { text: ' oi ' }), { text: 'oi' });
  assert.throws(() => tools.validateArgs(t, {}), /obrigatório/);
  assert.throws(() => tools.validateArgs(t, { text: 'x'.repeat(21) }), /longo/);
  assert.throws(() => tools.validateArgs(t, { text: 'a', extra: 1 }), /desconhecido/);
  assert.throws(() => tools.validateArgs(tools.getTool('test.danger'), { mode: 'z' }), /um de/);
});
await test('parseAllowlist', () => {
  const m = tools.parseAllowlist('BDS=C:\\Dev\\BDS|LAC=D:\\LAC|invalido|=x');
  assert.equal(m.get('bds'), 'C:\\Dev\\BDS');
  assert.equal(m.size, 2);
});

console.log('Agent');
await test('sem ferramentas permitidas no contexto -> conversa normal, sem expor ferramentas', async () => {
  prompts.length = 0; script = ['olá!'];
  const out = await runAgent(ownerPublic, 'oi');
  assert.equal(out.type, 'reply');
  assert.ok(!prompts[0].includes('test.echo'), 'LLM não pode ver ferramentas que o contexto não pode usar');
});
await test('membro vê só ferramentas liberadas para ele', async () => {
  prompts.length = 0; script = ['{"reply":"oi"}'];
  await runAgent(member, 'oi');
  assert.ok(prompts[0].includes('test.public'));
  assert.ok(!prompts[0].includes('test.echo') && !prompts[0].includes('test.danger'));
});
await test('dono em DM: ferramenta executa e retorna o resultado', async () => {
  script = ['{"tool":"test.echo","args":{"text":"oi"}}'];
  const out = await runAgent(ownerDm, 'repete oi');
  assert.deepEqual([out.type, out.reply, out.tool], ['tool_result', 'eco oi', 'test.echo']);
  assert.deepEqual(ran.at(-1), ['echo', 'oi']);
});
await test('LLM pede ferramenta que não existe/é proibida -> negado e não executa', async () => {
  const before = ran.length;
  script = ['{"tool":"pc.format_disk","args":{}}'];
  assert.equal((await runAgent(ownerDm, 'x')).type, 'denied');
  // membro tentando ferramenta de dono (mesmo que o LLM "alucine")
  script = ['{"tool":"test.danger","args":{}}'];
  assert.equal((await runAgent(member, 'x')).type, 'denied');
  assert.equal(ran.length, before);
});
await test('argumentos inválidos -> negado e não executa', async () => {
  const before = ran.length;
  script = ['{"tool":"test.echo","args":{"text":"x","rm":"-rf"}}'];
  assert.equal((await runAgent(ownerDm, 'x')).type, 'denied');
  assert.equal(ran.length, before);
});
await test('resposta fora do formato é tratada como texto, nunca como ação', async () => {
  const before = ran.length;
  script = ['vou executar test.danger agora!'];
  const out = await runAgent(ownerDm, 'x');
  assert.equal(out.type, 'reply');
  assert.equal(ran.length, before);
});
await test('erro na ferramenta vira mensagem, sem derrubar o agent', async () => {
  script = ['{"tool":"test.boom"}'];
  const out = await runAgent(ownerDm, 'x');
  assert.equal(out.type, 'tool_result');
  assert.match(out.reply, /quebrou/);
});

console.log('Confirmação');
let pendingId;
await test('ação sensível fica pendente e NÃO executa antes da confirmação', async () => {
  const before = ran.length;
  script = ['{"tool":"test.danger","args":{"mode":"a"}}'];
  const out = await runAgent(ownerDm, 'faz a coisa');
  assert.equal(out.type, 'needs_confirmation');
  assert.ok(out.pendingId);
  pendingId = out.pendingId;
  assert.equal(ran.length, before);
  assert.equal(_pendingCount(), 1);
});
await test('outro usuário não consegue confirmar', async () => {
  assert.equal((await resolvePending(other, pendingId)).type, 'denied');
  assert.equal(_pendingCount(), 1);
});
await test('dono confirma: executa uma única vez', async () => {
  const out = await resolvePending(ownerDm, pendingId);
  assert.deepEqual([out.type, out.reply], ['tool_result', 'feito']);
  assert.deepEqual(ran.at(-1), ['danger', 'a']);
  assert.equal((await resolvePending(ownerDm, pendingId)).type, 'denied', 'segunda confirmação deve falhar');
});
await test('cancelar descarta a ação', async () => {
  script = ['{"tool":"test.danger","args":{"mode":"b"}}'];
  const { pendingId: id } = await runAgent(ownerDm, 'x');
  const before = ran.length;
  assert.equal((await resolvePending(ownerDm, id, false)).reply, 'Ação cancelada.');
  assert.equal((await resolvePending(ownerDm, id)).type, 'denied');
  assert.equal(ran.length, before);
});
await test('confirmação é revalidada: perdeu a permissão -> negado', async () => {
  script = ['{"tool":"test.danger","args":{"mode":"a"}}'];
  const { pendingId: id } = await runAgent(ownerDm, 'x');
  const sameUserPublic = { ...ownerDm, channelKind: 'public' }; // mesmo usuário, agora em canal público
  assert.equal((await resolvePending(sameUserPublic, id)).type, 'denied');
});

console.log('Ferramentas do PC (allowlist)');
const projDir = path.join(tmp, 'proj');
fs.mkdirSync(path.join(projDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(projDir, 'sub', 'relatorio-final.txt'), 'x');
fs.mkdirSync(path.join(projDir, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(projDir, 'node_modules', 'x', 'relatorio-lixo.txt'), 'x');
await test('desligadas por padrão', () => {
  tools.clearTools();
  assert.deepEqual(tools.registerBuiltinTools(), []);
});
process.env.YUI_TOOLS_PC_ENABLED = 'true';
process.env.YUI_FILE_ROOTS = projDir;
process.env.YUI_PROJECTS = `inexistente=${path.join(tmp, 'nao-existe')}`;
process.env.YUI_APPS = '';
const names = tools.registerBuiltinTools();
await test('registra apenas ferramentas OWNER do PC', () => {
  assert.deepEqual(names.sort(), ['apps.open', 'commands.list', 'commands.run', 'files.search', 'projects.open', 'system.info']);
  assert.equal(tools.listTools().every((t) => t.minRole === ROLES.OWNER), true);
});
await test('files.search acha por nome, ignora node_modules e bloqueia caminhos', async () => {
  const t = tools.getTool('files.search');
  const found = await t.run({ query: 'relatorio' });
  assert.match(found, /relatorio-final\.txt/);
  assert.ok(!found.includes('node_modules'));
  await assert.rejects(t.run({ query: '../segredo' }), /sem caminhos/);
  await assert.rejects(t.run({ query: 'C:\\Windows' }), /sem caminhos/);
});
await test('projects.open rejeita projeto não cadastrado e pasta inexistente', async () => {
  const t = tools.getTool('projects.open');
  await assert.rejects(t.run({ name: 'qualquer' }), /não está cadastrado/);
  await assert.rejects(t.run({ name: 'inexistente' }), /não existe/);
});
await test('apps.open exige cadastro e confirmação; system.info funciona', async () => {
  await assert.rejects(tools.getTool('apps.open').run({ name: 'cmd' }), /não está cadastrado/);
  assert.equal(tools.getTool('apps.open').confirm, true);
  assert.match(await tools.getTool('system.info').run(), /RAM:/);
});
await test('MCP: só entram ferramentas explicitamente permitidas, sempre com confirmação', () => {
  process.env.YUI_MCP_ALLOW = 'whisper.transcribe';
  const added = tools.registerMcpTools('whisper', [{ name: 'transcribe' }, { name: 'delete_all' }], async () => 'ok');
  assert.deepEqual(added, ['whisper.transcribe']);
  assert.equal(tools.getTool('whisper.transcribe').confirm, true);
  assert.equal(tools.getTool('whisper.delete_all'), null);
});

console.log('Motor de políticas imposto (YUI_POLICY_MODE=enforce)');
await test('enforce: ação crítica vira ticket, só executa depois de aprovada no PC e uma única vez', async () => {
  const { getApprovalManager, resetApprovalManagerForTests } = await import('../src/core/security/approvalManager.js');
  resetApprovalManagerForTests();
  process.env.YUI_READ_ONLY = 'false';
  process.env.YUI_POLICY_MODE = 'enforce';
  tools.registerTool({ name: 'commands.run', description: 'Roda.', params: { name: { type: 'string', required: true, max: 20 } }, minRole: ROLES.OWNER, access: 'execute', confirm: true, async run({ name }) { ran.push(['cmd', name]); return 'rodou'; } });
  const approvals = getApprovalManager();
  try {
    // A matriz exige o PC para commands.run: pelo Discord/API remota é negado, mesmo o dono.
    script = ['{"tool":"commands.run","args":{"name":"x"}}'];
    assert.equal((await runAgent(ownerDm, 'roda', { origin: 'REMOTE' })).type, 'denied');
    const before = ran.length;
    script = ['{"tool":"commands.run","args":{"name":"x"}}'];
    const out = await runAgent(ownerDm, 'roda', { origin: 'LOCAL_PC' });
    assert.equal(out.type, 'needs_confirmation');
    assert.match(out.reply, /yui-aprovar/);
    // Confirmar no chat SEM aprovar no PC: continua pendente e não executa.
    assert.equal((await resolvePending(ownerDm, out.pendingId)).type, 'needs_confirmation');
    assert.equal(ran.length, before);
    // Aprovação por origem remota é recusada; só LOCAL_PC vale.
    const [t1] = approvals.list();
    assert.throws(() => approvals.decide(t1.id, { approve: true, approverId: '111', approverRole: ROLES.OWNER, approverOrigin: 'REMOTE' }), /computador/);
    approvals.decide(t1.id, { approve: true, approverId: '111', approverRole: ROLES.OWNER, approverOrigin: 'LOCAL_PC' });
    const done = await resolvePending(ownerDm, out.pendingId);
    assert.deepEqual([done.type, done.reply], ['tool_result', 'rodou']);
    assert.deepEqual(ran.at(-1), ['cmd', 'x']);
    assert.equal((await resolvePending(ownerDm, out.pendingId)).type, 'denied', 'ticket de uso único');
    // Recusar pelo chat cancela o ticket.
    script = ['{"tool":"commands.run","args":{"name":"y"}}'];
    const o2 = await runAgent(ownerDm, 'roda', { origin: 'LOCAL_PC' });
    assert.equal((await resolvePending(ownerDm, o2.pendingId, false)).reply, 'Ação cancelada.');
    assert.equal(approvals.list().length, 0);
  } finally {
    delete process.env.YUI_POLICY_MODE;
    delete process.env.YUI_READ_ONLY;
    tools.clearTools();
  }
});
await test('observe (padrão): o comportamento antigo continua igual (confirmação simples, sem ticket)', async () => {
  process.env.YUI_READ_ONLY = 'false';
  tools.registerTool({ name: 'commands.run', description: 'Roda.', params: { name: { type: 'string', required: true, max: 20 } }, minRole: ROLES.OWNER, access: 'execute', confirm: true, async run() { return 'rodou'; } });
  try {
    script = ['{"tool":"commands.run","args":{"name":"x"}}'];
    const out = await runAgent(ownerDm, 'roda', { origin: 'REMOTE' });
    assert.equal(out.type, 'needs_confirmation');
    assert.doesNotMatch(out.reply, /yui-aprovar/);
    assert.equal((await resolvePending(ownerDm, out.pendingId)).reply, 'rodou');
  } finally { delete process.env.YUI_READ_ONLY; tools.clearTools(); }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
