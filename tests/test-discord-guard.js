// Motor de políticas nas interações do Discord: observe não muda nada; enforce nega/exige o PC.
// Execução: npm run test:discordguard
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dg-'));
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
delete process.env.YUI_POLICY_MODE;

const { actionForInteraction, guardInteraction } = await import('../src/core/security/discordGuard.js');
const { createPolicyEngine } = await import('../src/core/security/policyEngine.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const OWNER = '111';
const MEMBER = '222';
const engine = (mode, readOnly) => createPolicyEngine({ env: { YUI_POLICY_MODE: mode }, readOnly: () => readOnly, auditFn: () => {} });
const slash = (name, sub = null) => ({ kind: 'slash', name, sub });
const comp = (customId) => ({ kind: 'component', customId });

console.log('Tabela');
await test('comandos e botões que mudam algo mapeiam para ações; navegação e comandos de consulta não', () => {
  const cases = [
    [slash('yui-criador', 'banir'), 'admin.ban_user'], [slash('yui-criador', 'desbanir'), 'admin.ban_user'], [{ ...slash('yui-criador', 'memorias'), acao: 'listar' }, 'memory.admin_inspect'],
    [slash('yui-criador', 'bot_config'), 'admin.bot_config'], [slash('yui-criador', 'automod'), 'admin.guild_configure'], [slash('yui-servidor'), 'admin.guild_configure'],
    [slash('yui-seguir-youtube'), 'admin.follow_social'], [slash('yui-config_ia'), 'admin.ai_configure'], [slash('baixar_video'), 'media.download'],
    [comp('adm_remoteban_user_1'), 'admin.ban_user'], [comp('banlist_unban_user_1'), 'admin.ban_user'], [comp('unban_user_1_2'), 'admin.ban_user'],
    [comp('crtcfg_modal_ban'), 'admin.ban_user'], [comp('cfgpanel_toggle_3_true'), 'admin.bot_config'], [comp('srvcfg_x'), 'admin.guild_configure'],
    // item 6 das lacunas do painel: os outros botões do painel de configuração que gravam no cofre
    [comp('cfgpanel_inc_3'), 'admin.bot_config'], [comp('cfgpanel_dec_3'), 'admin.bot_config'], [comp('cfgpanel_sel_24_mcp'), 'admin.bot_config'],
    [comp('cfgpanel_reset_3'), 'admin.bot_config'], [comp('cfgpanel_confirm_20_false'), 'admin.bot_config'], [comp('cfgpanel_confirmreset_20'), 'admin.bot_config'],
  ];
  for (const [d, a] of cases) assert.equal(actionForInteraction(d), a, JSON.stringify(d));
  for (const d of [slash('ajuda'), slash('yui-status'), slash('yui-memoria'), comp('cfgpanel_next_1'), comp('cfgpanel_back_4'), comp('cfgpanel_input_3'), comp('banlist_home'), comp('radio_stop'), comp('qualquer')]) assert.equal(actionForInteraction(d), null, JSON.stringify(d));
});

await test('/yui-criador memorias: listar e ver são inspeção; apagar e o botão de confirmar são memory.admin_wipe_user (como no canal)', () => {
  const mem = (acao) => ({ ...slash('yui-criador', 'memorias'), acao });
  assert.equal(actionForInteraction(mem('ver')), 'memory.admin_inspect');
  assert.equal(actionForInteraction(mem('apagar')), 'memory.admin_wipe_user');
  assert.equal(actionForInteraction(mem('apagar_usuario')), 'memory.admin_wipe_user');
  assert.equal(actionForInteraction(mem(null)), 'memory.admin_wipe_user', 'sem saber a ação, vale a mais restritiva');
  assert.equal(actionForInteraction(comp('memadm_ok_111111_222222_0_1790000000')), 'memory.admin_wipe_user');
  assert.equal(actionForInteraction(comp('memadm_no_111111')), null, 'cancelar não muda nada');
  // enforce, sem somente leitura: o dono em DM segue (ASK: o próprio fluxo pede a confirmação do alvo); membro e canal público não.
  const e = engine('enforce', false);
  assert.equal(guardInteraction({ data: mem('apagar_usuario'), userId: OWNER, isDM: true, engine: e }), null, 'dono em DM: segue para a confirmação');
  assert.equal(guardInteraction({ data: comp('memadm_ok_111_222_0_1'), userId: OWNER, isDM: true, engine: e }), null);
  assert.match(guardInteraction({ data: mem('apagar_usuario'), userId: OWNER, guildId: '9', channelId: '8', engine: e })?.message ?? '', /não é permitido/, 'dono num canal público: negado');
  assert.match(guardInteraction({ data: mem('apagar'), userId: MEMBER, isDM: true, engine: e })?.message ?? '', /não é permitido/, 'nunca a pedido de outro usuário');
  assert.match(guardInteraction({ data: comp('memadm_ok_222_333_0_1'), userId: MEMBER, guildId: '9', guildAdmin: true, engine: e })?.message ?? '', /não é permitido/);
  assert.match(guardInteraction({ data: mem('apagar_usuario'), userId: OWNER, isDM: true, engine: engine('enforce', true) })?.message ?? '', /não é permitido/, 'somente leitura vence sempre');
  assert.equal(guardInteraction({ data: mem('apagar_usuario'), userId: MEMBER, isDM: true, engine: engine('observe', false) }), null, 'observe: só registra');
});

console.log('observe e enforce');
await test('em observe nada é bloqueado', () => {
  for (const d of [slash('yui-criador', 'banir'), comp('adm_remoteban_user_1'), slash('yui-config_ia')]) {
    assert.equal(guardInteraction({ data: d, userId: MEMBER, guildId: '9', engine: engine('observe', true) }), null);
  }
});
await test('enforce + somente leitura: banir e mexer no painel global viram mensagem privada, mesmo para o dono', () => {
  const e = engine('enforce', true);
  for (const d of [slash('yui-criador', 'banir'), comp('banlist_unban_user_1'), comp('cfgpanel_toggle_1_true'), slash('yui-criador', 'bot_config')]) {
    const r = guardInteraction({ data: d, userId: OWNER, guildId: '9', guildAdmin: true, engine: e });
    assert.ok(r?.message, JSON.stringify(d));
  }
});
await test('enforce: membro comum não configura nem baixa nada que a matriz nega; baixar música continua liberado', () => {
  const e = engine('enforce', false);
  assert.ok(guardInteraction({ data: slash('yui-servidor'), userId: MEMBER, guildId: '9', engine: e })?.message);
  assert.ok(guardInteraction({ data: slash('yui-seguir-twitch'), userId: MEMBER, guildId: '9', engine: e })?.message);
  assert.ok(guardInteraction({ data: slash('yui-config_ia'), userId: MEMBER, guildId: '9', engine: e })?.message);
  assert.equal(guardInteraction({ data: slash('baixar_musica'), userId: MEMBER, guildId: '9', engine: e }), null);
});
await test('enforce: o dono banir pelo Discord (DM) é crítico e só vale no PC', () => {
  const r = guardInteraction({ data: slash('yui-criador', 'banir'), userId: OWNER, isDM: true, engine: engine('enforce', false) });
  assert.match(r?.message ?? '', /computador da Yui/);
});
await test('enforce: administrador do servidor segue configurando o próprio servidor', () => {
  const e = engine('enforce', false);
  assert.equal(guardInteraction({ data: slash('yui-servidor'), userId: MEMBER, guildId: '9', guildAdmin: true, engine: e }), null);
});
await test('o guarda nunca lança erro, mesmo com dados inválidos', () => {
  assert.equal(guardInteraction({}), null);
  assert.equal(guardInteraction({ data: null }), null);
});
await test('vigia: o interactionCreate chama o guarda antes dos handlers', () => {
  const src = fs.readFileSync(new URL('../src/events/interactionCreate.js', import.meta.url), 'utf8');
  const g = src.indexOf('guardInteraction({');
  assert.ok(g > 0 && g < src.indexOf("interaction.customId.startsWith('srvcfg_')"), 'guarda antes do despacho');
});

console.log('Conversa e auto-ban');
await test('ferramentas da IA (download/imagem) passam pelo guarda; o resto não é avaliado', async () => {
  const { guardToolCall } = await import('../src/core/security/discordGuard.js');
  assert.equal(guardToolCall({ tool: 'download_video', userId: MEMBER, guildId: '9', engine: engine('observe', true) }), null);
  assert.equal(guardToolCall({ tool: 'download_audio', userId: MEMBER, guildId: '9', engine: engine('enforce', false) }), null, 'liberado para todos na matriz');
  assert.equal(guardToolCall({ tool: 'search_web', userId: MEMBER, engine: engine('enforce', true) }), null);
  assert.equal(guardToolCall({}), null);
});
await test('auto-ban por nome de servidor/canal exige palavra inteira (sem falso positivo em "pintores" ou "sexologia")', async () => {
  process.env.YUI_BANS_FILE = path.join(tmp, 'bans-a.json');
  const { checkAutoBan } = await import('../src/handlers/banHandler.js');
  const hit = (g, c) => checkAutoBan('oi', g, '1', c, '2', '3');
  assert.equal(hit('Pintores Unidos', 'geral'), null);
  assert.equal(hit('Clube', 'sexologia'), null);
  assert.equal(hit('Clube', 'r34-chat')?.type, 'channel');
  assert.equal(hit('Loja 18+', 'x')?.type, 'guild');
  assert.equal(hit('Mercado', 'cuzão')?.type, 'channel');
});
await test('ia_automod: padrão é propor ao dono (review); só YUI_AUTOMOD_AI_BAN=auto bane sozinho (vigia do código)', () => {
  const src = fs.readFileSync(new URL('../src/handlers/llmHandler.js', import.meta.url), 'utf8');
  assert.match(src, /YUI_AUTOMOD_AI_BAN \?\? 'review'/);
  const i = src.indexOf('!alreadyBanned && !aiBanIsAutomatic()');
  assert.ok(i > 0, 'ramo de revisão');
  assert.ok(src.indexOf("addBan('user', userId, clampText(String(reason", i) > i, 'addBan só no ramo automático, depois da revisão');
});
await test('bans.json corrompido: a cópia fica guardada e a gravação é atômica', async () => {
  const file = path.join(tmp, 'bans-b.json');
  fs.writeFileSync(file, '{ quebrado');
  const { spawnSync } = await import('node:child_process');
  // Etapa 8 (revisão da Liz): o filho roda sob o bloqueio de integração externa (nenhuma exceção: ele só grava o arquivo de banimentos).
  const { criarBloqueioTemporario } = await import('./helpers/bloqueioExternoTeste.js');
  const bloqueio = criarBloqueioTemporario({ teste: 'test:discordguard', liberar: {} });
  const code = "import('./src/handlers/banHandler.js').then((m) => { m.addBan('user', '9999', 't'); })";
  const r = spawnSync(process.execPath, [...bloqueio.argv, '-e', code], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, NODE_ENV: 'test', YUI_BANS_FILE: file, ...bloqueio.env('banHandler') }, encoding: 'utf8' });
  bloqueio.fechar('test:discordguard');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('bans-b.json.corrompido-')), 'cópia da lista corrompida preservada');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).users['9999'], 'novo ban gravado em JSON válido');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'sem sobra do arquivo temporário');
});

