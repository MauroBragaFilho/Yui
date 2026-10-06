// Garantia de SOMENTE LEITURA: a Yui não pode apagar, gravar, mover nem executar programas.
// Execução: npm run test:readonly
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ro-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_OWNER_ID = '111';
process.env.YUI_PRIVATE_CHANNEL_IDS = 'priv1';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
delete process.env.YUI_READ_ONLY;
process.env.YUI_MCP_ALLOW = '';
process.env.YUI_MCP_READ_ONLY = '';

const { buildContext, ROLES, isReadOnlyMode, checkToolAccess, listAllowedTools } = await import('../src/core/permissions.js');
const ai = await import('../src/core/ai/manager.js');
const { runAgent, resolvePending } = await import('../src/core/agent/agent.js');
const tools = await import('../src/core/agent/tools.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const ownerDm = buildContext({ platform: 'discord', userId: '111', isDM: true });
const ownerApi = buildContext({ platform: 'api', userId: '111', isDM: true });
const member = buildContext({ platform: 'discord', userId: '222', channelId: 'pub' });

let script = [];
const prompts = [];
ai.registerBackend(
  { name: 'fake', local: false, async chat(a) { prompts.push(a.prompt); return script.shift() ?? '{"reply":"ok"}'; } },
  { activate: true }
);

const ran = [];
tools.clearTools();
tools.registerTool({ name: 'ler.algo', description: 'Lê.', access: 'read', async run() { ran.push('ler'); return 'lido'; } });
tools.registerTool({ name: 'abrir.pasta', description: 'Abre.', access: 'open', confirm: true, async run() { ran.push('abrir'); return 'aberto'; } });
tools.registerTool({ name: 'fs.apagar', description: 'Apaga arquivo.', access: 'write', async run() { ran.push('apagou'); return 'apagado'; } });
tools.registerTool({ name: 'fs.mover', description: 'Move arquivo.', async run() { ran.push('moveu'); return 'movido'; } }); // sem "access"
tools.registerTool({ name: 'prog.rodar', description: 'Executa programa.', access: 'execute', async run() { ran.push('rodou'); return 'rodou'; } });

console.log('Modo somente leitura');
await test('vem LIGADO por padrão; só "false" desliga (vazio/0/no não desligam)', () => {
  assert.equal(isReadOnlyMode(), true);
  for (const v of ['', '0', 'no', 'off', 'TRUE', ' true ']) { process.env.YUI_READ_ONLY = v; assert.equal(isReadOnlyMode(), true, `"${v}" não deve desligar`); }
  process.env.YUI_READ_ONLY = 'false'; assert.equal(isReadOnlyMode(), false);
  process.env.YUI_READ_ONLY = ' FALSE '; assert.equal(isReadOnlyMode(), false);
  delete process.env.YUI_READ_ONLY;
});
await test('apagar, mover (sem declarar acesso) e executar são NEGADOS ao dono, até em DM', () => {
  for (const t of ['fs.apagar', 'fs.mover', 'prog.rodar']) {
    const a = checkToolAccess(ownerDm, t);
    assert.equal(a.allowed, false, `${t} deveria ser negada`);
    assert.match(a.reason, /somente leitura/);
  }
});
await test('ler e abrir pasta continuam permitidos ao dono', () => {
  assert.equal(checkToolAccess(ownerDm, 'ler.algo').allowed, true);
  assert.equal(checkToolAccess(ownerDm, 'abrir.pasta').allowed, true);
  assert.deepEqual(listAllowedTools(ownerDm).sort(), ['abrir.pasta', 'ler.algo']);
});
await test('o LLM nem enxerga as ferramentas bloqueadas', async () => {
  prompts.length = 0; script = ['{"reply":"oi"}'];
  await runAgent(ownerApi, 'oi');
  assert.ok(prompts[0].includes('ler.algo') && prompts[0].includes('abrir.pasta'));
  for (const t of ['fs.apagar', 'fs.mover', 'prog.rodar']) assert.ok(!prompts[0].includes(t), `${t} não pode aparecer no prompt`);
});
await test('se o LLM pedir apagar/mover/executar (alucinação ou injeção), NADA executa', async () => {
  for (const tool of ['fs.apagar', 'fs.mover', 'prog.rodar']) {
    const before = ran.length;
    script = [JSON.stringify({ tool, args: {} })];
    const out = await runAgent(ownerApi, 'apaga tudo');
    assert.equal(out.type, 'denied', `${tool}`);
    assert.match(out.reply, /somente leitura/);
    assert.equal(ran.length, before, `${tool} não pode ter rodado`);
  }
});
await test('confirmação não fura o bloqueio: ação pendente cuja permissão mudou é negada', async () => {
  script = ['{"tool":"abrir.pasta","args":{}}'];
  const ask = await runAgent(ownerApi, 'abre');
  assert.equal(ask.type, 'needs_confirmation');
  // transforma a ferramenta em "write" depois do pedido: a revalidação deve barrar
  tools.registerTool({ name: 'abrir.pasta', description: 'Abre.', access: 'write', confirm: true, async run() { ran.push('abrir-write'); return 'x'; } });
  const before = ran.length;
  const out = await resolvePending(ownerApi, ask.pendingId, true);
  assert.equal(out.type, 'denied');
  assert.equal(ran.length, before);
  tools.registerTool({ name: 'abrir.pasta', description: 'Abre.', access: 'open', confirm: true, async run() { ran.push('abrir'); return 'aberto'; } });
});
await test('o bloqueio vale para qualquer papel e canal', () => {
  assert.equal(checkToolAccess(member, 'fs.apagar').allowed, false);
  assert.equal(checkToolAccess(buildContext({ userId: '333' }), 'fs.apagar').allowed, false);
});
await test('só uma decisão explícita (YUI_READ_ONLY=false) libera, e voltar ao padrão bloqueia de novo', () => {
  process.env.YUI_READ_ONLY = 'false';
  assert.equal(checkToolAccess(ownerDm, 'fs.apagar').allowed, true);
  delete process.env.YUI_READ_ONLY;
  assert.equal(checkToolAccess(ownerDm, 'fs.apagar').allowed, false);
});
await test('ferramentas MCP começam como "write" (bloqueadas) e só liberam se declaradas de leitura', () => {
  process.env.YUI_MCP_ALLOW = 'srv.escreve,srv.le';
  process.env.YUI_MCP_READ_ONLY = 'srv.le';
  tools.registerMcpTools('srv', [{ name: 'escreve' }, { name: 'le' }, { name: 'nao_listada' }], async () => 'ok');
  assert.equal(checkToolAccess(ownerDm, 'srv.escreve').allowed, false);
  assert.equal(checkToolAccess(ownerDm, 'srv.le').allowed, true);
  assert.equal(tools.getTool('srv.nao_listada'), null);
  process.env.YUI_MCP_ALLOW = '';
  process.env.YUI_MCP_READ_ONLY = '';
});

console.log('Ferramentas reais do PC');
const projDir = path.join(tmp, 'proj');
fs.mkdirSync(projDir);
process.env.YUI_TOOLS_PC_ENABLED = 'true';
process.env.YUI_FILE_ROOTS = projDir;
process.env.YUI_PROJECTS = `p=${projDir}`;
process.env.YUI_APPS = `bloco=${path.join(tmp, 'x.exe')}`;
tools.clearTools();
tools.registerBuiltinTools();
await test('declaram o acesso correto: system.info/files.search = read, projects.open = open, apps.open = execute', () => {
  const acc = Object.fromEntries(tools.listTools().map((t) => [t.name, t.access]));
  assert.deepEqual(acc, { 'system.info': 'read', 'files.search': 'read', 'projects.open': 'open', 'apps.open': 'execute' });
});
await test('no modo somente leitura, apps.open (executar programas) é bloqueado; as demais seguem', () => {
  assert.equal(checkToolAccess(ownerDm, 'apps.open').allowed, false);
  for (const t of ['system.info', 'files.search', 'projects.open']) assert.equal(checkToolAccess(ownerDm, t).allowed, true, t);
});
await test('files.search não altera nada: a pasta fica idêntica depois da busca', async () => {
  fs.writeFileSync(path.join(projDir, 'relatorio.txt'), 'conteudo');
  const snap = () => fs.readdirSync(projDir).map((f) => `${f}:${fs.statSync(path.join(projDir, f)).size}:${fs.statSync(path.join(projDir, f)).mtimeMs}`).join('|');
  const before = snap();
  await tools.getTool('files.search').run({ query: 'relatorio' });
  assert.equal(snap(), before);
});

console.log('API');
await test('/v1/health informa readOnly=true e /v1/agent nega apagar de ponta a ponta', async () => {
  const OWNER = 'owner-token-0123456789';
  tools.registerTool({ name: 'fs.apagar', description: 'Apaga arquivo.', access: 'write', async run() { ran.push('apagou-api'); return 'x'; } });
  const server = createApiServer({ tokens: parseTokens(`${OWNER}=111`) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${b}/v1/health`)).json();
  assert.equal(health.readOnly, true);
  script = ['{"tool":"fs.apagar","args":{}}'];
  const before = ran.length;
  const res = await (await fetch(`${b}/v1/agent`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'apaga o arquivo' }) })).json();
  assert.equal(res.type, 'denied', JSON.stringify(res));
  assert.equal(ran.length, before);
  server.close();
});

console.log('Vigia do código das ferramentas');
await test('tools.js não usa API que apague, grave, mova, ou execute comandos livres', () => {
  const raw = fs.readFileSync(path.join(here, '..', 'src', 'core', 'agent', 'tools.js'), 'utf8');
  // remove comentários para não gerar falso positivo
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const forbidden = [
    /\bunlink(Sync)?\b/, /\brm(Sync)?\s*\(/, /\brmdir(Sync)?\b/, /\bwriteFile(Sync)?\b/, /\bappendFile(Sync)?\b/,
    /\brename(Sync)?\b/, /\bcopyFile(Sync)?\b/, /\btruncate(Sync)?\b/, /\bmkdir(Sync)?\b/, /\bcreateWriteStream\b/,
    /\bchmod(Sync)?\b/, /\bchown(Sync)?\b/, /\bsymlink(Sync)?\b/, /\butimes(Sync)?\b/, /\bopen(Sync)?\s*\(\s*[^)]*['"][wa]/,
    /\bexec(Sync|File|FileSync)?\s*\(/, /\bfork\s*\(/, /shell\s*:\s*true/,
  ];
  for (const re of forbidden) assert.ok(!re.test(src), `tools.js usa uma API proibida: ${re}`);
  // as únicas chamadas de sistema de arquivos permitidas são de LEITURA
  const fsCalls = [...src.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]);
  const allowed = new Set(['existsSync', 'readdirSync']);
  for (const c of fsCalls) assert.ok(allowed.has(c), `fs.${c} não é uma operação de leitura permitida`);
  // iniciar algo só via spawn SEM shell
  assert.match(src, /spawn\(command, args, \{[^}]*shell: false/);
});
await test('o vigia detecta de fato: um código com unlink/rm/writeFile seria reprovado', () => {
  const bad = "import fs from 'fs'; fs.unlinkSync(p); fs.writeFileSync(a,b); fs.rmSync(d,{recursive:true});";
  const re = [/\bunlink(Sync)?\b/, /\bwriteFile(Sync)?\b/, /\brm(Sync)?\s*\(/];
  assert.ok(re.every((r) => r.test(bad)));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
