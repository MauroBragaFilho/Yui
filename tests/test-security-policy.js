// Motor unificado de políticas (Fase 1) em modo OBSERVAÇÃO: matriz, precedência, negação por padrão,
// registro de divergências e garantia de que o comportamento atual NÃO muda.
// Execução: npm run test:security
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-security-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_PRIVATE_CHANNEL_IDS = 'priv1';
process.env.YUI_READ_ONLY = 'true';
process.env.YUI_TOOLS_PC_ENABLED = 'true';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
for (const k of Object.keys(process.env)) if (k.startsWith('POLICY_')) delete process.env[k];
delete process.env.YUI_POLICY_MODE;

const { POLICY_STATES, CHANNEL_KINDS, buildContext, ROLES } = await import('../src/core/permissions.js');
const { MATRIX, COLUMNS, ORIGINS, canonicalAction } = await import('../src/core/security/permissionMatrix.js');
const { createPolicyEngine, originFor } = await import('../src/core/security/policyEngine.js');
const ai = await import('../src/core/ai/manager.js');
const { runAgent } = await import('../src/core/agent/agent.js');
const tools = await import('../src/core/agent/tools.js');
const { createDev } = await import('../src/core/dev/index.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const { AUTO, ASK, CRITICAL, DENY } = POLICY_STATES;
const auditLines = () => (fs.existsSync(process.env.YUI_AUDIT_FILE) ? fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const policyEvents = () => auditLines().filter((e) => e.event === 'policy.evaluate');
const rw = () => createPolicyEngine({ readOnly: () => false, auditFn: () => {}, env: {} });

console.log('Matriz');
await test('toda linha tem as 5 colunas com um estado válido; as 15 da especificação estão presentes', () => {
  for (const row of MATRIX.values()) {
    assert.deepEqual(Object.keys(row.decisions), [...COLUMNS], row.action);
    for (const d of Object.values(row.decisions)) assert.ok([AUTO, ASK, CRITICAL, DENY].includes(d), `${row.action}: ${d}`);
  }
  assert.equal([...MATRIX.values()].filter((r) => !r.proposed).length, 15);
  assert.ok([...MATRIX.values()].filter((r) => r.proposed).every((r) => ['system', 'files', 'projects', 'commands', 'apps', 'skills', 'memory', 'admin', 'bds', 'media', 'job'].includes(r.action.split('.')[0])));
});

await test('exemplos da especificação §1.2', () => {
  const e = rw();
  const d = (action, role, origin, guildAdmin) => e.evaluate({ action, role, origin, guildAdmin }).decision;
  const O = ROLES.OWNER;
  assert.equal(d('dev.run_terminal', O, ORIGINS.LOCAL_PC), CRITICAL);
  assert.equal(d('dev.write_apply_diff', O, ORIGINS.LOCAL_PC), CRITICAL);
  for (const origin of [ORIGINS.REMOTE, ORIGINS.DISCORD_DM, ORIGINS.DISCORD_GUILD]) {
    assert.equal(d('dev.run_terminal', O, origin), DENY, `terminal em ${origin}`);
    assert.equal(d('dev.write_apply_diff', O, origin), DENY, `escrita em ${origin}`);
  }
  assert.equal(d('dev.read_file_search', O, ORIGINS.REMOTE), AUTO);
  assert.equal(d('admin.ban_user', O, ORIGINS.DISCORD_DM), CRITICAL);
  assert.equal(d('admin.ban_user', O, ORIGINS.LOCAL_PC), AUTO);
  assert.equal(d('memory.wipe_own', ROLES.MEMBER, ORIGINS.DISCORD_DM), ASK);
  // memory.admin_wipe_user (decisão da Liz, 18/11/2026): o dono pede COM confirmação (ASK) em qualquer origem dele; os
  // outros papéis e o canal público são negados. Somente leitura continua negando (é `modifies`).
  for (const origin of [ORIGINS.LOCAL_PC, ORIGINS.REMOTE, ORIGINS.DISCORD_DM]) assert.equal(d('memory.admin_wipe_user', O, origin), ASK, `dono em ${origin}`);
  assert.equal(d('memory.admin_wipe_user', O, ORIGINS.DISCORD_GUILD), DENY, 'dono num canal público sem ManageGuild');
  assert.equal(d('memory.admin_wipe_user', O, ORIGINS.DISCORD_GUILD, true), DENY, 'nem como administrador do servidor');
  for (const role of [ROLES.TRUSTED, ROLES.MEMBER, ROLES.GUEST]) {
    for (const origin of [ORIGINS.DISCORD_DM, ORIGINS.DISCORD_GUILD, ORIGINS.REMOTE]) assert.equal(d('memory.admin_wipe_user', role, origin), DENY, `${role} em ${origin}`);
  }
  assert.equal(createPolicyEngine({ env: {}, auditFn: () => {}, readOnly: () => true }).evaluate({ action: 'memory.admin_wipe_user', role: O, origin: ORIGINS.DISCORD_DM }).decision, DENY, 'somente leitura vence sempre');
  assert.equal(d('radio.download_track', ROLES.MEMBER, ORIGINS.DISCORD_GUILD), DENY);
  assert.equal(d('radio.download_track', ROLES.TRUSTED, ORIGINS.DISCORD_GUILD, true), AUTO);
  assert.equal(d('admin.follow_social', ROLES.MEMBER, ORIGINS.DISCORD_GUILD, true), ASK);
  assert.equal(d('chat.generate_image', ROLES.MEMBER, ORIGINS.DISCORD_GUILD), AUTO);
});

console.log('Precedência e negação por padrão');
await test('ação desconhecida, papel desconhecido, bloqueado e origem inventada são negados', () => {
  const e = rw();
  assert.equal(e.evaluate({ action: 'tudo.liberado', role: ROLES.OWNER, origin: ORIGINS.LOCAL_PC }).decision, DENY);
  assert.equal(e.evaluate({ action: 'system.info', role: 'SUPERUSER', origin: ORIGINS.LOCAL_PC }).decision, DENY);
  assert.equal(e.evaluate({ action: 'system.info', role: ROLES.BLOCKED, origin: ORIGINS.LOCAL_PC }).decision, DENY);
  assert.equal(e.evaluate({ action: 'system.info', role: ROLES.OWNER, origin: 'TAILNET-LOCAL' }).decision, DENY);
  assert.equal(e.evaluate({}).decision, DENY);
  assert.equal(canonicalAction('__proto__'), null);
  assert.equal(canonicalAction('constructor'), null);
});

await test('somente leitura vence sempre: toda ação que modifica vira DENY, as demais não mudam', () => {
  let readOnly = true;
  const e = createPolicyEngine({ readOnly: () => readOnly, auditFn: () => {}, env: {} });
  for (const row of MATRIX.values().filter((r) => r.modifies)) {
    for (const origin of Object.values(ORIGINS)) {
      assert.equal(e.evaluate({ action: row.action, role: ROLES.OWNER, origin, guildAdmin: true }).decision, DENY, `${row.action} em ${origin}`);
    }
  }
  assert.equal(e.evaluate({ action: 'dev.run_terminal', role: ROLES.OWNER, origin: ORIGINS.LOCAL_PC }).reason, 'modo somente leitura');
  assert.equal(e.evaluate({ action: 'system.info', role: ROLES.OWNER, origin: ORIGINS.LOCAL_PC }).decision, AUTO);
  readOnly = false;
  assert.equal(e.evaluate({ action: 'dev.run_terminal', role: ROLES.OWNER, origin: ORIGINS.LOCAL_PC }).decision, CRITICAL);
});

await test('o dono só pode APERTAR por categoria (POLICY_<CATEGORIA>_AUTONOMY); afrouxar e valores inválidos são ignorados', () => {
  const mk = (env) => createPolicyEngine({ readOnly: () => false, auditFn: () => {}, env });
  const q = (e, action) => e.evaluate({ action, role: ROLES.OWNER, origin: ORIGINS.LOCAL_PC }).decision;
  assert.equal(q(mk({ POLICY_DEV_AUTONOMY: 'CRITICAL' }), 'dev.read_file_search'), CRITICAL);
  assert.equal(q(mk({ POLICY_DEV_AUTONOMY: 'critical' }), 'dev.read_file_search'), CRITICAL);
  assert.equal(q(mk({ POLICY_DEV_AUTONOMY: 'AUTO' }), 'dev.run_terminal'), CRITICAL, 'AUTO não afrouxa CRITICAL');
  assert.equal(q(mk({ POLICY_DEV_AUTONOMY: 'ASK' }), 'dev.run_terminal'), CRITICAL);
  assert.equal(q(mk({ POLICY_DEV_AUTONOMY: 'LIBERADO' }), 'dev.read_file_search'), AUTO);
  assert.equal(q(mk({ POLICY_DEV_AUTONOMY: 'constructor' }), 'dev.read_file_search'), AUTO, 'nome herdado do Object não vale');
  assert.equal(q(mk({ POLICY_MEDIA_AUTONOMY: 'DENY' }), 'dev.read_file_search'), AUTO, 'outra categoria não interfere');
});

await test('quem não é o dono não ganha poder de dono por vir de "origem local"; dono em canal público só com ManageGuild', () => {
  const e = rw();
  assert.equal(e.evaluate({ action: 'dev.run_terminal', role: ROLES.MEMBER, origin: ORIGINS.LOCAL_PC }).decision, DENY);
  assert.equal(e.evaluate({ action: 'dev.run_terminal', role: ROLES.TRUSTED, origin: ORIGINS.LOCAL_PC }).decision, DENY);
  assert.equal(e.evaluate({ action: 'system.info', role: ROLES.OWNER, origin: ORIGINS.DISCORD_GUILD }).decision, DENY);
  assert.equal(e.evaluate({ action: 'admin.guild_configure', role: ROLES.OWNER, origin: ORIGINS.DISCORD_GUILD, guildAdmin: true }).decision, AUTO);
  assert.equal(originFor({ platform: 'discord', channelKind: CHANNEL_KINDS.PUBLIC }), ORIGINS.DISCORD_GUILD);
  assert.equal(originFor({ platform: 'discord', channelKind: CHANNEL_KINDS.DM }), ORIGINS.DISCORD_DM);
  assert.equal(originFor({ platform: 'discord', channelKind: CHANNEL_KINDS.PRIVATE }), ORIGINS.DISCORD_DM);
  assert.equal(originFor({ platform: 'api', local: true }), ORIGINS.LOCAL_PC);
  assert.equal(originFor({ platform: 'api', local: false }), ORIGINS.REMOTE);
  assert.equal(originFor({ platform: 'api' }), ORIGINS.REMOTE, 'sem prova de origem local, é remoto');
});

console.log('Observação');
await test('observe registra decisão, decisão antiga e a divergência (mais restritivo / mais permissivo)', () => {
  const events = [];
  const e = createPolicyEngine({ readOnly: () => false, auditFn: (ev, ctx, d) => events.push({ ev, ctx, d }), env: {} });
  const owner = buildContext({ platform: 'discord', userId: '111', isDM: true });
  e.observe({ action: 'system.info', ctx: owner, legacy: 'allow' });
  e.observe({ action: 'commands.run', ctx: owner, legacy: 'ask', target: 'git status' });
  e.observe({ action: 'dev:write_file', ctx: owner, origin: ORIGINS.LOCAL_PC, legacy: 'deny' });
  const member = buildContext({ platform: 'discord', userId: '222', isDM: true });
  e.observe({ action: 'system.info', ctx: member, legacy: 'allow' });
  assert.equal(events.length, 4);
  assert.deepEqual([events[0].d.decision, events[0].d.diverges], [AUTO, null]);
  assert.deepEqual([events[1].d.decision, events[1].d.legacy, events[1].d.diverges], [DENY, ASK, 'motor mais restritivo']);
  assert.equal(events[1].d.targetHash.length, 16);
  assert.ok(!JSON.stringify(events[1].d).includes('git status'), 'o alvo vai só como hash');
  assert.deepEqual([events[2].d.decision, events[2].d.diverges], [CRITICAL, 'motor mais permissivo']);
  assert.equal(events[3].d.decision, DENY);
  assert.deepEqual([e.stats().total, e.stats().stricter, e.stats().looser], [4, 2, 1]);
});

await test('observe nunca lança, ignora ação fora da matriz e desliga com YUI_POLICY_MODE=off', () => {
  const owner = buildContext({ platform: 'api', userId: '111', isDM: true });
  const boom = createPolicyEngine({ auditFn: () => { throw new Error('disco cheio'); }, env: {} });
  assert.doesNotThrow(() => boom.observe({ action: 'system.info', ctx: owner, legacy: 'allow' }));
  assert.doesNotThrow(() => boom.observe({ action: 'system.info', ctx: undefined, legacy: 'allow' }));
  const events = [];
  const e = createPolicyEngine({ auditFn: (...a) => events.push(a), env: {} });
  assert.equal(e.observe({ action: 'ferramenta.nova', ctx: owner, legacy: 'allow' }), null);
  const off = createPolicyEngine({ auditFn: (...a) => events.push(a), env: { YUI_POLICY_MODE: 'off' } });
  assert.equal(off.observe({ action: 'system.info', ctx: owner, legacy: 'allow' }), null);
  assert.equal(events.length, 0);
});

console.log('Integração (o comportamento atual não muda)');
tools.clearTools();
tools.registerBuiltinTools();

await test('Agent: comando cadastrado continua pedindo confirmação, e a divergência fica na auditoria', async () => {
  process.env.YUI_READ_ONLY = 'false';
  process.env.YUI_COMMANDS = `ola=node -e "console.log('oi')"`;
  ai.registerBackend({ name: 'fake', local: false, async chat() { return '{"tool":"commands.run","args":{"name":"ola"}}'; } }, { activate: true });
  const owner = buildContext({ platform: 'api', userId: '111', isDM: true });
  const before = policyEvents().length;
  const out = await runAgent(owner, 'rode ola', { origin: 'LOCAL_PC' });
  assert.equal(out.type, 'needs_confirmation', 'o comportamento antigo foi mantido');
  const ev = policyEvents().slice(before);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].action, 'commands.run');
  assert.equal(ev[0].origin, 'LOCAL_PC');
  assert.deepEqual([ev[0].decision, ev[0].legacy, ev[0].diverges], [CRITICAL, ASK, 'motor mais restritivo']);
  process.env.YUI_READ_ONLY = 'true';
  const blocked = await runAgent(owner, 'rode ola', { origin: 'LOCAL_PC' });
  assert.equal(blocked.type, 'denied');
  const last = policyEvents().at(-1);
  assert.deepEqual([last.decision, last.legacy, last.diverges], [DENY, DENY, null], 'em somente leitura motor e código antigo concordam');
});

