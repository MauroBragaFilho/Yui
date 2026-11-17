// Validação do modo ENFORCE do motor de políticas, em ambiente ISOLADO (nada de produção, nada de rede, nada de chaves reais).
//   npm run validar:enforce                grava docs/EVIDENCIA_ENFORCE.md com os resultados desta execução
//   npm run validar:enforce -- --sem-doc   só imprime
// Sobe a API de verdade em 127.0.0.1 (porta livre), com banco, auditoria e segredo do canal numa pasta temporária,
// IA falsa e ferramenta falsa no lugar de commands.run (nada é executado de verdade).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-enforce-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_APPROVAL_NONCE_FILE = path.join(tmp, 'approval-channel.json');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.MEMORY_RETENTION_DAYS = '30';
process.env.YUI_TOOLS_PC_ENABLED = 'false';
for (const k of ['AI_BASE_URL', 'AI_BACKEND', 'YUI_POLICY_MODE', 'YUI_READ_ONLY']) delete process.env[k];

const { initMemory } = await import('../src/core/index.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const ai = await import('../src/core/ai/manager.js');
const tools = await import('../src/core/agent/tools.js');
const { runAgent, resolvePending } = await import('../src/core/agent/agent.js');
const { buildContext, ROLES } = await import('../src/core/permissions.js');
const { getApprovalManager, resetApprovalManagerForTests } = await import('../src/core/security/approvalManager.js');
const { startLocalApprovalChannel } = await import('../src/core/security/localChannel.js');
const { guardInteraction, guardToolCall } = await import('../src/core/security/discordGuard.js');
const { jobAllowed, resetJobGuardForTests } = await import('../src/core/security/jobGuard.js');
const { analyzeCommand } = await import('../src/core/dev/terminalSanitizer.js');
const { isSensitive } = await import('../src/core/dev/workspace-fs.js');
await initMemory();

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const results = [];
let currentGroup = '';
const group = (name) => { currentGroup = name; console.log(`\n${name}`); };
async function check(id, desc, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r === undefined || r === true || typeof r === 'string'; detail = typeof r === 'string' ? r : ''; } catch (err) { detail = String(err?.message ?? err).split('\n')[0].slice(0, 200); }
  results.push({ group: currentGroup, id, desc, ok, detail });
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${id}  ${desc}${ok || !detail ? '' : `  -> ${detail}`}`);
}
const setMode = (mode, readOnly) => { process.env.YUI_POLICY_MODE = mode; process.env.YUI_READ_ONLY = String(readOnly); resetJobGuardForTests(); };

// ── infraestrutura isolada ──
ai.registerBackend({ name: 'fake', local: false, async chat() { return script.shift() ?? '{"reply":"ok"}'; } }, { activate: true });
let script = [];
const executed = [];
tools.clearTools();
tools.registerTool({ name: 'commands.run', description: 'Ferramenta falsa de teste (não executa nada).', params: { name: { type: 'string', required: true, max: 20 } }, minRole: ROLES.OWNER, access: 'execute', confirm: true, async run({ name }) { executed.push(name); return `rodou:${name}`; } });

const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, route, { token = OWNER, body, remote = false } = {}) {
  const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(remote ? { 'X-Forwarded-For': '100.64.0.9' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const blockedByPolicy = (r) => r.status === 403 && Boolean(r.json?.policy);

resetApprovalManagerForTests();
const approvals = getApprovalManager();
const channel = await startLocalApprovalChannel({ manager: approvals, env: process.env, port: 0 });
const chCall = (route, { nonce = channel.nonce, method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${channel.port}${route}`, { method, headers: { 'x-yui-local-nonce': nonce, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const ownerCtx = buildContext({ platform: 'api', userId: '111', isDM: true });

// ───────────────────────── A. Bloqueio de operações não autorizadas ─────────────────────────
group('A. Operações não autorizadas são bloqueadas (enforce + YUI_READ_ONLY=true)');
setMode('enforce', true);
for (const [id, m, p, body] of [['A1', 'POST', '/v1/admin/bans', { type: 'user', id: '999999999999999999' }], ['A2', 'DELETE', '/v1/admin/memory/users/222'], ['A3', 'POST', '/v1/admin/restart', { confirm: true }], ['A4', 'POST', '/v1/admin/bds/delete', { caminho: 'x' }], ['A5', 'POST', '/v1/admin/ai/keys', { provider: 'groq', key: 'x' }]]) {
  await check(id, `${m} ${p} pelo dono no PC -> 403 da política`, async () => { const r = await call(m, p, { body }); assert.ok(blockedByPolicy(r), `status ${r.status}`); return true; });
}
await check('A6', 'Discord: dono tenta banir (/yui-criador banir) em DM -> bloqueado', () => assert.ok(guardInteraction({ data: { kind: 'slash', name: 'yui-criador', sub: 'banir' }, userId: '111', isDM: true })?.message));
await check('A7', 'Discord: botão de ban remoto vindo do webhook -> bloqueado', () => assert.ok(guardInteraction({ data: { kind: 'component', customId: 'adm_remoteban_user_1' }, userId: '111', guildId: '9', guildAdmin: true })?.message));
await check('A8', 'Prefixo: membro comum não configura canais com "+yui configurar"', () => assert.ok(guardInteraction({ data: { kind: 'prefix', name: 'configurar' }, userId: '222', guildId: '9' })?.message));
await check('A9', 'Jobs: manutenção (yt-dlp e dados) pulada em somente leitura', () => { assert.equal(jobAllowed('maintenance.ytdlp_update'), false); assert.equal(jobAllowed('maintenance.data_refresh'), false); });
await check('A10', 'Jobs: publicar, lembrar e limpar seguem funcionando em somente leitura', () => { for (const j of ['scheduler.youtube', 'reminders.tick', 'scheduler.memory_purge', 'cleanup.context']) assert.equal(jobAllowed(j), true, j); });

group('A. Papel e origem (enforce + YUI_READ_ONLY=false)');
setMode('enforce', false);
await check('A11', 'Membro comum chamando rotas de administração -> 403 da política', async () => { for (const [m, p] of [['POST', '/v1/admin/bans'], ['POST', '/v1/admin/restart'], ['DELETE', '/v1/admin/memory/users/111']]) assert.ok(blockedByPolicy(await call(m, p, { token: MEMBER, body: {} })), `${m} ${p}`); });
await check('A12', 'App remoto (Android/Tailscale) em ação crítica (trocar chaves de IA, apagar de vez no BDS) -> 403 "só no computador"', async () => { for (const p of ['/v1/admin/ai/keys', '/v1/admin/bds/purge']) { const r = await call('POST', p, { body: {}, remote: true }); assert.ok(blockedByPolicy(r) && r.json.requiresLocalApproval === true, p); } });
await check('A13', 'Agent: commands.run vindo de origem remota -> negado', async () => { script = ['{"tool":"commands.run","args":{"name":"x"}}']; const before = executed.length; const r = await runAgent(ownerCtx, 'roda', { origin: 'REMOTE' }); assert.equal(r.type, 'denied'); assert.equal(executed.length, before); });
await check('A14', 'Discord: membro comum não configura servidor, não segue canais, não mexe na IA', () => { for (const name of ['yui-servidor', 'yui-seguir-twitch', 'yui-config_ia']) assert.ok(guardInteraction({ data: { kind: 'slash', name }, userId: '222', guildId: '9' })?.message, name); });
await check('A15', 'Discord: administrador do servidor continua configurando o próprio servidor (sem regressão)', () => assert.equal(guardInteraction({ data: { kind: 'slash', name: 'yui-servidor' }, userId: '222', guildId: '9', guildAdmin: true }), null));
await check('A16', 'Módulo Código: secrets/, .git/ e git --output recusados', () => { for (const p of ['secrets/ai-providers.json', 'secrets/approval-channel.json', '.git/config']) assert.equal(isSensitive(p), true, p); for (const c of ['git diff --output=a.txt', 'git diff --no-index a b']) assert.equal(analyzeCommand(c, {}).ok, false, c); });
await check('A17', 'Adivinhação de token: 20 Bearer inválidos travam a origem (429), mesmo com o token certo depois', async () => {
  const s2 = createApiServer({ tokens: parseTokens(`${OWNER}=111`) });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const hit = (t) => fetch(`http://127.0.0.1:${s2.address().port}/v1/me`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.status);
  for (let i = 0; i < 20; i++) assert.equal(await hit(`errado-${i}-0123456789abcdef`), 401);
  assert.equal(await hit(OWNER), 429);
  s2.close();
});

// ───────────────────────── B. Aprovação local de ações críticas ─────────────────────────
group('B. Ação crítica exige ticket aprovado no computador (canal local 127.0.0.1)');
setMode('enforce', false);
let pending; let ticket;
await check('B1', 'Agent (origem LOCAL_PC): commands.run vira pedido de aprovação e NÃO executa', async () => {
  script = ['{"tool":"commands.run","args":{"name":"relatorio"}}'];
  const before = executed.length;
  pending = await runAgent(ownerCtx, 'roda', { origin: 'LOCAL_PC' });
  assert.equal(pending.type, 'needs_confirmation'); assert.match(pending.reply, /yui-aprovar/); assert.equal(executed.length, before);
  [ticket] = approvals.list(); assert.ok(ticket && ticket.levelRequired === 'CRITICAL');
});
await check('B2', 'Confirmar no chat sem aprovar no PC: continua pendente, nada executa', async () => { const before = executed.length; const r = await resolvePending(ownerCtx, pending.pendingId); assert.equal(r.type, 'needs_confirmation'); assert.equal(executed.length, before); });
await check('B3', 'Tentativa de aprovar por origem REMOTA (o que o app Android faria) é recusada', () => assert.throws(() => approvals.decide(ticket.id, { approve: true, approverId: '111', approverRole: ROLES.OWNER, approverOrigin: 'REMOTE' }), /computador/));
await check('B4', 'Canal local recusa: sem segredo (401), segredo errado (401), cabeçalho de proxy (403), navegador/Origin (403)', async () => {
  assert.equal((await chCall('/v1/local/pending', { nonce: '' })).status, 401);
  assert.equal((await chCall('/v1/local/pending', { nonce: 'errado' })).status, 401);
  assert.equal((await chCall('/v1/local/pending', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
  assert.equal((await chCall('/v1/local/pending', { headers: { Origin: 'http://evil.example' } })).status, 403);
});
await check('B5', 'Aprovação no PC (canal local com segredo) muda o ticket para APROVADO', async () => { const r = await chCall('/v1/local/decide', { method: 'POST', body: { id: ticket.id, approve: true } }); assert.equal(r.status, 200); assert.equal(r.json.status, 'APPROVED'); });
await check('B6', 'Depois de aprovado, a confirmação no chat executa UMA vez', async () => { const before = executed.length; const r = await resolvePending(ownerCtx, pending.pendingId); assert.deepEqual([r.type, r.reply], ['tool_result', 'rodou:relatorio']); assert.equal(executed.length, before + 1); });
await check('B7', 'Reuso (replay) do mesmo ticket é negado e nada executa de novo', async () => { const before = executed.length; const r = await resolvePending(ownerCtx, pending.pendingId); assert.equal(r.type, 'denied'); assert.equal(executed.length, before); });
await check('B8', 'Aprovar de novo um ticket já usado é recusado (409)', async () => { const r = await chCall('/v1/local/decide', { method: 'POST', body: { id: ticket.id, approve: true } }); assert.ok([409, 404].includes(r.status), `status ${r.status}`); });
await check('B9', 'Ticket com parâmetros adulterados: o hash não confere e nada executa', () => {
  const t = approvals.request({ action: 'commands.run', params: { name: 'a' }, level: 'CRITICAL', requester: ownerCtx, origin: 'LOCAL_PC' });
  approvals.decide(t.id, { approve: true, approverId: '111', approverRole: ROLES.OWNER, approverOrigin: 'LOCAL_PC' });
  const used = approvals.consume(t.id, { action: 'commands.run', params: { name: 'b' } });
  assert.equal(used.ok, false); assert.match(used.reason, /difere/);
});
await check('B10', 'Ticket crítico expira em 60 s: depois disso não pode ser aprovado', async () => {
  const { createApprovalManager, TTL_MS } = await import('../src/core/security/approvalManager.js');
  assert.equal(TTL_MS.CRITICAL, 60_000);
  let clock = 1_000_000;
  const m = createApprovalManager({ auditFn: () => {}, now: () => clock });
  const t = m.request({ action: 'commands.run', params: {}, level: 'CRITICAL', origin: 'LOCAL_PC' });
  clock += TTL_MS.CRITICAL + 1;
  assert.throws(() => m.decide(t.id, { approve: true, approverId: '111', approverRole: ROLES.OWNER, approverOrigin: 'LOCAL_PC' }), /expirou/);
});
await check('B11', 'Rejeitar pelo chat cancela o ticket (nenhum pedido pendente sobra)', async () => {
  script = ['{"tool":"commands.run","args":{"name":"y"}}'];
  const r = await runAgent(ownerCtx, 'roda', { origin: 'LOCAL_PC' });
  assert.equal((await resolvePending(ownerCtx, r.pendingId, false)).reply, 'Ação cancelada.');
  assert.equal(approvals.list().length, 0);
});
await check('B12', 'Auditoria registra o ciclo (criado, aprovado, executado) e a cadeia de hash está íntegra', async () => {
  const { verifyAudit } = await import('../src/core/audit.js');
  const lines = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const ev of ['policy.approval_created', 'policy.approved', 'policy.enacted']) assert.ok(lines.some((e) => e.event === ev), ev);
  const v = verifyAudit(process.env.YUI_AUDIT_FILE);
  assert.ok(v.ok && v.total > 0, JSON.stringify(v).slice(0, 160));
  return `${v.total} eventos, cadeia íntegra`;
});

// ───────────────────────── C. Regressões: o que deve continuar igual ─────────────────────────
group('C. Sem regressão: leituras e uso normal funcionam igual em observe e em enforce');
const readOnlyScenarios = [['GET', '/v1/health', null], ['GET', '/v1/me', OWNER], ['GET', '/v1/admin/overview', OWNER], ['GET', '/v1/admin/bans', OWNER], ['GET', '/v1/memory', OWNER], ['POST', '/v1/chat', OWNER]];
for (const [m, p, tok] of readOnlyScenarios) {
  await check(`C:${m} ${p}`, 'mesmo status em observe e em enforce (somente leitura ligado)', async () => {
    const run = async () => { const res = await fetch(base + p, { method: m, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' }, body: m === 'POST' ? JSON.stringify({ message: 'oi' }) : undefined }); await res.text(); return res.status; };
    setMode('observe', true); const a = await run();
    setMode('enforce', true); const b = await run();
    assert.equal(a, b, `observe=${a} enforce=${b}`);
    return `status ${a}`;
  });
}
await check('C:memória', 'dono apaga a própria memória em enforce + somente leitura (permitido pela matriz)', async () => { setMode('enforce', true); const r = await call('DELETE', '/v1/memory'); assert.equal(r.status, 200); });

// ───────────────────────── D. Rollback ─────────────────────────
group('D. Rollback: voltar a observe/off desfaz os bloqueios sem reiniciar nada');
await check('D1', 'enforce bloqueia; trocando YUI_POLICY_MODE=observe a MESMA requisição deixa de ser bloqueada pelo motor', async () => {
  setMode('enforce', true); assert.ok(blockedByPolicy(await call('POST', '/v1/admin/bans', { body: {} })));
  setMode('observe', true); assert.equal(blockedByPolicy(await call('POST', '/v1/admin/bans', { body: {} })), false);
  setMode('off', true); assert.equal(blockedByPolicy(await call('POST', '/v1/admin/bans', { body: {} })), false);
});
await check('D2', 'Jobs: em observe a manutenção volta a rodar', () => { setMode('observe', true); assert.equal(jobAllowed('maintenance.ytdlp_update'), true); });
await check('D3', 'Agent: em observe o comportamento antigo (confirmação simples, sem ticket) volta', async () => {
  setMode('observe', false); script = ['{"tool":"commands.run","args":{"name":"z"}}'];
  const r = await runAgent(ownerCtx, 'roda', { origin: 'REMOTE' });
  assert.equal(r.type, 'needs_confirmation'); assert.doesNotMatch(r.reply, /yui-aprovar/);
  await resolvePending(ownerCtx, r.pendingId, false);
});

// ── relatório ──
await channel.close();
server.close();
delete process.env.YUI_POLICY_MODE; delete process.env.YUI_READ_ONLY;
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram${failed.length ? `; falharam: ${failed.map((f) => f.id).join(', ')}` : ''}`);

if (!process.argv.includes('--sem-doc')) {
  const when = new Date().toISOString();
  const rows = results.map((r) => `| ${r.id} | ${r.desc.replace(/\|/g, '/')} | ${r.ok ? 'PASSOU' : '**FALHOU**'}${r.detail ? ` (${r.detail.replace(/\|/g, '/')})` : ''} |`);
  const doc = [
    '# Evidência da validação do enforce (ambiente isolado)',
    '',
    `Gerado por \`npm run validar:enforce\` em ${when}. Resultado: **${results.length - failed.length}/${results.length}** verificações.`,
    '',
    'Ambiente: API real em 127.0.0.1 (porta livre), canal local de aprovação real, banco/auditoria/segredo em pasta temporária, IA falsa e ferramenta falsa no lugar de `commands.run` (nada é executado). Sem rede, sem chaves, sem produção.',
    '',
    '| ID | Verificação | Resultado |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  fs.writeFileSync(path.resolve(import.meta.dirname, '..', 'docs', 'EVIDENCIA_ENFORCE.md'), doc);
  console.log('Evidência gravada em docs/EVIDENCIA_ENFORCE.md');
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