console.log('Prefixo +yui');
await test('subcomandos do prefixo que gravam/baixam mapeiam para ações; os de consulta não; enforce nega pelo mesmo motor', () => {
  const p = (name) => ({ kind: 'prefix', name });
  assert.equal(actionForInteraction(p('configurar')), 'admin.guild_configure');
  assert.equal(actionForInteraction(p('config')), 'admin.guild_configure');
  assert.equal(actionForInteraction(p('musica')), 'media.download');
  for (const n of ['diario', 'semanal', 'noticias', 'status', 'perguntar', 'ajuda', 'constructor', '__proto__']) assert.equal(actionForInteraction(p(n)), null, n);
  const e = engine('enforce', false);
  assert.ok(guardInteraction({ data: p('configurar'), userId: MEMBER, guildId: '9', engine: e })?.message, 'membro comum não configura canais');
  assert.equal(guardInteraction({ data: p('configurar'), userId: MEMBER, guildId: '9', guildAdmin: true, engine: e }), null);
  assert.equal(guardInteraction({ data: p('configurar'), userId: MEMBER, guildId: '9', engine: engine('observe', true) }), null);
});
await test('vigia: o prefixo passa pelo gate de Termos de Uso e pelo guarda antes de executar o comando', () => {
  const src = fs.readFileSync(new URL('../src/discord/prefixRouter.js', import.meta.url), 'utf8');
  const tos = src.indexOf('isServerAccepted(guildId)');
  const guard = src.indexOf('guardInteraction({');
  const run = src.indexOf('await command.execute(adapter)');
  assert.ok(tos > 0 && guard > tos && run > guard, 'ordem: ToS, guarda, execução');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