await test('Agent: leitura (system.info) concorda; sem origem informada a API conta como REMOTA', async () => {
  ai.registerBackend({ name: 'fake2', local: false, async chat() { return '{"tool":"system.info","args":{}}'; } }, { activate: true });
  const owner = buildContext({ platform: 'api', userId: '111', isDM: true });
  const before = policyEvents().length;
  const out = await runAgent(owner, 'como está o pc?');
  assert.equal(out.type, 'tool_result');
  const ev = policyEvents().slice(before)[0];
  assert.deepEqual([ev.decision, ev.legacy, ev.diverges, ev.origin], [AUTO, AUTO, null, 'REMOTE']);
});

await test('módulo Código: leitura concorda; gravar continua pedindo aprovação e o motor registra CRITICAL local', async () => {
  process.env.YUI_READ_ONLY = 'false';
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-sec-proj-'));
  fs.writeFileSync(path.join(project, 'a.js'), 'x');
  const act = (action, params) => JSON.stringify({ action, params, thought: '' });
  const llm = {
    async chat({ messages }) {
      const last = String(messages.at(-1).content);
      if (last.includes('[RESULTADO')) return { text: 'ok', provider: 'f', model: 'm' };
      return { text: /grave/.test(last) ? act('write_file', { path: 'n.txt', content: 'oi' }) : act('read_file', { path: 'a.js' }), provider: 'f', model: 'm' };
    },
  };
  const dev = createDev({ env: { YUI_DEV_ENABLED: 'true', YUI_PROJECTS: `P=${project}`, YUI_DEV_PROJECTS_FILE: path.join(tmp, 'p.json') }, llm, historyDir: path.join(tmp, 'h'), indexDir: path.join(tmp, 'i') });
  const ownerCtx = buildContext({ platform: 'api', userId: '111', isDM: true });
  const finish = async (runId, onApproval) => {
    let after = 0;
    for (let i = 0; i < 200; i++) {
      const r = dev.getEvents(runId, after);
      for (const e of r.events) { after = e.seq; if (e.type === 'approval') onApproval?.(e); if (e.type === 'done') return; }
      await new Promise((r2) => setTimeout(r2, 20));
    }
    throw new Error('não terminou');
  };
  let before = policyEvents().length;
  await finish((await dev.startRun({ projectId: 'p', message: 'leia a.js', local: true, ctx: ownerCtx })).runId);
  let ev = policyEvents().slice(before).filter((e) => e.action === 'dev.read_file_search');
  assert.ok(ev.length >= 1 && ev.every((e) => e.decision === AUTO && e.diverges === null), JSON.stringify(ev));

  before = policyEvents().length;
  const run = await dev.startRun({ projectId: 'p', message: 'grave n.txt', local: true, ctx: ownerCtx });
  let asked = false;
  await finish(run.runId, (e) => { asked = true; assert.equal(fs.existsSync(path.join(project, 'n.txt')), false); dev.answerApproval(run.runId, e.id, false, { ctx: ownerCtx }); });
  assert.ok(asked, 'o comportamento antigo (pedir aprovação) foi mantido');
  ev = policyEvents().slice(before).filter((e) => e.action === 'dev.write_apply_diff');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].decision, ev[0].legacy, ev[0].origin, ev[0].diverges], [CRITICAL, ASK, 'LOCAL_PC', 'motor mais restritivo']);
  assert.equal(ev[0].targetHash.length, 16);
  fs.rmSync(project, { recursive: true, force: true });
});

await test('gate(): observe mantém a decisão antiga; enforce usa a mais restritiva; ação fora da matriz não muda', () => {
  const events = [];
  const mk = (mode) => createPolicyEngine({ readOnly: () => false, auditFn: (ev, c, d) => events.push(d), env: { YUI_POLICY_MODE: mode } });
  const ctx = { role: ROLES.OWNER, platform: 'api', channelKind: 'private' };
  const obs = mk('observe').gate({ action: 'commands.run', ctx, origin: 'REMOTE', legacy: 'ask' });
  assert.deepEqual([obs.decision, obs.enforced], [ASK, false]);
  const enf = mk('enforce');
  assert.equal(enf.mode(), 'enforce');
  const a = enf.gate({ action: 'commands.run', ctx, origin: 'REMOTE', legacy: 'ask' });
  assert.deepEqual([a.decision, a.enforced], [DENY, true]);
  assert.equal(enf.gate({ action: 'commands.run', ctx, origin: 'LOCAL_PC', legacy: 'ask' }).decision, CRITICAL);
  assert.equal(enf.gate({ action: 'system.info', ctx, origin: 'LOCAL_PC', legacy: 'allow' }).decision, AUTO);
  // O motor nunca afrouxa: o código antigo negou, continua negado.
  assert.equal(enf.gate({ action: 'system.info', ctx, origin: 'LOCAL_PC', legacy: 'deny' }).decision, DENY);
  assert.deepEqual([enf.gate({ action: 'tool.inventada', ctx, legacy: 'ask' }).decision, enf.gate({ action: 'tool.inventada', ctx, legacy: 'ask' }).enforced], [ASK, false]);
  assert.ok(events.some((d) => d.mode === 'enforce' && d.effective === DENY));
  assert.equal(mk('qualquer-coisa').mode(), 'observe');
});

console.log(`\n${passed} testes OK`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = 0;
